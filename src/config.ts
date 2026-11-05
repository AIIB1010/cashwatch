import { z } from 'zod';

export const BANK_PROVIDERS = ['hapoalim', 'leumi', 'mizrahi', 'discount', 'mercantile', 'otsarHahayal', 'union', 'beinleumi', 'massad', 'yahav', 'oneZero', 'pagi'] as const;
export const CARD_PROVIDERS = ['isracard', 'amex', 'max', 'visaCal', 'behatsdaa', 'beyahadBishvilha'] as const;

/** ביטויים שמזהים בדרך כלל את שורת החיוב של חברת האשראי בתנועות הבנק */
export const DEFAULT_CHARGE_MATCH: Record<string, string> = {
  // באתר ישראכרט מופיעים גם כרטיסי אמריקן אקספרס שהחברה מנפיקה, והחיוב שלהם בבנק נקרא "אמריקן אקספרס"
  isracard: 'ישראכרט|isracard|אמריקן|אמקס|amex|american',
  amex: 'אמריקן|אמקס|amex|american',
  max: 'מקס|max|לאומי ?קארד|leumi ?card',
  visaCal: 'כאל|ויזה|visa|\\bcal\\b',
  behatsdaa: 'בהצדעה',
  beyahadBishvilha: 'ביחד',
};

/** טקסט זיהוי שורת החיוב בבנק לכרטיס: מה שהוגדר ידנית, או ברירת המחדל של החברה.
 *  ישראכרט מכסה גם "אמריקן אקספרס" (כרטיס שמונפק בישראכרט), אלא אם הוגדר מקור נפרד של אמריקן אקספרס – אז הוא מטפל בשורות שלו. */
export function effectiveChargeMatch(card: { provider: string; chargeMatch?: string | undefined }, allCards: Array<{ provider: string }>): string | undefined {
  if (card.chargeMatch) return card.chargeMatch;
  if (card.provider === 'isracard' && allCards.some((c) => c.provider === 'amex')) return 'ישראכרט|isracard';
  return DEFAULT_CHARGE_MATCH[card.provider];
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'שעה בפורמט HH:MM');

const bankSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'אותיות לטיניות/ספרות/מקף בלבד'),
  provider: z.enum(BANK_PROVIDERS),
  label: z.string().min(1),
  /** כשיש כמה חשבונות באותה כניסה – איזה מהם לעקוב (מספר מלא או סיומת) */
  accountNumber: z.string().optional(),
  /** התראה כשהיתרה הצפויה יורדת מתחת לערך הזה. ברירת מחדל 0 = "לא להיכנס למינוס" */
  alertBelow: z.number().default(0),
  /** מסגרת אוברדראפט (להצגה בדשבורד בלבד) */
  overdraftLimit: z.number().default(0),
});

const cardSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  provider: z.enum(CARD_PROVIDERS),
  label: z.string().min(1),
  /** מזהה חשבון הבנק ממנו יורד החיוב */
  fundingAccount: z.string(),
  /** חריגים: 4 ספרות אחרונות של כרטיס -> חשבון בנק אחר */
  cardOverrides: z.record(z.string(), z.string()).default({}),
  /** יום בחודש בו יורד החיוב. אם לא צוין – מזהים אוטומטית מהנתונים */
  billingDay: z.number().int().min(1).max(31).optional(),
  chargeMatch: z.string().optional(),
});

const emailSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().default(''),
  port: z.number().default(587),
  secure: z.boolean().default(false),
  user: z.string().default(''),
  from: z.string().default(''),
  to: z.union([z.string(), z.array(z.string())]).default([]),
});

const whatsappSchema = z.object({
  enabled: z.boolean().default(false),
  /** מספר היעד בפורמט בינלאומי ללא +, למשל 972501234567 */
  to: z.string().default(''),
});

const desktopSchema = z.object({
  /** התראה על המסך – בלי שום הגדרה. פעילה כברירת מחדל */
  enabled: z.boolean().default(true),
});

export const configSchema = z.object({
  timezone: z.string().default('Asia/Jerusalem'),
  schedule: z.object({
    /** auto = פעם ביום, ברגע שהמחשב דלוק (מומלץ). fixed = בשעות קבועות (ואם המחשב היה כבוי – ברגע שהוא נדלק) */
    mode: z.enum(['auto', 'fixed']).default('auto'),
    times: z.array(hhmm).min(1).default(['07:00']),
    /** auto: מרווח מינימלי בין בדיקות מלאות (שעות) */
    catchUpHours: z.number().default(20),
    /** אחרי ריצה שלא הצליחה במלואה – כמה שעות לחכות לפני ניסיון נוסף */
    retryHours: z.number().default(4),
  }).default({ mode: 'auto', times: ['07:00'], catchUpHours: 20, retryHours: 4 }),
  horizonDays: z.number().int().min(7).max(120).default(35),
  scraping: z.object({
    fetchDaysBack: z.number().int().min(30).max(365).default(75),
    /** בסריקה הראשונה של מקור – כמה ימי היסטוריה למשוך (לזיהוי דפוסים חוזרים) */
    historyDays: z.number().int().min(60).max(365).default(210),
    futureMonths: z.number().int().min(0).max(4).default(2),
    attempts: z.number().int().min(1).max(5).default(3),
    retryDelaySeconds: z.number().default(90),
    /** השהיה אקראית בין מקורות כדי לא להיראות כמו בוט */
    staggerSeconds: z.tuple([z.number(), z.number()]).default([8, 25]),
    attemptTimeoutSeconds: z.number().default(180),
    staleAfterHours: z.number().default(36),
  }).default({ fetchDaysBack: 75, historyDays: 210, futureMonths: 2, attempts: 3, retryDelaySeconds: 90, staggerSeconds: [8, 25], attemptTimeoutSeconds: 180, staleAfterHours: 36 }),
  dashboard: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().default(8080),
    /** כתובת הדשבורד כפי שתופיע בהודעות (אופציונלי) */
    publicUrl: z.string().optional(),
    /** מצב בלי דשבורד: לא מגישים את ממשק המשתמש ולא פותחים חלון. נשאר ה-API (ושרת ההגדרות המקומי) */
    headless: z.boolean().default(false),
  }).default({ host: '127.0.0.1', port: 8080, headless: false }),
  /** חיבורים החוצה: Webhook שמקבל תנועות חדשות וסיכום ריצה (החתימה נשמרת מוצפנת בסודות) */
  integrations: z.object({ webhookUrl: z.string().default('') }).default({ webhookUrl: '' }),
  banks: z.array(bankSchema).default([]),
  cards: z.array(cardSchema).default([]),
  alerts: z.object({
    /** כל כמה שעות להזכיר על התראה שעדיין פתוחה ולא השתנתה */
    reminderHours: z.number().default(24),
    /** הודעת "הכול תקין" כדי לדעת שהמערכת חיה */
    okDigest: z.enum(['never', 'weekly', 'daily']).default('weekly'),
  }).default({ reminderHours: 24, okDigest: 'weekly' }),
  notifications: z.object({
    email: emailSchema.default({ enabled: false, host: '', port: 587, secure: false, user: '', from: '', to: [] }),
    whatsapp: whatsappSchema.default({ enabled: false, to: '' }),
    desktop: desktopSchema.default({ enabled: true }),
  }).default({ email: { enabled: false, host: '', port: 587, secure: false, user: '', from: '', to: [] }, whatsapp: { enabled: false, to: '' }, desktop: { enabled: true } }),
  recurring: z.object({
    /** זיהוי אוטומטי של הוצאות/הכנסות קבועות מהיסטוריית התנועות */
    autoDetect: z.boolean().default(true),
  }).default({ autoDetect: true }),
  /** כתובת ping (למשל healthchecks.io) – מתריעה אם המערכת כולה הפסיקה לרוץ */
  healthcheckUrl: z.string().url().optional(),
});

export type Config = z.infer<typeof configSchema>;
export type BankConfig = z.infer<typeof bankSchema>;
export type CardConfig = z.infer<typeof cardSchema>;

export const secretsSchema = z.object({
  /** id של מקור -> פרטי התחברות כפי שהספרייה דורשת */
  sources: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  dashboardPassword: z.string().optional(),
  smtpPassword: z.string().optional(),
  callmebot: z.object({ apiKey: z.string() }).optional(),
  /** סוד לחתימת HMAC של ה-Webhook */
  webhookSecret: z.string().optional(),
});
export type Secrets = z.infer<typeof secretsSchema>;
