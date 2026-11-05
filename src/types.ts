/** תאריך בפורמט YYYY-MM-DD (לפי אזור הזמן של המשתמש) */
export type ISODate = string;

export interface Txn {
  id: string;
  sourceId: string;
  /** חשבון בנק (id מה-config) או 4 ספרות אחרונות של כרטיס */
  accountRef: string;
  date: ISODate;
  processedDate: ISODate;
  /** שלילי = יציאה, חיובי = כניסה */
  amount: number;
  description: string;
  memo: string;
  status: 'completed' | 'pending';
}

export type RecurringKind = 'expense' | 'income';

export interface RecurringItem {
  id: number;
  name: string;
  kind: RecurringKind;
  accountId: string;
  /** סכום חיובי תמיד; הכיוון נקבע לפי kind */
  amount: number;
  dayOfMonth: number;
  /** 1 = כל חודש, 2 = דו-חודשי, 3 = רבעוני, 12 = שנתי */
  intervalMonths: number;
  /** YYYY-MM – חודש עוגן כשהמרווח גדול מ-1 */
  anchorMonth: string | null;
  /** ביטוי חופשי/regex לזיהוי השורה בתנועות הבנק (אופציונלי) */
  match: string | null;
  /** סטייה מותרת בסכום באחוזים */
  tolerancePct: number;
  /** כמה ימים אחרי התאריך הצפוי עדיין לא נחשב "לא ירד/לא נכנס" */
  graceDays: number;
  active: boolean;
  startDate: ISODate | null;
  endDate: ISODate | null;
  note: string;
  /** זוהה אוטומטית מהיסטוריית התנועות */
  auto?: boolean;
  autoKey?: string | null;
  /** false = זוהה אוטומטית וממתין לאישור המשתמש */
  reviewed?: boolean;
}

export interface BankAccountState {
  id: string;
  label: string;
  balance: number | null;
  balanceAt: string | null;
  alertBelow: number;
  overdraftLimit: number;
}

export interface CardSourceConfig {
  id: string;
  label: string;
  /** חשבון הבנק ממנו יורד החיוב (ברירת מחדל) */
  fundingAccount: string;
  /** 4 ספרות אחרונות -> חשבון בנק אחר */
  fundingOverrides: Record<string, string>;
  billingDay: number | null;
  /** regex לזיהוי שורת החיוב בבנק */
  chargeMatch: string;
}

export type Certainty = 'scheduled' | 'estimated' | 'assumed';

export interface ForecastEvent {
  date: ISODate;
  accountId: string;
  type: 'recurring-expense' | 'recurring-income' | 'card-charge';
  name: string;
  amount: number;
  certainty: Certainty;
  ref?: string;
  /** היתרה הצפויה בסוף אותו יום, אחרי האירוע */
  balanceAfter?: number;
}

export interface DayPoint {
  date: ISODate;
  balance: number;
  delta: number;
}

export interface AccountForecast {
  accountId: string;
  label: string;
  startBalance: number | null;
  balanceAt: string | null;
  alertBelow: number;
  overdraftLimit: number;
  timeline: DayPoint[];
  events: ForecastEvent[];
  minBalance: number | null;
  minDate: ISODate | null;
  firstBreachDate: ISODate | null;
  /** כמה חסר כדי לא לרדת מתחת לסף (0 אם הכול בסדר) */
  shortfall: number;
}

export type OccurrenceState = 'upcoming' | 'due' | 'matched' | 'missing';

export interface Occurrence {
  itemId: number;
  name: string;
  kind: RecurringKind;
  accountId: string;
  date: ISODate;
  amount: number;
  state: OccurrenceState;
  matchedTxnId?: string;
  matchedAmount?: number;
}

export interface CardCharge {
  sourceId: string;
  label: string;
  fundingAccount: string;
  date: ISODate;
  /** שלילי */
  amount: number;
  txnCount: number;
  /** true אם חלק מהסכום הוא עסקאות "ממתינות" ללא תאריך חיוב סופי */
  estimated: boolean;
  state: OccurrenceState | 'mismatch';
  bankAmount?: number;
}

export type Severity = 'critical' | 'warning' | 'info';

export interface Finding {
  key: string;
  kind:
    | 'low-balance'
    | 'income-missing'
    | 'expense-missing'
    | 'card-not-charged'
    | 'card-mismatch'
    | 'scrape-failed'
    | 'stale-data'
    | 'no-balance';
  severity: Severity;
  title: string;
  body: string;
  /** משתנה כשהמצב החמיר/השתנה מהותית, ואז נשלחת התראה חדשה */
  fingerprint: string;
}

export interface Analysis {
  today: ISODate;
  horizonDays: number;
  accounts: AccountForecast[];
  occurrences: Occurrence[];
  cardCharges: CardCharge[];
  findings: Finding[];
}
