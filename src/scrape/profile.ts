import fs from 'node:fs';
import path from 'node:path';

/** מנקה נעילות שנשארו מדפדפן שנסגר באלימות, כדי שהפרופיל יהיה שמיש שוב */
export function clearProfileLocks(dir: string): void {
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* ignore */ }
  }
}

/** דפי בית של הספקים – לפתיחה ידנית בכניסה חד-פעמית */
export const LOGIN_URLS: Record<string, string> = {
  hapoalim: 'https://login.bankhapoalim.co.il/ng-portals/auth/he/',
  leumi: 'https://www.leumi.co.il/',
  mizrahi: 'https://www.mizrahi-tefahot.co.il/',
  discount: 'https://www.discountbank.co.il/',
  isracard: 'https://www.isracard.co.il/',
  amex: 'https://www.americanexpress.co.il/',
  max: 'https://www.max.co.il/',
  visaCal: 'https://www.cal-online.co.il/',
};

export const SYSTEM_BROWSERS = [
  process.env['ProgramFiles(x86)'] && `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  process.env.ProgramFiles && `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  process.env.ProgramFiles && `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  process.env['ProgramFiles(x86)'] && `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter((x): x is string => !!x);

/**
 * איזה דפדפן להפעיל: משתנה סביבה > ה-Chromium שהותקן עם puppeteer > Chrome/Edge שמותקנים במחשב.
 * כך אפשר להתקין את התוכנה בלי להוריד Chromium נפרד (חוסך כ-150MB).
 */
export async function resolveBrowserPath(): Promise<string | undefined> {
  const env = process.env.CHROMIUM_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (env) return env;
  try {
    const bundled = (await import('puppeteer')).default.executablePath();
    if (bundled && fs.existsSync(bundled)) return undefined; // ברירת המחדל של puppeteer
  } catch { /* ממשיכים לחיפוש */ }
  return SYSTEM_BROWSERS.find((p) => fs.existsSync(p));
}
