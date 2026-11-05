import type { ISODate } from '../types.ts';

const MS_DAY = 86_400_000;

export const toUtc = (d: ISODate): Date => new Date(`${d}T00:00:00Z`);
export const fmtDate = (d: Date): ISODate => d.toISOString().slice(0, 10);
export const addDays = (d: ISODate, n: number): ISODate => fmtDate(new Date(toUtc(d).getTime() + n * MS_DAY));
export const daysBetween = (from: ISODate, to: ISODate): number =>
  Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / MS_DAY);

export function todayIn(timeZone: string, now: Date = new Date()): ISODate {
  // en-CA מחזיר YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** המרת חותמת זמן/ISO לתאריך מקומי לפי אזור זמן */
export function localDate(iso: string, timeZone: string): ISODate {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`תאריך לא תקין: ${iso}`);
  return todayIn(timeZone, d);
}

export const ymOf = (d: ISODate): string => d.slice(0, 7);

export function monthIndex(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return (y as number) * 12 + ((m as number) - 1);
}

export function ymFromIndex(idx: number): string {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

export function daysInMonth(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y as number, m as number, 0)).getUTCDate();
}

/** יום בחודש, עם חיתוך לסוף החודש (31 בפברואר -> 28/29) */
export function dateInMonth(ym: string, day: number): ISODate {
  const d = Math.min(Math.max(1, day), daysInMonth(ym));
  return `${ym}-${String(d).padStart(2, '0')}`;
}

/** המופע הבא של יום-חיוב חודשי, בתאריך גדול ממש מ-after */
export function nextDayOfMonthAfter(after: ISODate, day: number): ISODate {
  let idx = monthIndex(ymOf(after));
  for (let i = 0; i < 3; i++, idx++) {
    const d = dateInMonth(ymFromIndex(idx), day);
    if (d > after) return d;
  }
  return dateInMonth(ymFromIndex(idx), day);
}

/** LRM סביב הסכום – מונע היפוך סימן המינוס בטקסט עברי (RTL), גם בוואטסאפ ובמייל */
export const ils = (n: number): string => {
  const sign = n < 0 && Math.round(n) !== 0 ? '-' : '';
  return `\u200E${sign}₪${Math.abs(Math.round(n)).toLocaleString('en-US')}\u200E`;
};

export const fmtShort = (d: ISODate): string => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

/** הוספת חודשים עם חיתוך לסוף החודש */
export function addMonthsClamp(d: ISODate, n: number): ISODate {
  const day = Number(d.slice(8, 10));
  return dateInMonth(ymFromIndex(monthIndex(ymOf(d)) + n), day);
}
