import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { applyLibraryPatches, MIZRAHI_BALANCE_INFO_V2 } from '../src/scrape/patches.ts';

test('תיקוני הספרייה: מוחלים פעם אחת, והקובץ נשאר תקין תחבירית', () => {
  const root = path.dirname(createRequire(import.meta.url).resolve('israeli-bank-scrapers/package.json'));
  const file = path.join(root, 'lib/scrapers/mizrahi.js');
  applyLibraryPatches();
  const again = applyLibraryPatches();
  assert.deepEqual(again, [], 'הרצה שנייה לא אמורה לשנות כלום');
  const src = fs.readFileSync(file, 'utf8');
  for (const id of ['mizrahi-postlogin', 'mizrahi-success', 'mizrahi-loggedout', 'mizrahi-logout', 'mizrahi-balanceinfo2', 'mizrahi-debug']) assert.ok(src.includes(`cashwatch-patch:${id}`), id);
  assert.ok(/cashwatch-patch(:mizrahi-balance)?/.test(src));
  assert.doesNotThrow(() => new vm.Script(src, { filename: 'mizrahi.js' }), 'הקובץ אחרי התיקון חייב להיות JS תקין');
  const nav = fs.readFileSync(path.join(root, 'lib/helpers/navigation.js'), 'utf8');
  assert.ok(nav.includes('cashwatch-patch:nav-redirect') && nav.includes('timeout = 90000'));
  assert.ok(src.includes('cashwatch-patch:mizrahi-postlogin') && src.includes('setTimeout(resolve, 90000)'), 'מזרחי ממתין עד 90 שניות למעבר איטי');
  assert.ok(src.includes('waitForUrl)(page, CHANGE_PASSWORD_URL).catch(() => new Promise(() => {}))'), 'מסלול החלפת סיסמה שאינו נדרש אינו מפיל כניסה רגילה');
  assert.doesNotThrow(() => new vm.Script(nav, { filename: 'navigation.js' }));
  // הקישור של "סיסמה שגויה" כבר לא גורם לעצירה מיידית
  assert.ok(!src.includes('waitUntilElementFound)(page, invalidPasswordSelector), (0, _navigation'));
});

/** מריצים את קטע ה-JS שמוזרק לספרייה על תשובת בנק מדומה */
async function runInfo(rows: Array<Record<string, unknown>>, fields: Record<string, unknown> = {}) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...a: string[]) => (this: unknown, response: unknown) => Promise<Record<string, unknown>>;
  const fn = new AsyncFunction('response', `const o = { ${MIZRAHI_BALANCE_INFO_V2} }; return o.cashwatchBalanceInfo;`);
  return fn.call({ page: { evaluate: async () => '' } }, { body: { fields, table: { rows } } }) as Promise<{ auto?: { value: number; verified: boolean; order: string }; candidates: Array<{ from: string; value: number }> }>;
}
const row = (date: string, amount: number, balance: number) => ({ MC02PeulaTaaEZ: `${date}T00:00:00`, MC02SchumEZ: amount, MC02YitraEZ: balance });

test('יתרה רצה במזרחי: טבלה מהחדש לישן מאומתת חשבונית ומחזירה את היתרה של השורה הראשונה', async () => {
  const info = await runInfo([row('2026-11-02', -20, 113492.32), row('2026-11-01', -7, 113512.32), row('2026-10-16', 83314, 113519.32), row('2026-10-15', -100, 30205.32)]);
  assert.equal(info.auto?.verified, true);
  assert.equal(info.auto?.order, 'desc');
  assert.equal(info.auto?.value, 113492.32);
});

test('יתרה רצה במזרחי: טבלה מהישן לחדש מזוהה (הסדר מאומת, לא מנחשים לפי תאריכים)', async () => {
  const info = await runInfo([row('2026-10-15', -100, 30205.32), row('2026-10-16', 83314, 113519.32), row('2026-11-01', -7, 113512.32), row('2026-11-02', -20, 113492.32)]);
  assert.equal(info.auto?.order, 'asc');
  assert.equal(info.auto?.value, 113492.32);
});

test('יתרה רצה: אם החשבון לא מסתדר – לא קובעים אוטומטית (רק הצעה לבחירת המשתמש)', async () => {
  const info = await runInfo([row('2026-11-02', -20, 500), row('2026-11-01', -7, 9999), row('2026-10-16', 50, 123)]);
  assert.equal(info.auto, undefined);
  assert.ok(info.candidates.some((c) => c.from === 'row.MC02YitraEZ'), 'נשארת הצעה');
});

test('waitForRedirect: אם הדף מציג "סיסמה שגויה" – זורק CASHWATCH_BAD_CREDENTIALS; אחרת TIMEOUT רגיל', async () => {
  applyLibraryPatches();
  const root = path.dirname(createRequire(import.meta.url).resolve('israeli-bank-scrapers/package.json'));
  const nav = fs.readFileSync(path.join(root, 'lib/helpers/navigation.js'), 'utf8');
  assert.ok(nav.includes('cashwatch-patch:nav-badcreds'));
  assert.doesNotThrow(() => new vm.Script(nav, { filename: 'navigation.js' }));
  const { waitForRedirect } = createRequire(import.meta.url)(path.join(root, 'lib/helpers/navigation.js')) as { waitForRedirect: (p: unknown, t: number) => Promise<void> };
  // הספרייה ממשיכה לדגום את הכתובת גם אחרי ה-timeout עד שהדף נסגר – מדמים סגירה כדי שהתהליך יסתיים
  let closed = false;
  const page = (text: string) => ({ url: () => { if (closed) throw new Error('closed'); return 'https://x/login'; }, evaluate: async () => text });
  try {
    await assert.rejects(waitForRedirect(page('שם המשתמש או הסיסמה שגויים'), 1200), /CASHWATCH_BAD_CREDENTIALS/);
    await assert.rejects(waitForRedirect(page('ברוך הבא'), 1200), (e: Error) => /waiting for redirect/.test(e.message) && !/BAD_CREDENTIALS/.test(e.message));
  } finally { closed = true; }
});
