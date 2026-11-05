/** קטלוג הספקים הנתמכים: שם בעברית ושדות ההתחברות שכל אחד דורש (לפי israeli-bank-scrapers) */
export interface CredentialField {
  key: string;
  label: string;
  /** נשמר מוצפן ולא מוצג שוב */
  secret: boolean;
  hint?: string;
  optional?: boolean;
}
export interface ProviderInfo {
  id: string;
  kind: 'bank' | 'card';
  name: string;
  fields: CredentialField[];
  note?: string;
}

const user = (label = 'שם משתמש'): CredentialField => ({ key: 'username', label, secret: false });
const pass: CredentialField = { key: 'password', label: 'סיסמה', secret: true };
const nid = (key = 'id'): CredentialField => ({ key, label: 'תעודת זהות', secret: false });

export const PROVIDERS: ProviderInfo[] = [
  { id: 'hapoalim', kind: 'bank', name: 'בנק הפועלים', fields: [{ key: 'userCode', label: 'קוד משתמש', secret: false }, pass],
    note: 'הבנק מבקש קוד אימות בכניסה ראשונה: השתמש בכפתור "כניסה ראשונה" ואז המכשיר נזכר.' },
  { id: 'leumi', kind: 'bank', name: 'בנק לאומי', fields: [user(), pass] },
  { id: 'mizrahi', kind: 'bank', name: 'מזרחי-טפחות', fields: [user(), pass] },
  { id: 'discount', kind: 'bank', name: 'בנק דיסקונט', fields: [nid(), pass, { key: 'num', label: 'קוד מזהה', secret: false }] },
  { id: 'mercantile', kind: 'bank', name: 'מרכנתיל', fields: [nid(), pass, { key: 'num', label: 'קוד מזהה', secret: false }] },
  { id: 'otsarHahayal', kind: 'bank', name: 'אוצר החייל', fields: [user(), pass] },
  { id: 'beinleumi', kind: 'bank', name: 'הבינלאומי', fields: [user(), pass] },
  { id: 'massad', kind: 'bank', name: 'בנק מסד', fields: [user(), pass] },
  { id: 'union', kind: 'bank', name: 'בנק איגוד', fields: [user(), pass] },
  { id: 'yahav', kind: 'bank', name: 'בנק יהב', fields: [user(), nid('nationalID'), pass] },
  { id: 'pagi', kind: 'bank', name: 'פאגי', fields: [user(), pass] },
  { id: 'oneZero', kind: 'bank', name: 'One Zero', fields: [{ key: 'email', label: 'אימייל', secret: false }, pass, { key: 'phoneNumber', label: 'טלפון (+972...)', secret: false }, { key: 'otpLongTermToken', label: 'טוקן אימות', secret: true, optional: true, hint: 'נוצר פעם אחת עם הפקודה otp-setup' }],
    note: 'דורש אימות SMS חד-פעמי דרך שורת הפקודה (otp-setup).' },
  { id: 'isracard', kind: 'card', name: 'ישראכרט', fields: [nid(), { key: 'card6Digits', label: '6 ספרות אחרונות של הכרטיס', secret: false }, pass],
    note: 'כרטיסי אמריקן אקספרס מנוהלים לעיתים באתר נפרד של אמריקן אקספרס. אם הכרטיס שלך לא מופיע ב"כרטיסים שזוהו" אחרי האיסוף – הוסף אותו בנפרד כ"אמריקן אקספרס".' },
  { id: 'amex', kind: 'card', name: 'אמריקן אקספרס', fields: [nid(), { key: 'card6Digits', label: '6 ספרות אחרונות של הכרטיס', secret: false }, pass] },
  { id: 'max', kind: 'card', name: 'מקס (לאומי קארד)', fields: [user(), pass] },
  { id: 'visaCal', kind: 'card', name: 'כאל (ויזה כאל)', fields: [user(), pass] },
  { id: 'behatsdaa', kind: 'card', name: 'בהצדעה', fields: [nid(), pass] },
  { id: 'beyahadBishvilha', kind: 'card', name: 'ביחד בשבילך', fields: [nid(), pass] },
];

export const providerById = (id: string): ProviderInfo | undefined => PROVIDERS.find((p) => p.id === id);
