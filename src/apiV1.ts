import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { computeAnalysis, getProgress, isRunning, runDaily, type AppContext } from './app.ts';
import type { Store } from './db.ts';
import type { ISODate, Txn } from './types.ts';
import { APP_VERSION } from './version.ts';

/**
 * API פתוח לקריאה (v1) – לשימוש מי שרוצה את הנתונים בלי הדשבורד (סקריפטים, Excel/Sheets, Home Assistant, סוכני AI דרך MCP).
 * אימות: Authorization: Bearer <token> (או X-API-Key). הטוקן נוצר בהגדרות; נשמר רק גיבוב SHA-256 שלו.
 * הכול קריאה בלבד, חוץ מ-POST /refresh שמפעיל איסוף "שקט" (כבוד לרווחי הזמן ולחסימת הסיסמאות – אין עקיפה).
 */
const KV = 'api_token_hash';
const sha = (s: string) => createHash('sha256').update(s).digest();

export function hasApiToken(store: Store): boolean { return !!store.getKv(KV); }
export function createApiToken(store: Store): string {
  const token = `cw_${randomBytes(24).toString('base64url')}`;
  store.setKv(KV, sha(token).toString('hex'));
  return token;
}
export function revokeApiToken(store: Store): void { store.setKv(KV, ''); }
export function verifyApiToken(store: Store, given: string): boolean {
  const want = store.getKv(KV);
  if (!want || !given) return false;
  const a = Buffer.from(want, 'hex');
  const b = sha(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

const csvCell = (v: unknown, text = false): string => {
  let s = String(v ?? '');
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`; // מניעת הזרקת נוסחאות ב-Excel
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function txnsToCsv(txns: Txn[], labels: Map<string, string>): string {
  const head = ['id', 'source_id', 'source', 'account', 'date', 'processed_date', 'amount', 'description', 'memo', 'status'];
  const rows = txns.map((t) => [t.id, t.sourceId, labels.get(t.sourceId) ?? '', t.accountRef, t.date, t.processedDate, t.amount, t.description, t.memo, t.status]
    .map((v, i) => csvCell(v, i === 2 || i === 7 || i === 8)).join(','));
  return `﻿${[head.join(','), ...rows].join('\r\n')}\r\n`;
}

const isDate = (s: unknown): s is ISODate => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function apiV1Router(ctx: AppContext): Router {
  const r = express.Router();
  const hits: number[] = [];

  r.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!hasApiToken(ctx.store)) return void res.status(403).json({ error: 'ה-API כבוי. צור טוקן בהגדרות ← "API ואינטגרציות".' });
    const auth = req.headers.authorization ?? '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(req.headers['x-api-key'] ?? '');
    if (!verifyApiToken(ctx.store, given)) return void res.status(401).json({ error: 'טוקן לא תקין' });
    const now = Date.now();
    while (hits.length && hits[0]! < now - 60_000) hits.shift();
    if (hits.length >= 120) return void res.status(429).json({ error: 'יותר מדי בקשות (עד 120 בדקה)' });
    hits.push(now);
    next();
  });

  const labels = () => new Map([...ctx.config.banks, ...ctx.config.cards].map((s) => [s.id, s.label]));

  r.get('/status', (_req, res) => {
    const st = new Map(ctx.store.listSourceStatus().map((s) => [s.sourceId, s]));
    const src = (kind: 'bank' | 'card', x: { id: string; label: string; provider: string }) => ({
      id: x.id, kind, label: x.label, provider: x.provider,
      lastAttemptAt: st.get(x.id)?.lastAttemptAt ?? null, lastSuccessAt: st.get(x.id)?.lastSuccessAt ?? null, lastError: st.get(x.id)?.lastError?.split('\n')[0] ?? null,
    });
    const last = ctx.store.listRuns(1)[0];
    res.json({
      version: APP_VERSION, running: isRunning(), progress: getProgress(),
      lastRun: last ? { startedAt: last.startedAt, finishedAt: last.finishedAt, ok: last.ok, trigger: last.trigger } : null,
      sources: [...ctx.config.banks.map((b) => src('bank', b)), ...ctx.config.cards.map((c) => src('card', c))],
    });
  });

  r.get('/accounts', (_req, res) => {
    const { analysis } = computeAnalysis(ctx);
    const bal = new Map(analysis.accounts.map((a) => [a.accountId, a]));
    res.json({
      accounts: [
        ...ctx.config.banks.map((b) => ({ id: b.id, kind: 'bank', provider: b.provider, label: b.label, balance: bal.get(b.id)?.startBalance ?? null, balanceAt: bal.get(b.id)?.balanceAt ?? null, alertBelow: b.alertBelow })),
        ...ctx.config.cards.map((c) => ({ id: c.id, kind: 'card', provider: c.provider, label: c.label, fundingAccount: c.fundingAccount, cards: ctx.store.listCardRefs(c.id) })),
      ],
    });
  });

  r.get('/transactions', (req, res) => {
    const q = req.query;
    const from = isDate(q.from) ? q.from : undefined;
    const to = isDate(q.to) ? q.to : undefined;
    if ((q.from && !from) || (q.to && !to)) return void res.status(400).json({ error: 'from/to בפורמט YYYY-MM-DD' });
    const source = typeof q.source === 'string' ? q.source : undefined;
    if (source && !labels().has(source)) return void res.status(404).json({ error: 'מקור לא קיים' });
    const status = q.status === 'pending' || q.status === 'completed' ? q.status : undefined;
    const limit = Number(q.limit ?? 1000); const offset = Number(q.offset ?? 0);
    const txns = ctx.store.queryTxns({ sourceId: source, from, to, status, limit: Number.isFinite(limit) ? limit : 1000, offset: Number.isFinite(offset) ? offset : 0 });
    if (q.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="cashwatch-transactions.csv"');
      return void res.send(txnsToCsv(txns, labels()));
    }
    res.json({ count: txns.length, transactions: txns.map((t) => ({ ...t, source: labels().get(t.sourceId) ?? null })) });
  });

  r.get('/forecast', (_req, res) => {
    const { analysis } = computeAnalysis(ctx);
    res.json({ today: analysis.today, horizonDays: analysis.horizonDays, accounts: analysis.accounts, cardCharges: analysis.cardCharges });
  });

  r.get('/recurring', (_req, res) => { res.json({ items: ctx.store.listRecurring() }); });

  r.get('/alerts', (_req, res) => { res.json({ alerts: computeAnalysis(ctx).findings }); });

  r.post('/refresh', (_req, res) => {
    if (isRunning()) return void res.status(409).json({ error: 'ריצה כבר מתבצעת' });
    runDaily(ctx, 'api', { quick: true }).catch((e) => ctx.log(`ריצה מה-API נכשלה: ${e instanceof Error ? e.message : e}`));
    res.status(202).json({ started: true, note: 'האיסוף מכבד את הרווח המינימלי בין ריצות ואת חסימת הסיסמאות; בדוק /status' });
  });

  r.use((_req, res) => { res.status(404).json({ error: 'נתיב לא קיים' }); });
  return r;
}
