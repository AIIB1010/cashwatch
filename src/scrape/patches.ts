import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * תיקונים קטנים לספריית האיסוף (גרסה 6.13.0 מקובעת). מופעלים בזמן ריצה ובצורה בטוחה (אידמפוטנטית),
 * כדי שלא יידרש npm install מחדש. כל תיקון נבדק: אם הטקסט המקורי לא נמצא – לא נוגעים בקובץ.
 * כל תיקון מסומן בהערה `cashwatch-patch:<id>` כדי שלא יוחל פעמיים.
 */
interface Patch {
  id: string;
  file: string;
  from: string;
  to: string;
  note: string;
  /** סימון ישן (מגרסאות קודמות) שמעיד שהתיקון כבר הוחל */
  legacyMarker?: string;
}


const MIZRAHI_BALANCE_INFO_V1 = String.raw`cashwatchBalanceInfo: await (async () => { const out = { candidates: [], fieldKeys: [], rowKeys: [] }; const num = (v) => { if (typeof v === 'number') return Number.isFinite(v) ? v : null; const raw = String(v == null ? '' : v).trim(); if (!raw || raw.length > 20) return null; if (!/^[-(]?[0-9][0-9,]*(\.[0-9]+)?[-)]?$/.test(raw)) return null; const neg = /^-|-$|^\(.*\)$/.test(raw); const n = Number(raw.replace(/[^0-9.]/g, '')); return Number.isNaN(n) ? null : (neg ? -n : n); }; try { const f = response.body.fields || {}; out.fieldKeys = Object.keys(f).slice(0, 80); const pat = /yitra|balance|sof/i; for (const k of out.fieldKeys) { const n = num(f[k]); if (n !== null && pat.test(k)) out.candidates.push({ from: 'fields.' + k, value: n }); } if (!out.candidates.length) { let c = 0; for (const k of out.fieldKeys) { const n = num(f[k]); if (n !== null && c < 12) { out.candidates.push({ from: 'fields.' + k, value: n }); c++; } } } const rows = (response.body.table && response.body.table.rows) || []; if (rows.length) { out.rowKeys = Object.keys(rows[0]).slice(0, 80); const dates = rows.map((r) => String(r.MC02PeulaTaaEZ || '')); const latest = dates[0] >= dates[dates.length - 1] ? rows[0] : rows[rows.length - 1]; for (const k of out.rowKeys) { if (pat.test(k)) { const n = num(latest[k]); if (n !== null) out.candidates.push({ from: 'row.' + k, value: n }); } } } const txt = await this.page.evaluate(() => (document.body ? document.body.innerText : '')); const m = txt.match(/יתרה[^\n0-9\-]{0,40}(-?[0-9][0-9,]*\.[0-9]{1,2}-?)/); if (m) { const n = num(m[1]); if (n !== null) out.candidates.push({ from: 'dom', value: n }); } } catch (e) { out.error = String((e && e.message) || e); } return out; })(), /* cashwatch-patch:mizrahi-balanceinfo */`;

/**
 * המזרחי כבר לא מחזיר יתרה ב-fields; היתרה נמצאת בכל שורת תנועה כיתרה רצה (MC02YitraEZ).
 * קובעים אותה אוטומטית רק אם בדיקה חשבונית על השורות מאמתת את הסדר: יתרה[i] = יתרה[i+1] + סכום[i] (מהחדש לישן), או להפך.
 */
export const MIZRAHI_BALANCE_INFO_V2 = String.raw`cashwatchBalanceInfo: await (async () => { const out = { candidates: [], fieldKeys: [], rowKeys: [] }; const num = (v) => { if (typeof v === 'number') return Number.isFinite(v) ? v : null; const raw = String(v == null ? '' : v).trim(); if (!raw || raw.length > 20) return null; if (!/^[-(]?[0-9][0-9,]*(\.[0-9]+)?[-)]?$/.test(raw)) return null; const neg = /^-|-$|^\(.*\)$/.test(raw); const n = Number(raw.replace(/[^0-9.]/g, '')); return Number.isNaN(n) ? null : (neg ? -n : n); }; try { const f = response.body.fields || {}; out.fieldKeys = Object.keys(f).slice(0, 80); const pat = /yitra|balance|sof/i; for (const k of out.fieldKeys) { const n = num(f[k]); if (n !== null && pat.test(k)) out.candidates.push({ from: 'fields.' + k, value: n }); } if (!out.candidates.length) { let c = 0; for (const k of out.fieldKeys) { const n = num(f[k]); if (n !== null && c < 12) { out.candidates.push({ from: 'fields.' + k, value: n }); c++; } } } const rows = (response.body.table && response.body.table.rows) || []; if (rows.length) { out.rowKeys = Object.keys(rows[0]).slice(0, 80); const dates = rows.map((r) => String(r.MC02PeulaTaaEZ || '')); const latest = dates[0] >= dates[dates.length - 1] ? rows[0] : rows[rows.length - 1]; for (const k of out.rowKeys) { if (pat.test(k)) { const n = num(latest[k]); if (n !== null) out.candidates.push({ from: 'row.' + k, value: n }); } } const arr = rows.map((r) => ({ y: num(r.MC02YitraEZ), a: num(r.MC02SchumEZ) })).filter((x) => x.y !== null && x.a !== null); if (arr.length >= 2) { let desc = 0; let asc = 0; for (let i = 0; i < arr.length - 1; i++) { if (Math.abs(arr[i].y - (arr[i + 1].y + arr[i].a)) < 0.011) desc++; if (Math.abs(arr[i + 1].y - (arr[i].y + arr[i + 1].a)) < 0.011) asc++; } const need = Math.max(1, Math.floor((arr.length - 1) * 0.8)); if (desc >= need && desc > asc) out.auto = { value: arr[0].y, from: 'row.MC02YitraEZ', verified: true, order: 'desc' }; else if (asc >= need && asc > desc) out.auto = { value: arr[arr.length - 1].y, from: 'row.MC02YitraEZ', verified: true, order: 'asc' }; } } const txt = await this.page.evaluate(() => (document.body ? document.body.innerText : '')); const m = txt.match(/יתרה[^\n0-9\-]{0,40}(-?[0-9][0-9,]*\.[0-9]{1,2}-?)/); if (m) { const n = num(m[1]); if (n !== null) out.candidates.push({ from: 'dom', value: n }); } } catch (e) { out.error = String((e && e.message) || e); } return out; })(), /* cashwatch-patch:mizrahi-balanceinfo2 */`;

export const PATCHES: Patch[] = [
  {
    id: 'mizrahi-balance',
    file: 'lib/scrapers/mizrahi.js',
    from: 'balance: +response.body.fields?.Yitra',
    to: "balance: (() => { const raw = String(response.body.fields?.Yitra ?? '').trim(); const neg = /^-|-$|^\\(.*\\)$/.test(raw); const digits = raw.replace(/[^0-9.]/g, ''); const n = Number(digits); return digits === '' || Number.isNaN(n) ? NaN : (neg ? -n : n); })() /* cashwatch-patch:mizrahi-balance */",
    note: 'מזרחי: פענוח יתרה עם פסיקים/מינוס בסוף (במקור NaN)',
    legacyMarker: '/* cashwatch-patch */',
  },
  {
    // במקור: ברגע שמופיע בדף קישור מסוים ("סיסמה שגויה") מפסיקים לחכות ומכריזים על שגיאה –
    // בלי לחכות שהכניסה תסתיים. אם הקישור קיים כבר בדף ההתחברות, כל כניסה נכשלת גם עם פרטים נכונים.
    id: 'mizrahi-postlogin',
    file: 'lib/scrapers/mizrahi.js',
    from: 'await Promise.race([(0, _elementsInteractions.waitUntilElementFound)(page, afterLoginSelector), (0, _elementsInteractions.waitUntilElementFound)(page, invalidPasswordSelector), (0, _navigation.waitForUrl)(page, CHANGE_PASSWORD_URL)]);',
    // החלפת סיסמה היא מסלול אפשרי בלבד. waitForUrl דוחה Promise כשהוא לא קורה,
    // ולכן אסור שידחה את כל הכניסה הרגילה. ברשת איטית מזרחי מציג "מיד מעבירים"
    // לפני המעבר בפועל; נותנים לו עד דקה וחצי, אך נשארים בתוך תקרת הניסיון של 3 דקות.
    to: 'await Promise.race([(0, _elementsInteractions.waitUntilElementFound)(page, afterLoginSelector).catch(() => new Promise(() => {})), (0, _navigation.waitForUrl)(page, CHANGE_PASSWORD_URL).catch(() => new Promise(() => {})), new Promise((resolve) => setTimeout(resolve, 90000))]); /* cashwatch-patch:mizrahi-postlogin */',
    note: 'מזרחי: מסלול החלפת סיסמה אינו מפיל כניסה רגילה; המתנה סלחנית למעבר לחשבון',
  },
  {
    id: 'mizrahi-success',
    file: 'lib/scrapers/mizrahi.js',
    from: '[_baseScraperWithBrowser.LoginResults.Success]: [AFTER_LOGIN_BASE_URL, isLoggedIn],',
    to: String.raw`[_baseScraperWithBrowser.LoginResults.Success]: [AFTER_LOGIN_BASE_URL, isLoggedIn, async () => !!(await page.$(afterLoginSelector)), /https:\/\/mto\.mizrahi-tefahot\.co\.il\/(OnlinePilot|Online)\/.*/], /* cashwatch-patch:mizrahi-success */`,
    note: 'מזרחי: זיהוי כניסה מוצלחת גם כשכתובת הדף או שם הלשונית השתנו',
  },
  {
    id: 'mizrahi-invalid',
    file: 'lib/scrapers/mizrahi.js',
    from: '[_baseScraperWithBrowser.LoginResults.InvalidPassword]: [async () => !!(await page.$(invalidPasswordSelector))],',
    to: '[_baseScraperWithBrowser.LoginResults.InvalidPassword]: [async () => !!(await page.$(invalidPasswordSelector)) && !(await page.$(afterLoginSelector))], /* cashwatch-patch:mizrahi-invalid */',
    note: 'מזרחי: "סיסמה שגויה" רק אם הכניסה באמת לא הושלמה',
  },
];

PATCHES.push(
  {
    // אחרי לחיצה על "כניסה" הספרייה מחכה 20 שניות בלבד שהדף יתקדם. בנק איטי = כשל, גם בלי שום בעיית אימות.
    id: 'nav-redirect',
    file: 'lib/helpers/navigation.js',
    from: 'async function waitForRedirect(pageOrFrame, timeout = 20000, clientSide = false, ignoreList = []) {',
    to: 'async function waitForRedirect(pageOrFrame, timeout = 90000, clientSide = false, ignoreList = []) { /* cashwatch-patch:nav-redirect */',
    note: 'כל הבנקים: המתנה של עד 90 שניות להתקדמות הדף אחרי כניסה (במקום 20)',
  },
  {
    // כשהדף לא מתקדם אחרי "כניסה" כי האתר הציג "פרטים/סיסמה שגויים" (ולא נתפס ע"י הספרייה) – מדווחים סיסמה שגויה במקום TIMEOUT,
    // כדי שהמערכת תפסיק לנסות שוב ושוב (סכנת נעילת חשבון).
    id: 'nav-badcreds',
    file: 'lib/helpers/navigation.js',
    from: 'await (0, _waiting.waitUntil)(async () => {\n    const current = await getCurrentUrl(pageOrFrame, clientSide);\n    return current !== initial && !ignoreList.includes(current);\n  }, `waiting for redirect from ${initial}`, timeout, 1000);',
    to: 'try { await (0, _waiting.waitUntil)(async () => {\n    const current = await getCurrentUrl(pageOrFrame, clientSide);\n    return current !== initial && !ignoreList.includes(current);\n  }, `waiting for redirect from ${initial}`, timeout, 1000); } catch (cwErr) { let bad = false; try { const t = await pageOrFrame.evaluate(() => (document.body ? document.body.innerText : \'\')); bad = /(שם משתמש|סיסמ[האת]|פרטי[םן]?( ה?(זיהוי|כניסה|התחברות))?)[^\\n]{0,40}(שגוי|שגויים|לא נכון|לא תקינ)/.test(t); } catch (e2) {} if (bad) throw new Error(\'CASHWATCH_BAD_CREDENTIALS\'); throw cwErr; } /* cashwatch-patch:nav-badcreds */',
    note: 'כל הבנקים: זיהוי "פרטים שגויים" בדף כשהכניסה לא מתקדמת (במקום TIMEOUT)',
  },
  {
    // איסוף "מועמדים" ליתרה (שם שדה + ערך) כדי שהמשתמש יבחר את הנכון, במקום לנחש ולהציג יתרה שגויה
    id: 'mizrahi-balanceinfo',
    file: 'lib/scrapers/mizrahi.js',
    from: 'return {\n      accountNumber,\n      txns: allTxn,',
    to: 'return {\n      accountNumber,\n      txns: allTxn,\n      ' + MIZRAHI_BALANCE_INFO_V1,
    note: 'מזרחי: איסוף ערכים שעשויים להיות היתרה (לבחירת המשתמש)',
  },
  {
    id: 'mizrahi-balanceinfo2',
    file: 'lib/scrapers/mizrahi.js',
    from: MIZRAHI_BALANCE_INFO_V1,
    to: MIZRAHI_BALANCE_INFO_V2,
    note: 'מזרחי: יתרה רצה מאומתת חשבונית (MC02YitraEZ)',
  },
  {
    // המזרחי מציג "יצאת מהחשבון בהצלחה" כשיש התחברות פתוחה אחרת: זה לא סיסמה שגויה. מסמנים ומדווחים כקונפליקט.
    id: 'mizrahi-loggedout',
    file: 'lib/scrapers/mizrahi.js',
    from: '[_baseScraperWithBrowser.LoginResults.InvalidPassword]: [async () => !!(await page.$(invalidPasswordSelector)) && !(await page.$(afterLoginSelector))], /* cashwatch-patch:mizrahi-invalid */',
    to: "[_baseScraperWithBrowser.LoginResults.InvalidPassword]: [async () => { if (!(await page.$(invalidPasswordSelector)) || (await page.$(afterLoginSelector))) return false; try { const t = await page.evaluate(() => (document.body ? document.body.innerText : '')); if (t.includes('יצאת מהחשבון בהצלחה')) { globalThis.__cashwatchLoggedOut = true; return false; } } catch (e) {} return true; }], /* cashwatch-patch:mizrahi-loggedout */",
    note: 'מזרחי: זיהוי דף "יצאת מהחשבון" (קונפליקט התחברות) במקום "סיסמה שגויה"',
  },
  {
    // בסוף כל איסוף מתנתקים מהחשבון (אם נמצא כפתור יציאה), כדי שהכניסה הבאה לא תתנגש בהתחברות פתוחה.
    id: 'mizrahi-logout',
    file: 'lib/scrapers/mizrahi.js',
    from: "async fetchData() {\n    await this.page.$eval('#dropdownBasic, .item', el => el.click());",
    to: "async terminate(success) { try { await this.page.evaluate(() => { const el = Array.from(document.querySelectorAll('a,button,span,div')).find((e) => e.children.length === 0 && /^\\s*(יציאה|התנתקות|יציאה מהחשבון|התנתק)\\s*$/.test(e.textContent || '')); if (el) el.click(); }); await new Promise((r) => setTimeout(r, 2500)); } catch (e) {} return super.terminate(success); } /* cashwatch-patch:mizrahi-logout */\n  async fetchData() {\n    await this.page.$eval('#dropdownBasic, .item', el => el.click());",
    note: 'מזרחי: התנתקות בסוף איסוף',
  },
  {
  // אבחון בלבד: שומר את שמות השדות (בלי ערכים) שהבנק מחזיר, כדי למצוא איפה נמצאת היתרה
  id: 'mizrahi-debug',
  file: 'lib/scrapers/mizrahi.js',
  from: 'const relevantRows = response.body.table.rows.filter(row => row.RecTypeSpecified);',
  to: 'const relevantRows = response.body.table.rows.filter(row => row.RecTypeSpecified); try { globalThis.__cashwatchMizrahiFields = { fields: Object.keys(response.body.fields || {}), row: Object.keys(response.body.table.rows[0] || {}) }; } catch (e) {} /* cashwatch-patch:mizrahi-debug */',
  note: 'מזרחי: שמירת שמות שדות לאבחון יתרה',
  },
);

export function applyLibraryPatches(log: (m: string) => void = () => {}): string[] {
  const applied: string[] = [];
  try {
    const req = createRequire(import.meta.url);
    const root = path.dirname(req.resolve('israeli-bank-scrapers/package.json'));
    for (const p of PATCHES) {
      const file = path.join(root, p.file);
      if (!fs.existsSync(file)) continue;
      const src = fs.readFileSync(file, 'utf8');
      if (src.includes(`cashwatch-patch:${p.id}`) || (p.legacyMarker && src.includes(p.legacyMarker)) || !src.includes(p.from)) continue;
      fs.writeFileSync(file, src.replace(p.from, p.to));
      applied.push(p.id);
      log(`🩹 הוחל תיקון לספרייה: ${p.note}`);
    }
  } catch (e) {
    log(`לא הצלחתי להחיל תיקוני ספרייה: ${e instanceof Error ? e.message : e}`);
  }
  return applied;
}
