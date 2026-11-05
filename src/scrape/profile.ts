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

/**
 * פרופיל הדפדפן (המכשיר המהימן) יכול להתנפח למאות מגה בגלל מטמונים, מודלים ורכיבים שכרום מוריד.
 * מוחקים אך ורק תיקיות מטמון מוכרות (רשימה סגורה) בתוך תיקיית הפרופיל – לא עוגיות, לא Local Storage ולא העדפות.
 * מחזיר כמה בייטים שוחררו (בקירוב).
 */
export const PROFILE_CACHE_DIRS = [
  'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'component_crx_cache', 'extensions_crx_cache', 'optimization_guide_model_store', 'OptGuideOnDeviceModel', 'screen_ai',
  'Service Worker/CacheStorage', 'Service Worker/ScriptCache', 'Safe Browsing', 'Subresource Filter', 'segmentation_platform',
  'Default/Cache', 'Default/Code Cache', 'Default/GPUCache', 'Default/DawnGraphiteCache', 'Default/DawnWebGPUCache',
  'Default/Service Worker/CacheStorage', 'Default/Service Worker/ScriptCache', 'Default/optimization_guide_prediction_model_downloads',
];

const dirSize = (d: string): number => {
  let n = 0;
  try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); n += e.isDirectory() ? dirSize(f) : fs.statSync(f).size; } } catch { /* ignore */ }
  return n;
};

export function pruneProfileCaches(profileDir: string): number {
  const root = path.resolve(profileDir);
  let freed = 0;
  for (const rel of PROFILE_CACHE_DIRS) {
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) continue; // הגנה: רק בתוך הפרופיל
    try { if (!fs.existsSync(target)) continue; freed += dirSize(target); fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return freed;
}
