import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * הגנת המפתח. ב-Windows המפתח עטוף ב-DPAPI (קשור למשתמש ה-Windows הנוכחי): קובץ data/.keyfile.dpapi לא ניתן
 * לפענוח במחשב אחר או במשתמש אחר, גם אם מעתיקים את תיקיית ה-data כולה (גיבוי, זיפ שנשלח בטעות, גניבת קבצים).
 * בשאר המערכות (Mac/Linux/Docker) המפתח נשמר בקובץ data/.keyfile בהרשאות 600, או נגזר מ-CASHWATCH_MASTER_KEY.
 * מגבלה: קוד זדוני שרץ תחת אותו משתמש Windows יכול לבקש מ-DPAPI לפענח – ממנו אי אפשר להגן בתוכנה מקומית.
 */
export interface KeyDeps {
  platform: NodeJS.Platform;
  protect: (raw: Buffer) => Buffer;
  unprotect: (blob: Buffer) => Buffer;
}

const DPAPI_ENTROPY = 'cashwatch-v1';

function runPowerShell(script: string, input: string): string {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { input, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (r.error || r.status !== 0) throw new Error(`DPAPI נכשל: ${(r.error?.message ?? r.stderr ?? '').toString().trim().slice(0, 200)}`);
  return r.stdout.trim();
}
const PS_HEAD = `Add-Type -AssemblyName System.Security; $e=[Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}'); $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); `;
const windowsDeps: KeyDeps = {
  platform: 'win32',
  protect: (raw) => Buffer.from(runPowerShell(`${PS_HEAD}[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$e,'CurrentUser')))`, raw.toString('base64')), 'base64'),
  unprotect: (blob) => Buffer.from(runPowerShell(`${PS_HEAD}[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$e,'CurrentUser')))`, blob.toString('base64')), 'base64'),
};

const keyCache = new Map<string, Buffer>();

/** מוחק קובץ רגיש: דורס בתוכן אקראי ואז מוחק (על SSD אין ערובה מלאה, אבל זה עדיף על מחיקה רגילה) */
export function shredFile(file: string): void {
  try {
    const size = fs.statSync(file).size;
    fs.writeFileSync(file, randomBytes(Math.max(size, 64)));
  } catch { /* ממשיכים למחיקה */ }
  fs.unlinkSync(file);
}

export function loadOrCreateKey(dataDir: string, deps?: Partial<KeyDeps>): Buffer {
  const env = process.env.CASHWATCH_MASTER_KEY;
  if (env) return scryptSync(env, 'cashwatch-v1', 32);
  const platform = deps?.platform ?? process.platform;
  const useDpapi = platform === 'win32' && process.env.CASHWATCH_NO_DPAPI !== '1';
  const d: KeyDeps = { ...windowsDeps, ...deps, platform };
  const cacheKey = `${path.resolve(dataDir)}|${useDpapi}`;
  if (!deps && keyCache.has(cacheKey)) return keyCache.get(cacheKey)!;
  const done = (k: Buffer) => { if (!deps) keyCache.set(cacheKey, k); return k; };

  const plain = path.join(dataDir, '.keyfile');
  const wrapped = path.join(dataDir, '.keyfile.dpapi');
  fs.mkdirSync(dataDir, { recursive: true });

  if (useDpapi) {
    if (fs.existsSync(wrapped)) {
      try {
        const k = d.unprotect(Buffer.from(fs.readFileSync(wrapped, 'utf8').trim(), 'base64'));
        if (k.length !== 32) throw new Error('אורך מפתח לא תקין');
        // אם נשאר קובץ גלוי (למשל קריסה באמצע מעבר קודם) והוא זהה למפתח העטוף – מוחקים אותו
        try { if (fs.existsSync(plain) && Buffer.from(fs.readFileSync(plain, 'utf8').trim(), 'hex').equals(k)) shredFile(plain); } catch { /* לא קריטי */ }
        return done(k);
      } catch (e) {
        throw new Error(`לא ניתן לפענח את מפתח ההצפנה (${wrapped}). כנראה שתיקיית data הועתקה ממחשב או ממשתמש Windows אחר. פרטי ההתחברות השמורים לא ניתנים לשחזור – יש להזין אותם מחדש בהגדרות (אפשר למחוק את הקובץ הזה ואת ערך ה-secrets, ולהתחיל מחדש). ${e instanceof Error ? e.message : e}`);
      }
    }
    // מעבר: מפתח ישן בקובץ רגיל -> עטיפה ב-DPAPI, אימות, ומחיקה מאובטחת של הקובץ הרגיל
    try {
      let key: Buffer;
      const hadPlain = fs.existsSync(plain);
      if (hadPlain) {
        key = Buffer.from(fs.readFileSync(plain, 'utf8').trim(), 'hex');
        if (key.length !== 32) throw new Error(`קובץ המפתח ${plain} פגום`);
      } else key = randomBytes(32);
      const blob = d.protect(key);
      if (!d.unprotect(blob).equals(key)) throw new Error('אימות עטיפת המפתח נכשל');
      fs.writeFileSync(wrapped, blob.toString('base64'));
      if (hadPlain) shredFile(plain);
      return done(key);
    } catch (e) {
      // אם PowerShell/DPAPI לא זמינים – לא מפילים את המערכת: חוזרים לקובץ מפתח רגיל (פחות מוגן) ומזהירים
      console.warn(`⚠️ לא הצלחתי להגן על מפתח ההצפנה עם Windows (${e instanceof Error ? e.message : e}). המפתח נשמר בקובץ רגיל.`);
      try { fs.rmSync(wrapped, { force: true }); } catch { /* ignore */ }
    }
  }

  if (fs.existsSync(plain)) {
    const k = Buffer.from(fs.readFileSync(plain, 'utf8').trim(), 'hex');
    if (k.length === 32) return done(k);
    throw new Error(`קובץ המפתח ${plain} פגום`);
  }
  const key = randomBytes(32);
  fs.writeFileSync(plain, key.toString('hex'), { mode: 0o600 });
  return done(key);
}

export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return `v1.${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
}

export function decrypt(key: Buffer, token: string): string {
  if (!token.startsWith('v1.')) throw new Error('פורמט הצפנה לא מוכר');
  const raw = Buffer.from(token.slice(3), 'base64');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
