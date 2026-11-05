import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SYSTEM_BROWSERS } from './scrape/profile.ts';

/**
 * פותח את הדשבורד בחלון "אפליקציה" נקי (בלי לשוניות וכתובת), עם פרופיל נפרד – כך זה מרגיש כמו תוכנה
 * ולא כמו אתר בדפדפן הרגיל. נשען על Edge/Chrome שכבר מותקנים. אם אין – נפתח בדפדפן ברירת המחדל.
 */
export function openDashboardWindow(url: string, dataDir: string): void {
  try {
    const browser = SYSTEM_BROWSERS.find((p) => fs.existsSync(p));
    if (browser) {
      spawn(browser, [`--app=${url}`, `--user-data-dir=${path.join(dataDir, 'app-window')}`, '--window-size=1320,900', '--no-first-run', '--no-default-browser-check'], { stdio: 'ignore', detached: true }).unref();
      return;
    }
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  } catch { /* לא קריטי */ }
}
