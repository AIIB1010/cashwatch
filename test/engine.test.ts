import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, occurrenceDates, sourceFindings, type AnalyzeInput } from '../src/engine/analyze.ts';
import type { RecurringItem, Txn } from '../src/types.ts';

const TODAY = '2026-11-06';
let seq = 0;
const tx = (accountRef: string, date: string, amount: number, description: string, extra: Partial<Txn> = {}): Txn => ({
  id: `t${++seq}`, sourceId: accountRef, accountRef, date, processedDate: date, amount, description, memo: '', status: 'completed', ...extra,
});
const item = (p: Partial<RecurringItem>): RecurringItem => ({
  id: ++seq, name: 'x', kind: 'expense', accountId: 'A', amount: 1000, dayOfMonth: 1, intervalMonths: 1, anchorMonth: null,
  match: null, tolerancePct: 10, graceDays: 3, active: true, startDate: null, endDate: null, note: '', ...p,
});
const base = (over: Partial<AnalyzeInput>): AnalyzeInput => ({
  today: TODAY, horizonDays: 35,
  accounts: [{ id: 'A', label: 'בנק א', balance: 5000, balanceAt: null, alertBelow: 0, overdraftLimit: 0 }],
  bankTxns: [], cardSources: [], cardTxns: [], recurring: [], ...over,
});
const card = (over = {}) => ({ id: 'C', label: 'ישראכרט', fundingAccount: 'A', fundingOverrides: {}, billingDay: 10, chargeMatch: 'ישראכרט', ...over });

test('occurrenceDates: חיתוך סוף חודש ומרווח דו-חודשי', () => {
  const d31 = occurrenceDates(item({ dayOfMonth: 31 }), '2026-01-01', '2026-03-31');
  assert.deepEqual(d31, ['2026-01-31', '2026-02-28', '2026-03-31']);
  const bi = occurrenceDates(item({ dayOfMonth: 15, intervalMonths: 2, anchorMonth: '2026-01' }), '2026-01-01', '2026-06-30');
  assert.deepEqual(bi, ['2026-01-15', '2026-03-15', '2026-05-15']);
});

test('תחזית: הוצאה והכנסה עתידיות משנות את היתרה והתראת מינוס נוצרת עם סכום חסר', () => {
  const r = analyze(base({
    accounts: [{ id: 'A', label: 'בנק א', balance: 3000, balanceAt: null, alertBelow: 0, overdraftLimit: 0 }],
    recurring: [item({ name: 'שכר דירה', amount: 4200, dayOfMonth: 10 }), item({ name: 'משכורת', kind: 'income', amount: 9000, dayOfMonth: 20 })],
  }));
  const a = r.accounts[0]!;
  assert.equal(a.firstBreachDate, '2026-11-10');
  assert.equal(a.minBalance, -1200);
  assert.equal(a.shortfall, 1200);
  assert.equal(a.timeline.find((p) => p.date === '2026-11-20')!.balance, 7800);
  const f = r.findings.find((x) => x.kind === 'low-balance')!;
  assert.equal(f.severity, 'critical');
  assert.match(f.body, /שכר דירה/);
});

test('חשבונות מחושבים כל אחד בנפרד, כולל חיוב אשראי לחשבון השני', () => {
  const r = analyze(base({
    horizonDays: 30,
    accounts: [
      { id: 'A', label: 'בנק א', balance: 5000, balanceAt: null, alertBelow: 0, overdraftLimit: 0 },
      { id: 'B', label: 'בנק ב', balance: 1000, balanceAt: null, alertBelow: 0, overdraftLimit: 0 },
    ],
    recurring: [item({ accountId: 'A', amount: 2000, dayOfMonth: 8 })],
    cardSources: [card({ fundingAccount: 'B' })],
    cardTxns: [tx('1234', '2026-10-20', -1500, 'סופר', { sourceId: 'C', processedDate: '2026-11-10' })],
  }));
  const [a, b] = r.accounts;
  assert.equal(a!.minBalance, 3000);
  assert.equal(b!.minBalance, -500);
  assert.equal(r.findings.filter((f) => f.kind === 'low-balance').length, 1);
  assert.match(r.findings[0]!.title, /בנק ב/);
});

test('הכנסה שהתקבלה מותאמת ולא מתריעה; הכנסה שלא נכנסה מתריעה ולא נספרת', () => {
  const salary = item({ name: 'משכורת', kind: 'income', amount: 14000, dayOfMonth: 1, match: 'הייטק' });
  const ok = analyze(base({ recurring: [salary], bankTxns: [tx('A', '2026-11-01', 14000, 'משכורת הייטק')] }));
  assert.equal(ok.occurrences.find((o) => o.date === '2026-11-01')!.state, 'matched');
  assert.equal(ok.findings.length, 0);

  const missing = analyze(base({ recurring: [salary], bankTxns: [] }));
  assert.equal(missing.occurrences.find((o) => o.date === '2026-11-01')!.state, 'missing');
  const f = missing.findings.find((x) => x.kind === 'income-missing')!;
  assert.equal(f.severity, 'critical');
  // לא נספרת בתחזית
  assert.equal(missing.accounts[0]!.events.some((e) => e.type === 'recurring-income' && e.date <= '2026-11-07'), false);
});

test('הכנסה בתוך תקופת החסד – עדיין לא התראה', () => {
  const r = analyze(base({ today: '2026-11-03', recurring: [item({ kind: 'income', dayOfMonth: 1, graceDays: 3 })] }));
  assert.equal(r.occurrences.find((o) => o.date === '2026-11-01')!.state, 'due');
  assert.equal(r.findings.length, 0);
});

test('הוצאה קבועה שלא ירדה: התראה, ובתחזית נחשבת כיורדת מחר (שמרני)', () => {
  const r = analyze(base({ recurring: [item({ name: 'ביטוח', amount: 300, dayOfMonth: 1 })] }));
  assert.ok(r.findings.some((f) => f.kind === 'expense-missing'));
  const ev = r.accounts[0]!.events.find((e) => e.name.includes('ביטוח'))!;
  assert.equal(ev.date, '2026-11-07');
  assert.equal(ev.amount, -300);
});

test('חיוב אשראי שירד תקין / לא ירד / סכום שונה', () => {
  const txns = [tx('1234', '2026-10-05', -2000, 'קניות', { sourceId: 'C', processedDate: '2026-11-02' })];
  const cs = [card({ billingDay: 2 })];
  const matched = analyze(base({ cardSources: cs, cardTxns: txns, bankTxns: [tx('A', '2026-11-02', -2000, 'ישראכרט בע"מ')] }));
  assert.equal(matched.cardCharges[0]!.state, 'matched');
  assert.equal(matched.findings.length, 0);

  const missing = analyze(base({ cardSources: cs, cardTxns: txns }));
  assert.equal(missing.cardCharges[0]!.state, 'missing');
  assert.ok(missing.findings.some((f) => f.kind === 'card-not-charged'));

  const mismatch = analyze(base({ cardSources: cs, cardTxns: txns, bankTxns: [tx('A', '2026-11-02', -1800, 'ישראכרט')] }));
  assert.equal(mismatch.cardCharges[0]!.state, 'mismatch');
  assert.ok(mismatch.findings.some((f) => f.kind === 'card-mismatch'));
});

test('שורת בנק לא מתאימה לא נחשבת חיוב אשראי (התאמה לפי תיאור)', () => {
  const r = analyze(base({
    cardSources: [card({ billingDay: 2 })],
    cardTxns: [tx('1234', '2026-10-05', -2000, 'קניות', { sourceId: 'C', processedDate: '2026-11-02' })],
    bankTxns: [tx('A', '2026-11-02', -2000, 'שכר דירה')],
  }));
  assert.equal(r.cardCharges[0]!.state, 'missing');
});

test('עסקאות ממתינות משויכות למועד החיוב הקרוב ומסומנות כהערכה', () => {
  const r = analyze(base({
    cardSources: [card({ billingDay: 10 })],
    cardTxns: [
      tx('1234', '2026-10-25', -500, 'א', { sourceId: 'C', processedDate: '2026-11-10' }),
      tx('1234', '2026-11-03', -250, 'ב', { sourceId: 'C', processedDate: '2026-11-03', status: 'pending' }),
    ],
  }));
  const c = r.cardCharges.find((x) => x.date === '2026-11-10')!;
  assert.equal(c.amount, -750);
  assert.equal(c.estimated, true);
  assert.equal(r.accounts[0]!.minBalance, 4250);
});

test('הכרטיס יכול לרדת מחשבון אחר לפי כרטיס (override)', () => {
  const r = analyze(base({
    accounts: [
      { id: 'A', label: 'א', balance: 5000, balanceAt: null, alertBelow: 0, overdraftLimit: 0 },
      { id: 'B', label: 'ב', balance: 5000, balanceAt: null, alertBelow: 0, overdraftLimit: 0 },
    ],
    cardSources: [card({ fundingOverrides: { '9999': 'B' } })],
    cardTxns: [
      tx('1234', '2026-10-25', -100, 'א', { sourceId: 'C', processedDate: '2026-11-10' }),
      tx('9999', '2026-10-25', -700, 'ב', { sourceId: 'C', processedDate: '2026-11-10' }),
    ],
  }));
  assert.equal(r.accounts[0]!.minBalance, 4900);
  assert.equal(r.accounts[1]!.minBalance, 4300);
});

test('אין יתרה -> התראה, בלי קריסה', () => {
  const r = analyze(base({ accounts: [{ id: 'A', label: 'א', balance: null, balanceAt: null, alertBelow: 0, overdraftLimit: 0 }] }));
  assert.equal(r.findings[0]!.kind, 'no-balance');
});

test('שורה בנקאית אחת לא משמשת שתי הוראות קבועות', () => {
  const r = analyze(base({
    recurring: [item({ name: 'א', amount: 500, dayOfMonth: 1 }), item({ name: 'ב', amount: 500, dayOfMonth: 2 })],
    bankTxns: [tx('A', '2026-11-01', -500, 'הוראת קבע')],
  }));
  assert.equal(r.occurrences.filter((o) => o.state === 'matched').length, 1);
  assert.equal(r.occurrences.filter((o) => o.state === 'missing').length, 1);
});

test('כשל איסוף חולף אחרי הצלחה לאחרונה לא מתריע; כשל ישן/סיסמה כן', () => {
  const now = new Date('2026-11-05T12:00:00Z');
  const row = (lastError: string, lastSuccessAt: string | null) => ({ sourceId: 'x', label: 'בנק', lastSuccessAt, lastError, lastAttemptAt: '2026-11-05T11:59:00Z' });
  assert.equal(sourceFindings([row('TIMEOUT: waiting for redirect', '2026-11-05T01:00:00Z')], now, 36).length, 0, 'הצלחה לפני 11 שעות + TIMEOUT = שקט');
  assert.equal(sourceFindings([row('TIMEOUT: waiting', '2026-11-03T01:00:00Z')], now, 36).length, 1, 'הצלחה ישנה (יותר מ-24 שעות) = התראה');
  assert.equal(sourceFindings([row('INVALID_PASSWORD: x', '2026-11-05T11:00:00Z')], now, 36).length, 1, 'סיסמה שגויה תמיד מתריעה');
  assert.equal(sourceFindings([row('TIMEOUT: x', null)], now, 36).length, 1, 'מעולם לא הצליח = התראה');
});
