// מכין את תיקיית build/stage שממנה נבנה קובץ ההתקנה: קוד + node_modules + Node מובנה (runtime/node.exe).
// רץ ב-CI אחרי `npm ci`. שימוש: node scripts/stage-windows.mjs <path-to-node.exe>
import fs from 'node:fs';
import path from 'node:path';

const nodeExe = process.argv[2];
if (!nodeExe || !fs.existsSync(nodeExe)) { console.error('חסר נתיב ל-node.exe (ארגומנט ראשון)'); process.exit(1); }
const root = path.resolve(import.meta.dirname, '..');
const stage = path.join(root, 'build', 'stage');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

const copy = (rel) => fs.cpSync(path.join(root, rel), path.join(stage, rel), { recursive: true, filter: (src) => !/[\\/](data|build|\.git)([\\/]|$)/.test(src.slice(root.length)) });
for (const rel of ['src', 'web', 'windows', 'node_modules', 'package.json', 'package-lock.json', 'tsconfig.json', 'README.md']) copy(rel);
fs.mkdirSync(path.join(stage, 'runtime'), { recursive: true });
fs.copyFileSync(nodeExe, path.join(stage, 'runtime', 'node.exe'));
// ודאות: אין סודות/נתונים בחבילה
for (const bad of ['data', 'secrets.yaml', 'config.yaml', '.keyfile']) if (fs.existsSync(path.join(stage, bad))) { console.error('נמצא קובץ אסור בחבילה:', bad); process.exit(1); }
console.log('stage מוכן:', stage);
