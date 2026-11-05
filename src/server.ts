import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns/promises';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { cancelRun, computeAnalysis, getProgress, isRunning, runDaily, type AppContext } from './app.ts';
import { todayIn } from './engine/dates.ts';
import { openDashboardWindow } from './openApp.ts';
import { isRunDue } from './schedule.ts';
import { registerSettingsApi } from './settingsApi.ts';
import { withHint } from './scrape/types.ts';
import { getLogo, removeLogo, saveCustomLogo } from './logos.ts';
import { apiV1Router } from './apiV1.ts';
import { cleanupIssuerItems, detectAndFile, explainDetection } from './patterns.ts';

export { APP_VERSION } from './version.ts';
import { APP_VERSION } from './version.ts';

function projectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'web', 'index.html'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('לא נמצאה תיקיית web');
}

const recurringSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['expense', 'income']),
  accountId: z.string(),
  amount: z.number().positive().max(10_000_000),
  dayOfMonth: z.number().int().min(1).max(31),
  intervalMonths: z.number().int().min(1).max(12).default(1),
  anchorMonth: z.string().regex(/^\d{4}-\d{2}$/).nullable().default(null),
  match: z.string().max(120).nullable().default(null),
  tolerancePct: z.number().min(0).max(1000).default(10),
  graceDays: z.number().int().min(0).max(20).default(3),
  active: z.boolean().default(true),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  note: z.string().max(300).default(''),
});

/** "מועמדים" ליתרה שנשמרו באיסוף האחרון (אם הבנק לא החזיר יתרה) */
function readBalanceHints(dataDir: string, id: string): Array<{ from: string; value: number }> {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dataDir, `debug-${id}.json`), 'utf8')) as { candidates?: Array<{ from: string; value: number }> };
    return (info.candidates ?? []).filter((c) => typeof c.value === 'number').slice(0, 8);
  } catch { return []; }
}

export function createApp(ctx: AppContext, hooks: { onScheduleChange?: () => void } = {}): express.Express {
  const app = express();
  const password = ctx.secrets.dashboardPassword;
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // API פתוח (v1) – מאומת בטוקן משלו, לכן מורכב לפני סיסמת הדשבורד
  app.use('/api/v1', apiV1Router(ctx));

  if (password) {
    const want = Buffer.from(password);
    app.use((req, res, next) => {
      const h = req.headers.authorization ?? '';
      if (h.startsWith('Basic ')) {
        const given = Buffer.from(Buffer.from(h.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':'));
        if (given.length === want.length && timingSafeEqual(given, want)) return next();
      }
      res.setHeader('WWW-Authenticate', 'Basic realm="CashWatch", charset="UTF-8"');
      res.status(401).send('נדרשת התחברות');
    });
  }

  // הגנת CSRF: פעולות שמשנות מצב דורשות כותרת מותאמת (מכריחה preflight, שנחסם בבקשות cross-site)
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-requested-with'] !== 'cashwatch') {
      return res.status(403).json({ error: 'חסרה כותרת X-Requested-With' });
    }
    next();
  });
  app.use(express.json({ limit: '50kb' }));

  app.get('/api/state', (_req, res) => {
    const { analysis, findings } = computeAnalysis(ctx);
    const states = new Map(ctx.store.listAlerts(true).map((a) => [a.key, a]));
    const labels = new Map([...ctx.config.banks, ...ctx.config.cards].map((s) => [s.id, s]));
    res.json({
      version: APP_VERSION,
      locked: !!ctx.settings?.locked,
      detection: explainDetection(ctx),
      now: (ctx.nowFn?.() ?? new Date()).toISOString(),
      today: analysis.today,
      running: isRunning(),
      progress: getProgress(),
      schedule: { mode: ctx.config.schedule.mode, times: ctx.config.schedule.times },
      banks: ctx.config.banks.map((b) => ({ id: b.id, label: b.label, provider: b.provider })),
      cards: ctx.config.cards.map((c) => ({ id: c.id, label: c.label, provider: c.provider, fundingAccount: c.fundingAccount })),
      analysis,
      alerts: findings.map((f) => ({ ...f, firstSeen: states.get(f.key)?.firstSeen ?? null, lastNotified: states.get(f.key)?.lastNotified ?? null })),
      sources: [...labels.values()].map((s) => {
        const st = ctx.store.listSourceStatus().find((x) => x.sourceId === s.id);
        return { id: s.id, label: s.label, provider: s.provider, lastAttemptAt: st?.lastAttemptAt ?? null, lastSuccessAt: st?.lastSuccessAt ?? null, lastError: st?.lastError ? withHint(st.lastError) : null, balanceHints: readBalanceHints(ctx.dataDir, s.id), attempts: ctx.store.recentAttempts(s.id, 14) };
      }),
      recurring: ctx.store.listRecurring(),
      runs: ctx.store.listRuns(8),
      notificationChannels: ctx.channels.map((c) => c.name),
    });
  });

  const parseItem = (body: unknown) => {
    const item = recurringSchema.parse(body);
    if (!ctx.config.banks.some((b) => b.id === item.accountId)) throw new z.ZodError([{ code: 'custom', path: ['accountId'], message: 'חשבון לא קיים' }]);
    if (item.intervalMonths > 1 && !item.anchorMonth) item.anchorMonth = todayIn(ctx.config.timezone).slice(0, 7);
    if (item.match) { try { new RegExp(item.match, 'i'); } catch { /* יטופל כטקסט רגיל */ } }
    return item;
  };
  const handle = (fn: (req: Request, res: Response) => void) => (req: Request, res: Response) => {
    try { fn(req, res); }
    catch (e) {
      if (e instanceof z.ZodError) return void res.status(400).json({ error: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  };
  app.post('/api/recurring', handle((req, res) => { res.status(201).json(ctx.store.saveRecurring(parseItem(req.body))); }));
  app.put('/api/recurring/:id', handle((req, res) => {
    const id = Number(req.params.id);
    const old = ctx.store.getRecurring(id);
    if (!old) return void res.status(404).json({ error: 'לא נמצא' });
    // עריכה = המשתמש בדק את הפריט, לכן הוא נחשב מאושר
    res.json(ctx.store.saveRecurring({ ...parseItem(req.body), id, auto: old.auto, autoKey: old.autoKey, reviewed: true }));
  }));
  app.post('/api/recurring/dismiss', handle((req, res) => {
    const body = z.object({ key: z.string().min(1).max(400).optional(), keys: z.array(z.string().min(1).max(400)).max(500).optional() }).parse(req.body);
    const keys = [...(body.keys ?? []), ...(body.key ? [body.key] : [])];
    for (const k of keys) ctx.store.dismiss(k);
    res.json({ ok: true, dismissed: keys.length });
  }));
  app.post('/api/recurring/approve-all', handle((_req, res) => { res.json({ approved: ctx.store.approveAllAuto() }); }));
  app.post('/api/recurring/detect', handle((_req, res) => { res.json({ added: detectAndFile(ctx).length }); }));
  app.delete('/api/recurring/:id', handle((req, res) => {
    if (!ctx.store.deleteRecurring(Number(req.params.id))) return void res.status(404).json({ error: 'לא נמצא' });
    res.json({ ok: true });
  }));

  // לוגו של ספק (בנק/אשראי) – מורד פעם אחת מהאתר הרשמי ונשמר מקומית; 404 = מציגים מונוגרמה
  app.get('/api/logos/:provider', async (req, res) => {
    const provider = String(req.params.provider);
    const configured = [...ctx.config.banks, ...ctx.config.cards].some((x) => x.provider === provider);
    const file = configured && /^[a-zA-Z]+$/.test(provider) ? await getLogo(path.join(ctx.dataDir, 'logos'), provider) : null;
    if (!file) return void res.status(404).end();
    res.set('Cache-Control', 'private, no-cache').sendFile(path.resolve(file));
  });
  // החלפת אייקון ידנית (אם האייקון שהורד שגוי): גוף הבקשה = קובץ התמונה (PNG/ICO/JPG/GIF עד 300KB)
  app.put('/api/logos/:provider', express.raw({ type: '*/*', limit: '400kb' }), (req, res) => {
    const provider = String(req.params.provider);
    const configured = [...ctx.config.banks, ...ctx.config.cards].some((x) => x.provider === provider);
    if (!configured || !/^[a-zA-Z]+$/.test(provider)) return void res.status(404).json({ error: 'ספק לא מוכר' });
    if (!Buffer.isBuffer(req.body) || !saveCustomLogo(path.join(ctx.dataDir, 'logos'), provider, req.body)) return void res.status(400).json({ error: 'הקובץ אינו תמונה תקינה (PNG / ICO / JPG / GIF עד 300KB)' });
    res.json({ ok: true });
  });
  app.delete('/api/logos/:provider', (req, res) => {
    const provider = String(req.params.provider);
    if (!/^[a-zA-Z]+$/.test(provider)) return void res.status(400).json({ error: 'ספק לא תקין' });
    removeLogo(path.join(ctx.dataDir, 'logos'), provider);
    res.json({ ok: true });
  });

  // פתיחת נעילת הסיסמה (פעם אחת אחרי הפעלת המחשב). האטה קלה בניסיון כושל מקשה על ניחושים דרך הממשק
  let failedUnlocks = 0;
  app.post('/api/unlock', async (req, res) => {
    if (!ctx.settings) return void res.status(400).json({ error: 'לא רלוונטי במצב הזה' });
    const pass = typeof req.body?.passphrase === 'string' ? req.body.passphrase : '';
    try {
      if (failedUnlocks >= 3) await new Promise((r) => setTimeout(r, Math.min(failedUnlocks, 10) * 1000));
      ctx.settings.unlock(pass);
      failedUnlocks = 0;
      ctx.log('🔓 המערכת נפתחה');
      res.json({ ok: true });
    } catch (e) {
      failedUnlocks++;
      res.status(401).json({ error: e instanceof Error ? e.message : 'סיסמה שגויה' });
    }
  });

  app.post('/api/run', (_req, res) => {
    if (isRunning()) return void res.status(409).json({ error: 'ריצה כבר מתבצעת' });
    runDaily(ctx, 'manual', { force: true, quick: true }).catch((e) => ctx.log(`ריצה ידנית נכשלה: ${e instanceof Error ? e.message : e}`));
    res.status(202).json({ started: true });
  });

  registerSettingsApi(app, ctx, hooks);

  app.post('/api/run/cancel', (_req, res) => { res.json({ canceled: cancelRun() }); });

  if (!ctx.config.dashboard.headless) app.use(express.static(path.join(projectRoot(), 'web'), { extensions: ['html'] }));
  return app;
}

async function isOnline(): Promise<boolean> {
  try {
    await Promise.race([dns.lookup('www.google.com'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000))]);
    return true;
  } catch { return false; }
}

/**
 * הפעלת השרת + מתזמן חכם: כל 5 דקות בודק אם הגיע הזמן לבדיקה יומית.
 * מצב auto: פעם ביום, ברגע שהמחשב דלוק (אין שעה קבועה). אם המחשב היה כבוי/במצב שינה – ירוץ ברגע שיתעורר.
 */
export function startServer(ctx: AppContext): { close: () => void } {
  const app = createApp(ctx);
  const { host, port } = ctx.config.dashboard;
  const server = app.listen(port, host, () => {
    const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
    ctx.log(`📊 דשבורד: ${url}`);
    if (ctx.settings?.locked) {
      ctx.log('🔒 המערכת נעולה בסיסמה – פתח את CashWatch והזן סיסמה כדי שהבדיקות יחזרו לרוץ');
      void import('./notify/desktop.ts').then((m) => m.sendDesktopNotification('CashWatch נעול', 'פתח את CashWatch והזן את סיסמת הנעילה כדי שהבדיקות האוטומטיות יתחילו')).catch(() => {});
    }
    try { const n = cleanupIssuerItems(ctx.store); if (n) ctx.log(`🧹 הוסרו ${n} הוראות קבועות אוטומטיות שהן חיובי כרטיס אשראי`); } catch { /* לא קריטי */ }
    if (!process.env.CASHWATCH_NO_OPEN && !ctx.config.dashboard.headless && process.stdout.isTTY && ['win32', 'darwin'].includes(process.platform)) openDashboardWindow(url, ctx.dataDir);
  });

  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      ctx.log(`❌ פורט ${port} תפוס: כנראה כבר רצה גרסה (ישנה?) של CashWatch ברקע. סגור אותה (אייקון במגש ← יציאה) או הפעל מחדש את CashWatch.bat, ואז נסה שוב.`);
      process.exit(1);
    }
    throw e;
  });

  const tick = async () => {
    try {
      const c = ctx.config;
      if (ctx.settings?.locked) return; // נעול בסיסמה – מחכים שהמשתמש יפתח בדשבורד
      if (isRunning() || (!c.banks.length && !c.cards.length)) return;
      const lastOk = ctx.store.lastSuccessfulRun();
      const lastAttempt = ctx.store.lastRunStartedAt();
      const due = isRunDue({
        mode: c.schedule.mode, times: c.schedule.times, timeZone: c.timezone, now: new Date(),
        lastOkAt: lastOk ? new Date(lastOk) : null, lastAttemptAt: lastAttempt ? new Date(lastAttempt) : null,
        minIntervalHours: c.schedule.catchUpHours, retryHours: c.schedule.retryHours,
      });
      if (!due) return;
      if (!(await isOnline())) { ctx.log('אין חיבור לאינטרנט כרגע – אנסה שוב בעוד כמה דקות'); return; }
      ctx.log('⏰ הגיע הזמן לבדיקה – מריץ');
      await runDaily(ctx, 'auto');
    } catch (e) {
      ctx.log(`בדיקה מתוזמנת נכשלה: ${e instanceof Error ? e.message : e}`);
    }
  };
  const disabled = !!process.env.CASHWATCH_NO_CATCHUP;
  const first = disabled ? null : setTimeout(tick, 90_000); // מחכים דקה וחצי אחרי עליית המחשב/הרשת
  const every = disabled ? null : setInterval(tick, 5 * 60_000);
  ctx.log(ctx.config.schedule.mode === 'auto' ? '⏰ מצב אוטומטי: בדיקה אחת ביום, ברגע שהמחשב דלוק' : `⏰ בדיקה בשעות קבועות: ${ctx.config.schedule.times.join(', ')} (ואם המחשב היה כבוי – ברגע שיידלק)`);
  return { close: () => { if (first) clearTimeout(first); if (every) clearInterval(every); server.close(); } };
}
