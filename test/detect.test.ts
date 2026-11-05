import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRecurring, normalizeTokens } from '../src/engine/detect.ts';
import type { RecurringItem, Txn } from '../src/types.ts';

let n = 0;
const tx = (date: string, amount: number, description: string, acc = 'A'): Txn => ({ id: `d${++n}`, sourceId: acc, accountRef: acc, date, processedDate: date, amount, description, memo: '', status: 'completed' });
const run = (txns: Txn[], extra: Partial<Parameters<typeof detectRecurring>[0]> = {}) =>
  detectRecurring({ today: '2026-11-05', bankTxns: txns, existing: [], dismissed: new Set(), excludeMatchers: [], ...extra });

test('נרמול תיאור: מסיר מספרים, מילות כלליות ואותיות בודדות', () => {
  assert.deepEqual(normalizeTokens('הוראת קבע ארנונה 123456'), ['ארנונה']);
  assert.deepEqual(normalizeTokens('משכורת - חברת הייטק בע"מ'), ['משכורת', 'חברת', 'הייטק']);
});

test('מזהה משכורת חודשית והוצאה חודשית קבועה', () => {
  const t = [
    ...['2026-06-01', '2026-07-01', '2026-08-02', '2026-09-01', '2026-10-01'].map((d) => tx(d, 14500, 'משכורת חברת הייטק')),
    ...['2026-06-10', '2026-07-10', '2026-08-11', '2026-09-10', '2026-10-10'].map((d) => tx(d, -4200, 'שכר דירה הוראת קבע')),
  ];
  const r = run(t);
  const salary = r.find((p) => p.kind === 'income')!;
  const rent = r.find((p) => p.kind === 'expense')!;
  assert.equal(salary.amount, 14500);
  assert.equal(salary.dayOfMonth, 1);
  assert.equal(rent.amount, 4200);
  assert.equal(rent.intervalMonths, 1);
  assert.equal(rent.tolerancePct, 10);
  assert.match('שכר דירה', new RegExp(rent.match, 'i'));
});

test('מזהה חיוב דו-חודשי (ארנונה) ומשייך חודש עוגן', () => {
  const r = run(['2026-05-15', '2026-07-15', '2026-09-15'].map((d) => tx(d, -820, 'ארנונה עיריית תל אביב')));
  assert.equal(r.length, 1);
  assert.equal(r[0]!.intervalMonths, 2);
  assert.equal(r[0]!.anchorMonth, '2026-09');
});

test('סכום משתנה (חשמל) מזוהה עם סטייה גבוהה', () => {
  const r = run([['2026-07-20', -310], ['2026-08-20', -480], ['2026-09-21', -390], ['2026-10-20', -260]].map(([d, a]) => tx(d as string, a as number, 'חברת חשמל')));
  assert.equal(r.length, 1);
  assert.ok(r[0]!.tolerancePct >= 40);
});

test('לא מזהה: רק שתי הופעות, תנועות ללא דפוס, מזומן, חיובי אשראי, ודפוס שכבר לא פעיל', () => {
  assert.equal(run(['2026-09-01', '2026-10-01'].map((d) => tx(d, -500, 'ביטוח'))).length, 0);
  assert.equal(run(['2026-07-03', '2026-08-19', '2026-09-27', '2026-10-08'].map((d) => tx(d, -90, 'קפה ארומה'))).length, 0);
  assert.equal(run(['2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05'].map((d) => tx(d, -500, 'משיכת מזומן כספומט'))).length, 0);
  assert.equal(run(['2026-07-02', '2026-08-02', '2026-09-02', '2026-10-02'].map((d) => tx(d, -3000, 'ישראכרט בעמ')), { excludeMatchers: [(s) => /ישראכרט/.test(s)] }).length, 0);
  assert.equal(run(['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05'].map((d) => tx(d, -200, 'מנוי ישן'))).length, 0);
});

test('לא מציע שוב דפוס שכבר מכוסה בהוראה קיימת או שנדחה', () => {
  const t = ['2026-07-10', '2026-08-10', '2026-09-10', '2026-10-10'].map((d) => tx(d, -4200, 'שכר דירה'));
  const existing = [{ id: 1, name: 'שכר דירה', kind: 'expense', accountId: 'A', amount: 4200, dayOfMonth: 10, intervalMonths: 1, anchorMonth: null, match: null, tolerancePct: 10, graceDays: 3, active: true, startDate: null, endDate: null, note: '' } as RecurringItem];
  assert.equal(run(t, { existing }).length, 0);
  const first = run(t);
  assert.equal(first.length, 1);
  assert.equal(run(t, { dismissed: new Set([first[0]!.key]) }).length, 0);
});

test('חשבונות נפרדים לא מתערבבים', () => {
  const t = [...['2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05'].map((d) => tx(d, -100, 'מנוי חדר כושר', 'A')), ...['2026-08-05', '2026-09-05'].map((d) => tx(d, -100, 'מנוי חדר כושר', 'B'))];
  const r = run(t);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.accountId, 'A');
});

test('אבחון: קבוצה שהופיעה פעמיים מוסברת (לא זוהתה כי חסרה היסטוריה)', () => {
  const diag: Parameters<typeof detectRecurring>[0]['diag'] = [];
  const r = run(['2026-09-10', '2026-10-10'].map((d) => tx(d, -4200, 'שכר דירה')), { diag });
  assert.equal(r.length, 0);
  assert.equal(diag!.length, 1);
  assert.match(diag![0]!.reason, /2 חודשים/);
});

test('העברה קבועה של 5,500 בין הרבה העברות אחרות באותו תיאור: מפוצלת לפי סכום ומזוהה', () => {
  const t = [
    ...['2026-06-05', '2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05'].map((d) => tx(d, -5500, 'העברה באינטרנט')),
    ...['2026-06-12', '2026-06-20', '2026-07-03', '2026-07-22', '2026-08-14', '2026-08-29', '2026-09-09', '2026-10-17'].map((d, i) => tx(d, -(137 + i * 211), 'העברה באינטרנט')),
  ];
  const r = run(t);
  const p = r.find((x) => Math.abs(x.amount - 5500) < 1);
  assert.ok(p, 'נמצאה ההעברה של 5,500');
  assert.equal(p!.dayOfMonth, 5);
  assert.match(p!.name, /5,500/);
  assert.equal(r.filter((x) => x.amount < 5000).length, 0, 'ההעברות הרנדומליות לא זוהו');
});

test('חיוב קבוע פעמיים בחודש (יום 2 ויום 12) מפוצל לשני דפוסים נפרדים', () => {
  const dates = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
  const t = dates.flatMap((m) => [tx(`${m}-02`, -2289, 'קופת גמל הפרשה'), tx(`${m}-12`, -2289, 'קופת גמל הפרשה')]);
  const r = run(t);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((x) => x.dayOfMonth).sort((a, b) => a - b), [2, 12]);
});

test('שורות חיוב של חברות אשראי (גם כאלה שלא מחוברות) לא נחשבות הוראה קבועה', () => {
  const dates = ['2026-06-02', '2026-07-02', '2026-08-02', '2026-09-02', '2026-10-02'];
  const t = [
    ...dates.map((d) => tx(d, -5200, 'דינרס קלאב')),
    ...dates.map((d) => tx(d, -3100, 'מקס איט פיננסים')),
    ...dates.map((d) => tx(d, -900, 'ישראכרט בע"מ')),
    ...dates.map((d) => tx(d, -450, 'כרטיסי אשראי לישראל')),
    ...dates.map((d) => tx(d, -1200, 'ועד בית')),
  ];
  const r = run(t);
  assert.deepEqual(r.map((p) => p.name), ['ועד בית']);
});

test('הוראת קבע עם תיאור כללי – הזיהוי נעשה לפי ההערה/המוטב', () => {
  const t = ['2026-06-05', '2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05'].map((d) => ({ ...tx(d, -380, 'הוראת קבע'), memo: 'מכבי שירותי בריאות' }));
  const other = ['2026-06-15', '2026-07-15', '2026-08-15', '2026-09-15', '2026-10-15'].map((d) => ({ ...tx(d, -120, 'הוראת קבע'), memo: 'חברת חשמל' }));
  const r = run([...t, ...other]);
  assert.equal(r.length, 2);
  assert.ok(r.some((p) => p.name.includes('מכבי')));
  assert.ok(r.some((p) => p.name.includes('חשמל')));
});

test('קבוצות שלא זוהו מוצגות לפי תת-קבוצה עם נתונים להוספה ידנית; קבוצה שהתעלמו ממנה לא מוצגת', () => {
  // העברה ב-5 לחודש וגם העברה באותו סכום באמצע החודש, בימים משתנים מאוד – לא דפוס אוטומטי, אבל המשתמש יכול להוסיף
  const t = [
    ...['2026-06-03', '2026-07-09', '2026-08-04', '2026-09-12', '2026-10-06'].map((d) => tx(d, -5500, 'העברה באינטרנט')),
    ...['2026-06-21', '2026-07-23', '2026-08-26', '2026-09-24', '2026-10-27'].map((d) => tx(d, -5500, 'העברה באינטרנט')),
  ];
  const diag: NonNullable<Parameters<typeof detectRecurring>[0]['diag']> = [];
  run(t, { diag });
  assert.ok(diag.length >= 1);
  const m = diag[0]!;
  assert.equal(m.amount, 5500);
  assert.ok(m.day >= 1 && m.day <= 31 && m.months === 5 && m.perMonth >= 1);
  assert.ok(m.match.length > 0);
  const diag2: typeof diag = [];
  run(t, { diag: diag2, dismissed: new Set(diag.map((d) => d.key)) });
  assert.equal(diag2.length, 0);
});

test('הכנסות: רק 3 חודשים רצופים באותו סכום בערך (עד 10%) נחשבות דפוס; כסף חד-פעמי מאנשים – לא', () => {
  const consecutive = ['2026-08-10', '2026-09-10', '2026-10-10'].map((d, i) => tx(d, [1000, 1060, 950][i]!, 'זיכוי מדוד כהן'));
  const wide = ['2026-08-05', '2026-09-05', '2026-10-05'].map((d, i) => tx(d, [1000, 1300, 700][i]!, 'זיכוי מרינה לוי'));
  const gap = ['2026-06-07', '2026-08-07', '2026-10-07'].map((d) => tx(d, 500, 'זיכוי מיוסי'));
  const diag: NonNullable<Parameters<typeof detectRecurring>[0]['diag']> = [];
  const r = run([...consecutive, ...wide, ...gap], { diag });
  assert.deepEqual(r.map((p) => p.name), ['זיכוי מדוד כהן']);
  assert.equal(r[0]!.tolerancePct, 10);
  assert.equal(diag.filter((d) => d.kind === 'income').length, 0, 'הכנסות שלא עומדות בכלל לא מוצעות');
});

test('הכנסה: רצף של 3 חודשים אחרונים מזוהה גם אם לפניו היו חודשים עם סכום אחר', () => {
  const t = [['2026-05-01', 3000], ['2026-06-01', 8000], ['2026-08-01', 5000], ['2026-09-01', 5100], ['2026-10-01', 4950]].map(([d, a]) => tx(d as string, a as number, 'משכורת חברה'));
  const r = run(t);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.occurrences, 3);
});
