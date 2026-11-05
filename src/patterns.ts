import { effectiveChargeMatch } from './config.ts';
import { addDays, todayIn } from './engine/dates.ts';
import { makeMatcher } from './engine/analyze.ts';
import { detectRecurring, ISSUER_LINES, type DetectDiag, type DetectedPattern } from './engine/detect.ts';
import type { AppContext } from './app.ts';

/** ניקוי: הוראות שזוהו אוטומטית בגרסאות קודמות ושהן בעצם חיובי כרטיס אשראי (טרם אושרו). מקומי בלבד – לא נוגע בבנקים. */
export function cleanupIssuerItems(store: AppContext['store']): number {
  let n = 0;
  for (const it of store.listRecurring()) {
    if (it.auto && it.reviewed === false && ISSUER_LINES.test(`${it.name} ${it.match}`) && store.deleteRecurring(it.id!)) n++;
  }
  return n;
}

/**
 * סורק את היסטוריית התנועות בבנק, מזהה הוצאות/הכנסות שחוזרות בקביעות,
 * ושומר אותן כהוראות קבועות (מסומנות "אוטומטי", וממתינות לאישור המשתמש).
 */
export function detectAndFile(ctx: AppContext): DetectedPattern[] {
  const { config, store } = ctx;
  if (!config.recurring.autoDetect) return [];
  const today = todayIn(config.timezone, ctx.nowFn?.() ?? new Date());
  const banks = new Set(config.banks.map((b) => b.id));
  const bankTxns = store.getTxns('bank', addDays(today, -400)).filter((t) => banks.has(t.accountRef));
  if (!bankTxns.length) return [];
  const excludeMatchers = config.cards
    .map((c) => makeMatcher(effectiveChargeMatch(c, config.cards) ?? null))
    .filter((m): m is (s: string) => boolean => m !== null);
  cleanupIssuerItems(store);
  const found = detectRecurring({ today, bankTxns, existing: store.listRecurring(), dismissed: store.getDismissed(), excludeMatchers });
  for (const p of found) {
    store.saveRecurring({
      name: p.name, kind: p.kind, accountId: p.accountId, amount: p.amount, dayOfMonth: p.dayOfMonth, intervalMonths: p.intervalMonths,
      anchorMonth: p.anchorMonth, match: p.match, tolerancePct: p.tolerancePct, graceDays: 4, active: true, startDate: null, endDate: null,
      note: `זוהה אוטומטית (${p.occurrences} חודשים)`, auto: true, autoKey: p.key, reviewed: false,
    });
  }
  if (found.length) ctx.log(`🔎 זוהו ${found.length} הוראות קבועות חדשות מההיסטוריה`);
  return found;
}

export interface DetectionInfo {
  autoDetect: boolean;
  accounts: Array<{ id: string; label: string; txnCount: number; oldest: string | null; newest: string | null; historyDays: number }>;
  /** קבוצות שכמעט זוהו, ולמה לא */
  nearMisses: DetectDiag[];
  /** האם חסרה היסטוריה כדי לזהות (פחות מ-100 ימים באחד החשבונות) */
  needsHistory: boolean;
}

/** הסבר למשתמש: כמה היסטוריה יש לכל חשבון, ולמה דפוסים מסוימים לא זוהו */
export function explainDetection(ctx: AppContext): DetectionInfo {
  const { config, store } = ctx;
  const today = todayIn(config.timezone, ctx.nowFn?.() ?? new Date());
  const all = store.getTxns('bank', addDays(today, -400));
  const accounts = config.banks.map((b) => {
    const mine = all.filter((t) => t.accountRef === b.id).map((t) => t.date).sort();
    const oldest = mine[0] ?? null;
    return { id: b.id, label: b.label, txnCount: mine.length, oldest, newest: mine.at(-1) ?? null, historyDays: oldest ? Math.round((Date.parse(today) - Date.parse(oldest)) / 86_400_000) : 0 };
  });
  const excludeMatchers = config.cards
    .map((c) => makeMatcher(effectiveChargeMatch(c, config.cards) ?? null))
    .filter((m): m is (s: string) => boolean => m !== null);
  const diag: DetectDiag[] = [];
  detectRecurring({ today, bankTxns: all.filter((t) => config.banks.some((b) => b.id === t.accountRef)), existing: store.listRecurring(), dismissed: store.getDismissed(), excludeMatchers, diag });
  const nearMisses = diag.filter((d) => d.reason !== 'כבר מוגדר כהוראה קבועה').sort((a, b) => b.occurrences - a.occurrences || b.amount - a.amount).slice(0, 12);
  return { autoDetect: config.recurring.autoDetect, accounts, nearMisses, needsHistory: accounts.some((a) => a.txnCount > 0 && a.historyDays < 100) };
}
