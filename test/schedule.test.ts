import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRunDue, zonedToUtc, type ScheduleInput } from '../src/schedule.ts';

const base = (o: Partial<ScheduleInput>): ScheduleInput => ({
  mode: 'auto', times: ['07:00'], timeZone: 'Asia/Jerusalem', now: new Date('2026-11-05T09:00:00Z'),
  lastOkAt: null, lastAttemptAt: null, minIntervalHours: 20, retryHours: 4, ...o,
});
const d = (s: string) => new Date(s);

test('zonedToUtc: שעון ישראל (חורף UTC+2, קיץ UTC+3)', () => {
  assert.equal(zonedToUtc('2026-11-05', '07:00', 'Asia/Jerusalem').toISOString(), '2026-11-05T05:00:00.000Z');
  assert.equal(zonedToUtc('2026-07-05', '07:00', 'Asia/Jerusalem').toISOString(), '2026-07-05T04:00:00.000Z');
});

test('auto: אף פעם לא רץ -> מריץ; רץ לפני פחות מ-20 שעות -> לא; יותר -> כן', () => {
  assert.equal(isRunDue(base({})), true);
  assert.equal(isRunDue(base({ lastOkAt: d('2026-11-05T01:00:00Z'), lastAttemptAt: d('2026-11-05T01:00:00Z') })), false);
  assert.equal(isRunDue(base({ lastOkAt: d('2026-11-04T05:00:00Z'), lastAttemptAt: d('2026-11-04T05:00:00Z') })), true);
});

test('auto: אחרי ריצה שלא הצליחה במלואה ממתינים retryHours לפני ניסיון חוזר', () => {
  const failedAt = d('2026-11-05T07:30:00Z');
  assert.equal(isRunDue(base({ lastOkAt: d('2026-11-03T05:00:00Z'), lastAttemptAt: failedAt })), false); // עברה שעה וחצי
  assert.equal(isRunDue(base({ now: d('2026-11-05T12:00:00Z'), lastOkAt: d('2026-11-03T05:00:00Z'), lastAttemptAt: failedAt })), true); // עברו 4.5 שעות
});

test('fixed: המחשב נדלק אחרי שעת הריצה -> מריץ מיד; אם כבר רץ אחרי המשבצת -> לא', () => {
  // עכשיו 11:00 בישראל, המשבצת 07:00 חלפה ועוד לא רצה היום
  assert.equal(isRunDue(base({ mode: 'fixed', lastOkAt: d('2026-11-04T05:00:00Z'), lastAttemptAt: d('2026-11-04T05:00:00Z') })), true);
  assert.equal(isRunDue(base({ mode: 'fixed', lastOkAt: d('2026-11-05T06:00:00Z'), lastAttemptAt: d('2026-11-05T06:00:00Z') })), false);
});

test('fixed: לפני שעת הריצה של היום -> לא מריץ (המשבצת של אתמול כבר נענתה)', () => {
  assert.equal(isRunDue(base({ mode: 'fixed', now: d('2026-11-05T03:00:00Z'), lastOkAt: d('2026-11-04T06:00:00Z'), lastAttemptAt: d('2026-11-04T06:00:00Z') })), false);
});
