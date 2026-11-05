import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { isRunning, type AppContext } from './app.ts';
import { PROVIDERS, providerById } from './providers.ts';
import { buildChannel, buildAlertMessage, dispatch, type ChannelType } from './notify/channels.ts';
import { addDays, todayIn } from './engine/dates.ts';
import { detectAndFile } from './patterns.ts';
import { deleteLegacySecretsFile, legacySecretsPath } from './settings.ts';
import { createApiToken, hasApiToken, revokeApiToken } from './apiV1.ts';
import { sendWebhook, validWebhookUrl } from './webhooks.ts';
import { scrapeAll } from './scrape/runner.ts';
import { withHint } from './scrape/types.ts';

interface Job {
  id: string;
  kind: 'test' | 'login';
  sourceId: string;
  state: 'running' | 'done' | 'error';
  startedAt: string;
  finishedAt?: string;
  message?: string;
  result?: unknown;
  error?: string;
}

const jobs = new Map<string, Job>();
const hasRunningJob = () => [...jobs.values()].some((j) => j.state === 'running');

function newJob(kind: Job['kind'], sourceId: string): Job {
  const job: Job = { id: randomUUID(), kind, sourceId, state: 'running', startedAt: new Date().toISOString() };
  jobs.set(job.id, job);
  for (const [id, j] of jobs) if (jobs.size > 40 && j.state !== 'running') jobs.delete(id);
  return job;
}

const maskNum = (n: string) => (n.length > 4 ? `…${n.slice(-4)}` : n);
const fail = (res: Response, code: number, error: string) => res.status(code).json({ error });

const sourceBody = z.object({
  kind: z.enum(['bank', 'card']).optional(),
  provider: z.string().optional(),
  label: z.string().trim().max(60).optional().default(''),
  alertBelow: z.number().min(-1_000_000).max(10_000_000).optional(),
  overdraftLimit: z.number().min(0).max(10_000_000).optional(),
  fundingAccount: z.string().optional(),
  billingDay: z.number().int().min(1).max(31).nullable().optional(),
  chargeMatch: z.string().max(120).nullable().optional(),
  cardOverrides: z.record(z.string().regex(/^\d{4}$/, '4 ספרות אחרונות של הכרטיס'), z.string()).optional(),
  credentials: z.record(z.string(), z.string().max(200)).optional(),
});

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const generalBody = z.object({
  schedule: z.object({ mode: z.enum(['auto', 'fixed']).optional(), times: z.array(hhmm).min(1).max(6).optional() }).optional(),
  horizonDays: z.number().int().min(7).max(120).optional(),
  alerts: z.object({ reminderHours: z.number().min(1).max(168), okDigest: z.enum(['never', 'weekly', 'daily']) }).optional(),
  publicUrl: z.string().max(200).nullable().optional(),
  autoDetect: z.boolean().optional(),
  timezone: z.string().refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'אזור זמן לא תקין').optional(),
});

const notifBody = z.object({
  desktop: z.object({ enabled: z.boolean() }).optional(),
  email: z.object({
    enabled: z.boolean(), address: z.string().trim().max(120), password: z.string().max(200).optional(),
    host: z.string().max(120).optional(), port: z.number().int().min(1).max(65535).optional(), secure: z.boolean().optional(),
    to: z.string().max(300).optional(), from: z.string().max(120).optional(),
  }).optional(),
  whatsapp: z.object({ enabled: z.boolean(), to: z.string().max(30), apiKey: z.string().max(100).optional() }).optional(),
});

/** הגדרות SMTP מוכנות לפי דומיין – כדי שהמשתמש יצטרך להקליד רק כתובת וסיסמה */
const EMAIL_PRESETS: Record<string, { host: string; port: number; secure: boolean; name: string }> = {
  'gmail.com': { host: 'smtp.gmail.com', port: 587, secure: false, name: 'Gmail' },
  'googlemail.com': { host: 'smtp.gmail.com', port: 587, secure: false, name: 'Gmail' },
  'yahoo.com': { host: 'smtp.mail.yahoo.com', port: 465, secure: true, name: 'Yahoo' },
  'icloud.com': { host: 'smtp.mail.me.com', port: 587, secure: false, name: 'iCloud' },
  'me.com': { host: 'smtp.mail.me.com', port: 587, secure: false, name: 'iCloud' },
};
const presetFor = (address: string) => EMAIL_PRESETS[address.split('@')[1]?.toLowerCase() ?? ''];

export function registerSettingsApi(app: express.Express, ctx: AppContext, hooks: { onScheduleChange?: () => void } = {}): void {
  const settings = ctx.settings;
  const guard = (req: Request, res: Response, fn: () => unknown) => {
    if (!settings) return fail(res, 400, 'ההגדרות במצב הזה הן לקריאה בלבד');
    if (settings.locked) return fail(res, 423, 'המערכת נעולה בסיסמה. הזן את הסיסמה בדשבורד כדי לערוך הגדרות.');
    try { return fn(); } catch (e) {
      if (e instanceof z.ZodError) return fail(res, 400, e.issues.map((i) => `${i.path.join('.') || 'שדה'}: ${i.message}`).join('; '));
      return fail(res, 400, e instanceof Error ? e.message : String(e));
    }
  };
  const profileDir = (id: string) => path.join(ctx.dataDir, 'browser-profiles', id);

  const view = () => {
    const c = ctx.config, sec = ctx.secrets;
    const status = new Map(ctx.store.listSourceStatus().map((s) => [s.sourceId, s]));
    const credView = (id: string, provider: string) => {
      const info = providerById(provider);
      const have = sec.sources[id] ?? {};
      const values: Record<string, string> = {};
      const present: Record<string, boolean> = {};
      for (const f of info?.fields ?? []) {
        present[f.key] = !!have[f.key];
        if (!f.secret && have[f.key]) values[f.key] = have[f.key]!;
      }
      return { values, present };
    };
    const src = (kind: 'bank' | 'card', x: { id: string; provider: string; label: string }, extra: object) => ({
      id: x.id, kind, provider: x.provider, label: x.label, ...extra, credentials: credView(x.id, x.provider),
      status: status.get(x.id) ? { ...status.get(x.id)!, lastError: status.get(x.id)!.lastError ? withHint(status.get(x.id)!.lastError!) : null } : null, hasProfile: fs.existsSync(profileDir(x.id)),
    });
    const n = c.notifications;
    return {
      providers: PROVIDERS,
      general: { timezone: c.timezone, schedule: { mode: c.schedule.mode, times: c.schedule.times }, horizonDays: c.horizonDays, alerts: c.alerts, publicUrl: c.dashboard.publicUrl ?? null, autoDetect: c.recurring.autoDetect },
      sources: [
        ...c.banks.map((b) => src('bank', b, { alertBelow: b.alertBelow, overdraftLimit: b.overdraftLimit })),
        ...c.cards.map((k) => src('card', k, { fundingAccount: k.fundingAccount, billingDay: k.billingDay ?? null, chargeMatch: k.chargeMatch ?? null, cardOverrides: k.cardOverrides, detectedCards: ctx.store.listCardRefs(k.id) })),
      ],
      notifications: {
        desktop: { enabled: n.desktop.enabled },
        email: {
          enabled: n.email.enabled, address: n.email.user, hasPassword: !!sec.smtpPassword, preset: presetFor(n.email.user)?.name ?? null,
          advanced: { host: n.email.host, port: n.email.port, secure: n.email.secure, from: n.email.from, to: (Array.isArray(n.email.to) ? n.email.to : [n.email.to]).join(', ') },
        },
        whatsapp: { enabled: n.whatsapp.enabled, to: n.whatsapp.to, hasKey: !!sec.callmebot?.apiKey },
      },
      api: { hasToken: hasApiToken(ctx.store), webhookUrl: c.integrations.webhookUrl, hasWebhookSecret: !!sec.webhookSecret, headless: c.dashboard.headless, port: c.dashboard.port, host: c.dashboard.host },
      security: { locked: !!settings?.locked, passphrase: !!settings?.passphraseMode, platform: process.platform },
      editable: !!settings,
      legacySecretsFile: !!settings && fs.existsSync(legacySecretsPath()) && Object.keys(sec.sources).length > 0,
    };
  };

  app.get('/api/settings', (_req, res) => res.json(view()));

  // מחיקה מאובטחת של secrets.yaml הישן (טקסט גלוי). רק בלחיצת משתמש, ורק אם הסיסמאות כבר שמורות מוצפנות במערכת
  app.post('/api/settings/legacy-secrets/delete', (req, res) => guard(req, res, () => {
    if (!settings) return fail(res, 400, 'ההגדרות במצב הזה הן לקריאה בלבד');
    if (!Object.keys(ctx.secrets.sources).length) return fail(res, 409, 'עוד לא שמורות סיסמאות מוצפנות במערכת, לכן לא מוחקים את הקובץ');
    res.json({ deleted: deleteLegacySecretsFile(legacySecretsPath()) });
  }));

  // ---------- מקורות: בנקים וכרטיסים ----------
  const saveSource = (req: Request, res: Response, existingId?: string) => guard(req, res, () => {
    const b = sourceBody.parse(req.body);
    const c = ctx.config;
    const existing = existingId ? [...c.banks, ...c.cards].find((x) => x.id === existingId) : undefined;
    if (existingId && !existing) return fail(res, 404, 'המקור לא נמצא');
    const kind: 'bank' | 'card' = existingId ? (c.banks.some((x) => x.id === existingId) ? 'bank' : 'card') : (b.kind ?? 'bank');
    const provider = existing?.provider ?? b.provider;
    const info = provider ? providerById(provider) : undefined;
    if (!info || info.kind !== kind) throw new Error('ספק לא תקין');

    // פרטי התחברות: ערכים ריקים = להשאיר קיים
    const creds = { ...(existingId ? ctx.secrets.sources[existingId] ?? {} : {}) };
    for (const [k, v] of Object.entries(b.credentials ?? {})) {
      if (!info.fields.some((f) => f.key === k)) throw new Error(`שדה לא מוכר: ${k}`);
      if (v.trim()) creds[k] = v.trim();
    }
    const missing = info.fields.filter((f) => !f.optional && !creds[f.key]).map((f) => f.label);
    if (missing.length) throw new Error(`חסרים פרטי התחברות: ${missing.join(', ')}`);

    let id = existingId;
    if (!id) {
      let n = 1;
      const used = new Set([...c.banks, ...c.cards].map((x) => x.id));
      while (used.has(`${provider}-${n}`)) n++;
      id = `${provider}-${n}`;
    }
    const finalId = id;
    // שם ריק → שם ברירת מחדל לפי הספק (עם מספור אם כבר קיים אחד כזה)
    if (!b.label) {
      const base = info.name;
      const names = new Set([...c.banks, ...c.cards].filter((x) => x.id !== finalId).map((x) => x.label));
      let name = base;
      for (let i = 2; names.has(name); i++) name = `${base} ${i}`;
      b.label = name;
    }
    settings!.updateConfig((cfg) => {
      if (kind === 'bank') {
        const row = { id: finalId, provider: provider as never, label: b.label, alertBelow: b.alertBelow ?? 0, overdraftLimit: b.overdraftLimit ?? 0 };
        const i = cfg.banks.findIndex((x) => x.id === finalId);
        if (i >= 0) cfg.banks[i] = { ...cfg.banks[i]!, ...row }; else cfg.banks.push(row);
      } else {
        if (!b.fundingAccount) throw new Error('בחר מאיזה חשבון בנק יורד החיוב של הכרטיס');
        const row = { id: finalId, provider: provider as never, label: b.label, fundingAccount: b.fundingAccount, cardOverrides: b.cardOverrides ?? {}, billingDay: b.billingDay ?? undefined, chargeMatch: b.chargeMatch || undefined };
        const i = cfg.cards.findIndex((x) => x.id === finalId);
        if (i >= 0) cfg.cards[i] = row; else cfg.cards.push(row);
      }
    });
    settings!.updateSecrets((s) => { s.sources[finalId] = creds; });
    ctx.store.clearSourceError(finalId);
    res.status(existingId ? 200 : 201).json({ id: finalId });
  });
  app.post('/api/settings/sources', (req, res) => saveSource(req, res));
  app.put('/api/settings/sources/:id', (req, res) => saveSource(req, res, String(req.params.id)));

  app.delete('/api/settings/sources/:id', (req, res) => guard(req, res, () => {
    const id = String(req.params.id);
    const c = ctx.config;
    const isBank = c.banks.some((b) => b.id === id);
    if (!isBank && !c.cards.some((k) => k.id === id)) return fail(res, 404, 'המקור לא נמצא');
    if (isRunning() || hasRunningJob()) return fail(res, 409, 'פעולה אחרת מתבצעת כרגע, נסה שוב בעוד רגע');
    if (isBank) {
      const users = c.cards.filter((k) => k.fundingAccount === id || Object.values(k.cardOverrides).includes(id));
      if (users.length) return fail(res, 409, `אי אפשר למחוק: הכרטיסים הבאים יורדים מהחשבון הזה: ${users.map((k) => k.label).join(', ')}. שנה אותם קודם.`);
      const items = ctx.store.listRecurring().filter((r) => r.accountId === id);
      if (items.length) return fail(res, 409, `אי אפשר למחוק: יש ${items.length} הוראות קבועות על החשבון. מחק אותן קודם.`);
    }
    settings!.updateConfig((cfg) => { cfg.banks = cfg.banks.filter((x) => x.id !== id); cfg.cards = cfg.cards.filter((x) => x.id !== id); });
    settings!.updateSecrets((s) => { delete s.sources[id]; });
    ctx.store.deleteSourceData(id);
    fs.rmSync(profileDir(id), { recursive: true, force: true });
    res.json({ ok: true });
  }));

  /** צילום המסך האחרון של כישלון איסוף במקור (לאבחון). מקומי בלבד, מאחורי אותה הגנה של הדשבורד */
  app.get('/api/failures/:id', (req, res) => {
    const id = String(req.params.id);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return fail(res, 400, 'מזהה לא תקין');
    const dir = path.resolve(ctx.dataDir, 'failures');
    let newest: { file: string; t: number } | null = null;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith(`${id}-`) || !f.endsWith('.png')) continue;
        const t = fs.statSync(path.join(dir, f)).mtimeMs;
        if (!newest || t > newest.t) newest = { file: f, t };
      }
    } catch { /* אין תיקייה */ }
    if (!newest) return fail(res, 404, 'אין צילום מסך שמור לכישלון האחרון');
    res.sendFile(path.join(dir, newest.file));
  });

  // ---------- בדיקת חיבור וכניסה ראשונה (משימות רקע) ----------
  app.get('/api/jobs/:id', (req, res) => {
    const j = jobs.get(String(req.params.id));
    return j ? res.json(j) : fail(res, 404, 'משימה לא נמצאה');
  });

  /** "בדוק חיבור" = אוסף עכשיו נתונים מהמקור ושומר אותם, כך שהדשבורד מתעדכן מיד */
  app.post('/api/settings/sources/:id/test', (req, res) => guard(req, res, () => {
    const id = String(req.params.id);
    const c = ctx.config;
    const src = [...c.banks, ...c.cards].find((x) => x.id === id);
    if (!src) return fail(res, 404, 'המקור לא נמצא');
    if (!ctx.secrets.sources[id]) return fail(res, 400, 'חסרים פרטי התחברות');
    if (isRunning() || hasRunningJob()) return fail(res, 409, 'פעולה אחרת מתבצעת כרגע (בדיקה או ריצה יומית). נסה שוב בעוד רגע.');
    const kind = c.banks.some((b) => b.id === id) ? 'bank' : 'card';
    const job = newJob('test', id);
    void (async () => {
      try {
        const today = todayIn(c.timezone);
        const [r] = await scrapeAll({ config: ctx.config, secrets: ctx.secrets, store: ctx.store, provider: ctx.provider, dataDir: ctx.dataDir, today, log: ctx.log, only: [id], attempts: 2, conflictWaitSeconds: 150, retryOnlyConflicts: true, force: true, ignoreGap: true, progress: (e) => { job.message = e.message; } });
        if (!r?.ok) {
          job.state = 'error';
          job.error = withHint(r?.error ?? 'שגיאה לא ידועה');
        } else {
          const filed = detectAndFile(ctx).length;
          const txns = ctx.store.getTxns(kind, addDays(today, -400)).filter((t) => t.sourceId === id);
          const refs = [...new Set(txns.map((t) => t.accountRef))];
          job.state = 'done';
          job.result = {
            collected: true, newPatterns: filed, balanceMissing: kind === 'bank' && ctx.store.getBalance(id) === null, balanceHints: (() => { try { return (JSON.parse(fs.readFileSync(path.join(ctx.dataDir, `debug-${id}.json`), 'utf8')) as { candidates?: unknown[] }).candidates ?? []; } catch { return []; } })(),
            accounts: (refs.length ? refs : [id]).map((ref) => {
              const mine = txns.filter((t) => t.accountRef === ref);
              const dates = mine.map((t) => t.date).sort();
              return {
                account: kind === 'bank' ? src.label : `כרטיס ••${ref}`,
                balance: kind === 'bank' ? ctx.store.getBalance(id)?.balance ?? null : null,
                txnCount: mine.length, pending: mine.filter((t) => t.status === 'pending').length, from: dates[0] ?? null, to: dates.at(-1) ?? null,
                latest: [...mine].sort((x, y) => (x.date < y.date ? 1 : -1)).slice(0, 3).map((t) => ({ date: t.date, amount: t.amount, description: t.description.slice(0, 40) })),
              };
            }),
          };
        }
      } catch (e) {
        job.state = 'error';
        job.error = e instanceof Error ? e.message : String(e);
      }
      job.finishedAt = new Date().toISOString();
    })();
    res.status(202).json({ jobId: job.id });
  }));

  /** משיכת היסטוריה ארוכה מכל הבנקים (לזיהוי הוצאות והכנסות שחוזרות) ואז זיהוי */
  app.post('/api/recurring/backfill', (req, res) => guard(req, res, () => {
    const statuses = ctx.store.listSourceStatus();
    const inFailure = (id: string) => { const x = statuses.find((y) => y.sourceId === id); return !!x?.lastError && (!x.lastSuccessAt || (x.lastAttemptAt ?? '') > x.lastSuccessAt); };
    const allBanks = ctx.config.banks.map((b) => b.id);
    const banks = allBanks.filter((id) => !inFailure(id)); // בנק במצב כשל לא מנסים שוב (כדי לא להציף ולא לנעול)
    const skippedBanks = allBanks.filter((id) => inFailure(id));
    if (!allBanks.length) return fail(res, 400, 'עוד לא הוגדר חשבון בנק');
    if (!banks.length) return fail(res, 400, 'כל הבנקים במצב כשל איסוף כרגע. תקן קודם (ראה "מצב איסוף הנתונים"), ואז נסה שוב.');
    if (isRunning() || hasRunningJob()) return fail(res, 409, 'פעולה אחרת מתבצעת כרגע. נסה שוב בעוד רגע.');
    const job = newJob('test', 'history');
    void (async () => {
      try {
        const today = todayIn(ctx.config.timezone);
        const results = await scrapeAll({ config: ctx.config, secrets: ctx.secrets, store: ctx.store, provider: ctx.provider, dataDir: ctx.dataDir, today, log: ctx.log, only: banks, attempts: 2, conflictWaitSeconds: 150, retryOnlyConflicts: true, force: true, ignoreGap: true, forceHistory: true, progress: (e) => { job.message = `${e.label}: ${e.message ?? ''}`; } });
        const added = detectAndFile(ctx).length;
        const failed = results.filter((r) => !r.ok && !r.skipped);
        job.state = failed.length === results.length ? 'error' : 'done';
        job.result = { added, sources: results.length, failed: failed.length, skipped: skippedBanks.length };
        if (job.state === 'error') job.error = withHint(failed[0]?.error ?? 'האיסוף נכשל');
      } catch (e) {
        job.state = 'error';
        job.error = e instanceof Error ? e.message : String(e);
      }
      job.finishedAt = new Date().toISOString();
    })();
    res.status(202).json({ jobId: job.id });
  }));

  /** הזנת יתרה ידנית לבנק שלא מחזיר יתרה (חד-פעמי; אחר כך מתעדכנת לפי תנועות) */
  app.put('/api/settings/sources/:id/balance', (req, res) => guard(req, res, () => {
    const id = String(req.params.id);
    if (!ctx.config.banks.some((b) => b.id === id)) return fail(res, 404, 'חשבון בנק לא נמצא');
    const amount = z.object({ amount: z.number().min(-100_000_000).max(100_000_000) }).parse(req.body).amount;
    ctx.store.setAnchor(id, amount, todayIn(ctx.config.timezone));
    res.json({ ok: true });
  }));

  app.post('/api/settings/sources/:id/browser-login', (req, res) => guard(req, res, () => {
    const id = String(req.params.id);
    const src = [...ctx.config.banks, ...ctx.config.cards].find((x) => x.id === id);
    if (!src) return fail(res, 404, 'המקור לא נמצא');
    if (!ctx.provider.interactiveLogin) return fail(res, 400, 'כניסה ידנית לא נתמכת במצב הזה');
    if (isRunning() || hasRunningJob()) return fail(res, 409, 'פעולה אחרת מתבצעת כרגע. נסה שוב בעוד רגע.');
    const job = newJob('login', id);
    job.message = 'פותח חלון דפדפן…';
    void ctx.provider.interactiveLogin({ provider: src.provider, profileDir: profileDir(id), onOpen: () => { job.message = 'החלון נפתח במחשב. התחבר, ואחרי שנכנסת לחשבון – סגור את החלון.'; } })
      .then(() => { job.state = 'done'; job.message = 'החלון נסגר. אוסף נתונים עכשיו (אם הבנק עוד רואה התחברות פתוחה, ננסה שוב אחרי כמה דקות).'; })
      .catch((e: unknown) => { job.state = 'error'; job.error = e instanceof Error ? e.message : String(e); })
      .finally(() => { job.finishedAt = new Date().toISOString(); });
    res.status(202).json({ jobId: job.id });
  }));

  // ---------- הגדרות כלליות והתראות ----------
  app.put('/api/settings/general', (req, res) => guard(req, res, () => {
    const b = generalBody.parse(req.body);
    settings!.updateConfig((c) => {
      if (b.schedule?.mode) c.schedule.mode = b.schedule.mode;
      if (b.schedule?.times) c.schedule.times = [...new Set(b.schedule.times)].sort();
      if (b.horizonDays) c.horizonDays = b.horizonDays;
      if (b.alerts) c.alerts = b.alerts;
      if (b.timezone) c.timezone = b.timezone;
      if (b.publicUrl !== undefined) c.dashboard.publicUrl = b.publicUrl || undefined;
      if (b.autoDetect !== undefined) c.recurring.autoDetect = b.autoDetect;
    });
    hooks.onScheduleChange?.();
    res.json({ ok: true });
  }));

  // ---------- אבטחה: נעילה בסיסמה ----------
  app.post('/api/settings/security/passphrase', (req, res) => guard(req, res, () => {
    const b = z.object({ passphrase: z.string().min(8, 'הסיסמה קצרה מדי (לפחות 8 תווים)').max(200) }).parse(req.body);
    if (settings!.passphraseMode) throw new Error('הנעילה בסיסמה כבר פעילה');
    settings!.enablePassphrase(b.passphrase);
    res.json({ ok: true });
  }));
  app.delete('/api/settings/security/passphrase', (req, res) => guard(req, res, () => {
    const b = z.object({ passphrase: z.string().max(200) }).parse(req.body);
    settings!.disablePassphrase(b.passphrase);
    res.json({ ok: true });
  }));

  // ---------- API ואינטגרציות ----------
  // הטוקן מוצג פעם אחת בלבד (נשמר רק גיבוב). יצירה מחדש מבטלת את הקודם.
  app.post('/api/settings/api/token', (req, res) => guard(req, res, () => { res.json({ token: createApiToken(ctx.store) }); }));
  app.delete('/api/settings/api/token', (req, res) => guard(req, res, () => { revokeApiToken(ctx.store); res.json({ ok: true }); }));
  app.put('/api/settings/api', (req, res) => guard(req, res, () => {
    const b = z.object({ webhookUrl: z.string().trim().max(500).optional(), webhookSecret: z.string().max(200).nullable().optional(), headless: z.boolean().optional() }).parse(req.body);
    if (b.webhookUrl && !validWebhookUrl(b.webhookUrl)) throw new Error('כתובת ה-Webhook חייבת להתחיל ב-http:// או https://');
    settings!.updateConfig((c) => {
      if (b.webhookUrl !== undefined) c.integrations.webhookUrl = b.webhookUrl;
      if (b.headless !== undefined) c.dashboard.headless = b.headless;
    });
    if (b.webhookSecret !== undefined) settings!.updateSecrets((sc) => { if (b.webhookSecret) sc.webhookSecret = b.webhookSecret; else delete sc.webhookSecret; });
    res.json({ ok: true, restartNeeded: b.headless !== undefined });
  }));
  app.post('/api/settings/api/webhook-test', (req, res) => guard(req, res, async () => {
    const url = ctx.config.integrations.webhookUrl;
    if (!url) return fail(res, 400, 'עוד לא הוגדרה כתובת Webhook');
    res.json(await sendWebhook(url, ctx.secrets.webhookSecret, 'test', { message: 'הודעת בדיקה מ-CashWatch' }));
  }));

  app.put('/api/settings/notifications', (req, res) => guard(req, res, () => {
    const b = notifBody.parse(req.body);
    settings!.updateConfig((c) => {
      const n = c.notifications;
      if (b.email) {
        const e = b.email;
        const preset = presetFor(e.address);
        const host = e.host?.trim() || preset?.host || '';
        if (e.enabled && (!e.address.includes('@') || !host)) throw new Error('הכנס כתובת מייל תקינה. אם זה לא Gmail/Yahoo/iCloud – פתח "הגדרות מתקדמות" והכנס שרת SMTP.');
        n.email = {
          enabled: e.enabled, host, port: e.port ?? preset?.port ?? 587, secure: e.secure ?? preset?.secure ?? false, user: e.address,
          from: e.from?.trim() || e.address, to: e.to?.trim() ? e.to.split(/[,;\s]+/).filter(Boolean) : [e.address],
        };
      }
      if (b.whatsapp) n.whatsapp = { enabled: b.whatsapp.enabled, to: b.whatsapp.to };
      if (b.desktop) n.desktop = { enabled: b.desktop.enabled };
    });
    settings!.updateSecrets((s) => {
      if (b.email?.password) s.smtpPassword = b.email.password;
      if (b.whatsapp?.apiKey) s.callmebot = { apiKey: b.whatsapp.apiKey };
    });
    res.json({ ok: true });
  }));

  app.post('/api/settings/notifications/test', async (req, res) => {
    if (!settings) return fail(res, 400, 'ההגדרות במצב הזה הן לקריאה בלבד');
    const type = String(req.body?.channel) as ChannelType;
    if (!['desktop', 'email', 'whatsapp'].includes(type)) return fail(res, 400, 'ערוץ לא מוכר');
    const ch = buildChannel(type, ctx.config, ctx.secrets, true);
    if (!ch) return fail(res, 400, 'חסרים פרטים בערוץ הזה (מלא את כל השדות ושמור)');
    const sample = req.body?.sample === 'overdraft';
    const msg = buildAlertMessage([sample
      ? { severity: 'critical', title: 'דוגמה: צפויה חריגה בחשבון', body: 'זו התראה לדוגמה, בלי קשר למצב החשבון האמיתי שלך. כך תיראה התראה כשחשבון צפוי לרדת מתחת לסף: "צפוי לרדת מתחת ל-₪0 בתאריך 15/12 (בעוד 6 ימים)".' }
      : { severity: 'info', title: 'הודעת בדיקה מ-CashWatch', body: 'אם קיבלת את זה – ההתראות עובדות ✅' }], ctx.config.dashboard.publicUrl);
    const r = await dispatch([ch], msg);
    if (r.failed.length) return res.json({ ok: false, error: r.failed[0]!.error });
    res.json({ ok: true });
  });
}
