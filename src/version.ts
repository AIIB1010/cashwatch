import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** גרסת התוכנה מתוך package.json (מחפשים כלפי מעלה מתיקיית הקוד) */
export const APP_VERSION: string = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const f = path.join(dir, 'package.json');
    if (fs.existsSync(f)) { try { return String(JSON.parse(fs.readFileSync(f, 'utf8')).version); } catch { return '?'; } }
    dir = path.dirname(dir);
  }
  return '?';
})();
