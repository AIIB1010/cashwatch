import type {
  Analysis,
  AccountForecast,
  BankAccountState,
  CardCharge,
  CardSourceConfig,
  Finding,
  ForecastEvent,
  ISODate,
  Occurrence,
  RecurringItem,
  Txn,
} from '../types.ts';
import {
  addDays,
  dateInMonth,
  daysBetween,
  fmtShort,
  ils,
  monthIndex,
  nextDayOfMonthAfter,
  ymFromIndex,
  ymOf,
} from './dates.ts';
import { withHint } from '../scrape/types.ts';

export interface AnalyzeInput {
  today: ISODate;
  horizonDays: number;
  accounts: BankAccountState[];
  bankTxns: Txn[];
  cardSources: CardSourceConfig[];
  cardTxns: Txn[];
  recurring: RecurringItem[];
  /** כמה ימים אחורה בודקים אם דבר צפוי באמת קרה */
  lookbackDays?: number;
}

const DEFAULT_LOOKBACK = 14;
const CARD_LOOKBACK = 12;
const CARD_GRACE = 3;

export function makeMatcher(pattern: string | null | undefined): ((s: string) => boolean) | null {
  if (!pattern || !pattern.trim()) return null;
  try {
    const re = new RegExp(pattern, 'i');
    return (s) => re.test(s);
  } catch {
    const p = pattern.toLowerCase();
    return (s) => s.toLowerCase().includes(p);
  }
}

/** כל תאריכי המופע של הוראה קבועה בטווח [from, to] */
export function occurrenceDates(item: RecurringItem, from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  const first = monthIndex(ymOf(from)) - 1;
  const last = monthIndex(ymOf(to)) + 1;
  const interval = Math.max(1, item.intervalMonths || 1);
  const anchor = monthIndex(item.anchorMonth ?? ymOf(item.startDate ?? from));
  for (let idx = first; idx <= last; idx++) {
    if (interval > 1 && (((idx - anchor) % interval) + interval) % interval !== 0) continue;
    const d = dateInMonth(ymFromIndex(idx), item.dayOfMonth);
    if (d < from || d > to) continue;
    if (item.startDate && d < item.startDate) continue;
    if (item.endDate && d > item.endDate) continue;
    out.push(d);
  }
  return out;
}

function signOk(kind: 'expense' | 'income', amount: number): boolean {
  return kind === 'expense' ? amount < 0 : amount > 0;
}

export function reconcileRecurring(
  items: RecurringItem[],
  bankTxns: Txn[],
  today: ISODate,
  horizonEnd: ISODate,
  lookbackDays: number,
  used: Set<string>,
): Occurrence[] {
  const from = addDays(today, -lookbackDays);
  const all: Array<{ item: RecurringItem; date: ISODate }> = [];
  for (const item of items) {
    if (!item.active) continue;
    for (const date of occurrenceDates(item, from, horizonEnd)) all.push({ item, date });
  }
  all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.item.id - b.item.id));

  const byAccount = new Map<string, Txn[]>();
  for (const t of bankTxns) {
    const arr = byAccount.get(t.accountRef) ?? [];
    arr.push(t);
    byAccount.set(t.accountRef, arr);
  }

  const out: Occurrence[] = [];
  for (const { item, date } of all) {
    const matcher = makeMatcher(item.match);
    const lo = addDays(date, -3);
    const hi = today;
    const tol = (item.amount * item.tolerancePct) / 100;
    let best: Txn | undefined;
    let bestScore = Infinity;
    for (const t of byAccount.get(item.accountId) ?? []) {
      if (used.has(t.id) || t.date < lo || t.date > hi) continue;
      if (!signOk(item.kind, t.amount)) continue;
      if (Math.abs(Math.abs(t.amount) - item.amount) > tol + 0.5) continue;
      if (matcher && !matcher(`${t.description} ${t.memo}`)) continue;
      const score = Math.abs(daysBetween(date, t.date)) * 1000 + Math.abs(Math.abs(t.amount) - item.amount);
      if (score < bestScore) {
        best = t;
        bestScore = score;
      }
    }
    let state: Occurrence['state'];
    if (best) {
      used.add(best.id);
      state = 'matched';
    } else if (date > today) state = 'upcoming';
    else if (today <= addDays(date, item.graceDays)) state = 'due';
    else state = 'missing';
    out.push({
      itemId: item.id,
      name: item.name,
      kind: item.kind,
      accountId: item.accountId,
      date,
      amount: item.amount,
      state,
      matchedTxnId: best?.id,
      matchedAmount: best ? Math.abs(best.amount) : undefined,
    });
  }
  return out;
}

function modeDay(dates: ISODate[]): number | null {
  if (!dates.length) return null;
  const counts = new Map<number, number>();
  for (const d of dates) counts.set(Number(d.slice(8, 10)), (counts.get(Number(d.slice(8, 10))) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
}

export function buildCardCharges(
  today: ISODate,
  cardSources: CardSourceConfig[],
  cardTxns: Txn[],
  bankTxns: Txn[],
  used: Set<string>,
): CardCharge[] {
  const out: CardCharge[] = [];
  for (const src of cardSources) {
    const txns = cardTxns.filter((t) => t.sourceId === src.id);
    const completed = txns.filter((t) => t.status === 'completed');
    const billingDay =
      src.billingDay ?? modeDay(completed.map((t) => t.processedDate).filter((d) => d >= addDays(today, -90))) ?? 10;

    interface Group {
      funding: string;
      date: ISODate;
      sum: number;
      count: number;
      estimated: boolean;
    }
    const groups = new Map<string, Group>();
    for (const t of txns) {
      const funding = src.fundingOverrides[t.accountRef] ?? src.fundingAccount;
      let date: ISODate;
      let estimated = false;
      if (t.status === 'completed') {
        date = t.processedDate;
        if (date < addDays(today, -CARD_LOOKBACK)) continue;
      } else {
        // עסקה ממתינה – אין עדיין תאריך חיוב סופי. מניחים את מועד החיוב הקרוב (שמרני).
        date = nextDayOfMonthAfter(today, billingDay);
        estimated = true;
      }
      const key = `${funding}|${date}`;
      const g = groups.get(key) ?? { funding, date, sum: 0, count: 0, estimated: false };
      g.sum += t.amount;
      g.count++;
      g.estimated ||= estimated;
      groups.set(key, g);
    }

    const matcher = makeMatcher(src.chargeMatch);
    for (const g of [...groups.values()].sort((a, b) => (a.date < b.date ? -1 : 1))) {
      if (Math.abs(g.sum) < 1) continue;
      const base = {
        sourceId: src.id,
        label: src.label,
        fundingAccount: g.funding,
        date: g.date,
        amount: Math.round(g.sum * 100) / 100,
        txnCount: g.count,
        estimated: g.estimated,
      };
      if (g.date > today) {
        out.push({ ...base, state: 'upcoming' });
        continue;
      }
      const hi = addDays(g.date, 5) < today ? addDays(g.date, 5) : today;
      const cands = bankTxns.filter(
        (t) =>
          t.accountRef === g.funding &&
          !used.has(t.id) &&
          t.date >= addDays(g.date, -2) &&
          t.date <= hi &&
          Math.sign(t.amount) === Math.sign(g.sum) &&
          (!matcher || matcher(`${t.description} ${t.memo}`)),
      );
      if (!cands.length) {
        out.push({ ...base, state: today <= addDays(g.date, CARD_GRACE) ? 'due' : 'missing' });
        continue;
      }
      const bankSum = cands.reduce((s, t) => s + t.amount, 0);
      cands.forEach((t) => used.add(t.id));
      const close = Math.abs(bankSum - g.sum) <= Math.max(10, Math.abs(g.sum) * 0.015);
      out.push({ ...base, state: close ? 'matched' : 'mismatch', bankAmount: Math.round(bankSum * 100) / 100 });
    }
  }
  return out;
}

function forecastAccount(
  acc: BankAccountState,
  today: ISODate,
  horizonDays: number,
  events: ForecastEvent[],
): AccountForecast {
  const base: AccountForecast = {
    accountId: acc.id,
    label: acc.label,
    startBalance: acc.balance,
    balanceAt: acc.balanceAt,
    alertBelow: acc.alertBelow,
    overdraftLimit: acc.overdraftLimit,
    timeline: [],
    events: events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.amount - b.amount)),
    minBalance: null,
    minDate: null,
    firstBreachDate: null,
    shortfall: 0,
  };
  if (acc.balance === null) return base;

  const byDate = new Map<ISODate, number>();
  for (const e of events) byDate.set(e.date, (byDate.get(e.date) ?? 0) + e.amount);

  let bal = acc.balance;
  let min = bal;
  let minDate: ISODate = today;
  let breach: ISODate | null = bal < acc.alertBelow ? today : null;
  base.timeline.push({ date: today, balance: round2(bal), delta: 0 });
  for (let i = 1; i <= horizonDays; i++) {
    const d = addDays(today, i);
    const delta = byDate.get(d) ?? 0;
    bal += delta;
    base.timeline.push({ date: d, balance: round2(bal), delta: round2(delta) });
    if (bal < min) {
      min = bal;
      minDate = d;
    }
    if (breach === null && bal < acc.alertBelow) breach = d;
  }
  const dayBal = new Map(base.timeline.map((pt) => [pt.date, pt.balance]));
  for (const e of base.events) e.balanceAfter = dayBal.get(e.date);
  base.minBalance = round2(min);
  base.minDate = minDate;
  base.firstBreachDate = breach;
  base.shortfall = breach ? round2(acc.alertBelow - min) : 0;
  return base;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function analyze(input: AnalyzeInput): Analysis {
  const { today, horizonDays } = input;
  const horizonEnd = addDays(today, horizonDays);
  const lookback = input.lookbackDays ?? DEFAULT_LOOKBACK;
  const used = new Set<string>();
  const labelOf = new Map(input.accounts.map((a) => [a.id, a.label]));

  // סדר חשוב: חיובי אשראי קודם (הם "תופסים" שורות בנק), ואז הוראות קבועות
  const cardCharges = buildCardCharges(today, input.cardSources, input.cardTxns, input.bankTxns, used);
  const occurrences = reconcileRecurring(input.recurring, input.bankTxns, today, horizonEnd, lookback, used);

  const tomorrow = addDays(today, 1);
  const eventsByAccount = new Map<string, ForecastEvent[]>();
  const push = (e: ForecastEvent) => {
    const arr = eventsByAccount.get(e.accountId) ?? [];
    arr.push(e);
    eventsByAccount.set(e.accountId, arr);
  };

  for (const o of occurrences) {
    if (o.state === 'matched') continue;
    const sign = o.kind === 'expense' ? -1 : 1;
    if (o.state === 'upcoming') {
      if (o.date <= horizonEnd)
        push({ date: o.date, accountId: o.accountId, type: o.kind === 'expense' ? 'recurring-expense' : 'recurring-income', name: o.name, amount: sign * o.amount, certainty: 'scheduled', ref: `r${o.itemId}` });
    } else if (o.kind === 'expense') {
      // עוד לא ירד – מניחים שירד מחר (שמרני)
      push({ date: tomorrow, accountId: o.accountId, type: 'recurring-expense', name: `${o.name} (טרם ירד)`, amount: -o.amount, certainty: 'assumed', ref: `r${o.itemId}` });
    }
    // הכנסה שלא נכנסה – לא סופרים אותה (שמרני) וגם תופיע התראה
  }
  for (const c of input.cardSources.length ? cardCharges : []) {
    if (c.state === 'upcoming') {
      if (c.date <= horizonEnd)
        push({ date: c.date, accountId: c.fundingAccount, type: 'card-charge', name: `חיוב ${c.label}${c.estimated ? ' (כולל עסקאות ממתינות)' : ''}`, amount: c.amount, certainty: c.estimated ? 'estimated' : 'scheduled', ref: c.sourceId });
    } else if (c.state === 'due' || c.state === 'missing') {
      push({ date: tomorrow, accountId: c.fundingAccount, type: 'card-charge', name: `חיוב ${c.label} (טרם ירד)`, amount: c.amount, certainty: 'assumed', ref: c.sourceId });
    }
  }

  const accounts = input.accounts.map((a) => forecastAccount(a, today, horizonDays, eventsByAccount.get(a.id) ?? []));

  const findings: Finding[] = [];
  for (const f of accounts) {
    if (f.startBalance === null) {
      findings.push({
        key: `no-balance:${f.accountId}`,
        kind: 'no-balance',
        severity: 'warning',
        title: `${f.label}: אין נתוני יתרה`,
        body: 'הבנק לא החזיר יתרה, ולכן אי אפשר לחשב תחזית. הזן את היתרה הנוכחית בלוח הבקרה, בכרטיס החשבון (פעם אחת; אחר כך היא תתעדכן לבד לפי התנועות).',
        fingerprint: 'no-balance',
      });
      continue;
    }
    if (f.firstBreachDate) {
      const daysTo = daysBetween(today, f.firstBreachDate);
      const already = daysTo === 0;
      const lines: string[] = [];
      lines.push(`יתרה נוכחית: ${ils(f.startBalance)}`);
      lines.push(already ? `החשבון כבר מתחת לסף (${ils(f.alertBelow)}).` : `צפוי לרדת מתחת ל-${ils(f.alertBelow)} בתאריך ${fmtShort(f.firstBreachDate)} (בעוד ${daysTo} ימים).`);
      lines.push(`נקודת שפל צפויה: ${ils(f.minBalance!)} ב-${fmtShort(f.minDate!)}.`);
      lines.push(`כדי להישאר מעל הסף צריך להפקיד לפחות ${ils(f.shortfall)}.`);
      const drivers = f.events
        .filter((e) => e.date <= f.minDate! && e.amount < 0)
        .sort((a, b) => a.amount - b.amount)
        .slice(0, 5);
      if (drivers.length) {
        lines.push('החיובים הגדולים עד אז:');
        for (const e of drivers) lines.push(`• ${fmtShort(e.date)} ${e.name}: ${ils(e.amount)}`);
      }
      findings.push({
        key: `low-balance:${f.accountId}`,
        kind: 'low-balance',
        severity: daysTo <= 7 ? 'critical' : 'warning',
        title: `${f.label}: צפוי מינוס${already ? ' (כבר עכשיו)' : ` ב-${fmtShort(f.firstBreachDate)}`}`,
        body: lines.join('\n'),
        fingerprint: `${f.firstBreachDate}|${Math.round(f.minBalance! / 100) * 100}`,
      });
    }
  }

  for (const o of occurrences) {
    if (o.state !== 'missing') continue;
    const where = labelOf.get(o.accountId) ?? o.accountId;
    if (o.kind === 'income') {
      findings.push({
        key: `income-missing:${o.itemId}:${o.date}`,
        kind: 'income-missing',
        severity: 'critical',
        title: `הכנסה לא נכנסה: ${o.name}`,
        body: `צפוי היה להיכנס ${ils(o.amount)} ל${where} בתאריך ${fmtShort(o.date)}, ועדיין לא נמצאה תנועה מתאימה. ההכנסה לא נספרת בתחזית.`,
        fingerprint: o.date,
      });
    } else {
      findings.push({
        key: `expense-missing:${o.itemId}:${o.date}`,
        kind: 'expense-missing',
        severity: 'warning',
        title: `הוצאה קבועה לא ירדה: ${o.name}`,
        body: `צפוי היה לרדת ${ils(o.amount)} מ${where} בתאריך ${fmtShort(o.date)}, ולא נמצאה תנועה מתאימה. בתחזית מניחים שהיא עוד תרד.`,
        fingerprint: o.date,
      });
    }
  }
  for (const c of cardCharges) {
    const where = labelOf.get(c.fundingAccount) ?? c.fundingAccount;
    if (c.state === 'missing') {
      findings.push({
        key: `card-not-charged:${c.sourceId}:${c.fundingAccount}:${c.date}`,
        kind: 'card-not-charged',
        severity: 'warning',
        title: `חיוב אשראי לא ירד: ${c.label}`,
        body: `חיוב של ${ils(-c.amount)} (${c.txnCount} עסקאות) היה אמור לרדת מ${where} ב-${fmtShort(c.date)}, ולא נמצא בתנועות הבנק. בתחזית מניחים שעוד ירד.`,
        fingerprint: c.date,
      });
    } else if (c.state === 'mismatch') {
      findings.push({
        key: `card-mismatch:${c.sourceId}:${c.fundingAccount}:${c.date}`,
        kind: 'card-mismatch',
        severity: 'warning',
        title: `סכום חיוב אשראי שונה: ${c.label}`,
        body: `ב-${fmtShort(c.date)} ירדו מ${where} ${ils(c.bankAmount ?? 0)} במקום ${ils(c.amount)} לפי פירוט הכרטיס.`,
        fingerprint: `${c.date}|${Math.round(c.bankAmount ?? 0)}`,
      });
    }
  }

  const rank = { critical: 0, warning: 1, info: 2 } as const;
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return { today, horizonDays, accounts, occurrences, cardCharges, findings };
}

export interface SourceStatusRow {
  sourceId: string;
  label: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastAttemptAt: string | null;
}

/** התראות על כשל באיסוף נתונים – כדי שהמערכת לא "תשתוק" כשהיא עיוורת */
const TRANSIENT_ERRORS = /^(TIMEOUT|NETWORK|GENERAL_ERROR|GENERIC|SESSION_CONFLICT|EXCEPTION)/;

/**
 * כשל איסוף חולף (איטיות/רשת/התנגשות התחברות) לא מקפיץ התראה אם הייתה הצלחה בתוך `transientGraceHours`:
 * המערכת ממשיכה לנסות לבד. שגיאות פרטי כניסה והצלחה ישנה מדי – כן מתריעות.
 */
export function sourceFindings(rows: SourceStatusRow[], now: Date, staleHours: number, transientGraceHours = 24, failStreak: Map<string, number> = new Map()): Finding[] {
  const out: Finding[] = [];
  for (const r of rows) {
    // כשל חולף לא מתריע בתוך חלון ההמתנה – אלא אם הוא חוזר 3 פעמים ברציפות (אז זו לא תקלה חולפת)
    if (r.lastError && TRANSIENT_ERRORS.test(r.lastError) && (failStreak.get(r.sourceId) ?? 0) < 3 && r.lastSuccessAt && now.getTime() - new Date(r.lastSuccessAt).getTime() < transientGraceHours * 3_600_000) continue;
    if (r.lastError && r.lastAttemptAt && (!r.lastSuccessAt || r.lastAttemptAt > r.lastSuccessAt)) {
      out.push({
        key: `scrape-failed:${r.sourceId}`,
        kind: 'scrape-failed',
        severity: 'critical',
        title: `לא הצלחתי למשוך נתונים מ${r.label}`,
        body: `${withHint(r.lastError)}\nעד שזה יטופל התחזית של החשבון הזה לא מעודכנת.`,
        fingerprint: r.lastError.slice(0, 80),
      });
    } else if (r.lastSuccessAt) {
      const ageH = (now.getTime() - new Date(r.lastSuccessAt).getTime()) / 3_600_000;
      if (ageH > staleHours) {
        out.push({
          key: `stale-data:${r.sourceId}`,
          kind: 'stale-data',
          severity: 'warning',
          title: `הנתונים של ${r.label} לא עודכנו ${Math.round(ageH)} שעות`,
          body: 'בדוק שהמערכת רצה ושההתחברות לא נחסמה.',
          fingerprint: 'stale',
        });
      }
    }
  }
  return out;
}
