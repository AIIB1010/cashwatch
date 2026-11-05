import type { Txn } from '../types.ts';

export interface ScrapedAccount {
  accountNumber: string;
  balance?: number;
  txns: Array<Omit<Txn, 'id' | 'sourceId'>>;
}

export type ScrapeOutcome =
  | { ok: true; accounts: ScrapedAccount[] }
  | { ok: false; errorType: string; errorMessage: string };

export interface ScrapeRequest {
  sourceId: string;
  provider: string;
  kind: 'bank' | 'card';
  credentials: Record<string, string>;
  startDate: Date;
  futureMonths: number;
  timeZone: string;
  timeoutMs: number;
  failureScreenshotDir: string;
  /** תיקיית פרופיל דפדפן קבועה למקור – שומרת "מכשיר מוכר" כדי שהבנק לא יבקש אימות בכל ריצה */
  profileDir: string;
  /** נשלח כשהניסיון חרג מהזמן: הספק חייב לסגור את הדפדפן מיד */
  signal?: AbortSignal;
}

export interface ScrapeProvider {
  scrape(req: ScrapeRequest): Promise<ScrapeOutcome>;
  /** כניסה ידנית חד-פעמית בדפדפן גלוי (לא נתמך בהדגמה) */
  interactiveLogin?(o: { provider: string; profileDir: string; url?: string; onOpen?: () => void }): Promise<void>;
}

/** שגיאות שאסור לנסות שוב אוטומטית – ניסיון חוזר עלול לנעול את החשבון */
export const NO_RETRY_ERRORS = new Set(['INVALID_PASSWORD', 'CHANGE_PASSWORD', 'ACCOUNT_BLOCKED', 'TWO_FACTOR_RETRIEVER_MISSING']);

export const ERROR_HINTS: Record<string, string> = {
  INVALID_PASSWORD: 'הבנק דחה את הכניסה. אם אתה בטוח שהפרטים נכונים (ואתה נכנס ידנית בהצלחה), ייתכן שהאתר השתנה: לחץ "צילום מסך של הכישלון" בהגדרות כדי לראות מה קרה. אחרת, פתח "עריכה" והקלד מחדש את הפרטים. (לא מנסים שוב אוטומטית כדי לא לנעול את החשבון.)',
  CHANGE_PASSWORD: 'הבנק דורש החלפת סיסמה. היכנס ידנית לאתר, החלף סיסמה ועדכן אותה בהגדרות.',
  ACCOUNT_BLOCKED: 'החשבון נחסם. יש לפנות לבנק/חברת האשראי.',
  TWO_FACTOR_RETRIEVER_MISSING: 'נדרש אימות דו-שלבי. לחץ "כניסה ראשונה" בהגדרות והתחבר בחלון שייפתח.',
  TIMEOUT: 'פג הזמן. ייתכן שהאתר איטי או חוסם גישה (בדוק שהשרת רץ מכתובת IP ישראלית).',
  SESSION_CONFLICT: 'הבנק ניתק אותנו כי כבר הייתה התחברות פתוחה לחשבון (למשל כניסה ידנית שלך או ריצה קודמת שנגמרה לא מזמן). זו לא בעיית סיסמה. נסה שוב בעוד כמה דקות, ובכניסה ידנית תמיד לחץ "יציאה" באתר לפני שאתה סוגר את החלון.',
  NETWORK: 'אין גישה לאתר מהמחשב/השרת הזה. בדוק אינטרנט, ושההרצה היא מכתובת IP ישראלית (בנקים חוסמים IP מחו״ל ושרתי ענן; VPN/ענן זר ייחסם).',
  GENERIC: 'שגיאה כללית באתר. ייתכן שהאתר השתנה או חוסם את הגישה האוטומטית.',
  GENERAL_ERROR: 'שגיאה כללית. ייתכן שהאתר השתנה, או שיש חסימת אבטחה (WAF/גאו-IP).',
};

/** שורת השגיאה הראשונה + ההסבר העדכני לפי סוג השגיאה (ההסבר לא נשמר ב-DB, כדי שתמיד יהיה מעודכן) */
export function withHint(raw: string): string {
  const first = raw.split('\n')[0] ?? raw;
  const type = first.split(':')[0] ?? '';
  const hint = ERROR_HINTS[type];
  return hint ? `${first}\n${hint}` : first;
}
