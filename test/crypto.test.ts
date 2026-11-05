import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOrCreateKey } from '../src/crypto.ts';
import { deleteLegacySecretsFile, openSettings } from '../src/settings.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cw-crypto-'));
/** "DPAPI" מדומה: XOR (מספיק כדי לבדוק את הלוגיקה של הקבצים, לא את ההצפנה עצמה) */
const fake = { platform: 'win32' as const, protect: (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a)), unprotect: (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a)) };

test('Windows: מפתח חדש נשמר רק עטוף ב-DPAPI, ובטעינה חוזרת מתקבל אותו מפתח', () => {
  const dir = tmp();
  const k1 = loadOrCreateKey(dir, fake);
  assert.equal(k1.length, 32);
  assert.ok(fs.existsSync(path.join(dir, '.keyfile.dpapi')));
  assert.ok(!fs.existsSync(path.join(dir, '.keyfile')), 'אין קובץ מפתח גלוי');
  assert.ok(!fs.readFileSync(path.join(dir, '.keyfile.dpapi'), 'utf8').includes(k1.toString('hex')));
  assert.deepEqual(loadOrCreateKey(dir, fake), k1);
});

test('Windows: מפתח ישן בקובץ גלוי עובר עטיפה, אותו מפתח נשמר, והקובץ הגלוי נמחק', () => {
  const dir = tmp();
  const old = Buffer.alloc(32, 7);
  fs.writeFileSync(path.join(dir, '.keyfile'), old.toString('hex'));
  const k = loadOrCreateKey(dir, fake);
  assert.deepEqual(k, old, 'סודות קיימים נשארים קריאים');
  assert.ok(!fs.existsSync(path.join(dir, '.keyfile')));
  assert.deepEqual(loadOrCreateKey(dir, fake), old);
});

test('Windows: קובץ עטוף שלא ניתן לפענח (מחשב/משתמש אחר) – שגיאה ברורה, בלי ליצור מפתח חדש בשקט', () => {
  const dir = tmp();
  loadOrCreateKey(dir, fake);
  const broken = { ...fake, unprotect: () => { throw new Error('Key not valid for use in specified state'); } };
  assert.throws(() => loadOrCreateKey(dir, broken), /לא ניתן לפענח את מפתח ההצפנה/);
});

test('Windows: אם DPAPI לא זמין – חוזרים לקובץ מפתח רגיל במקום להפיל את המערכת', () => {
  const dir = tmp();
  const warn = console.warn; console.warn = () => {};
  try {
    const k = loadOrCreateKey(dir, { ...fake, protect: () => { throw new Error('no powershell'); } });
    assert.equal(k.length, 32);
    assert.ok(fs.existsSync(path.join(dir, '.keyfile')));
    assert.ok(!fs.existsSync(path.join(dir, '.keyfile.dpapi')));
  } finally { console.warn = warn; }
});

test('לא-Windows: קובץ מפתח רגיל ויציב', () => {
  const dir = tmp();
  const k = loadOrCreateKey(dir, { platform: 'linux' });
  assert.ok(fs.existsSync(path.join(dir, '.keyfile')));
  assert.deepEqual(loadOrCreateKey(dir, { platform: 'linux' }), k);
});

test('openSettings לעולם לא מוחק את secrets.yaml (גם אם הסיסמאות שמורות ב-DB); מחיקה רק בבקשה מפורשת', () => {
  const dir = tmp();
  const yamlPath = path.join(dir, 'secrets.yaml');
  fs.writeFileSync(yamlPath, 'sources:\n  b1: { username: u, password: TOPSECRET }\n');
  const { settings, store } = openSettings({ dataDir: path.join(dir, 'data'), configPath: path.join(dir, 'nope.yaml'), secretsPath: yamlPath });
  try {
    settings.updateSecrets((s) => { s.sources.b1 = { username: 'u', password: 'p' }; });
    assert.ok(fs.existsSync(yamlPath), 'אין מחיקה אוטומטית');
    assert.equal(deleteLegacySecretsFile(yamlPath), true);
    assert.ok(!fs.existsSync(yamlPath));
    assert.equal(deleteLegacySecretsFile(yamlPath), false);
  } finally { store.close(); }
});

test('Windows: אם נשאר קובץ גלוי לצד העטוף (קריסה באמצע מעבר) – נמחק בטעינה הבאה', () => {
  const dir = tmp();
  const k = loadOrCreateKey(dir, fake);
  fs.writeFileSync(path.join(dir, '.keyfile'), k.toString('hex'));
  assert.deepEqual(loadOrCreateKey(dir, fake), k);
  assert.ok(!fs.existsSync(path.join(dir, '.keyfile')));
});

test('התראת מסך: מצב ההרשאה של Windows מתורגם להסבר, ו-Enabled נחשב תקין', async () => {
  const { explainToastSetting } = await import('../src/notify/desktop.ts');
  assert.equal(explainToastSetting('SETTING=Enabled'), null);
  assert.equal(explainToastSetting(''), null);
  assert.match(explainToastSetting('SETTING=DisabledForUser')!, /Windows חוסם.*DisabledForUser.*התראות/);
});

test('כרטיס: דמי כרטיס עם פטור (חיוב 0 בשקלים) לא נחשבים חיוב; מט"ח ממתין נשאר הערכה', async () => {
  const { effectiveAmount } = await import('../src/scrape/amounts.ts');
  assert.equal(effectiveAmount({ chargedAmount: -0, originalAmount: -9.9, originalCurrency: 'ILS' }), 0);
  assert.equal(effectiveAmount({ chargedAmount: -150, originalAmount: -150, originalCurrency: 'ILS' }), -150);
  assert.equal(effectiveAmount({ chargedAmount: 0, originalAmount: -40, originalCurrency: 'USD' }), -40);
  assert.equal(effectiveAmount({ chargedAmount: NaN, originalAmount: -77 }), -77);
});

test('נעילה בסיסמה: עטיפה/פענוח, סיסמה שגויה נדחית, ובפתיחה מחדש המערכת נעולה עד unlock', async () => {
  const { wrapWithPassphrase, unwrapWithPassphrase } = await import('../src/crypto.ts');
  const key = Buffer.alloc(32, 9);
  const blob = wrapWithPassphrase(key, 'correct horse');
  assert.deepEqual(unwrapWithPassphrase(blob, 'correct horse'), key);
  assert.throws(() => unwrapWithPassphrase(blob, 'wrong pass'), /סיסמה שגויה/);
  assert.ok(!blob.includes(key.toString('hex')) && !blob.includes(key.toString('base64')));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lock-'));
  const opts = { dataDir: dir, configPath: path.join(dir, 'x.yaml'), secretsPath: path.join(dir, 'y.yaml') };
  let o = openSettings(opts);
  o.settings.updateSecrets((s) => { s.sources.b1 = { username: 'u', password: 'TOPSECRET' }; });
  assert.throws(() => o.settings.enablePassphrase('short'), /קצרה/);
  o.settings.enablePassphrase('correct horse');
  assert.ok(!fs.existsSync(path.join(dir, '.keyfile')) && !fs.existsSync(path.join(dir, '.keyfile.dpapi')), 'אין עותק של המפתח שמוגן רק ע"י המחשב');
  o.store.close();

  o = openSettings(opts);
  assert.equal(o.settings.locked, true);
  assert.deepEqual(o.settings.secrets.sources, {}, 'נעול: אין סודות');
  assert.throws(() => o.settings.updateSecrets(() => {}), /נעולה/);
  assert.throws(() => o.settings.unlock('nope nope'), /שגויה/);
  assert.equal(o.settings.locked, true);
  o.settings.unlock('correct horse');
  assert.equal(o.settings.secrets.sources.b1?.password, 'TOPSECRET');
  assert.throws(() => o.settings.disablePassphrase('wrong'), /שגויה/);
  o.settings.disablePassphrase('correct horse');
  assert.ok(!fs.existsSync(path.join(dir, '.keyfile.pass')));
  o.store.close();
  o = openSettings(opts);
  assert.equal(o.settings.locked, false);
  assert.equal(o.settings.secrets.sources.b1?.password, 'TOPSECRET', 'הסודות נשארו קריאים אחרי ביטול הנעילה');
  o.store.close();
});
