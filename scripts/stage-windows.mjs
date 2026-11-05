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

// מדלגים על data/build/.git רק ברמה העליונה של הפרויקט. (בעבר סיננו כל תיקייה בשם build גם בתוך node_modules,
// וזה שבר חבילות כמו lines-and-columns שהקוד שלהן בתיקיית build.)
const TOP_SKIP = new Set(['data', 'build', '.git']);
const copy = (rel) => fs.cpSync(path.join(root, rel), path.join(stage, rel), { recursive: true, filter: (src) => !TOP_SKIP.has(path.relative(root, src).split(path.sep)[0]) || path.relative(root, src) === rel && !TOP_SKIP.has(rel) });
for (const rel of ['src', 'web', 'windows', 'node_modules', 'package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) if (fs.existsSync(path.join(root, rel))) copy(rel);
// ודאות שלמות: מספר הקבצים ב-node_modules של החבילה זהה למקור (אחרת חסרים קבצים והתוכנה תישבר בזמן ריצה)
const countFiles = (dir) => { let n = 0; for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1; return n; };
const a = countFiles(path.join(root, 'node_modules')), b = countFiles(path.join(stage, 'node_modules'));
if (a !== b) { console.error(`node_modules בחבילה לא שלם: ${b} קבצים מתוך ${a}`); process.exit(1); }
fs.mkdirSync(path.join(stage, 'runtime'), { recursive: true });
fs.copyFileSync(nodeExe, path.join(stage, 'runtime', 'node.exe'));
// ודאות: אין סודות/נתונים בחבילה
for (const bad of ['data', 'secrets.yaml', 'config.yaml', '.keyfile']) if (fs.existsSync(path.join(stage, bad))) { console.error('נמצא קובץ אסור בחבילה:', bad); process.exit(1); }
console.log('stage מוכן:', stage);
