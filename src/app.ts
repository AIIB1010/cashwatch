import { analyze, sourceFindings } from './engine/analyze.ts';
import { addDays, fmtShort, ils, todayIn } from './engine/dates.ts';
import { effectiveChargeMatch, type Config, type Secrets } from './config.ts';
import type { Store } from './db.ts';
import { buildAlertMessage, buildChannels, buildDigestMessage, dispatch, type AlertLine, type Channel } from './notify/channels.ts';
import { detectAndFile } from './patterns.ts';
import { notifyAfterRun } from './webhooks.ts';
import { scrapeAll, type SourceResult } from './scrape/runner.ts';
import type { ScrapeProvider } from './scrape/types.ts';
import type { Settings } from './settings.ts';
import type { Analysis, Finding } from './types.ts';

export interface AppContext {
  config: Config;
  secrets: Secrets;
  store: Store;
  provider: ScrapeProvider;
  dataDir: string;
  channels: Channel[];
  log: (msg: string) => void;
  /** כשקיים – ההגדרות נקראות ממנו בכל גישה (ניתנות לעריכה מהדשבורד בלי הפעלה מחדש) */
  settings?: Settings;
  /** לבדיקות/דמו */
  nowFn?: () => Date;
  fast?: boolean;
}

type ContextInput = Omit<AppContext, 'channels' | 'config' | 'secrets'> & {
  config?: Config;
  secrets?: Secrets;
  channels?: Channel[];
};

export function createContext(p: ContextInput): AppContext {
  if (!p.settings && (!p.config || !p.secrets)) throw new Error('נדרשים settings או config+secrets');
  const ctx = { store: p.store, provider: p.provider, dataDir: p.dataDir, log: p.log, settings: p.settings, nowFn: p.nowFn, fast: p.fast } as AppContext;
  Object.defineProperty(ctx, 'config', { enumerable: true, get: () => (p.settings ? p.settings.config : p.config!) });
  Object.defineProperty(ctx, 'secrets', { enumerable: true, get: () => (p.settings ? p.settings.secrets : p.secrets!) });
  Object.defineProperty(ctx, 'channels', { enumerable: true, get: () => p.channels ?? buildChannels(ctx.config, ctx.secrets) });
  return ctx;
}

export function computeAnalysis(ctx: AppContext): { analysis: Analysis; findings: Finding[] } {
  const { config, store } = ctx;
  const now = ctx.nowFn?.() ?? new Date();
  const today = todayIn(config.timezone, now);
  const since = addDays(today, -120);

  const bankTxnsAll = store.getTxns('bank', since);
  const accounts = config.banks.map((b) => {
    const bal = store.getBalance(b.id);
    if (bal) return { id: b.id, label: b.label, balance: bal.balance, balanceAt: bal.at, alertBelow: b.alertBelow, overdraftLimit: b.overdraftLimit };
    // הבנק לא מחזיר יתרה: משתמשים ביתרה שהמשתמש הזין + תנועות שהתווספו אחריה
    const anchor = store.getAnchor(b.id);
    const derived = anchor ? anchor.amount + bankTxnsAll.filter((t) => t.accountRef === b.id && t.status === 'completed' && t.date > anchor.date).reduce((sum, t) => sum + t.amount, 0) : null;
    return { id: b.id, label: b.label, balance: derived, balanceAt: anchor ? `${anchor.date}T12:00:00Z` : null, alertBelow: b.alertBelow, overdraftLimit: b.overdraftLimit };
  });
  const cardSources = config.cards.map((c) => ({
    id: c.id, label: c.label, fundingAccount: c.fundingAccount, fundingOverrides: c.cardOverrides,
    billingDay: c.billingDay ?? null, chargeMatch: effectiveChargeMatch(c, config.cards) ?? '',
  }));
  const analysis = analyze({
    today, horizonDays: config.horizonDays, accounts,
    bankTxns: bankTxnsAll, cardSources, cardTxns: store.getTxns('card', since),
    recurring: store.listRecurring().filter((r) => accounts.some((a) => a.id === r.accountId)),
  });

  const labels = new Map([...config.banks, ...config.cards].map((s) => [s.id, s.label]));
  const status = store.listSourceStatus().map((s) => ({ ...s, label: labels.get(s.sourceId) ?? s.sourceId }));
  const missing = [...labels.keys()].filter((id) => !status.some((s) => s.sourceId === id));
  const rows = [
    ...status,
    ...missing.map((id) => ({ sourceId: id, label: labels.get(id)!, lastAttemptAt: null, lastSuccessAt: null, lastError: null, lastDurationMs: null })),
  ];
  // כמה כשלונות רצופים אחרונים לכל מקור (לפי יומן הניסיונות)
  const failStreak = new Map<string, number>();
  for (const r of rows) { let n = 0; for (const a of store.recentAttempts(r.sourceId, 8).reverse()) { if (a.ok) break; n++; } failStreak.set(r.sourceId, n); }
  const findings = [...sourceFindings(rows, now, config.scraping.staleAfterHours, 24, failStreak), ...analysis.findings];
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { analysis, findings };
}

let running: Promise<RunSummary> | null = null;
const RUN_TIMEOUT_MIN = 30;

interface RunProgress { startedAt: string; trigger: string; cancel: boolean; items: Record<string, { label: string; state: string; message?: string }> }
let progress: RunProgress | null = null;
export const getProgress = () => (progress ? { startedAt: progress.startedAt, trigger: progress.trigger, canceling: progress.cancel, items: progress.items } : null);
/** ביטול ריצה: ההמתנות נפסקות מיד; איסוף שכבר החל מסתיים (עד כמה דקות) ואז הריצה נעצרת */
export function cancelRun(): boolean {
  if (!progress) return false;
  progress.cancel = true;
  return true;
}

export interface RunSummary {
  ok: boolean;
  sources: SourceResult[];
  findings: number;
  notified: number;
  channels: { sent: string[]; failed: Array<{ name: string; error: string }> };
  resolved: string[];
  filed?: number;
  locked?: boolean;
}

/** הריצה היומית: איסוף -> ניתוח -> התראות. ריצה אחת בכל רגע נתון. */
export function runDaily(ctx: AppContext, trigger: string, opts: RunOpts = {}): Promise<RunSummary> {
  if (running) return running;
  if (ctx.settings?.locked) {
    // נעול בסיסמה: אין גישה לפרטי ההתחברות. לא נרשמת ריצה ולא כשל – מחכים שהמשתמש יפתח בדשבורד
    return Promise.resolve({ ok: true, sources: [], findings: 0, notified: 0, channels: { sent: [], failed: [] }, resolved: [], locked: true } as RunSummary);
  }
  progress = { startedAt: new Date().toISOString(), trigger, cancel: false, items: {} };
  // שומר-ראש: ריצה שנתקעה (דפדפן/רשת/נעילה) לא יכולה להשאיר את המערכת "בודקת עכשיו" לשעות
  const mine = doRun(ctx, trigger, opts);
  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ctx.log(`⚠️ הריצה נתקעה יותר מ-${RUN_TIMEOUT_MIN} דקות ונעצרה (ייתכן שהאתר של הבנק לא הגיב)`); reject(new Error(`הריצה חרגה מ-${RUN_TIMEOUT_MIN} דקות`)); }, RUN_TIMEOUT_MIN * 60_000);
    timer.unref?.();
  });
  mine.catch(() => {});
  const mineRun = Promise.race([mine, watchdog]).finally(() => { clearTimeout(timer); if (running === mineRun) { running = null; progress = null; } });
  running = mineRun;
  return mineRun;
}
export const isRunning = (): boolean => running !== null;

interface RunOpts {
  skipScrape?: boolean;
  /** עוקף את חסימת "סיסמה שגויה" (לחיצה ידנית של המשתמש) */
  force?: boolean;
  /** ריצה ידנית מהירה: בלי השהיות ובלי ניסיונות חוזרים ארוכים – מדווחת כשל מיד */
  quick?: boolean;
  ignoreGap?: boolean;
}

async function doRun(ctx: AppContext, trigger: string, opts: RunOpts): Promise<RunSummary> {
  const { config, store, log } = ctx;
  const nowIso = () => (ctx.nowFn?.() ?? new Date()).toISOString();
  const runId = store.startRun(trigger, nowIso());
  let summary: RunSummary = { ok: false, sources: [], findings: 0, notified: 0, channels: { sent: [], failed: [] }, resolved: [] };
  try {
    const today = todayIn(config.timezone, ctx.nowFn?.() ?? new Date());
    const sources = opts.skipScrape
      ? []
      : await scrapeAll({ config, secrets: ctx.secrets, store, provider: ctx.provider, dataDir: ctx.dataDir, today, log, fast: ctx.fast || opts.quick, force: opts.force, ignoreGap: opts.ignoreGap, attempts: opts.quick ? 1 : undefined,
        progress: (e) => { if (progress) progress.items[e.sourceId] = { label: e.label, state: e.state, message: e.message }; }, shouldCancel: () => !!progress?.cancel });

    const filed = sources.some((x) => x.ok) || opts.skipScrape ? detectAndFile(ctx) : [];
    const { findings } = computeAnalysis(ctx);
    const now = ctx.nowFn?.() ?? new Date();

    // מה לשלוח עכשיו
    const toSend: Array<{ f: Finding; tag?: string }> = [];
    for (const f of findings) {
      const st = store.getAlertState(f.key);
      if (!st || st.resolvedAt) toSend.push({ f });
      else if (st.fingerprint !== f.fingerprint) toSend.push({ f, tag: 'עודכן' });
      else if (!st.lastNotified || (now.getTime() - new Date(st.lastNotified).getTime()) / 3_600_000 >= config.alerts.reminderHours) toSend.push({ f, tag: 'תזכורת' });
      else store.upsertAlert(f, now.toISOString(), false);
    }

    let channelsResult = { sent: [] as string[], failed: [] as Array<{ name: string; error: string }> };
    let notified = 0;
    if (toSend.length) {
      const lines: AlertLine[] = toSend.map(({ f, tag }) => ({ severity: f.severity, title: f.title, body: f.body, tag }));
      const msg = buildAlertMessage(lines, config.dashboard.publicUrl);
      if (ctx.channels.length === 0) {
        log('⚠️ אין ערוץ התראות פעיל. ההתראות מוצגות רק בדשבורד.');
        channelsResult.failed.push({ name: 'none', error: 'אין ערוץ פעיל' });
      } else {
        channelsResult = await dispatch(ctx.channels, msg);
      }
      const delivered = channelsResult.sent.length > 0;
      for (const { f } of toSend) if (delivered) store.upsertAlert(f, now.toISOString(), true);
      if (delivered) notified = toSend.length;
      for (const fl of channelsResult.failed) log(`❌ שליחה נכשלה (${fl.name}): ${fl.error}`);
    } else {
      await maybeSendDigest(ctx, sources, findings.length, filed.length);
    }
    const resolved = store.resolveMissing(findings.map((f) => f.key), now.toISOString());

    summary = { ok: sources.every((s) => s.ok || s.skipped), sources, findings: findings.length, notified, channels: channelsResult, resolved, filed: filed.length };
    store.finishRun(runId, nowIso(), summary.ok, summary);
    await ping(config.healthcheckUrl, summary.ok ? '' : '/fail', log);
    if (!opts.skipScrape) await notifyAfterRun(ctx, { ok: summary.ok, trigger, sources, findings: findings.length }, addDays(today, -120));
    return summary;
  } catch (e) {
    const msg = e instanceof Error ? e.stack ?? e.message : String(e);
    log(`❌ הריצה נכשלה: ${msg}`);
    store.finishRun(runId, nowIso(), false, { error: msg });
    await ping(config.healthcheckUrl, '/fail', log);
    throw e;
  }
}

/** עדכון קבוע (יומי/שבועי) – נשלח גם כשאין שום חשש, כדי שתדע שהמערכת חיה ומה המצב */
async function maybeSendDigest(ctx: AppContext, sources: SourceResult[], openAlerts: number, filed: number): Promise<void> {
  const mode = ctx.config.alerts.okDigest;
  if (mode === 'never' || ctx.channels.length === 0) return;
  const now = ctx.nowFn?.() ?? new Date();
  const today = todayIn(ctx.config.timezone, now);
  const dow = new Intl.DateTimeFormat('en-US', { timeZone: ctx.config.timezone, weekday: 'short' }).format(now);
  if (mode === 'weekly' && dow !== 'Sun') return;
  if (ctx.store.getKv('last_digest') === today) return;
  const { analysis } = computeAnalysis(ctx);
  const accounts = analysis.accounts.filter((x) => x.startBalance !== null).map((a) => ({
    label: a.label, balance: ils(a.startBalance!), min: ils(a.minBalance!), minDate: fmtShort(a.minDate!), low: a.minBalance! < 0,
  }));
  const upcoming = analysis.accounts
    .flatMap((a) => a.events.filter((e) => e.amount < 0 && e.date <= addDays(today, 14)).map((e) => ({ a, e })))
    .sort((x, y) => (x.e.date < y.e.date ? -1 : 1))
    .slice(0, 6)
    .map(({ a, e }) => ({ date: fmtShort(e.date), account: a.label, name: e.name, amount: ils(e.amount), after: e.balanceAfter !== undefined ? ils(e.balanceAfter) : undefined }));
  const notes: string[] = [];
  if (filed) notes.push(`🔎 זוהו ${filed} הוראות קבועות חדשות מההיסטוריה – כדאי לאשר אותן בדשבורד`);
  if (sources.length) notes.push(`נאספו נתונים מ-${sources.filter((s) => s.ok).length}/${sources.length} מקורות`);
  const digest = {
    ok: !openAlerts,
    headline: openAlerts ? `⚠️ יש ${openAlerts} התראות פתוחות (פרטים בדשבורד)` : `✅ אין חשש למינוס ב-${analysis.horizonDays} הימים הקרובים`,
    accounts, upcoming, notes,
  };
  const res = await dispatch(ctx.channels, buildDigestMessage(digest, ctx.config.dashboard.publicUrl));
  if (res.sent.length) ctx.store.setKv('last_digest', today);
}

async function ping(url: string | undefined, suffix: string, log: (m: string) => void): Promise<void> {
  if (!url) return;
  try { await fetch(url.replace(/\/$/, '') + suffix, { signal: AbortSignal.timeout(10_000) }); }
  catch (e) { log(`healthcheck ping נכשל: ${e instanceof Error ? e.message : e}`); }
}

