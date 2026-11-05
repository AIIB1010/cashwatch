import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createContext } from '../src/app.ts';
import { decrypt, encrypt } from '../src/crypto.ts';
import { createApp } from '../src/server.ts';
import { openSettings } from '../src/settings.ts';
import { MockScrapeProvider } from '../src/scrape/mock.ts';
import { todayIn } from '../src/engine/dates.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cw-set-'));

test('הצפנה: הלוך-חזור, ופענוח עם מפתח שגוי נכשל', () => {
  const k = Buffer.alloc(32, 7);
  const t = encrypt(k, 'סיסמה סודית');
  assert.ok(!t.includes('סיסמה'));
  assert.equal(decrypt(k, t), 'סיסמה סודית');
  assert.throws(() => decrypt(Buffer.alloc(32, 8), t));
});

test('הסודות נשמרים מוצפנים ב-DB ולא כטקסט גלוי', () => {
  const dir = tmp();
  const { settings, store } = openSettings({ dataDir: dir, configPath: path.join(dir, 'none.yaml') });
  settings.updateSecrets((s) => { s.sources.x = { password: 'SUPER-SECRET-123' }; });
  const raw = store.getKv('secrets')!;
  assert.ok(!raw.includes('SUPER-SECRET-123'));
  assert.ok(!fs.readFileSync(path.join(dir, 'cashwatch.db')).includes('SUPER-SECRET-123'));
  store.close();
  const again = openSettings({ dataDir: dir, configPath: path.join(dir, 'none.yaml') });
  assert.equal(again.settings.secrets.sources.x!.password, 'SUPER-SECRET-123');
  again.store.close();
});

test('ייבוא חד-פעמי מ-config.yaml ו-secrets.yaml קיימים', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'banks:\n  - { id: poalim, provider: hapoalim, label: "הפועלים" }\nnotifications:\n  whatsapp: { provider: greenapi }\n');
  fs.writeFileSync(path.join(dir, 'secrets.yaml'), 'sources:\n  poalim: { userCode: "u", password: "p" }\n');
  const a = openSettings({ dataDir: dir, configPath: path.join(dir, 'config.yaml'), secretsPath: path.join(dir, 'secrets.yaml') });
  assert.equal(a.imported, true);
  assert.equal(a.settings.config.banks[0]!.id, 'poalim');
  assert.equal(a.settings.secrets.sources.poalim!.password, 'p');
  a.store.close();
  const b = openSettings({ dataDir: dir, configPath: path.join(dir, 'config.yaml'), secretsPath: path.join(dir, 'secrets.yaml') });
  assert.equal(b.imported, false);
  assert.equal(b.settings.config.banks.length, 1);
  b.store.close();
});

async function withServer(fn: (call: (method: string, url: string, body?: unknown) => Promise<{ status: number; json: any }>, dir: string) => Promise<void>) {
  const dir = tmp();
  const { settings, store } = openSettings({ dataDir: dir, configPath: path.join(dir, 'none.yaml') });
  const ctx = createContext({ settings, store, provider: new MockScrapeProvider(todayIn('Asia/Jerusalem')), dataDir: dir, log: () => {}, fast: true });
  const server = createApp(ctx).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'cashwatch' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  try { await fn(call, dir); } finally { server.close(); store.close(); }
}

test('API הגדרות: הוספת בנק וכרטיס, מיפוי כרטיס לבנק, ואין החזרת סיסמאות', async () => {
  await withServer(async (call) => {
    const bank = await call('POST', '/api/settings/sources', { kind: 'bank', provider: 'hapoalim', label: 'פועלים', credentials: { userCode: 'u1', password: 'TOPSECRET' } });
    assert.equal(bank.status, 201);
    const card = await call('POST', '/api/settings/sources', { kind: 'card', provider: 'isracard', label: 'ישראכרט', fundingAccount: bank.json.id, credentials: { id: '123', card6Digits: '123456', password: 'PW2' } });
    assert.equal(card.status, 201);
    const view = await call('GET', '/api/settings');
    assert.ok(!JSON.stringify(view.json).includes('TOPSECRET') && !JSON.stringify(view.json).includes('PW2'), 'סיסמאות לא אמורות לחזור מה-API');
    const b = view.json.sources.find((s: any) => s.id === bank.json.id);
    assert.equal(b.credentials.present.password, true);
    assert.equal(b.credentials.values.userCode, 'u1');
    // חסר שדה חובה
    const bad = await call('POST', '/api/settings/sources', { kind: 'bank', provider: 'leumi', label: 'x', credentials: { username: 'u' } });
    assert.equal(bad.status, 400);
    // אי אפשר למחוק בנק שכרטיס יורד ממנו
    assert.equal((await call('DELETE', `/api/settings/sources/${bank.json.id}`)).status, 409);
    assert.equal((await call('DELETE', `/api/settings/sources/${card.json.id}`)).status, 200);
    assert.equal((await call('DELETE', `/api/settings/sources/${bank.json.id}`)).status, 200);
  });
});

test('API: עדכון ללא סיסמה משאיר את הקיימת; הגדרות התראות נשמרות והסוד לא חוזר', async () => {
  await withServer(async (call) => {
    const bank = await call('POST', '/api/settings/sources', { kind: 'bank', provider: 'leumi', label: 'לאומי', credentials: { username: 'u', password: 'KEEPME' } });
    const upd = await call('PUT', `/api/settings/sources/${bank.json.id}`, { label: 'לאומי חדש', credentials: { username: 'u2' } });
    assert.equal(upd.status, 200);
    const v = (await call('GET', '/api/settings')).json.sources[0];
    assert.equal(v.label, 'לאומי חדש');
    assert.equal(v.credentials.values.username, 'u2');
    assert.equal(v.credentials.present.password, true);
    const n = await call('PUT', '/api/settings/notifications', { whatsapp: { enabled: true, to: '972501234567', apiKey: 'WA-KEY-XYZ' }, email: { enabled: true, address: 'me@gmail.com', password: 'APP-PASS-123' } });
    assert.equal(n.status, 200);
    const view = (await call('GET', '/api/settings')).json;
    assert.equal(view.notifications.whatsapp.hasKey, true);
    assert.equal(view.notifications.email.hasPassword, true);
    assert.equal(view.notifications.email.preset, 'Gmail');
    assert.equal(view.notifications.email.advanced.host, 'smtp.gmail.com');
    assert.equal(view.notifications.email.advanced.to, 'me@gmail.com');
    assert.ok(!JSON.stringify(view).includes('WA-KEY-XYZ') && !JSON.stringify(view).includes('APP-PASS-123'));
    // דומיין לא מוכר בלי שרת – שגיאה ברורה
    const bad = await call('PUT', '/api/settings/notifications', { email: { enabled: true, address: 'me@walla.co.il' } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /SMTP/);
  });
});

test('API: בקשה משנה-מצב בלי כותרת X-Requested-With נחסמת (CSRF)', async () => {
  const dir = tmp();
  const { settings, store } = openSettings({ dataDir: dir, configPath: path.join(dir, 'none.yaml') });
  const ctx = createContext({ settings, store, provider: new MockScrapeProvider('2026-01-01'), dataDir: dir, log: () => {} });
  const server = createApp(ctx).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/settings/general`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
  server.close(); store.close();
});

test('API: בדיקת חיבור כמשימת רקע, ושגיאה ממקור לא מוכר מדווחת בצורה ברורה', async () => {
  await withServer(async (call) => {
    // המקור "poalim" נתמך ע"י ספק הדמה
    await call('POST', '/api/settings/sources', { kind: 'bank', provider: 'hapoalim', label: 'x', credentials: { userCode: 'u', password: 'p' } });
    const ctxBank = (await call('GET', '/api/settings')).json.sources[0].id; // hapoalim-1 – ספק הדמה מכיר רק מזהים קבועים
    const t = await call('POST', `/api/settings/sources/${ctxBank}/test`, {});
    assert.equal(t.status, 202);
    let job: any;
    for (let i = 0; i < 20; i++) { job = (await call('GET', `/api/jobs/${t.json.jobId}`)).json; if (job.state !== 'running') break; await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(job.state, 'error'); // ספק הדמה לא מכיר את hapoalim-1 – מוודא שהשגיאה מדווחת יפה
    assert.match(job.error, /אין נתוני דמו/);
  });
});

test('צילום מסך של כישלון: מוגש לפי מקור (האחרון), ומזהה לא תקין נדחה', async () => {
  const dir = tmp();
  const { settings, store } = openSettings({ dataDir: dir, configPath: path.join(dir, 'none.yaml') });
  fs.mkdirSync(path.join(dir, 'failures'));
  fs.writeFileSync(path.join(dir, 'failures', 'mizrahi-1-100.png'), Buffer.from('OLD'));
  const newer = path.join(dir, 'failures', 'mizrahi-1-200.png');
  fs.writeFileSync(newer, Buffer.from('NEWER'));
  fs.utimesSync(newer, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  const ctx = createContext({ settings, store, provider: new MockScrapeProvider('2026-01-01'), dataDir: dir, log: () => {} });
  const server = createApp(ctx).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ok = await fetch(`${base}/api/failures/mizrahi-1`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'NEWER');
  assert.equal((await fetch(`${base}/api/failures/none-1`)).status, 404);
  assert.equal((await fetch(`${base}/api/failures/..%2F..%2Fetc`)).status, 400);
  server.close(); store.close();
});

test('API: הוספת כרטיס בלי שם – נקבע שם ברירת מחדל לפי הספק, ובכרטיס שני מתווסף מספר', async () => {
  await withServer(async (call) => {
    const bank = await call('POST', '/api/settings/sources', { kind: 'bank', provider: 'hapoalim', label: 'פועלים', credentials: { userCode: 'u1', password: 'p' } });
    const creds = { id: '123', card6Digits: '123456', password: 'PW2' };
    const c1 = await call('POST', '/api/settings/sources', { kind: 'card', provider: 'isracard', label: '', fundingAccount: bank.json.id, credentials: creds });
    const c2 = await call('POST', '/api/settings/sources', { kind: 'card', provider: 'isracard', fundingAccount: bank.json.id, credentials: creds });
    assert.equal(c1.status, 201);
    assert.equal(c2.status, 201);
    const labels = (await call('GET', '/api/settings')).json.sources.filter((s: any) => s.kind === 'card').map((s: any) => s.label);
    assert.equal(labels.length, 2);
    assert.notEqual(labels[0], labels[1]);
    assert.ok(labels.every((l: string) => l.length > 0));
  });
});
