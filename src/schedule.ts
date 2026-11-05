import { todayIn } from './engine/dates.ts';

export interface ScheduleInput {
  mode: 'auto' | 'fixed';
  /** שעות HH:MM (מצב fixed) */
  times: string[];
  timeZone: string;
  now: Date;
  /** מועד סיום הריצה המלאה האחרונה (כל המקורות שניתן לאסוף הצליחו) */
  lastOkAt: Date | null;
  /** מועד תחילת הניסיון האחרון (כל ריצה) */
  lastAttemptAt: Date | null;
  /** auto: כל כמה שעות לכל היותר מריצים בדיקה מלאה */
  minIntervalHours: number;
  /** אחרי ריצה שנכשלה – לא מנסים שוב לפני כמה שעות (כדי לא להציף בנקים) */
  retryHours: number;
}

const HOUR = 3_600_000;

function tzOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at);
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - at.getTime();
}

/** הופך "תאריך + שעה" באזור זמן למועד UTC */
export function zonedToUtc(date: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  let t = new Date(guess.getTime() - tzOffsetMs(guess, timeZone));
  t = new Date(guess.getTime() - tzOffsetMs(t, timeZone));
  return t;
}

/** האם הגיע הזמן להריץ בדיקה מלאה? נקראת כל כמה דקות מתזמן פנימי. */
export function isRunDue(p: ScheduleInput): boolean {
  const { now } = p;
  if (p.lastAttemptAt && now.getTime() - p.lastAttemptAt.getTime() < p.retryHours * HOUR && !(p.lastOkAt && p.lastOkAt >= p.lastAttemptAt)) {
    // ניסיון אחרון לא הצליח במלואו ועבר מעט זמן – ממתינים
    return false;
  }
  if (p.mode === 'auto') {
    return !p.lastOkAt || now.getTime() - p.lastOkAt.getTime() >= p.minIntervalHours * HOUR;
  }
  // שעות קבועות: ה"משבצת" האחרונה שחלפה (היום או אתמול). אם עוד לא רצה מאז – הגיע הזמן (גם אם המחשב היה כבוי בשעה הזו).
  const today = todayIn(p.timeZone, now);
  const yesterday = todayIn(p.timeZone, new Date(now.getTime() - 24 * HOUR));
  const slots = [yesterday, today].flatMap((d) => p.times.map((t) => zonedToUtc(d, t, p.timeZone))).filter((s) => s <= now).sort((a, b) => b.getTime() - a.getTime());
  const last = slots[0];
  if (!last) return false;
  return !p.lastOkAt || p.lastOkAt < last;
}
