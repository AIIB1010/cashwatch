import { createHash, createHmac } from 'node:crypto';
import type { AppContext } from './app.ts';
import type { Store } from './db.ts';
import type { Txn } from './types.ts';
import { APP_VERSION } from './version.ts';

/**
 * Webhook יוצא: אחרי כל איסוף מוצלח נשלחת הודעה לכתובת שהמשתמש הגדיר (אם הוגדרה).
 * אירועים: `transactions.new` (תנועות שלא נראו קודם), `run.finished` (סיכום ריצה), `test` (בדיקה ידנית).
 * חתימה: X-CashWatch-Signature: sha256=<HMAC-SHA256 של גוף הבקשה בסוד המשותף>. הגוף: {event, sentAt, version, data}.
 */
export type WebhookEventName = 'transactions.new' | 'run.finished' | 'test';
type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function validWebhookUrl(url: string): boolean {
  try { const u = new URL(url); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
}

export async function sendWebhook(url: string, secret: string | undefined, event: WebhookEventName, data: unknown, fetchFn: FetchFn = fetch as unknown as FetchFn): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!validWebhookUrl(url)) return { ok: false, error: 'כתובת Webhook לא תקינה (נדרש http או https)' };
  const body = JSON.stringify({ event, sentAt: new Date().toISOString(), version: APP_VERSION, data });
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-CashWatch-Event': event, 'User-Agent': `CashWatch/${APP_VERSION}` };
  if (secret) headers['X-CashWatch-Signature'] = signBody(secret, body);
  try {
    const res = await fetchFn(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `השרת החזיר ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const KV = 'webhook_seen';
const keyOf = (t: Txn) => createHash('sha1').update(`${t.sourceId}|${t.accountRef}|${t.date}|${t.amount}|${t.description}|${t.memo}`).digest('hex').slice(0, 16);

/** תנועות שלא נשלחו עדיין. בפעם הראשונה רק "מתעדים" את מה שקיים (בלי להציף את ה-Webhook בהיסטוריה). */
export function collectNewTxns(store: Store, since: string): Txn[] {
  const current = store.queryTxns({ from: since, limit: 10_000 });
  const raw = store.getKv(KV);
  const seen = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  const first = !raw;
  const fresh = first ? [] : current.filter((t) => !seen.has(keyOf(t)));
  for (const t of current) seen.add(keyOf(t));
  store.setKv(KV, JSON.stringify([...seen].slice(-30_000)));
  return fresh;
}

/** נקרא בסוף ריצה. כשל ב-Webhook לא משפיע על הריצה (רק נרשם ביומן) */
export async function notifyAfterRun(ctx: AppContext, summary: { ok: boolean; trigger?: string; sources: Array<{ sourceId: string; ok: boolean; skipped?: boolean; error?: string }>; findings: number }, since: string): Promise<void> {
  const url = ctx.config.integrations.webhookUrl;
  if (!url) return;
  try {
    const labels = new Map([...ctx.config.banks, ...ctx.config.cards].map((s) => [s.id, s.label]));
    const fresh = collectNewTxns(ctx.store, since);
    const secret = ctx.secrets.webhookSecret;
    if (fresh.length) {
      const r = await sendWebhook(url, secret, 'transactions.new', { count: fresh.length, transactions: fresh.map((t) => ({ ...t, source: labels.get(t.sourceId) ?? null })) });
      if (!r.ok) ctx.log(`⚠️ Webhook (transactions.new) נכשל: ${r.error}`);
    }
    const r2 = await sendWebhook(url, secret, 'run.finished', { ok: summary.ok, findings: summary.findings, sources: summary.sources.map((s) => ({ id: s.sourceId, ok: s.ok, skipped: !!s.skipped, error: s.error?.split('\n')[0] ?? null })) });
    if (!r2.ok) ctx.log(`⚠️ Webhook (run.finished) נכשל: ${r2.error}`);
  } catch (e) {
    ctx.log(`⚠️ Webhook נכשל: ${e instanceof Error ? e.message : e}`);
  }
}
