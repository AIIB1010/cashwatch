/**
 * מנעול יחיד לכל שימוש בדפדפן (איסוף, בדיקת חיבור, כניסה ראשונה).
 * מונע שני תהליכי Chromium על אותו פרופיל בו-זמנית (שמקלקל התחברות ומנעול פרופיל).
 */
let chain: Promise<unknown> = Promise.resolve();
const MAX_HOLD_MS = 25 * 60_000;

export function withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  // אם פעולה נתקעת, לא חוסמים את כל הבאות אחריה יותר מ-MAX_HOLD_MS
  const held = run.then(() => undefined, () => undefined);
  chain = Promise.race([held, new Promise<undefined>((r) => { const t = setTimeout(() => r(undefined), MAX_HOLD_MS); t.unref?.(); })]);
  return run;
}
