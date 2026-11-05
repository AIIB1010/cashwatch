import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cancelRun, computeAnalysis, createContext, runDaily } from '../src/app.ts';
import { configSchema, secretsSchema } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { todayIn } from '../src/engine/dates.ts';
import type { Channel } from '../src/notify/channels.ts';
import { MockScrapeProvider, demoDates } from '../src/scrape/mock.ts';

function setup(failing: string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-'));
  const config = configSchema.parse({
    banks: [{ id: 'poalim', provider: 'hapoalim', label: 'פועלים' }, { id: 'leumi', provider: 'leumi', label: 'לאומי' }],
    cards: [{ id: 'isracard-1', provider: 'isracard', label: 'ישראכרט', fundingAccount: 'poalim' }, { id: 'max-1', provider: 'max', label: 'מקס', fundingAccount: 'leumi' }],
    scraping: { attempts: 2 },
  });
  const secrets = secretsSchema.parse({ sources: Object.fromEntries(['poalim', 'leumi', 'isracard-1', 'max-1'].map((i) => [i, { username: 'x', password: 'y' }])) });
  const store = new Store(path.join(dir, 't.db'));
  const today = todayIn(config.timezone);
  const D = demoDates(today);
  const dom = (d: string) => Number(d.slice(8, 10));
  store.saveRecurring({ name: 'החזר הלוואה', kind: 'expense', accountId: 'leumi', amount: 1500, dayOfMonth: dom(new Date(Date.now() + 2 * 86400000).toISOString()), intervalMonths: 1, anchorMonth: null, match: null, tolerancePct: 10, graceDays: 3, active: true, startDate: null, endDate: null, note: '' });
  store.saveRecurring({ name: 'משכורת', kind: 'income', accountId: 'poalim', amount: 14500, dayOfMonth: dom(D.salary), intervalMonths: 1, anchorMonth: null, match: 'הייטק', tolerancePct: 10, graceDays: 3, active: true, startDate: null, endDate: null, note: '' });
  const sent: string[] = [];
  const channel: Channel = { name: 'test', async send(m) { sent.push(m.text); } };
  const ctx = createContext({ config, secrets, store, provider: new MockScrapeProvider(today, new Set(failing)), dataDir: dir, log: () => {}, channels: [channel], fast: true });
  return { ctx, store, sent };
}

test('ריצה מלאה: איסוף, ניתוח והתראה; ריצה שנייה לא שולחת שוב את אותה התראה', async () => {
  const { ctx, sent } = setup();
  const r1 = await runDaily(ctx, 'test');
  assert.equal(r1.sources.every((s) => s.ok), true);
  assert.ok(r1.notified >= 1, 'אמורה להישלח התראת מינוס בלאומי');
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /לאומי: צפוי מינוס/);
  const r2 = await runDaily(ctx, 'test');
  assert.equal(r2.notified, 0);
  assert.equal(sent.length, 1, 'לא אמורה לצאת הודעה חוזרת באותו יום');
});

test('כשל באיסוף ממקור אחד: שאר המקורות ממשיכים, ונשלחת התראה על הכשל', async () => {
  const { ctx, sent } = setup(['leumi']);
  const r = await runDaily(ctx, 'test');
  assert.equal(r.sources.find((s) => s.sourceId === 'leumi')!.ok, false);
  assert.equal(r.sources.find((s) => s.sourceId === 'poalim')!.ok, true);
  assert.ok(sent.some((t) => t.includes('לא הצלחתי למשוך נתונים מלאומי')));
});

test('הערוץ נכשל -> ההתראה לא מסומנת כנשלחה ומנסים שוב בריצה הבאה', async () => {
  const { ctx } = setup();
  let fail = true; const got: string[] = [];
  ctx.channels.splice(0, 1, { name: 'flaky', async send(m) { if (fail) throw new Error('down'); got.push(m.text); } });
  const r1 = await runDaily(ctx, 'test');
  assert.equal(r1.notified, 0);
  fail = false;
  const r2 = await runDaily(ctx, 'test');
  assert.ok(r2.notified >= 1);
  assert.equal(got.length, 1);
});

test('בנק בלי יתרה: היתרה הידנית + תנועות שאחריה', async () => {
  const { ctx, store } = setup();
  await runDaily(ctx, 'test');
  // מדמים בנק שלא מחזיר יתרה
  store.db.prepare("DELETE FROM balances WHERE account_id='leumi'").run();
  assert.equal(computeAnalysis(ctx).analysis.accounts.find((a) => a.accountId === 'leumi')!.startBalance, null);
  const today = todayIn(ctx.config.timezone);
  store.setAnchor('leumi', 5000, '2000-01-01'); // עוגן ישן מאוד – כל התנועות שאחריו נספרות
  const bal = computeAnalysis(ctx).analysis.accounts.find((a) => a.accountId === 'leumi')!.startBalance!;
  const sum = store.getTxns('bank', '2000-01-01').filter((t) => t.accountRef === 'leumi' && t.status === 'completed').reduce((s, t) => s + t.amount, 0);
  assert.equal(Math.round(bal), Math.round(5000 + sum));
  store.setAnchor('leumi', 777, today); // עוגן של היום – תנועות של היום כבר נכללות
  const bal2 = computeAnalysis(ctx).analysis.accounts.find((a) => a.accountId === 'leumi')!.startBalance!;
  assert.equal(bal2, 777);
});

test('מקור שנכשל בסיסמה שגויה לא נבדק שוב אוטומטית (הגנה מנעילת חשבון), ואחרי עדכון פרטים כן', async () => {
  const { ctx, store } = setup();
  store.markFailure('poalim', new Date().toISOString(), 'INVALID_PASSWORD: Login failed', 100);
  const r = await runDaily(ctx, 'test');
  const p = r.sources.find((s) => s.sourceId === 'poalim')!;
  assert.equal(p.skipped, true);
  assert.equal(r.sources.find((s) => s.sourceId === 'leumi')!.ok, true);
  assert.equal(r.ok, true, 'מקור מדולג בכוונה לא נחשב כשל בריצה');
  store.clearSourceError('poalim');
  const r2 = await runDaily(ctx, 'test');
  assert.equal(r2.sources.find((s) => s.sourceId === 'poalim')!.ok, true);
});

test('קונפליקט התחברות (הבנק הציג דף יציאה): לא נחשב סיסמה שגויה, מנסים שוב ומצליחים', async () => {
  const { ctx, store } = setup();
  const real = ctx.provider;
  let calls = 0;
  ctx.provider = { scrape: async (req) => { if (req.sourceId === 'poalim' && ++calls === 1) return { ok: false, errorType: 'SESSION_CONFLICT', errorMessage: 'דף יציאה' }; return real.scrape(req); } };
  const r = await runDaily(ctx, 'test');
  const p = r.sources.find((s) => s.sourceId === 'poalim')!;
  assert.equal(p.ok, true);
  assert.equal(p.attempts, 2);
  assert.equal(store.listSourceStatus().find((s) => s.sourceId === 'poalim')!.lastError, null);
});

test('לא מתחברים שוב לאותו מקור תוך 20 דקות מהצלחה (אלא בבדיקה ידנית מאולצת)', async () => {
  const { ctx } = setup();
  await runDaily(ctx, 'test');
  const second = await runDaily(ctx, 'test');
  assert.equal(second.sources.every((s) => s.skipped && s.ok), true);
  const manual = await runDaily(ctx, 'manual', { force: true, quick: true });
  assert.equal(manual.sources.every((s) => s.skipped), true, 'ריענון ידני לא עוקף את הרווח');
  const forced = await runDaily(ctx, 'manual', { force: true, ignoreGap: true });
  assert.equal(forced.sources.every((s) => !s.skipped), true);
});

test('ביטול ריצה: המקורות שלא התחילו מדולגים עם "בוטל"', async () => {
  const { ctx } = setup();
  const p = runDaily(ctx, 'test');
  assert.equal(cancelRun(), true);
  const r = await p;
  assert.ok(r.sources.length > 0 && r.sources.every((s) => s.error === 'בוטל' && s.skipped));
  assert.equal(cancelRun(), false, 'אין ריצה פעילה לבטל');
});

test('ניסיון שנתקע: חורג מהזמן, הדפדפן נסגר (signal), ומנסים שוב ומצליחים', async () => {
  const { ctx } = setup();
  ctx.config.scraping.attemptTimeoutSeconds = 0.2;
  const real = ctx.provider;
  let aborted = 0;
  let calls = 0;
  ctx.provider = {
    scrape: (req) => {
      if (req.sourceId === 'poalim' && ++calls === 1) return new Promise(() => { req.signal?.addEventListener('abort', () => { aborted++; }); }); // לא מסתיים לעולם
      return real.scrape(req);
    },
  };
  const r = await runDaily(ctx, 'test');
  const p = r.sources.find((s) => s.sourceId === 'poalim')!;
  assert.equal(p.ok, true);
  assert.equal(p.attempts, 2);
  assert.equal(aborted, 1, 'הדפדפן של הניסיון התקוע חייב להיסגר');
});

test('היסטוריה ארוכה נמשכת פעם אחת לכל מקור (גם אם כבר נאסף בעבר), ואז חלון קצר', async () => {
  const { ctx, store } = setup();
  const windows: number[] = [];
  const real = ctx.provider;
  ctx.provider = { scrape: (req) => { if (req.sourceId === 'poalim') windows.push(Math.round((Date.now() - req.startDate.getTime()) / 86_400_000)); return real.scrape(req); } };
  store.markSuccess('poalim', new Date(Date.now() - 86_400_000).toISOString(), 10); // נאסף בעבר, בלי סימון היסטוריה
  await runDaily(ctx, 'manual', { force: true, ignoreGap: true });
  await runDaily(ctx, 'manual', { force: true, ignoreGap: true });
  assert.ok(windows[0]! >= 200, `ראשונה ארוכה (${windows[0]})`);
  assert.ok(windows[1]! <= 80, `שנייה קצרה (${windows[1]})`);
});

test('יומן ניסיונות איסוף נשמר לכל מקור', async () => {
  const { ctx, store } = setup();
  await runDaily(ctx, 'test');
  const a = store.recentAttempts('poalim');
  assert.equal(a.length, 1);
  assert.equal(a[0]!.ok, true);
});
