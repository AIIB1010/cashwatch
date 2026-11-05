import fs from 'node:fs';
import path from 'node:path';

/**
 * לוגואים של בנקים וחברות אשראי: לא נשלחים עם התוכנה (סימנים מסחריים). התוכנה מורידה סמל קטן (favicon) מהאתר הרשמי של
 * כל ספק שהמשתמש הגדיר, פעם אחת, ושומרת אותו במחשב (data/logos). אם אין חיבור/סמל – מוצגת מונוגרמה צבעונית במקום.
 * הדומיינים קבועים בקוד (לא קלט משתמש), ולכן אין סיכון ל-SSRF.
 */
export const LOGO_DOMAINS: Record<string, string> = {
  hapoalim: 'www.bankhapoalim.co.il', leumi: 'www.leumi.co.il', mizrahi: 'www.mizrahi-tefahot.co.il', discount: 'www.discountbank.co.il',
  mercantile: 'www.mercantile.co.il', otsarHahayal: 'www.bankotsar.co.il', union: 'www.unionbank.co.il', beinleumi: 'www.fibi.co.il',
  massad: 'www.bank-massad.co.il', yahav: 'www.bank-yahav.co.il', pagi: 'www.pagi.co.il',
  isracard: 'www.isracard.co.il', amex: 'www.americanexpress.co.il', max: 'www.max.co.il', visaCal: 'www.cal-online.co.il', behatsdaa: 'www.behatsdaa.org.il',
};
const PATHS = ['/apple-touch-icon.png', '/favicon.ico', '/favicon.png'];
const MAX_BYTES = 300_000;

/** מזהה סוג תמונה לפי התוכן (לא לפי מה שהשרת טוען). SVG מוחרג בכוונה (יכול להכיל סקריפטים). */
export function sniffImage(b: Buffer): 'png' | 'ico' | 'jpg' | 'gif' | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length > 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'ico';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 6 && b.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  return null;
}

type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }>;
const failedAt = new Map<string, number>();
const inflight = new Map<string, Promise<string | null>>();

export function cachedLogo(dir: string, provider: string): string | null {
  for (const ext of ['png', 'ico', 'jpg', 'gif']) {
    const f = path.join(dir, `${provider}.${ext}`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** מחזיר נתיב קובץ הלוגו (מהמטמון, או אחרי הורדה). null אם אין. */
export async function getLogo(dir: string, provider: string, fetchFn: FetchFn = fetch as unknown as FetchFn, now = Date.now()): Promise<string | null> {
  const domain = LOGO_DOMAINS[provider];
  if (!domain) return null;
  const have = cachedLogo(dir, provider);
  if (have) return have;
  if ((failedAt.get(provider) ?? 0) > now - 6 * 3600_000) return null;
  const running = inflight.get(provider);
  if (running) return running;
  const job = (async () => {
    for (const p of PATHS) {
      try {
        const res = await fetchFn(`https://${domain}${p}`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 100 || buf.length > MAX_BYTES) continue;
        const ext = sniffImage(buf);
        if (!ext) continue;
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${provider}.${ext}`);
        fs.writeFileSync(file, buf);
        return file;
      } catch { /* מנסים את הנתיב הבא */ }
    }
    failedAt.set(provider, now);
    return null;
  })().finally(() => inflight.delete(provider));
  inflight.set(provider, job);
  return job;
}

export function resetLogoFailures(): void { failedAt.clear(); }

/** שמירת אייקון שהמשתמש העלה (מחליף כל אייקון קודם של אותו ספק). מחזיר false אם זו לא תמונה תקינה. */
export function saveCustomLogo(dir: string, provider: string, data: Buffer): boolean {
  if (data.length < 100 || data.length > MAX_BYTES) return false;
  const ext = sniffImage(data);
  if (!ext) return false;
  fs.mkdirSync(dir, { recursive: true });
  removeLogo(dir, provider);
  fs.writeFileSync(path.join(dir, `${provider}.${ext}`), data);
  failedAt.delete(provider);
  return true;
}

/** מוחק את האייקון השמור (הורד או הועלה); בבקשה הבאה ינסה שוב להוריד מהאתר הרשמי */
export function removeLogo(dir: string, provider: string): void {
  for (const ext of ['png', 'ico', 'jpg', 'gif']) fs.rmSync(path.join(dir, `${provider}.${ext}`), { force: true });
  failedAt.delete(provider);
}
