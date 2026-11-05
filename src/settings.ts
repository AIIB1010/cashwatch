import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { configSchema, secretsSchema, type Config, type Secrets } from './config.ts';
import { decrypt, encrypt, isPassphraseMode, loadKeyUnlessLocked, MIN_PASSPHRASE, passFilePath, shredFile, storeKeyMachineProtected, unwrapWithPassphrase, wrapWithPassphrase } from './crypto.ts';
import { Store } from './db.ts';

export function validateConfig(c: Config): void {
  const ids = [...c.banks.map((b) => b.id), ...c.cards.map((x) => x.id)];
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`מזהה כפול: ${dup}`);
  const banks = new Set(c.banks.map((b) => b.id));
  for (const card of c.cards) {
    for (const ref of [card.fundingAccount, ...Object.values(card.cardOverrides)]) {
      if (!banks.has(ref)) throw new Error(`הכרטיס "${card.label}" מפנה לחשבון בנק שלא קיים`);
    }
  }
}

/** הגדרות המערכת – נשמרות ב-DB (הסודות מוצפנים). הדשבורד הוא ממשק העריכה. */
export class Settings {
  private cfg: Config | null = null;
  private sec: Secrets | null = null;

  constructor(readonly store: Store, readonly dataDir: string, private key: Buffer | null) {}

  /** נעול בסיסמה: פרטי ההתחברות לא נגישים עד unlock */
  get locked(): boolean { return this.key === null; }
  get passphraseMode(): boolean { return isPassphraseMode(this.dataDir); }

  unlock(passphrase: string): void {
    if (this.key) return;
    this.key = unwrapWithPassphrase(fs.readFileSync(passFilePath(this.dataDir), 'utf8'), passphrase);
    this.sec = null;
  }

  /** מפעיל נעילה בסיסמה: המפתח עטוף בסיסמה, ונמחק כל עותק שלו שמוגן רק ע"י המחשב */
  enablePassphrase(passphrase: string): void {
    if (!this.key) throw new Error('המערכת נעולה');
    if (passphrase.length < MIN_PASSPHRASE) throw new Error(`הסיסמה קצרה מדי (לפחות ${MIN_PASSPHRASE} תווים)`);
    fs.writeFileSync(passFilePath(this.dataDir), wrapWithPassphrase(this.key, passphrase));
    for (const f of ['.keyfile', '.keyfile.dpapi']) { const p = path.join(this.dataDir, f); if (fs.existsSync(p)) shredFile(p); }
  }

  /** מבטל נעילה בסיסמה (דורש את הסיסמה הנוכחית) וחוזר להגנת המחשב */
  disablePassphrase(passphrase: string): void {
    if (!this.key) throw new Error('המערכת נעולה');
    const k = unwrapWithPassphrase(fs.readFileSync(passFilePath(this.dataDir), 'utf8'), passphrase);
    if (!k.equals(this.key)) throw new Error('סיסמה שגויה');
    storeKeyMachineProtected(this.dataDir, this.key);
    shredFile(passFilePath(this.dataDir));
  }

  get config(): Config {
    if (!this.cfg) {
      const raw = this.store.getKv('config');
      this.cfg = configSchema.parse(raw ? JSON.parse(raw) : {});
    }
    return this.cfg;
  }

  get secrets(): Secrets {
    if (!this.key) return secretsSchema.parse({}); // נעול: אין גישה לסודות
    if (!this.sec) {
      const raw = this.store.getKv('secrets');
      const parsed = secretsSchema.parse(raw ? JSON.parse(decrypt(this.key, raw)) : {});
      if (process.env.DASHBOARD_PASSWORD) parsed.dashboardPassword = process.env.DASHBOARD_PASSWORD;
      this.sec = parsed;
    }
    return this.sec;
  }

  get hasConfig(): boolean {
    return this.store.getKv('config') !== null;
  }

  updateConfig(mutate: (c: Config) => void): Config {
    const next = structuredClone(this.config);
    mutate(next);
    const parsed = configSchema.parse(next);
    validateConfig(parsed);
    this.store.setKv('config', JSON.stringify(parsed));
    this.cfg = parsed;
    return parsed;
  }

  updateSecrets(mutate: (s: Secrets) => void): void {
    if (!this.key) throw new Error('המערכת נעולה – הזן את סיסמת הנעילה בדשבורד');
    const next = structuredClone(this.secrets);
    mutate(next);
    const parsed = secretsSchema.parse(next);
    this.store.setKv('secrets', encrypt(this.key, JSON.stringify(parsed)));
    this.sec = parsed;
  }

  /** ייבוא חד-פעמי מקבצי config.yaml / secrets.yaml (למי שכבר הגדיר דרכם) */
  importYaml(configPath: string, secretsPath: string): boolean {
    if (this.hasConfig || !fs.existsSync(configPath)) return false;
    const config = configSchema.parse(YAML.parse(fs.readFileSync(configPath, 'utf8')) ?? {});
    validateConfig(config);
    this.store.setKv('config', JSON.stringify(config));
    this.cfg = config;
    if (fs.existsSync(secretsPath) && this.key) {
      const secrets = secretsSchema.parse(YAML.parse(fs.readFileSync(secretsPath, 'utf8')) ?? {});
      this.store.setKv('secrets', encrypt(this.key, JSON.stringify(secrets)));
      this.sec = null;
    }
    return true;
  }
}

export interface OpenedSettings {
  settings: Settings;
  store: Store;
  dataDir: string;
  imported: boolean;
}

export function openSettings(opts: { dataDir?: string; configPath?: string; secretsPath?: string } = {}): OpenedSettings {
  const dataDir = path.resolve(opts.dataDir ?? process.env.CASHWATCH_DATA ?? 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const store = new Store(path.join(dataDir, 'cashwatch.db'));
  const settings = new Settings(store, dataDir, loadKeyUnlessLocked(dataDir));
  const imported = settings.importYaml(
    path.resolve(opts.configPath ?? process.env.CASHWATCH_CONFIG ?? 'config.yaml'),
    path.resolve(opts.secretsPath ?? process.env.CASHWATCH_SECRETS ?? 'secrets.yaml'),
  );
  return { settings, store, dataDir, imported };
}

/** הנתיב של secrets.yaml הישן (טקסט גלוי, מהגרסאות הראשונות) */
export function legacySecretsPath(): string {
  return path.resolve(process.env.CASHWATCH_SECRETS ?? 'secrets.yaml');
}

/**
 * מחיקה מאובטחת של secrets.yaml הישן – **רק לפי בקשה מפורשת של המשתמש** (כפתור בהגדרות), לעולם לא אוטומטית.
 * (גרסה 1.2.14 מחקה אותו אוטומטית מתוך בדיקה וגרמה למחיקת קובץ אמיתי; לכן אין יותר שום מחיקה אוטומטית.)
 */
export function deleteLegacySecretsFile(secretsPath: string): boolean {
  if (!fs.existsSync(secretsPath)) return false;
  shredFile(secretsPath);
  return true;
}
