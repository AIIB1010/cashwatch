import { effectiveAmount } from './amounts.ts';
import fs from 'node:fs';
import path from 'node:path';
import { applyLibraryPatches } from './patches.ts';
import { interactiveLogin } from './interactive.ts';
import { clearProfileLocks, LOGIN_URLS, pruneProfileCaches, resolveBrowserPath } from './profile.ts';
import { localDate } from '../engine/dates.ts';
import type { ScrapeOutcome, ScrapeProvider, ScrapeRequest, ScrapedAccount } from './types.ts';

/**
 * שכבת האיסוף האמיתית – עוטפת את israeli-bank-scrapers (פותחת דפדפן headless ונכנסת לאתר הבנק/חברת האשראי
 * בדיוק כמו שאתה עושה ידנית). נטענת דינמית כדי שהדמו/הבדיקות לא ידרשו דפדפן.
 */
export class RealScrapeProvider implements ScrapeProvider {
  async interactiveLogin(o: { provider: string; profileDir: string; url?: string; onOpen?: () => void }): Promise<void> {
    await interactiveLogin({ profileDir: o.profileDir, url: o.url ?? LOGIN_URLS[o.provider] ?? 'about:blank', onOpen: o.onOpen });
  }

  async scrape(req: ScrapeRequest): Promise<ScrapeOutcome> {
    applyLibraryPatches();
    const lib = await import('israeli-bank-scrapers');
    const company = (lib.CompanyTypes as Record<string, string>)[req.provider];
    if (!company) return { ok: false, errorType: 'GENERIC', errorMessage: `ספק לא נתמך: ${req.provider}` };

    fs.mkdirSync(req.failureScreenshotDir, { recursive: true });
    const executablePath = await resolveBrowserPath();
    const args = process.env.CASHWATCH_NO_SANDBOX === '1' ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : [];
    fs.mkdirSync(req.profileDir, { recursive: true });
    clearProfileLocks(req.profileDir);
    args.push(`--user-data-dir=${req.profileDir}`, '--disable-blink-features=AutomationControlled');

    // מפעילים את הדפדפן בעצמנו, כדי שנוכל לסגור אותו בכוח כשניסיון נתקע (אחרת נשאר חלון פתוח על הפרופיל)
    const puppeteer = (await import('puppeteer')).default;
    const browser = await puppeteer.launch({ headless: process.env.CASHWATCH_SHOW_BROWSER !== '1', executablePath, args, timeout: Math.min(req.timeoutMs, 60_000) });
    const kill = () => { try { browser.process()?.kill('SIGKILL'); } catch { /* ignore */ } void browser.close().catch(() => {}); };
    req.signal?.addEventListener('abort', kill, { once: true });
    if (req.signal?.aborted) kill();

    const scraper = lib.createScraper({
      companyId: company as never,
      startDate: req.startDate,
      futureMonthsToScrape: req.kind === 'card' ? req.futureMonths : undefined,
      combineInstallments: false,
      browser,
      verbose: false,
      timeout: req.timeoutMs,
      defaultTimeout: req.timeoutMs,
      navigationRetryCount: 1,
      storeFailureScreenShotPath: path.join(req.failureScreenshotDir, `${req.sourceId}-${Date.now()}.png`),
    } as never);

    const creds = { ...req.credentials } as Record<string, unknown>;
    // One Zero: אימות דו-שלבי בעזרת טוקן ארוך-טווח (otpLongTermToken) – נוצר פעם אחת ב-otp-setup
    (globalThis as { __cashwatchLoggedOut?: boolean }).__cashwatchLoggedOut = false;
    let result;
    try {
      result = await scraper.scrape(creds as never);
    } finally {
      req.signal?.removeEventListener('abort', kill);
      await browser.close().catch(() => {});
      try { pruneProfileCaches(req.profileDir); } catch { /* לא קריטי */ }
    }
    if (!result.success) {
      const msg = result.errorMessage ?? '';
      if ((globalThis as { __cashwatchLoggedOut?: boolean }).__cashwatchLoggedOut) {
        return { ok: false, errorType: 'SESSION_CONFLICT', errorMessage: 'הבנק הציג דף יציאה (התחברות אחרת פתוחה)' };
      }
      if (/Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/i.test(msg)) {
        return { ok: false, errorType: 'INTERNAL', errorMessage: `תקלה בהתקנת התוכנה (חסר קובץ): ${msg.slice(0, 160)}` };
      }
      if (/CASHWATCH_BAD_CREDENTIALS/.test(msg)) {
        return { ok: false, errorType: 'INVALID_PASSWORD', errorMessage: 'האתר הציג שהפרטים שגויים' };
      }
      if (/net::ERR_|Not attached to an active page|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|Navigation failed|Target closed/i.test(msg)) {
        return { ok: false, errorType: 'NETWORK', errorMessage: `האתר לא נגיש או שהחיבור נחסם (${msg.slice(0, 120)})` };
      }
      return { ok: false, errorType: String(result.errorType ?? 'GENERIC'), errorMessage: result.errorMessage ?? 'שגיאה לא ידועה' };
    }
    // בנק שלא החזיר יתרה: שומרים "מועמדים" (שם שדה + ערך) שהמשתמש יוכל לבחור מהם. בלי ערכים אחרים של החשבון.
    for (const a of result.accounts ?? []) {
      const info = (a as { cashwatchBalanceInfo?: unknown }).cashwatchBalanceInfo;
      if (info && !((typeof a.balance === 'number' && Number.isFinite(a.balance)) || (info as { auto?: { verified?: boolean } }).auto?.verified)) {
        try { fs.writeFileSync(path.join(path.dirname(path.dirname(req.profileDir)), `debug-${req.sourceId}.json`), JSON.stringify(info, null, 1)); } catch { /* לא קריטי */ }
      }
    }
    // יתרה מאומתת שחושבה בתיקון הספרייה (כשהבנק לא מחזיר יתרה ישירות)
    const verifiedBalance = (a: { balance?: number }): number | undefined => {
      if (typeof a.balance === 'number' && Number.isFinite(a.balance)) return a.balance;
      const auto = (a as { cashwatchBalanceInfo?: { auto?: { value?: number; verified?: boolean } } }).cashwatchBalanceInfo?.auto;
      return auto?.verified && typeof auto.value === 'number' && Number.isFinite(auto.value) ? auto.value : undefined;
    };
    const accounts: ScrapedAccount[] = (result.accounts ?? []).map((a) => ({
      accountNumber: String(a.accountNumber),
      balance: verifiedBalance(a),
      txns: a.txns.map((t) => {
        const amount = req.kind === 'card' ? effectiveAmount(t) : (Number.isFinite(t.chargedAmount) && t.chargedAmount !== 0 ? t.chargedAmount : t.originalAmount);
        return {
          accountRef: req.kind === 'card' ? String(a.accountNumber).replace(/\D/g, '').slice(-4) : String(a.accountNumber),
          date: localDate(t.date, req.timeZone),
          processedDate: localDate(t.processedDate || t.date, req.timeZone),
          amount: Number(amount),
          description: String(t.description ?? ''),
          memo: String(t.memo ?? ''),
          status: t.status === 'pending' ? 'pending' : 'completed',
          originalAmount: Number.isFinite(t.originalAmount) ? Number(t.originalAmount) : null,
          originalCurrency: t.originalCurrency ? String(t.originalCurrency) : null,
          installmentNo: t.installments?.number ?? null,
          installmentTotal: t.installments?.total ?? null,
          category: t.category ? String(t.category) : null,
          identifier: t.identifier !== undefined && t.identifier !== null ? String(t.identifier) : null,
          txnType: t.type ? String(t.type) : null,
        } as const;
      }),
    }));
    return { ok: true, accounts };
  }
}
