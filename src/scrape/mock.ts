import { addDays, addMonthsClamp } from '../engine/dates.ts';
import type { ScrapeOutcome, ScrapeProvider, ScrapeRequest } from './types.ts';

type MockTxn = { accountRef: string; date: string; processedDate: string; amount: number; description: string; memo: string; status: 'completed' | 'pending' };

/** תאריכי הדמו – פונקציה של "היום", כדי שההדגמה תעבוד בכל תאריך */
export function demoDates(today: string) {
  const d = (off: number) => addDays(today, off);
  return {
    salary: d(-12), rent: d(-10), arnona: d(-8), cashW: d(-2), isracardCharge: d(-4),
    sideJob: d(-9), insurance: d(-7), maxCharge: d(-5),
    missingIncome: d(-6), missingExpense: d(-6),
  };
}

/** נתוני דמה למצב הדגמה – כדי לראות את הדשבורד וההתראות בלי להתחבר לשום בנק */
export class MockScrapeProvider implements ScrapeProvider {
  constructor(private readonly today: string, private readonly failing: Set<string> = new Set()) {}

  async scrape(req: ScrapeRequest): Promise<ScrapeOutcome> {
    if (this.failing.has(req.sourceId)) return { ok: false, errorType: 'TIMEOUT', errorMessage: 'פג הזמן בהמתנה לאתר (דמו)' };
    const t = this.today;
    const D = demoDates(t);
    const tx = (ref: string, date: string, amount: number, description: string, extra: Partial<MockTxn> = {}): MockTxn =>
      ({ accountRef: ref, date, processedDate: date, amount, description, memo: '', status: 'completed', ...extra });

    if (req.sourceId === 'poalim') {
      const ref = '12-345-678901';
      return { ok: true, accounts: [{ accountNumber: ref, balance: 6400, txns: [
        tx(ref, D.salary, 14500, 'משכורת - חברת הייטק בע"מ'),
        tx(ref, D.rent, -4200, 'שכר דירה - הוראת קבע'),
        tx(ref, D.arnona, -380, 'ארנונה עיריית תל אביב'),
        tx(ref, D.isracardCharge, -3120.4, 'ישראכרט בע"מ'),
        tx(ref, D.cashW, -250, 'משיכת מזומן'),
      ] }] };
    }
    if (req.sourceId === 'leumi') {
      const ref = '800-5566778';
      return { ok: true, accounts: [{ accountNumber: ref, balance: 900, txns: [
        tx(ref, D.sideJob, 3200, 'העברה - עבודה צדדית'),
        tx(ref, D.insurance, -650, 'ביטוח בריאות הראל'),
        tx(ref, D.maxCharge, -1980, 'מקס איט פיננסים'),
      ] }] };
    }
    if (req.sourceId === 'isracard-1') {
      const cur = D.isracardCharge;
      const next = addMonthsClamp(cur, 1);
      return { ok: true, accounts: [{ accountNumber: '4580', txns: [
        tx('4580', addDays(t, -30), -1260, 'סופר שוק', { processedDate: cur }),
        tx('4580', addDays(t, -27), -1860.4, 'דלק + קניות', { processedDate: cur }),
        tx('4580', addDays(t, -9), -2200, 'כרטיסי טיסה', { processedDate: next }),
        tx('4580', addDays(t, -5), -940, 'מסעדות וקפה', { processedDate: next }),
        tx('4580', addDays(t, -1), -430, 'רשת מזון', { processedDate: addDays(t, -1), status: 'pending' }),
        tx('4580', t, -120, 'שירותי ממשל - אגרה', { processedDate: t, status: 'pending' }),
      ] }] };
    }
    if (req.sourceId === 'max-1') {
      const cur = D.maxCharge;
      const next = addMonthsClamp(cur, 1);
      return { ok: true, accounts: [{ accountNumber: '9921', txns: [
        tx('9921', addDays(t, -29), -1980, 'חנות בגדים', { processedDate: cur }),
        tx('9921', addDays(t, -12), -1400, 'ריהוט לבית', { processedDate: next }),
        tx('9921', addDays(t, -2), -310, 'משלוח אוכל', { processedDate: addDays(t, -2), status: 'pending' }),
      ] }] };
    }
    return { ok: false, errorType: 'GENERIC', errorMessage: `אין נתוני דמו עבור ${req.sourceId}` };
  }
}
