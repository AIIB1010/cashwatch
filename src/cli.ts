import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { createContext, runDaily, type AppContext } from './app.ts';
import { configSchema, secretsSchema } from './config.ts';
import { makeLogger } from './logger.ts';
import { openSettings, Settings } from './settings.ts';
import { loadOrCreateKey } from './crypto.ts';
import { interactiveLogin } from './scrape/interactive.ts';
import { Store } from './db.ts';
import { addDays, todayIn } from './engine/dates.ts';
import { buildAlertMessage, buildChannels, dispatch, type Channel } from './notify/channels.ts';
import { demoDates, MockScrapeProvider } from './scrape/mock.ts';
import { RealScrapeProvider } from './scrape/real.ts';
import { LOGIN_URLS } from './scrape/profile.ts';
import { ERROR_HINTS } from './scrape/types.ts';
import { startServer } from './server.ts';

let log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

/** טוען את ההגדרות מה-DB (ומייבא פעם אחת מ-config.yaml/secrets.yaml אם קיימים) */
function loadAll() {
  const o = openSettings();
  if (o.imported) log('ℹ️  ייבאתי את ההגדרות מ-config.yaml / secrets.yaml. מעכשיו מנהלים אותן מדף ההגדרות בדשבורד.');
  const { config, secrets } = o.settings;
  const warnings: string[] = [];
  if (!config.banks.length && !config.cards.length) warnings.push('עוד לא הוגדרו בנקים/כרטיסים – הוסף בדשבורד, בלשונית "הגדרות".');
  if (!buildChannels(config, secrets).length) warnings.push('אין ערוץ התראות פעיל – הגדר בדשבורד, בהגדרות. (עד אז לא תקבל התראות)');
  return { config, secrets, settings: o.settings, store: o.store, paths: { dataDir: o.dataDir }, warnings };
}

function realContext(): AppContext {
  const { settings, store, paths, warnings } = loadAll();
  log = makeLogger(paths.dataDir);
  warnings.forEach((w) => log(`⚠️  ${w}`));
  return createContext({ settings, store, provider: new RealScrapeProvider(), dataDir: paths.dataDir, log: (m) => log(m) });
}

async function cmdServe() {
  const ctx = realContext();
  startServer(ctx);
  process.on('SIGTERM', () => process.exit(0));
}

async function cmdRun() {
  const ctx = realContext();
  const s = await runDaily(ctx, 'cli');
  log(`סיום: ${s.sources.filter((x) => x.ok).length}/${s.sources.length} מקורות הצליחו, ${s.findings} ממצאים, ${s.notified} התראות נשלחו`);
  for (const r of s.sources.filter((x) => !x.ok)) log(`❌ ${r.sourceId}: ${r.error}`);
  process.exit(s.ok ? 0 : 2);
}

async function cmdCheckConfig() {
  const { config, secrets, warnings } = loadAll();
  log(`✅ הגדרות תקינות: ${config.banks.length} בנקים, ${config.cards.length} כרטיסים, ריצה ב-${config.schedule.times.join(', ')}`);
  warnings.forEach((w) => log(`⚠️  ${w}`));
  const channels = buildChannels(config, secrets);
  log(`ערוצי התראות פעילים: ${channels.map((c) => c.name).join(', ') || 'אין'}`);
}

async function cmdTestNotify() {
  const { config, secrets } = loadAll();
  const channels = buildChannels(config, secrets);
  if (!channels.length) { log('אין ערוץ פעיל בהגדרות'); process.exit(1); }
  const res = await dispatch(channels, buildAlertMessage([{ severity: 'info', title: 'בדיקת התראה', body: 'אם קיבלת את זה – ההתראות עובדות ✅' }], config.dashboard.publicUrl));
  log(`נשלח: ${res.sent.join(', ') || '—'}`);
  res.failed.forEach((f) => log(`❌ ${f.name}: ${f.error}`));
  process.exit(res.failed.length ? 1 : 0);
}

/** יצירה חד-פעמית של טוקן אימות דו-שלבי ארוך טווח (One Zero) ושמירתו מוצפן בהגדרות */
async function cmdOtpSetup(id: string | undefined) {
  if (!id) throw new Error('שימוש: npm run otp-setup -- <id של הבנק מה-config>');
  const { config, settings } = loadAll();
  const bank = config.banks.find((b) => b.id === id);
  if (!bank) throw new Error(`לא נמצא בנק "${id}" בהגדרות`);
  if (bank.provider !== 'oneZero') throw new Error(`אימות OTP חד-פעמי נתמך כרגע רק ב-oneZero (הספק של "${id}" הוא ${bank.provider}).`);
  const creds = settings.secrets.sources[id];
  if (!creds?.phoneNumber) throw new Error('חסר מספר טלפון בפרטי ההתחברות. הוסף אותו בדף ההגדרות בדשבורד.');
  const lib = await import('israeli-bank-scrapers');
  const scraper = lib.createScraper({ companyId: lib.CompanyTypes.oneZero, startDate: new Date() } as never);
  const trig = await scraper.triggerTwoFactorAuth(creds.phoneNumber);
  if (!trig.success) throw new Error(`שליחת קוד נכשלה: ${trig.errorMessage}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question('הזן את קוד ה-SMS שקיבלת: ')).trim();
  rl.close();
  const res = await scraper.getLongTermTwoFactorToken(code);
  if (!res.success) throw new Error(`אימות נכשל: ${res.errorMessage}`);
  settings.updateSecrets((sec) => { sec.sources[id] = { ...(sec.sources[id] ?? {}), otpLongTermToken: res.longTermTwoFactorAuthToken }; });
  log('✅ הטוקן נשמר (מוצפן). מעתה ההתחברות אוטומטית ללא SMS.');
}

/** הדגמה עם נתוני דמה – בלי התחברות לשום בנק */
async function cmdDemo() {
  const dir = path.resolve('data/demo');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const config = configSchema.parse({
    banks: [
      { id: 'poalim', provider: 'hapoalim', label: 'הפועלים – משותף', overdraftLimit: 8000 },
      { id: 'leumi', provider: 'leumi', label: 'לאומי – פרטי', overdraftLimit: 3000 },
    ],
    cards: [
      { id: 'isracard-1', provider: 'isracard', label: 'ישראכרט 4580', fundingAccount: 'poalim' },
      { id: 'max-1', provider: 'max', label: 'מקס 9921', fundingAccount: 'leumi' },
    ],
    dashboard: { port: Number(process.env.PORT ?? 8099) },
    alerts: { reminderHours: 24, okDigest: 'never' },
  });
  const secrets = secretsSchema.parse({ sources: Object.fromEntries(['poalim', 'leumi', 'isracard-1', 'max-1'].map((i) => [i, { username: 'demo', password: 'demo' }])) });
  const store = new Store(path.join(dir, 'demo.db'));
  const settings = new Settings(store, dir, loadOrCreateKey(dir));
  settings.updateConfig((c) => { Object.assign(c, config); });
  settings.updateSecrets((sec) => { Object.assign(sec, secrets); });
  const today = todayIn(config.timezone);
  const D = demoDates(today);
  const dom = (d: string) => Number(d.slice(8, 10));
  const R = (name: string, kind: 'expense' | 'income', accountId: string, amount: number, day: number, match: string | null, tol = 10) =>
    store.saveRecurring({ name, kind, accountId, amount, dayOfMonth: day, intervalMonths: 1, anchorMonth: null, match, tolerancePct: tol, graceDays: 3, active: true, startDate: null, endDate: null, note: '' });
  R('משכורת', 'income', 'poalim', 14500, dom(D.salary), 'הייטק');
  R('שכר דירה', 'expense', 'poalim', 4200, dom(D.rent), 'שכר דירה');
  R('ארנונה', 'expense', 'poalim', 380, dom(D.arnona), 'ארנונה');
  R('משכנתא', 'expense', 'poalim', 5200, dom(addDays(today, 3)), 'משכנתא');
  R('החזר מס', 'income', 'poalim', 1800, dom(D.missingIncome), 'מס הכנסה');
  R('ועד בית', 'expense', 'poalim', 250, dom(D.missingExpense), 'ועד');
  R('ביטוח בריאות', 'expense', 'leumi', 650, dom(D.insurance), 'הראל');
  R('עבודה צדדית', 'income', 'leumi', 3200, dom(D.sideJob), 'עבודה צדדית');
  R('החזר הלוואה', 'expense', 'leumi', 1500, dom(addDays(today, 5)), null);
  const consoleChannel: Channel = { name: 'console', async send(m) { console.log(`\n──── התראה (הדגמה) ────\n${m.text}\n───────────────────────\n`); } };
  const ctx = createContext({ settings, store, provider: new MockScrapeProvider(today), dataDir: dir, log, channels: [consoleChannel], fast: true });
  await runDaily(ctx, 'demo');
  process.env.CASHWATCH_NO_CATCHUP = '1';
  startServer(ctx);
}

/**
 * כניסה ידנית חד-פעמית: פותח חלון דפדפן גלוי עם הפרופיל הקבוע של המקור.
 * מתחברים בעצמך (כולל קוד אימות – אפשר לבחור שיחה קולית), מסמנים "זכור מכשיר" אם יש,
 * ואז סוגרים את החלון. מעתה הריצות האוטומטיות משתמשות באותו פרופיל ("מכשיר מוכר").
 */
async function cmdBrowserLogin(id: string | undefined, urlArg: string | undefined) {
  if (!id) throw new Error('שימוש: npm run browser-login -- <id> [כתובת]');
  const { config, paths } = loadAll();
  const src = [...config.banks, ...config.cards].find((s) => s.id === id);
  if (!src) throw new Error(`לא נמצא מקור "${id}" בהגדרות`);
  console.log(`\nנפתח חלון דפדפן עבור "${src.label}".\n1. היכנס לחשבון כרגיל (אם מבקשים קוד – בחר שיחה קולית).\n2. אם יש אפשרות "זכור מכשיר / מכשיר מהימן" – סמן אותה.\n3. אחרי שנכנסת לחשבון, סגור את חלון הדפדפן.\nמחכה לסגירת החלון…`);
  await interactiveLogin({ profileDir: path.join(paths.dataDir, 'browser-profiles', id), url: urlArg ?? LOGIN_URLS[src.provider] ?? 'about:blank' });
  console.log('✅ הפרופיל נשמר. עכשיו הרץ: npm run test-connection -- ' + id);
}

/**
 * בדיקת חיבור בסיסית למקור אחד (או לכולם): נכנס לאתר, מושך נתונים ומדפיס סיכום.
 * לא כותב ל-DB ולא שולח התראות – רק בודק שההתחברות וההתמשקות עובדות.
 */
async function cmdTestConnection(target: string | undefined) {
  const { config, secrets, warnings, paths } = loadAll();
  warnings.filter((w) => !w.includes('ערוץ התראות') && !w.includes('smtp')).forEach((w) => log(`⚠️  ${w}`));
  const all = [
    ...config.banks.map((b) => ({ kind: 'bank' as const, id: b.id, provider: b.provider, label: b.label })),
    ...config.cards.map((c) => ({ kind: 'card' as const, id: c.id, provider: c.provider, label: c.label })),
  ];
  const picked = !target || target === 'all' ? (target === 'all' ? all : []) : all.filter((s) => s.id === target);
  if (!picked.length) {
    console.log(`שימוש: npm run test-connection -- <id>|all [--show]\nמקורות מוגדרים: ${all.map((s) => s.id).join(', ') || '(אין – מלא config.yaml)'}`);
    process.exit(1);
  }
  const provider = new RealScrapeProvider();
  const mask = (n: string) => (n.length > 4 ? `…${n.slice(-4)}` : n);
  let failed = 0;
  for (const src of picked) {
    const creds = secrets.sources[src.id];
    console.log(`\n━━━ ${src.label} (${src.id} · ${src.provider}) ━━━`);
    if (!creds) { console.log('❌ חסרים פרטי התחברות (הוסף בדף ההגדרות בדשבורד)'); failed++; continue; }
    const t0 = Date.now();
    const out = await provider.scrape({
      sourceId: src.id, provider: src.provider, kind: src.kind, credentials: creds,
      startDate: new Date(Date.now() - 30 * 86_400_000), futureMonths: config.scraping.futureMonths, timeZone: config.timezone,
      timeoutMs: config.scraping.attemptTimeoutSeconds * 1000, failureScreenshotDir: path.join(paths.dataDir, 'failures'),
      profileDir: path.join(paths.dataDir, 'browser-profiles', src.id),
    }).catch((e) => ({ ok: false as const, errorType: 'EXCEPTION', errorMessage: e instanceof Error ? e.message : String(e) }));
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (!out.ok) {
      console.log(`❌ נכשל אחרי ${secs}ש׳: ${out.errorType} – ${out.errorMessage}`);
      console.log(`   ${ERROR_HINTS[out.errorType] ?? 'הרץ שוב עם --show כדי לראות את הדפדפן, ובדוק data/failures/ לצילום מסך.'}`);
      failed++;
      continue;
    }
    console.log(`✅ התחברות הצליחה (${secs}ש׳) – ${out.accounts.length} ${src.kind === 'bank' ? 'חשבונות' : 'כרטיסים'}`);
    for (const a of out.accounts) {
      const dates = a.txns.map((t) => t.date).sort();
      console.log(`  • ${mask(a.accountNumber)}  ${a.balance !== undefined ? `יתרה: ${a.balance.toLocaleString('he-IL')}` : src.kind === 'bank' ? '⚠️ יתרה לא הוחזרה' : ''}  תנועות: ${a.txns.length}${dates.length ? ` (${dates[0]} → ${dates.at(-1)})` : ''}  ממתינות: ${a.txns.filter((t) => t.status === 'pending').length}`);
      for (const t of [...a.txns].sort((x, y) => (x.date < y.date ? 1 : -1)).slice(0, 5)) {
        console.log(`      ${t.date}${src.kind === 'card' ? ` (חיוב ${t.processedDate})` : ''}  ${String(t.amount.toFixed(2)).padStart(10)}  ${t.status === 'pending' ? '[ממתין] ' : ''}${t.description.slice(0, 40)}`);
      }
      if (src.kind === 'bank' && a.balance === undefined) failed++;
    }
  }
  console.log(failed ? `\n${failed} מקורות דורשים טיפול.` : '\n🎉 כל המקורות שנבדקו עובדים.');
  process.exit(failed ? 1 : 0);
}

const [cmd, arg] = process.argv.slice(2).filter((a) => a !== '--show');
if (process.argv.includes('--show')) process.env.CASHWATCH_SHOW_BROWSER = '1';
const commands: Record<string, () => Promise<void>> = {
  serve: cmdServe, run: cmdRun, 'check-config': cmdCheckConfig, 'test-notify': cmdTestNotify,
  mcp: async () => (await import('./mcp.ts')).runMcpStdio(),
  'otp-setup': () => cmdOtpSetup(arg), 'test-connection': () => cmdTestConnection(arg), 'browser-login': () => cmdBrowserLogin(arg, process.argv[4]), demo: cmdDemo,
};
const fn = commands[cmd ?? 'serve'];
if (!fn) { console.error(`פקודות: ${Object.keys(commands).join(' | ')}`); process.exit(1); }
fn().catch((e) => { console.error(`❌ ${e instanceof Error ? e.message : e}`); process.exit(1); });
