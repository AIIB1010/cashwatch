import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getLogo, resetLogoFailures, sniffImage } from '../src/logos.ts';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const ok = (b: Buffer) => async () => ({ ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer });

test('לוגו: מורד פעם אחת, נשמר במטמון מקומי, ומזהה סוג לפי התוכן', async () => {
  resetLogoFailures();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-logo-'));
  let calls = 0;
  const f = async (...a: Parameters<ReturnType<typeof ok>>) => { calls++; return ok(PNG)(...a); };
  const file = await getLogo(dir, 'leumi', f);
  assert.ok(file && file.endsWith('leumi.png') && fs.existsSync(file));
  assert.equal(await getLogo(dir, 'leumi', f), file);
  assert.equal(calls, 1, 'הפעם השנייה מהמטמון');
  assert.equal(sniffImage(PNG), 'png');
});

test('לוגו: תשובה שאינה תמונה (HTML / SVG) נדחית, ספק לא מוכר לא מורד, וכישלון לא נבדק שוב מיד', async () => {
  resetLogoFailures();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-logo-'));
  const html = Buffer.from('<html>' + 'x'.repeat(300) + '</html>');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">' + ' '.repeat(300) + '</svg>');
  let calls = 0;
  const bad = async () => { calls++; return ok(html)(); };
  assert.equal(await getLogo(dir, 'max', bad), null);
  const first = calls;
  assert.equal(await getLogo(dir, 'max', bad), null);
  assert.equal(calls, first, 'אחרי כישלון לא מנסים שוב מיד');
  resetLogoFailures();
  assert.equal(await getLogo(dir, 'isracard', ok(svg)), null);
  assert.equal(await getLogo(dir, 'notAProvider', ok(PNG)), null);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('זיהוי שורת חיוב: ישראכרט כולל אמריקן אקספרס, אלא אם הוגדר מקור נפרד של אמריקן אקספרס', async () => {
  const { effectiveChargeMatch } = await import('../src/config.ts');
  assert.match(effectiveChargeMatch({ provider: 'isracard' }, [{ provider: 'isracard' }])!, /אמריקן/);
  assert.equal(effectiveChargeMatch({ provider: 'isracard' }, [{ provider: 'isracard' }, { provider: 'amex' }]), 'ישראכרט|isracard');
  assert.equal(effectiveChargeMatch({ provider: 'isracard', chargeMatch: 'xyz' }, [{ provider: 'amex' }]), 'xyz');
  assert.match(effectiveChargeMatch({ provider: 'amex' }, [{ provider: 'amex' }])!, /אמקס/);
});

test('אייקון שהמשתמש העלה מחליף את הקיים; קובץ שאינו תמונה נדחה; איפוס מוחק', async () => {
  const { saveCustomLogo, removeLogo, cachedLogo } = await import('../src/logos.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-logo-'));
  assert.equal(saveCustomLogo(dir, 'mizrahi', Buffer.from('<html>' + 'x'.repeat(300))), false);
  assert.equal(saveCustomLogo(dir, 'mizrahi', PNG), true);
  assert.ok(cachedLogo(dir, 'mizrahi')!.endsWith('mizrahi.png'));
  removeLogo(dir, 'mizrahi');
  assert.equal(cachedLogo(dir, 'mizrahi'), null);
});
