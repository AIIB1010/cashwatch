import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Store } from './db.ts';

/**
 * עדכון מגרסאות ב-GitHub (Releases). הנתונים (תיקיית data) לא נוגעים בעדכון: המתקין מחליף רק את קבצי התוכנה.
 * בדיקה: פעם ביום מול api.github.com (אפשר לכבות). התקנה אוטומטית: רק בהתקנה מקובץ ההתקנה (יש runtime\node.exe), ב-Windows.
 * אימות: חובה קובץ checksum (SHA-256) מצורף לאותו Release. הערה: זה מגן מפני הורדה פגומה, לא מפני חשבון GitHub שנפרץ
 * (בשביל זה צריך חתימה דיגיטלית על הקובץ).
 */
export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  releaseUrl?: string;
  notes?: string;
  assetUrl?: string;
  sha256Url?: string;
  checkedAt: string;
  error?: string;
}

export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const parse = (v: string): number[] => v.replace(/^v/, '').split('-')[0]!.split('.').map((x) => Number.parseInt(x, 10) || 0);
/** חיובי אם a חדשה מ-b */
export function compareVersions(a: string, b: string): number {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; }
  return 0;
}

type FetchFn = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;
const ALLOWED_HOSTS = /^https:\/\/(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)\//;

export async function checkForUpdate(repo: string, current: string, fetchFn: FetchFn = fetch as unknown as FetchFn, now = new Date()): Promise<UpdateInfo> {
  const base: UpdateInfo = { current, latest: null, available: false, checkedAt: now.toISOString() };
  if (!REPO_RE.test(repo)) return { ...base, error: 'שם פרויקט לא תקין' };
  try {
    const res = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/vnd.github+json', 'User-Agent': `CashWatch/${current}` } });
    if (res.status === 404) return { ...base, error: 'לא נמצא Release ציבורי (הפרויקט פרטי, או שעוד לא פורסמה גרסה)' };
    if (!res.ok) return { ...base, error: `GitHub החזיר ${res.status}` };
    const j = (await res.json()) as { tag_name?: string; html_url?: string; body?: string; draft?: boolean; prerelease?: boolean; assets?: Array<{ name: string; browser_download_url: string }> };
    if (!j.tag_name || j.draft || j.prerelease) return base;
    const latest = j.tag_name.replace(/^v/, '');
    const exe = j.assets?.find((a) => /^CashWatch-Setup-[\d.]+\.exe$/.test(a.name));
    const sha = exe ? j.assets?.find((a) => a.name === `${exe.name}.sha256`) : undefined;
    return {
      ...base, latest, available: compareVersions(latest, current) > 0, releaseUrl: j.html_url, notes: (j.body ?? '').slice(0, 2000),
      assetUrl: exe && ALLOWED_HOSTS.test(exe.browser_download_url) ? exe.browser_download_url : undefined,
      sha256Url: sha && ALLOWED_HOSTS.test(sha.browser_download_url) ? sha.browser_download_url : undefined,
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

/** מוריד את המתקין, מאמת SHA-256 מול הקובץ שבאותו Release, ומחזיר נתיב. זורק שגיאה אם האימות נכשל. */
export async function downloadInstaller(info: UpdateInfo, dir: string, fetchFn: FetchFn = fetch as unknown as FetchFn): Promise<string> {
  if (!info.assetUrl || !info.sha256Url) throw new Error('ל-Release אין קובץ התקנה עם checksum – אי אפשר לעדכן אוטומטית. הורד ידנית מדף ה-Release.');
  const want = ((await (await fetchFn(info.sha256Url, { signal: AbortSignal.timeout(30_000) })).text()).trim().split(/\s+/)[0] ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) throw new Error('קובץ ה-checksum לא תקין');
  const res = await fetchFn(info.assetUrl, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`הורדת המתקין נכשלה (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000 || buf.length > 400_000_000) throw new Error('גודל המתקין חריג');
  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== want) throw new Error('אימות ה-checksum נכשל – הקובץ שהורד לא תואם. העדכון בוטל.');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `CashWatch-Setup-${info.latest}.exe`);
  fs.writeFileSync(file, buf);
  return file;
}

export function projectRootDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) { if (fs.existsSync(path.join(dir, 'package.json'))) return dir; dir = path.dirname(dir); }
  return process.cwd();
}

/** התקנה מקובץ ההתקנה (עם Node מובנה): רק שם אפשר להחליף קבצים בבטחה אוטומטית */
export function canAutoInstall(root = projectRootDir(), platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && fs.existsSync(path.join(root, 'runtime', 'node.exe')) && fs.existsSync(path.join(root, 'windows', 'update.ps1'));
}

/** מפעיל את סקריפט העדכון (מנותק מהתהליך הזה), שעוצר את התוכנה, מריץ את המתקין בשקט ומפעיל מחדש. אחרי הקריאה התוכנה צפויה להיסגר. */
export function launchUpdater(installer: string, root = projectRootDir()): void {
  const script = path.join(root, 'windows', 'update.ps1');
  spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-Installer', installer, '-Root', root], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

const KV_CHECK = 'update_info';
export const readCachedUpdate = (store: Store): UpdateInfo | null => { try { const r = store.getKv(KV_CHECK); return r ? (JSON.parse(r) as UpdateInfo) : null; } catch { return null; } };
export const cacheUpdate = (store: Store, info: UpdateInfo): void => store.setKv(KV_CHECK, JSON.stringify(info));
