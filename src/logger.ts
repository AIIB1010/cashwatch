import fs from 'node:fs';
import path from 'node:path';

/** לוג לקובץ (data/cashwatch.log) ולמסך. קובץ הלוג מקוצר כשהוא גדל, ומשמש לאבחון תקלות (אין בו סיסמאות). */
export function makeLogger(dataDir: string): (msg: string) => void {
  const file = path.join(dataDir, 'cashwatch.log');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(-300_000));
  } catch { /* לא קריטי */ }
  return (msg: string) => {
    const line = `${new Date().toISOString()} ${msg}`;
    console.log(`${line.slice(11, 19)} ${msg}`);
    try { fs.appendFileSync(file, `${line}\n`); } catch { /* לא קריטי */ }
  };
}
