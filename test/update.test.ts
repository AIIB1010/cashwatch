import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canAutoInstall, checkForUpdate, compareVersions, downloadInstaller } from '../src/update.ts';

const rel = (over: object = {}) => ({
  tag_name: 'v1.4.0', html_url: 'https://github.com/o/r/releases/tag/v1.4.0', body: 'notes', draft: false, prerelease: false,
  assets: [
    { name: 'CashWatch-Setup-1.4.0.exe', browser_download_url: 'https://github.com/o/r/releases/download/v1.4.0/CashWatch-Setup-1.4.0.exe' },
    { name: 'CashWatch-Setup-1.4.0.exe.sha256', browser_download_url: 'https://github.com/o/r/releases/download/v1.4.0/CashWatch-Setup-1.4.0.exe.sha256' },
  ], ...over,
});
const resp = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => String(body), arrayBuffer: async () => (body as Buffer).buffer.slice((body as Buffer).byteOffset, (body as Buffer).byteOffset + (body as Buffer).byteLength) as ArrayBuffer });

test('השוואת גרסאות', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.ok(compareVersions('v1.3.1', '1.3.1') === 0);
  assert.ok(compareVersions('1.3.0', '1.3.1') < 0);
});

test('בדיקת עדכון: גרסה חדשה, גרסה זהה, טיוטה/Release לא קיים, ושם פרויקט לא תקין', async () => {
  const up = await checkForUpdate('o/r', '1.3.1', async () => resp(rel()));
  assert.equal(up.available, true);
  assert.equal(up.latest, '1.4.0');
  assert.ok(up.assetUrl && up.sha256Url);
  assert.equal((await checkForUpdate('o/r', '1.4.0', async () => resp(rel()))).available, false);
  assert.equal((await checkForUpdate('o/r', '1.3.1', async () => resp(rel({ draft: true })))).available, false);
  assert.match((await checkForUpdate('o/r', '1.3.1', async () => resp({}, 404))).error!, /ציבורי/);
  assert.match((await checkForUpdate('bad repo!', '1.3.1', async () => resp(rel()))).error!, /לא תקין/);
  const evil = rel({ assets: [{ name: 'CashWatch-Setup-1.4.0.exe', browser_download_url: 'https://evil.example/x.exe' }] });
  assert.equal((await checkForUpdate('o/r', '1.3.1', async () => resp(evil))).assetUrl, undefined, 'רק כתובות GitHub');
});

test('הורדת מתקין: מאמת SHA-256, דוחה אי-התאמה וחוסר checksum', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-upd-'));
  const data = Buffer.alloc(1_200_000, 7);
  const good = createHash('sha256').update(data).digest('hex');
  const info = await checkForUpdate('o/r', '1.3.1', async () => resp(rel()));
  const mk = (sum: string) => async (url: string) => (url.endsWith('.sha256') ? resp(`${sum}  CashWatch-Setup-1.4.0.exe\n`) : resp(data));
  const file = await downloadInstaller(info, dir, mk(good));
  assert.ok(fs.existsSync(file) && file.endsWith('CashWatch-Setup-1.4.0.exe'));
  fs.rmSync(file);
  await assert.rejects(downloadInstaller(info, dir, mk('0'.repeat(64))), /checksum/);
  assert.equal(fs.readdirSync(dir).length, 0, 'קובץ לא תקין לא נשמר');
  await assert.rejects(downloadInstaller({ ...info, sha256Url: undefined }, dir, mk(good)), /checksum/);
});

test('עדכון אוטומטי זמין רק בהתקנה עם Node מובנה ב-Windows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-root-'));
  assert.equal(canAutoInstall(root, 'win32'), false);
  fs.mkdirSync(path.join(root, 'runtime')); fs.writeFileSync(path.join(root, 'runtime', 'node.exe'), 'x');
  fs.mkdirSync(path.join(root, 'windows')); fs.writeFileSync(path.join(root, 'windows', 'update.ps1'), 'x');
  assert.equal(canAutoInstall(root, 'win32'), true);
  assert.equal(canAutoInstall(root, 'linux'), false);
});

test('ניקוי מטמוני פרופיל: מוחק רק תיקיות מטמון מוכרות, לא עוגיות/אחסון/העדפות', async () => {
  const { pruneProfileCaches } = await import('../src/scrape/profile.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-prof-'));
  const mk = (rel: string, size = 1000) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.alloc(size, 1)); };
  mk('Default/Cache/data_0', 5000); mk('Default/Code Cache/js/a', 3000); mk('optimization_guide_model_store/m', 7000); mk('Default/Service Worker/CacheStorage/x', 2000);
  mk('Default/Network/Cookies'); mk('Default/Local Storage/leveldb/1'); mk('Local State'); mk('Default/Preferences'); mk('Default/Service Worker/Database/y');
  const freed = pruneProfileCaches(dir);
  assert.ok(freed >= 17000);
  for (const keep of ['Default/Network/Cookies', 'Default/Local Storage/leveldb/1', 'Local State', 'Default/Preferences', 'Default/Service Worker/Database/y']) assert.ok(fs.existsSync(path.join(dir, keep)), keep);
  for (const gone of ['Default/Cache', 'Default/Code Cache', 'optimization_guide_model_store', 'Default/Service Worker/CacheStorage']) assert.ok(!fs.existsSync(path.join(dir, gone)), gone);
});

test('כשל אחרי כשל: 3 כשלונות חולפים ברציפות מתריעים גם בתוך חלון ההמתנה; שגיאת INTERNAL מתריעה מיד', async () => {
  const { sourceFindings } = await import('../src/engine/analyze.ts');
  const now = new Date('2026-11-05T12:00:00Z');
  const row = (err: string) => ({ sourceId: 's', label: 'פועלים', lastAttemptAt: '2026-11-05T11:00:00Z', lastSuccessAt: '2026-11-05T05:00:00Z', lastError: err, lastDurationMs: 1 });
  assert.equal(sourceFindings([row('TIMEOUT: x')], now, 36, 24, new Map([['s', 1]])).length, 0, 'כשל חולף בודד – שקט');
  assert.equal(sourceFindings([row('TIMEOUT: x')], now, 36, 24, new Map([['s', 3]])).length, 1, 'שלושה ברצף – מתריע');
  assert.equal(sourceFindings([row('INTERNAL: חסר קובץ')], now, 36, 24, new Map([['s', 1]])).length, 1, 'תקלת התקנה – מיד');
});
