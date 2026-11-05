import type { ISODate, RecurringItem, Txn } from '../types.ts';
import { monthIndex, ymFromIndex, ymOf } from './dates.ts';
import { makeMatcher } from './analyze.ts';

export interface DetectedPattern {
  /** מפתח יציב לזיהוי הדפוס (לשם "אל תציע שוב") */
  key: string;
  name: string;
  kind: 'expense' | 'income';
  accountId: string;
  amount: number;
  dayOfMonth: number;
  intervalMonths: number;
  anchorMonth: string | null;
  match: string;
  tolerancePct: number;
  occurrences: number;
  lastDate: ISODate;
}

const STOP = new Set(['הוראת', 'קבע', 'העברה', 'העברת', 'זיכוי', 'חיוב', 'בעמ', 'חשבון', 'תשלום', 'עבור', 'של', 'אל', 'מאת', 'bank', 'transfer', 'payment', 'ltd']);
const CASH = /משיכת מזומן|כספומט|\batm\b|מזומן/i;

/** שורות חיוב של חברות אשראי – נכללות כבר בתחזית דרך הכרטיסים המחוברים, לכן אף פעם לא "הוראה קבועה" */
export const ISSUER_LINES = /ישראכרט|isracard|דיינרס|דינרס|diners|מקס\s*איט|(?<![\p{L}])(?:max|מקס)(?![\p{L}])|כאל|כרטיסי אשראי לישראל|(?<![\p{L}])cal(?![\p{L}])|ויזה|visa|אמריקן|אמקס|amex|american express|לאומי ?קארד|leumi ?card|כרטיס אשראי|כרטיסי אשראי|בהצדעה|ביחד בשבילך/iu;

/** מילות מפתח של שורה: מהתיאור, ואם הוא כללי בלבד ("הוראת קבע") – מהערה/מוטב */
export function lineTokens(t: { description: string; memo: string }): string[] {
  const d = normalizeTokens(t.description);
  return d.length ? d : normalizeTokens(t.memo ?? '');
}
const lineLabel = (t: { description: string; memo: string }) =>
  (normalizeTokens(t.description).length ? t.description : `${t.description} ${t.memo ?? ''}`).trim().replace(/\s+/g, ' ');

export function normalizeTokens(desc: string): string[] {
  const clean = desc
    .replace(/[‎‏‪-‮]/g, '')
    .replace(/["'״׳`]/g, '')
    .replace(/[0-9]+/g, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .toLowerCase();
  return clean.split(/\s+/).filter((t) => t.length >= 2 && !STOP.has(t)).slice(0, 3);
}

const INCOME_RULE = 'הכנסה: נדרשים 3 חודשים רצופים באותו סכום בערך (עד 10% הפרש)';
const dayOf = (d: ISODate) => Number(d.slice(8, 10));
const circ = (a: number, b: number) => { const x = Math.abs(a - b); return Math.min(x, 30 - x); };
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface DetectDiag {
  key: string;
  name: string;
  accountId: string;
  kind: 'expense' | 'income';
  occurrences: number;
  amount: number;
  /** למה הקבוצה לא הוכרה כדפוס חוזר (בעברית, למשתמש) */
  reason: string;
  /** נתונים להוספה ידנית כהוראה קבועה (המשתמש יכול לאשר את ההצעה בכל זאת) */
  day: number;
  match: string;
  months: number;
  /** המקסימום של הופעות בחודש אחד */
  perMonth: number;
}

export interface DetectInput {
  today: ISODate;
  bankTxns: Txn[];
  existing: RecurringItem[];
  dismissed: Set<string>;
  /** שורות שלא לנתח (חיובי כרטיסי אשראי) */
  excludeMatchers: Array<(s: string) => boolean>;
  /** אם מועבר – נאספים בו הסברים על קבוצות שכמעט זוהו */
  diag?: DetectDiag[];
}

interface Group { acc: string; sign: number; txns: Txn[] }

/** מפצל רשימה (ממוינת לפי ערך) לקבוצות; `split(prev, cur)` קובע היכן עוצרים */
function clusterBy<T>(items: T[], value: (x: T) => number, split: (prev: number, cur: number) => boolean): T[][] {
  const sorted = [...items].sort((a, b) => value(a) - value(b));
  const out: T[][] = [];
  let cur: T[] = [];
  for (const it of sorted) {
    if (cur.length && split(value(cur[cur.length - 1]!), value(it))) { out.push(cur); cur = []; }
    cur.push(it);
  }
  if (cur.length) out.push(cur);
  return out;
}

interface EvalResult { pattern?: DetectedPattern; reason?: string; /** נכשל כי מופיע כמה פעמים בחודש – אפשר לנסות לפצל לפי סכום/יום */ splittable?: boolean }

/** מזהה הכנסות/הוצאות שחוזרות באופן קבוע בתנועות הבנק (חודשי / דו-חודשי / רבעוני) */
export function detectRecurring(input: DetectInput): DetectedPattern[] {
  const nowIdx = monthIndex(ymOf(input.today));
  const groups = new Map<string, Group>();
  for (const t of input.bankTxns) {
    if (t.status !== 'completed' || Math.abs(t.amount) < 20) continue;
    const text = `${t.description} ${t.memo}`;
    if (CASH.test(text) || ISSUER_LINES.test(text) || input.excludeMatchers.some((m) => m(text))) continue;
    const toks = lineTokens(t);
    if (!toks.length) continue;
    const sign = t.amount < 0 ? -1 : 1;
    const key = `${t.accountRef}|${sign < 0 ? 'expense' : 'income'}|${toks.join(' ')}`;
    const g = groups.get(key) ?? { acc: t.accountRef, sign, txns: [] };
    g.txns.push(t);
    groups.set(key, g);
  }

  const rejectDiag = (key: string, g: Group, txns: Txn[], reason: string, suffix = '') => {
    if (!input.diag || txns.length < 2 || input.dismissed.has(key) || g.sign > 0) return; // הכנסות שלא עומדות בכלל הרצף לא מוצעות בכלל
    const last = txns.reduce((a, b) => (a.date >= b.date ? a : b));
    const perMonthMap = new Map<number, number>();
    for (const t of txns) { const i = monthIndex(ymOf(t.date)); perMonthMap.set(i, (perMonthMap.get(i) ?? 0) + 1); }
    input.diag.push({
      key, name: `${lineLabel(last)}`.slice(0, 40) + suffix, accountId: g.acc, kind: g.sign < 0 ? 'expense' : 'income', occurrences: txns.length,
      amount: Math.round(median(txns.map((t) => Math.abs(t.amount)))), reason,
      day: Math.round(median(txns.map((t) => dayOf(t.date)))), match: lineTokens(last).slice(0, 2).map(esc).join('.*'),
      months: perMonthMap.size, perMonth: Math.max(...perMonthMap.values()),
    });
  };

  /** בדיקת קבוצה אחת מול כל הכללים */
  const evaluate = (txns: Txn[], key: string, g: Group, nameSuffix: string): EvalResult => {
    // תנועה אחת לחודש (אם יש כמה – בוחרים את הקרובה ליום החציוני; אם זה קורה ביותר מחודש אחד, זה לא דפוס חודשי)
    const byMonth = new Map<number, Txn[]>();
    for (const t of txns) { const i = monthIndex(ymOf(t.date)); byMonth.set(i, [...(byMonth.get(i) ?? []), t]); }
    if ([...byMonth.values()].filter((v) => v.length > 1).length >= 2) return { reason: 'מופיע כמה פעמים באותו חודש (לא דפוס חודשי)', splittable: true };
    const medDay = median(txns.map((t) => dayOf(t.date)));
    let months = [...byMonth.keys()].sort((a, b) => a - b);
    if (months.length < 3) return { reason: `הופיע ב-${months.length} חודשים בלבד (נדרשים 3 לפחות)` };
    let chosen = months.map((i) => byMonth.get(i)!.reduce((best, t) => (circ(dayOf(t.date), medDay) < circ(dayOf(best.date), medDay) ? t : best)));
    if (g.sign > 0) {
      // הכנסה: כסף שנכנס מאנשים הוא בדרך כלל חד-פעמי. דפוס = לפחות 3 חודשים רצופים (עד היום) באותו סכום בערך (עד 10% הפרש)
      const run: Txn[] = [chosen[chosen.length - 1]!];
      const runMonths: number[] = [months[months.length - 1]!];
      for (let k = chosen.length - 2; k >= 0; k--) {
        if (runMonths[0]! - months[k]! !== 1) break;
        const cand = [chosen[k]!, ...run].map((t) => Math.abs(t.amount));
        const med = median(cand);
        if (cand.some((a) => Math.abs(a - med) > 0.1 * med)) break;
        run.unshift(chosen[k]!); runMonths.unshift(months[k]!);
      }
      if (run.length < 3) return { reason: INCOME_RULE };
      chosen = run; months = runMonths;
    }

    const diffs = months.slice(1).map((m, i) => m - months[i]!);
    let interval = 0;
    for (const d of [1, 2, 3]) if (diffs.every((x) => x === d)) { interval = d; break; }
    if (!interval && diffs.filter((x) => x === 2).length <= 1 && diffs.every((x) => x === 1 || x === 2)) interval = 1; // חודש שדילג
    if (!interval) return { reason: 'מרווח לא סדיר בין ההופעות' };
    const lastIdx = months.at(-1)!;
    if (nowIdx - lastIdx > interval) return { reason: 'נראה שהפסיק (לא הופיע לאחרונה)' };

    const days = chosen.map((t) => dayOf(t.date));
    const day = Math.round(median(days));
    if (days.some((d) => circ(d, day) > 4)) return { reason: 'היום בחודש משתנה (יותר מ-4 ימים)' };

    const amts = chosen.map((t) => Math.abs(t.amount));
    const mean = amts.reduce((a, b) => a + b, 0) / amts.length;
    const cv = Math.sqrt(amts.reduce((a, b) => a + (b - mean) ** 2, 0) / amts.length) / mean;
    if (cv > 0.7) return { reason: 'הסכום משתנה מאוד' };
    const tol = g.sign > 0 ? 10 : cv <= 0.12 ? 10 : cv <= 0.35 ? 40 : 80;
    const amount = Math.round(median(amts) * 100) / 100;

    const kind = g.sign < 0 ? 'expense' : 'income';
    const sample = chosen.at(-1)!;
    const toks = lineTokens(sample);
    const match = toks.slice(0, 2).map(esc).join('.*');
    const dup = input.existing.some((it) => {
      if (it.accountId !== g.acc || it.kind !== kind) return false;
      const m = makeMatcher(it.match);
      return (m && m(sample.description) && Math.abs(it.amount - amount) <= 0.2 * amount) || (Math.abs(it.amount - amount) <= 0.2 * amount && circ(it.dayOfMonth, day) <= 5);
    });
    if (dup) return { reason: 'כבר מוגדר כהוראה קבועה' };

    const names = new Map<string, number>();
    for (const t of chosen) names.set(lineLabel(t), (names.get(lineLabel(t)) ?? 0) + 1);
    const name = `${[...names.entries()].sort((a, b) => b[1] - a[1])[0]![0].slice(0, 40)}${nameSuffix}`;
    return {
      pattern: { key, name, kind, accountId: g.acc, amount, dayOfMonth: day, intervalMonths: interval, anchorMonth: interval > 1 ? ymFromIndex(lastIdx) : null, match, tolerancePct: tol, occurrences: chosen.length, lastDate: sample.date },
    };
  };

  const out: DetectedPattern[] = [];
  for (const [key, g] of groups) {
    if (input.dismissed.has(key)) continue;
    const whole = evaluate(g.txns, key, g, '');
    if (whole.pattern) { out.push(whole.pattern); continue; }
    if (!whole.splittable) { rejectDiag(key, g, g.txns, whole.reason!); continue; }

    // מופיע כמה פעמים בחודש: מפצלים לפי סכום (למשל העברה קבועה של 5,500 בין העברות אחרות), ואז לפי יום בחודש
    let found = false;
    const leaves: Array<{ txns: Txn[]; key: string; suffix: string; reason: string }> = [];
    const tryPart = (txns: Txn[], subKey: string, suffix: string, allowDaySplit: boolean) => {
      if (txns.length < 3 || input.dismissed.has(subKey)) return;
      const r = evaluate(txns, subKey, g, suffix);
      if (r.pattern) { out.push(r.pattern); found = true; return; }
      if (r.splittable && allowDaySplit) {
        for (const dc of clusterBy(txns, (t) => dayOf(t.date), (p, c) => c - p > 5)) {
          const d = Math.round(median(dc.map((t) => dayOf(t.date))));
          tryPart(dc, `${subKey}|d${d}`, `${suffix} (בערך ב-${d} לחודש)`, false);
        }
        return;
      }
      leaves.push({ txns, key: subKey, suffix, reason: r.reason ?? 'לא זוהה דפוס' });
    };
    for (const ac of clusterBy(g.txns, (t) => Math.abs(t.amount), (p, c) => c > p * 1.08)) {
      const amt = Math.round(median(ac.map((t) => Math.abs(t.amount))));
      tryPart(ac, `${key}|~${amt}`, ` (כ-₪${amt.toLocaleString('en-US')})`, true);
    }
    // מה שלא זוהה – מוצג למשתמש לפי תת-קבוצה (עם אפשרות להוסיף ידנית או להתעלם)
    for (const l of leaves) rejectDiag(l.key, g, l.txns, l.reason, l.suffix);
    if (!found && !leaves.length) rejectDiag(key, g, g.txns, whole.reason!);
  }
  return out.sort((a, b) => b.occurrences - a.occurrences || b.amount - a.amount);
}
