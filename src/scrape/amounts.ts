/**
 * הסכום שנחשב לחיוב בפועל בשורת כרטיס אשראי.
 * בישראכרט/אמקס שורה כמו "דמי כרטיס" עם "פטור" מגיעה עם סכום עסקה (dealSum) אבל סכום חיוב 0 (paymentSum=0).
 * אם נשתמש אז בסכום העסקה – נחשב חיוב שלא קיים. לכן: חיוב 0 בשקלים = 0.
 * חיוב 0 במטבע זר = סכום ההמרה עוד לא ידוע, ואז משתמשים בסכום המקורי כהערכה.
 */
export function effectiveAmount(t: { chargedAmount?: number; originalAmount?: number; originalCurrency?: string; chargedCurrency?: string }): number {
  const charged = Number(t.chargedAmount);
  const original = Number(t.originalAmount);
  if (Number.isFinite(charged) && charged !== 0) return charged;
  if (Number.isFinite(charged) && (t.originalCurrency ?? 'ILS') === 'ILS') return 0; // פטור/חיוב אפס בשקלים
  return Number.isFinite(original) ? original : 0;
}
