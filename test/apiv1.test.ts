import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { openSettings } from '../src/settings.ts';
import { createApp } from '../src/server.ts';
import { MockScrapeProvider } from '../src/scrape/mock.ts';
import { createApiToken, revokeApiToken, txnsToCsv } from '../src/apiV1.ts';
import { collectNewTxns, sendWebhook, signBody } from '../src/webhooks.ts';
import { occurrenceDates } from '../src/engine/analyze.ts';
import type { RecurringItem, Txn } from '../src/types.ts';

async function withApi(fn: (call: (p: string, init?: RequestInit) => Promise<{ status: number; body: any; text: string; headers: Headers }>, ctx: any) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-api-'));
  const { settings, store } = openSettings({ dataDir: dir, configPath: path.join(dir, 'x.yaml'), secretsPath: path.join(dir, 'y.yaml') });
  settings.updateConfig((c) => { c.banks.push({ id: 'b1', provider: 'hapoalim', label: 'פועלים', alertBelow: 0, overdraftLimit: 0 }); });
  store.replaceTxns('b1', 'bank', '2026-01-01', [
    { accountRef: '123', date: '2026-10-01', processedDate: '2026-10-01', amount: -250, description: '=HYPERLINK("x")', memo: 'a,b', status: 'completed' },
    { accountRef: '123', date: '2026-10-03', processedDate: '2026-10-03', amount: 900, description: 'משכורת', memo: '', status: 'completed' },
  ]);
  const ctx = { store, provider: new MockScrapeProvider(new Date().toISOString().slice(0, 10)), dataDir: dir, log: () => {}, settings, get config() { return settings.config; }, get secrets() { return settings.secrets; }, channels: [] } as any;
  const server = createApp(ctx).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (p: string, init?: RequestInit) => {
    const res = await fetch(base + p, init);
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8').replace(/^\uFEFF/, '');
    (call as any).lastBuf = buf;
    let body: any = null; try { body = JSON.parse(text); } catch { /* csv */ }
    return { status: res.status, body, text, headers: res.headers };
  };
  try { await fn(call, ctx); } finally { server.close(); store.close(); }
}

test('API v1: כבוי בלי טוקן, 401 לטוקן שגוי, ועובד עם טוקן תקין; ביטול סוגר שוב', async () => {
  await withApi(async (call, ctx) => {
    assert.equal((await call('/api/v1/accounts')).status, 403);
    const token = createApiToken(ctx.store);
    assert.match(token, /^cw_/);
    assert.equal((await call('/api/v1/accounts', { headers: { Authorization: 'Bearer nope' } })).status, 401);
    const ok = await call('/api/v1/accounts', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.accounts[0].id, 'b1');
    assert.ok(!JSON.stringify(ok.body).includes(token));
    assert.equal((await call('/api/v1/accounts', { headers: { 'X-API-Key': token } })).status, 200);
    revokeApiToken(ctx.store);
    assert.equal((await call('/api/v1/accounts', { headers: { Authorization: `Bearer ${token}` } })).status, 403);
  });
});

test('API v1: תנועות עם סינון, CSV עם BOM והגנת נוסחאות, ושגיאות קלט', async () => {
  await withApi(async (call, ctx) => {
    const h = { headers: { Authorization: `Bearer ${createApiToken(ctx.store)}` } };
    const all = await call('/api/v1/transactions', h);
    assert.equal(all.body.count, 2);
    const some = await call('/api/v1/transactions?from=2026-10-02', h);
    assert.equal(some.body.count, 1);
    assert.equal(some.body.transactions[0].description, 'משכורת');
    assert.equal((await call('/api/v1/transactions?from=bad', h)).status, 400);
    assert.equal((await call('/api/v1/transactions?source=nope', h)).status, 404);
    const csv = await call('/api/v1/transactions?format=csv', h);
    assert.deepEqual([...(call as any).lastBuf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM לאקסל');
    assert.ok(csv.text.startsWith('id,'));
    assert.ok(csv.text.includes(`"'=HYPERLINK(""x"")"`), 'נוסחה מנוטרלת');
    assert.ok(csv.text.includes('"a,b"'));
    for (const p of ['status', 'forecast', 'recurring', 'alerts']) assert.equal((await call(`/api/v1/${p}`, h)).status, 200, p);
    assert.equal((await call('/api/v1/unknown', h)).status, 404);
  });
});

test('API v1: אין החזרת סודות, והדשבורד ממשיך לעבוד בלי טוקן', async () => {
  await withApi(async (call, ctx) => {
    const h = { headers: { Authorization: `Bearer ${createApiToken(ctx.store)}` } };
    ctx.settings.updateSecrets((s: any) => { s.sources.b1 = { userCode: 'u', password: 'SUPERSECRET' }; s.webhookSecret = 'HOOKSECRET'; });
    for (const p of ['status', 'accounts', 'forecast', 'recurring']) assert.ok(!(await call(`/api/v1/${p}`, h)).text.includes('SUPERSECRET'));
    const settings = await call('/api/settings');
    assert.ok(!settings.text.includes('HOOKSECRET') && !settings.text.includes('SUPERSECRET'));
    assert.equal(settings.body.api.hasWebhookSecret, true);
    assert.equal((await call('/api/state')).status, 200);
  });
});

test('Webhook: חתימת HMAC, כתובת לא תקינה, וזיהוי תנועות חדשות (הפעם הראשונה בלי הצפה)', async () => {
  const sent: any[] = [];
  const fakeFetch = async (_u: string, init: any) => { sent.push(init); return { ok: true, status: 200 }; };
  assert.equal((await sendWebhook('ftp://x', 's', 'test', {}, fakeFetch)).ok, false);
  const r = await sendWebhook('https://example.com/h', 'sekret', 'test', { a: 1 }, fakeFetch);
  assert.equal(r.ok, true);
  assert.equal(sent[0].headers['X-CashWatch-Signature'], signBody('sekret', sent[0].body));
  assert.equal(sent[0].headers['X-CashWatch-Event'], 'test');
  assert.deepEqual(Object.keys(JSON.parse(sent[0].body)).sort(), ['data', 'event', 'sentAt', 'version']);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-wh-'));
  const { store } = openSettings({ dataDir: dir, configPath: path.join(dir, 'x.yaml'), secretsPath: path.join(dir, 'y.yaml') });
  try {
    const mk = (d: string, a: number) => ({ accountRef: '1', date: d, processedDate: d, amount: a, description: 'x', memo: '', status: 'completed' as const });
    store.replaceTxns('b1', 'bank', '2026-01-01', [mk('2026-10-01', -5)]);
    assert.equal(collectNewTxns(store, '2026-01-01').length, 0, 'ריצה ראשונה רק מתעדת');
    store.replaceTxns('b1', 'bank', '2026-01-01', [mk('2026-10-01', -5), mk('2026-10-02', -7)]);
    const fresh: Txn[] = collectNewTxns(store, '2026-01-01');
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0]!.amount, -7);
    assert.equal(collectNewTxns(store, '2026-01-01').length, 0);
  } finally { store.close(); }
});

test('הוצאה/הכנסה חד-פעמית: תאריך התחלה = סיום נותן הופעה אחת בדיוק', () => {
  const item: RecurringItem = { name: 'החזר מס', kind: 'income', accountId: 'b1', amount: 3200, dayOfMonth: 17, intervalMonths: 1, anchorMonth: null, match: null, tolerancePct: 10, graceDays: 3, active: true, startDate: '2026-11-17', endDate: '2026-11-17', note: '' } as RecurringItem;
  assert.deepEqual(occurrenceDates(item, '2026-09-01', '2027-03-01'), ['2026-11-17']);
});

test('CSV: תא טקסט שמתחיל ב-= או + או - או @ מנוטרל', () => {
  const t: Txn = { id: '1', sourceId: 's', accountRef: 'a', date: '2026-01-01', processedDate: '2026-01-01', amount: -5, description: '+cmd', memo: '@x', status: 'completed' };
  const csv = txnsToCsv([t], new Map([['s', 'מקור']]));
  assert.ok(csv.includes("'+cmd") && csv.includes("'@x"));
  assert.ok(csv.includes(',-5,'), 'סכום שלילי אמיתי לא נפגע');
});

test('נעילה בסיסמה בשרת: state מדווח locked, עריכת הגדרות נחסמת (423), ו-unlock פותח', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lockapi-'));
  const opts = { dataDir: dir, configPath: path.join(dir, 'x.yaml'), secretsPath: path.join(dir, 'y.yaml') };
  const first = openSettings(opts);
  first.settings.enablePassphrase('correct horse');
  first.store.close();
  const { settings, store } = openSettings(opts);
  const ctx = { store, provider: new MockScrapeProvider('2026-11-05'), dataDir: dir, log: () => {}, settings, get config() { return settings.config; }, get secrets() { return settings.secrets; }, channels: [] } as any;
  const server = createApp(ctx).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (p: string, body: unknown, method = 'POST') => fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'cashwatch' }, body: JSON.stringify(body) });
  try {
    assert.equal((await (await fetch(base + '/api/state')).json() as any).locked, true);
    assert.equal((await post('/api/settings/notifications', { desktop: { enabled: true } }, 'PUT')).status, 423);
    assert.equal((await post('/api/unlock', { passphrase: 'bad bad bad' })).status, 401);
    assert.equal((await post('/api/unlock', { passphrase: 'correct horse' })).status, 200);
    assert.equal((await (await fetch(base + '/api/state')).json() as any).locked, false);
    assert.equal((await post('/api/settings/notifications', { desktop: { enabled: true } }, 'PUT')).status, 200);
  } finally { server.close(); store.close(); }
});
