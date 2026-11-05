import fs from 'node:fs';
import { withBrowserLock } from './lock.ts';
import { clearProfileLocks, resolveBrowserPath } from './profile.ts';

/**
 * כניסה ידנית חד-פעמית: חלון דפדפן גלוי עם הפרופיל הקבוע של המקור. המשתמש מתחבר בעצמו
 * (כולל קוד אימות) והבנק "זוכר את המכשיר". מסתיים כשהחלון נסגר.
 */
export function interactiveLogin(opts: { profileDir: string; url: string; onOpen?: () => void }): Promise<void> {
  return withBrowserLock(() => interactiveLoginLocked(opts));
}

async function interactiveLoginLocked(opts: { profileDir: string; url: string; onOpen?: () => void }): Promise<void> {
  fs.mkdirSync(opts.profileDir, { recursive: true });
  clearProfileLocks(opts.profileDir);
  const puppeteer = (await import('puppeteer')).default;
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: await resolveBrowserPath(),
    userDataDir: opts.profileDir,
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
  });
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.goto(opts.url).catch(() => {});
  opts.onOpen?.();
  // לא משאירים חלון פתוח (ומנעול דפדפן תפוס) לנצח
  const limit = setTimeout(() => { void browser.close().catch(() => {}); }, 15 * 60_000);
  await new Promise<void>((resolve) => browser.on('disconnected', () => resolve()));
  clearTimeout(limit);
}
