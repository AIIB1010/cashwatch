import path from 'node:path';
import type { Config } from '../config.ts';
import type { Secrets } from '../config.ts';
import { addDays, localDate } from '../engine/dates.ts';
import type { Store } from '../db.ts';
import { withBrowserLock } from './lock.ts';
import { NO_RETRY_ERRORS, type ScrapeOutcome, type ScrapeProvider } from './types.ts';

export interface SourceResult {
  sourceId: string;
  ok: boolean;
  /** דולג בכוונה (למשל סיסמה שגויה שעדיין לא תוקנה) */
  skipped?: boolean;
  attempts: number;
  error?: string;
  txnCount?: number;
  durationMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

function withTimeout<T>(p: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => { t = setTimeout(() => { onTimeout?.(); rej(new Error(`TIMEOUT: ${label} חרג מ-${Math.round(ms / 1000)} שניות`)); }, ms); }),
  ]);
}

export interface RunnerDeps {
  config: Config;
  secrets: Secrets;
  store: Store;
  provider: ScrapeProvider;
  dataDir: string;
  today: string;
  log: (msg: string) => void;
  /** לבדיקות: מדלג על השהיות */
  fast?: boolean;
  /** לאסוף רק את המקורות האלה (למשל מהכפתור "בדוק חיבור") */
  only?: string[];
  /** דיווח התקדמות לממשק */
  progress?: (e: { sourceId: string; label: string; state: 'waiting' | 'running' | 'retry-wait' | 'done' | 'failed' | 'skipped'; message?: string }) => void;
  /** ביטול ע"י המשתמש */
  shouldCancel?: () => boolean;
  /** מושך את ההיסטוריה הארוכה (historyDays) גם אם כבר נאסף בעבר */
  forceHistory?: boolean;
  /** עוקף את הרווח המינימלי של 20 דקות (בדיקת חיבור ידנית) */
  ignoreGap?: boolean;
  /** מנסים שוב רק במקרה של קונפליקט התחברות (בבדיקה ידנית: כדי לא לתקוע את המשתמש על שגיאות אחרות) */
  retryOnlyConflicts?: boolean;
  /** כמה שניות לחכות בין ניסיונות כשיש קונפליקט התחברות (ברירת מחדל 5 דקות) */
  conflictWaitSeconds?: number;
  /** בדיקה ידנית: ממשיכים גם למקור שנחסם עקב פרטי התחברות שגויים */
  force?: boolean;
  /** עקיפת מספר הניסיונות (בבדיקה ידנית מנסים פעם אחת) */
  attempts?: number;
}

/** מושך נתונים מכל המקורות. כשל במקור אחד לא עוצר את האחרים. */
export function scrapeAll(deps: RunnerDeps): Promise<SourceResult[]> {
  return withBrowserLock(() => scrapeAllLocked(deps));
}

async function scrapeAllLocked(deps: RunnerDeps): Promise<SourceResult[]> {
  const { config, store, log } = deps;
  const all = [
    ...config.banks.map((b) => ({ kind: 'bank' as const, id: b.id, provider: b.provider, label: b.label })),
    ...config.cards.map((c) => ({ kind: 'card' as const, id: c.id, provider: c.provider, label: c.label })),
  ];
  const sources = deps.only ? all.filter((x) => deps.only!.includes(x.id)) : all;
  const maxAttempts = deps.attempts ?? config.scraping.attempts;
  const results: SourceResult[] = [];
  const cancelled = () => !!deps.shouldCancel?.();
  /** המתנה שאפשר לבטל, עם דיווח זמן שנותר */
  const wait = async (src: { id: string; label: string }, seconds: number, why: string) => {
    for (let left = Math.round(seconds); left > 0 && !cancelled(); left--) {
      if (left % 10 === 0 || left === Math.round(seconds)) deps.progress?.({ sourceId: src.id, label: src.label, state: 'retry-wait', message: `${why} – ממתין עוד ${left >= 60 ? `${Math.ceil(left / 60)} דק׳` : `${left} שנ׳`}` });
      await sleep(1000);
    }
  };

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i]!;
    if (cancelled()) {
      results.push({ sourceId: src.id, ok: false, skipped: true, attempts: 0, error: 'בוטל', durationMs: 0 });
      deps.progress?.({ sourceId: src.id, label: src.label, state: 'skipped', message: 'בוטל' });
      continue;
    }
    // הגנה מנעילת חשבון: מקור שנכשל בגלל סיסמה/חסימה לא נבדק שוב עד שהמשתמש מתקן את הפרטים
    const prev = store.listSourceStatus().find((x) => x.sourceId === src.id);
    if (!deps.force && prev?.lastError && /^(INVALID_PASSWORD|CHANGE_PASSWORD|ACCOUNT_BLOCKED)/.test(prev.lastError)) {
      log(`[${src.id}] מדלג: ${prev.lastError.split('\n')[0]} (יש לעדכן פרטי התחברות בהגדרות)`);
      deps.progress?.({ sourceId: src.id, label: src.label, state: 'skipped', message: 'ממתין לתיקון פרטי התחברות' });
      results.push({ sourceId: src.id, ok: false, skipped: true, attempts: 0, error: prev.lastError, durationMs: 0 });
      continue;
    }
    // לא מתחברים שוב לאותו מקור תוך זמן קצר מהצלחה: בנקים מנתקים התחברות ישנה כשמתחברים פעמיים
    const MIN_GAP_MS = 20 * 60_000;
    if (!deps.ignoreGap && prev?.lastSuccessAt && !prev.lastError && Date.now() - new Date(prev.lastSuccessAt).getTime() < MIN_GAP_MS) {
      const mins = Math.round((Date.now() - new Date(prev.lastSuccessAt).getTime()) / 60000);
      log(`[${src.id}] נאסף לפני פחות מ-20 דקות – מדלג כדי לא להתנגש בהתחברות קודמת`);
      deps.progress?.({ sourceId: src.id, label: src.label, state: 'skipped', message: `נאסף לפני ${mins} דק׳ – הנתונים עדכניים` });
      results.push({ sourceId: src.id, ok: true, skipped: true, attempts: 0, txnCount: 0, durationMs: 0 });
      continue;
    }
    if (i > 0 && !deps.fast) await wait(src, rand(...config.scraping.staggerSeconds), 'השהיה קצרה בין בנקים');
    const started = Date.now();
    store.markAttempt(src.id, new Date().toISOString());
    const creds = deps.secrets.sources[src.id];
    if (!creds) {
      const msg = `חסרים פרטי התחברות ב-secrets.yaml עבור "${src.id}"`;
      store.markFailure(src.id, new Date().toISOString(), msg, 0);
      results.push({ sourceId: src.id, ok: false, attempts: 0, error: msg, durationMs: 0 });
      continue;
    }

    // סריקה ראשונה של מקור: מושכים היסטוריה ארוכה (לזיהוי דפוסים חוזרים). אחר כך – רק חלון קצר.
    // (הסימון נשמר רק אחרי שאיסוף ארוך הצליח; מקורות שנאספו בגרסאות ישנות עם חלון קצר יקבלו היסטוריה פעם אחת)
    const needLong = deps.forceHistory || !store.getKv(`history_ok:${src.id}`);
    const startDate = new Date(`${addDays(deps.today, -(needLong ? config.scraping.historyDays : config.scraping.fetchDaysBack))}T00:00:00Z`);
    let outcome: ScrapeOutcome = { ok: false, errorType: 'GENERIC', errorMessage: 'לא בוצע ניסיון' };
    let attempts = 0;
    for (let a = 1; a <= maxAttempts; a++) {
      attempts = a;
      log(`[${src.id}] מושך נתונים (ניסיון ${a}/${maxAttempts})…`);
      deps.progress?.({ sourceId: src.id, label: src.label, state: 'running', message: `מתחבר ומושך נתונים (ניסיון ${a}/${maxAttempts})` });
      try {
        const ac = new AbortController();
        outcome = await withTimeout(
          deps.provider.scrape({
            signal: ac.signal,
            sourceId: src.id, provider: src.provider, kind: src.kind, credentials: creds, startDate,
            futureMonths: config.scraping.futureMonths, timeZone: config.timezone,
            timeoutMs: config.scraping.attemptTimeoutSeconds * 1000,
            failureScreenshotDir: path.join(deps.dataDir, 'failures'),
            profileDir: path.join(deps.dataDir, 'browser-profiles', src.id),
          }),
          config.scraping.attemptTimeoutSeconds * 1000 + Math.min(15_000, config.scraping.attemptTimeoutSeconds * 100),
          src.id,
          () => ac.abort(),
        );
      } catch (e) {
        outcome = { ok: false, errorType: 'TIMEOUT', errorMessage: e instanceof Error ? e.message : String(e) };
      }
      store.logAttempt(src.id, new Date().toISOString(), outcome.ok, outcome.ok ? null : outcome.errorType, Date.now() - started);
      if (outcome.ok || NO_RETRY_ERRORS.has(outcome.errorType) || (deps.retryOnlyConflicts && outcome.errorType !== 'SESSION_CONFLICT')) break;
      log(`[${src.id}] נכשל: ${outcome.errorType} – ${outcome.errorMessage}`);
      const conflict = outcome.errorType === 'SESSION_CONFLICT';
      if (cancelled()) break;
      if (a < maxAttempts && !deps.fast) await wait(src, conflict ? (deps.conflictWaitSeconds ?? 300) : config.scraping.retryDelaySeconds * a, conflict ? 'הבנק עוד רואה התחברות פתוחה' : 'ניסיון נוסף');
    }

    const dur = Date.now() - started;
    const nowIso = new Date().toISOString();
    if (!outcome.ok) {
      const msg = `${outcome.errorType}: ${outcome.errorMessage}`;
      store.markFailure(src.id, nowIso, msg, dur);
      deps.progress?.({ sourceId: src.id, label: src.label, state: 'failed', message: msg.split('\n')[0] });
      results.push({ sourceId: src.id, ok: false, attempts, error: msg, durationMs: dur });
      continue;
    }

    try {
      const since = localDate(startDate.toISOString(), config.timezone);
      let accounts = outcome.accounts;
      let txnCount = 0;
      if (src.kind === 'bank') {
        const bank = config.banks.find((b) => b.id === src.id)!;
        const pick =
          (bank.accountNumber ? accounts.find((a) => a.accountNumber.includes(bank.accountNumber!) || bank.accountNumber!.includes(a.accountNumber)) : undefined) ??
          accounts.find((a) => a.balance !== undefined) ?? accounts[0];
        if (!pick) throw new Error('לא נמצא חשבון בתשובה מהבנק');
        if (accounts.length > 1 && !bank.accountNumber) log(`[${src.id}] אזהרה: נמצאו ${accounts.length} חשבונות; נבחר ${pick.accountNumber}. הגדר accountNumber כדי לבחור ידנית.`);
        accounts = [pick];
        if (pick.balance !== undefined) store.setBalance(src.id, bank.label, pick.balance, nowIso);
        else log(`[${src.id}] אזהרה: הבנק לא החזיר יתרה – אי אפשר לחשב תחזית.`);
      }
      const all = accounts.flatMap((a) => a.txns.map((t) => (src.kind === 'bank' ? { ...t, accountRef: src.id } : t)));
      // הגנה: אם פתאום חזר ריק למרות שיש היסטוריה – כנראה כשל שקט, לא מוחקים
      if (all.length === 0 && store.countTxnsSince(src.id, since) > 5) {
        throw new Error('האתר החזיר 0 תנועות למרות שיש היסטוריה – התעלמתי כדי לא למחוק נתונים (כנראה כשל שקט)');
      }
      txnCount = store.replaceTxns(src.id, src.kind, since, all);
      store.markSuccess(src.id, nowIso, dur);
      if (needLong) store.setKv(`history_ok:${src.id}`, nowIso);
      results.push({ sourceId: src.id, ok: true, attempts, txnCount, durationMs: dur });
      log(`[${src.id}] הצליח: ${txnCount} תנועות`);
      deps.progress?.({ sourceId: src.id, label: src.label, state: 'done', message: `${txnCount} תנועות` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      store.markFailure(src.id, nowIso, msg, dur);
      results.push({ sourceId: src.id, ok: false, attempts, error: msg, durationMs: dur });
    }
  }
  return results;
}
