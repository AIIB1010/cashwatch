import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { Finding, ISODate, RecurringItem, Txn } from './types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS balances (
  account_id TEXT PRIMARY KEY, label TEXT, balance REAL, balance_at TEXT);
CREATE TABLE IF NOT EXISTS balance_history (
  account_id TEXT, at TEXT, balance REAL);
CREATE INDEX IF NOT EXISTS ix_bh ON balance_history(account_id, at);
CREATE TABLE IF NOT EXISTS txns (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, kind TEXT NOT NULL, account_ref TEXT NOT NULL,
  date TEXT NOT NULL, processed_date TEXT NOT NULL, amount REAL NOT NULL,
  description TEXT, memo TEXT, status TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_txn ON txns(source_id, date);
CREATE TABLE IF NOT EXISTS recurring (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL, account_id TEXT NOT NULL,
  amount REAL NOT NULL, day_of_month INTEGER NOT NULL, interval_months INTEGER NOT NULL DEFAULT 1,
  anchor_month TEXT, match TEXT, tolerance_pct REAL NOT NULL DEFAULT 10, grace_days INTEGER NOT NULL DEFAULT 3,
  active INTEGER NOT NULL DEFAULT 1, start_date TEXT, end_date TEXT, note TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS alert_state (
  key TEXT PRIMARY KEY, kind TEXT, severity TEXT, title TEXT, body TEXT, fingerprint TEXT,
  first_seen TEXT, last_seen TEXT, last_notified TEXT, resolved_at TEXT);
CREATE TABLE IF NOT EXISTS source_status (
  source_id TEXT PRIMARY KEY, last_attempt_at TEXT, last_success_at TEXT, last_error TEXT, last_duration_ms INTEGER);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT, finished_at TEXT, trigger TEXT, ok INTEGER, summary TEXT);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS source_log (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT, at TEXT, ok INTEGER, error_type TEXT, duration_ms INTEGER);
CREATE INDEX IF NOT EXISTS ix_sl ON source_log(source_id, id);
`;

export interface SourceStatusRow {
  sourceId: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
}

export interface AlertRow extends Finding {
  firstSeen: string;
  lastSeen: string;
  lastNotified: string | null;
  resolvedAt: string | null;
}

export class Store {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    const cols = (this.db.prepare('PRAGMA table_info(recurring)').all() as Array<{ name: string }>).map((c) => c.name);
    const tcols = (this.db.prepare('PRAGMA table_info(txns)').all() as Array<{ name: string }>).map((c) => c.name);
    for (const [c, def] of [['original_amount', 'REAL'], ['original_currency', 'TEXT'], ['installment_no', 'INTEGER'], ['installment_total', 'INTEGER'], ['category', 'TEXT'], ['identifier', 'TEXT'], ['txn_type', 'TEXT']] as const) {
      if (!tcols.includes(c)) this.db.exec(`ALTER TABLE txns ADD COLUMN ${c} ${def}`);
    }
    for (const [c, def] of [['auto', 'INTEGER NOT NULL DEFAULT 0'], ['auto_key', 'TEXT'], ['reviewed', 'INTEGER NOT NULL DEFAULT 1']] as const) {
      if (!cols.includes(c)) this.db.exec(`ALTER TABLE recurring ADD COLUMN ${c} ${def}`);
    }
  }
  close() { this.db.close(); }

  // ---------- יתרות ----------
  setBalance(accountId: string, label: string, balance: number, atIso: string) {
    this.db.prepare('INSERT INTO balances(account_id,label,balance,balance_at) VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET label=excluded.label,balance=excluded.balance,balance_at=excluded.balance_at').run(accountId, label, balance, atIso);
    this.db.prepare('INSERT INTO balance_history(account_id,at,balance) VALUES(?,?,?)').run(accountId, atIso, balance);
  }
  getBalance(accountId: string): { balance: number; at: string } | null {
    const r = this.db.prepare('SELECT balance, balance_at AS at FROM balances WHERE account_id=?').get(accountId) as { balance: number; at: string } | undefined;
    return r ?? null;
  }
  /** יתרה ידנית (לבנקים שלא מחזירים יתרה): הסכום שהמשתמש הזין ותאריך ההזנה. מתעדכנת לפי תנועות מאוחרות יותר */
  setAnchor(accountId: string, amount: number, date: string): void {
    this.setKv(`balance_anchor:${accountId}`, JSON.stringify({ amount, date }));
  }
  getAnchor(accountId: string): { amount: number; date: string } | null {
    const raw = this.getKv(`balance_anchor:${accountId}`);
    return raw ? (JSON.parse(raw) as { amount: number; date: string }) : null;
  }

  balanceHistory(accountId: string, sinceIso: string): Array<{ at: string; balance: number }> {
    return this.db.prepare('SELECT at, balance FROM balance_history WHERE account_id=? AND at>=? ORDER BY at').all(accountId, sinceIso) as Array<{ at: string; balance: number }>;
  }

  // ---------- תנועות ----------
  /**
   * מחליף את התמונה העדכנית של מקור: מוחק תנועות "חיות" (בטווח הסריקה או ממתינות) ומכניס מחדש.
   * כך עסקה שהייתה ממתינה והפכה לסופית לא תוכפל.
   */
  replaceTxns(sourceId: string, kind: 'bank' | 'card', since: ISODate, txns: Omit<Txn, 'id' | 'sourceId'>[]): number {
    const counts = new Map<string, number>();
    const rows = txns.map((t) => {
      const base = createHash('sha1').update([sourceId, t.accountRef, t.date, t.processedDate, t.amount.toFixed(2), t.description, t.memo].join('|')).digest('hex').slice(0, 20);
      const n = (counts.get(base) ?? 0) + 1;
      counts.set(base, n);
      return { ...t, id: `${base}#${n}`, sourceId };
    });
    this.db.exec('BEGIN');
    try {
      this.db.prepare("DELETE FROM txns WHERE source_id=? AND (date>=? OR processed_date>=? OR status='pending')").run(sourceId, since, since);
      const ins = this.db.prepare('INSERT OR REPLACE INTO txns(id,source_id,kind,account_ref,date,processed_date,amount,description,memo,status,original_amount,original_currency,installment_no,installment_total,category,identifier,txn_type) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const r of rows) ins.run(r.id, sourceId, kind, r.accountRef, r.date, r.processedDate, r.amount, r.description, r.memo, r.status, r.originalAmount ?? null, r.originalCurrency ?? null, r.installmentNo ?? null, r.installmentTotal ?? null, r.category ?? null, r.identifier ?? null, r.txnType ?? null);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return rows.length;
  }
  countTxnsSince(sourceId: string, since: ISODate): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM txns WHERE source_id=? AND date>=?').get(sourceId, since) as { c: number }).c;
  }
  getTxns(kind: 'bank' | 'card', since: ISODate): Txn[] {
    const rows = this.db.prepare('SELECT * FROM txns WHERE kind=? AND (date>=? OR processed_date>=?) ORDER BY date').all(kind, since, since) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string, sourceId: r.source_id as string, accountRef: r.account_ref as string,
      date: r.date as string, processedDate: r.processed_date as string, amount: r.amount as number,
      description: (r.description as string) ?? '', memo: (r.memo as string) ?? '', status: r.status as 'completed' | 'pending',
    }));
  }

  /** שליפה גמישה לתנועות (ל-API): לפי מקור, טווח תאריכים וסטטוס */
  queryTxns(q: { sourceId?: string; from?: ISODate; to?: ISODate; status?: 'completed' | 'pending'; limit?: number; offset?: number }): Txn[] {
    const where: string[] = []; const args: Array<string | number> = [];
    if (q.sourceId) { where.push('source_id=?'); args.push(q.sourceId); }
    if (q.from) { where.push('date>=?'); args.push(q.from); }
    if (q.to) { where.push('date<=?'); args.push(q.to); }
    if (q.status) { where.push('status=?'); args.push(q.status); }
    const limit = Math.min(Math.max(q.limit ?? 1000, 1), 10_000);
    const sql = `SELECT * FROM txns ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date DESC, id LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...args, limit, Math.max(q.offset ?? 0, 0)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string, sourceId: r.source_id as string, accountRef: r.account_ref as string,
      date: r.date as string, processedDate: r.processed_date as string, amount: r.amount as number,
      description: (r.description as string) ?? '', memo: (r.memo as string) ?? '', status: r.status as 'completed' | 'pending',
      originalAmount: (r.original_amount as number | null) ?? null, originalCurrency: (r.original_currency as string | null) ?? null,
      installmentNo: (r.installment_no as number | null) ?? null, installmentTotal: (r.installment_total as number | null) ?? null,
      category: (r.category as string | null) ?? null, identifier: (r.identifier as string | null) ?? null, txnType: (r.txn_type as string | null) ?? null,
    }));
  }

  // ---------- הוראות קבועות ----------
  private rowToItem(r: Record<string, unknown>): RecurringItem {
    return {
      id: r.id as number, name: r.name as string, kind: r.kind as 'expense' | 'income', accountId: r.account_id as string,
      amount: r.amount as number, dayOfMonth: r.day_of_month as number, intervalMonths: r.interval_months as number,
      anchorMonth: (r.anchor_month as string) || null, match: (r.match as string) || null, tolerancePct: r.tolerance_pct as number,
      graceDays: r.grace_days as number, active: !!r.active, startDate: (r.start_date as string) || null,
      endDate: (r.end_date as string) || null, note: (r.note as string) ?? '',
      auto: !!r.auto, autoKey: (r.auto_key as string) || null, reviewed: r.reviewed === undefined ? true : !!r.reviewed,
    };
  }
  listRecurring(): RecurringItem[] {
    return (this.db.prepare('SELECT * FROM recurring ORDER BY kind DESC, day_of_month, name').all() as Array<Record<string, unknown>>).map((r) => this.rowToItem(r));
  }
  saveRecurring(item: Omit<RecurringItem, 'id'> & { id?: number }): RecurringItem {
    const vals = [item.name, item.kind, item.accountId, item.amount, item.dayOfMonth, item.intervalMonths, item.anchorMonth, item.match, item.tolerancePct, item.graceDays, item.active ? 1 : 0, item.startDate, item.endDate, item.note, item.auto ? 1 : 0, item.autoKey ?? null, item.reviewed === false ? 0 : 1];
    if (item.id) {
      const r = this.db.prepare('UPDATE recurring SET name=?,kind=?,account_id=?,amount=?,day_of_month=?,interval_months=?,anchor_month=?,match=?,tolerance_pct=?,grace_days=?,active=?,start_date=?,end_date=?,note=?,auto=?,auto_key=?,reviewed=? WHERE id=?').run(...vals, item.id);
      if (!r.changes) throw new Error('הפריט לא נמצא');
      return { ...item, id: item.id };
    }
    const r = this.db.prepare('INSERT INTO recurring(name,kind,account_id,amount,day_of_month,interval_months,anchor_month,match,tolerance_pct,grace_days,active,start_date,end_date,note,auto,auto_key,reviewed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...vals);
    return { ...item, id: Number(r.lastInsertRowid) };
  }
  getRecurring(id: number): RecurringItem | null {
    const r = this.db.prepare('SELECT * FROM recurring WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToItem(r) : null;
  }
  /** מחיקה. הוראה שזוהתה אוטומטית נרשמת כ"נדחתה" כדי שלא תוצע שוב */
  deleteRecurring(id: number): boolean {
    const it = this.getRecurring(id);
    if (it?.autoKey) this.dismiss(it.autoKey);
    return this.db.prepare('DELETE FROM recurring WHERE id=?').run(id).changes > 0;
  }
  approveAllAuto(): number {
    return Number(this.db.prepare('UPDATE recurring SET reviewed=1 WHERE reviewed=0').run().changes);
  }
  getDismissed(): Set<string> {
    const raw = this.getKv('dismissed_patterns');
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  }
  dismiss(key: string): void {
    const d = this.getDismissed();
    d.add(key);
    this.setKv('dismissed_patterns', JSON.stringify([...d]));
  }

  // ---------- סטטוס מקורות ----------
  markAttempt(sourceId: string, atIso: string) {
    this.db.prepare('INSERT INTO source_status(source_id,last_attempt_at) VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at').run(sourceId, atIso);
  }
  markSuccess(sourceId: string, atIso: string, durationMs: number) {
    this.db.prepare('INSERT INTO source_status(source_id,last_attempt_at,last_success_at,last_error,last_duration_ms) VALUES(?,?,?,NULL,?) ON CONFLICT(source_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,last_error=NULL,last_duration_ms=excluded.last_duration_ms').run(sourceId, atIso, atIso, durationMs);
  }
  markFailure(sourceId: string, atIso: string, error: string, durationMs: number) {
    this.db.prepare('INSERT INTO source_status(source_id,last_attempt_at,last_error,last_duration_ms) VALUES(?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_error=excluded.last_error,last_duration_ms=excluded.last_duration_ms').run(sourceId, atIso, error, durationMs);
  }
  /** יומן ניסיונות איסוף (להבנת דפוסי כשל לאורך זמן) */
  logAttempt(sourceId: string, atIso: string, ok: boolean, errorType: string | null, durationMs: number): void {
    this.db.prepare('INSERT INTO source_log(source_id,at,ok,error_type,duration_ms) VALUES(?,?,?,?,?)').run(sourceId, atIso, ok ? 1 : 0, errorType, durationMs);
    this.db.prepare('DELETE FROM source_log WHERE source_id=? AND id NOT IN (SELECT id FROM source_log WHERE source_id=? ORDER BY id DESC LIMIT 200)').run(sourceId, sourceId);
  }
  recentAttempts(sourceId: string, limit = 14): Array<{ at: string; ok: boolean; errorType: string | null; durationMs: number }> {
    return (this.db.prepare('SELECT at, ok, error_type, duration_ms FROM source_log WHERE source_id=? ORDER BY id DESC LIMIT ?').all(sourceId, limit) as Array<Record<string, unknown>>)
      .map((r) => ({ at: r.at as string, ok: !!r.ok, errorType: (r.error_type as string) ?? null, durationMs: (r.duration_ms as number) ?? 0 })).reverse();
  }

  listSourceStatus(): SourceStatusRow[] {
    return (this.db.prepare('SELECT * FROM source_status').all() as Array<Record<string, unknown>>).map((r) => ({
      sourceId: r.source_id as string, lastAttemptAt: (r.last_attempt_at as string) ?? null, lastSuccessAt: (r.last_success_at as string) ?? null,
      lastError: (r.last_error as string) ?? null, lastDurationMs: (r.last_duration_ms as number) ?? null,
    }));
  }

  // ---------- התראות ----------
  getAlertState(key: string): AlertRow | null {
    const r = this.db.prepare('SELECT * FROM alert_state WHERE key=?').get(key) as Record<string, string> | undefined;
    return r ? this.rowToAlert(r) : null;
  }
  private rowToAlert(r: Record<string, string>): AlertRow {
    return { key: r.key!, kind: r.kind as Finding['kind'], severity: r.severity as Finding['severity'], title: r.title!, body: r.body!, fingerprint: r.fingerprint!, firstSeen: r.first_seen!, lastSeen: r.last_seen!, lastNotified: r.last_notified ?? null, resolvedAt: r.resolved_at ?? null };
  }
  listAlerts(activeOnly: boolean): AlertRow[] {
    const sql = activeOnly ? 'SELECT * FROM alert_state WHERE resolved_at IS NULL ORDER BY first_seen' : 'SELECT * FROM alert_state ORDER BY last_seen DESC LIMIT 100';
    return (this.db.prepare(sql).all() as Array<Record<string, string>>).map((r) => this.rowToAlert(r));
  }
  upsertAlert(f: Finding, nowIso: string, notified: boolean) {
    this.db.prepare(`INSERT INTO alert_state(key,kind,severity,title,body,fingerprint,first_seen,last_seen,last_notified,resolved_at) VALUES(?,?,?,?,?,?,?,?,?,NULL)
      ON CONFLICT(key) DO UPDATE SET kind=excluded.kind,severity=excluded.severity,title=excluded.title,body=excluded.body,fingerprint=excluded.fingerprint,
      first_seen=CASE WHEN alert_state.resolved_at IS NOT NULL THEN excluded.first_seen ELSE alert_state.first_seen END,
      last_seen=excluded.last_seen, resolved_at=NULL,
      last_notified=CASE WHEN ? THEN excluded.last_notified ELSE alert_state.last_notified END`)
      .run(f.key, f.kind, f.severity, f.title, f.body, f.fingerprint, nowIso, nowIso, notified ? nowIso : null, notified ? 1 : 0);
  }
  resolveMissing(activeKeys: string[], nowIso: string): string[] {
    const open = this.listAlerts(true).filter((a) => !activeKeys.includes(a.key));
    for (const a of open) this.db.prepare('UPDATE alert_state SET resolved_at=? WHERE key=?').run(nowIso, a.key);
    return open.map((a) => a.title);
  }

  /** כרטיסים שזוהו תחת כניסה אחת של חברת אשראי (4 ספרות אחרונות + מספר תנועות) */
  listCardRefs(sourceId: string): Array<{ ref: string; count: number }> {
    return (this.db.prepare('SELECT account_ref AS ref, COUNT(*) AS count FROM txns WHERE source_id=? GROUP BY account_ref ORDER BY account_ref').all(sourceId) as Array<{ ref: string; count: number }>);
  }

  /** מחיקת כל הנתונים של מקור שהוסר */
  deleteSourceData(sourceId: string): void {
    this.db.prepare('DELETE FROM txns WHERE source_id=?').run(sourceId);
    this.db.prepare('DELETE FROM source_status WHERE source_id=?').run(sourceId);
    this.db.prepare('DELETE FROM balances WHERE account_id=?').run(sourceId);
    this.db.prepare('DELETE FROM balance_history WHERE account_id=?').run(sourceId);
  }

  // ---------- ריצות ו-kv ----------
  startRun(trigger: string, atIso: string): number {
    return Number(this.db.prepare('INSERT INTO runs(started_at,trigger) VALUES(?,?)').run(atIso, trigger).lastInsertRowid);
  }
  finishRun(id: number, atIso: string, ok: boolean, summary: unknown) {
    this.db.prepare('UPDATE runs SET finished_at=?, ok=?, summary=? WHERE id=?').run(atIso, ok ? 1 : 0, JSON.stringify(summary), id);
  }
  listRuns(limit = 15): Array<{ id: number; startedAt: string; finishedAt: string | null; trigger: string; ok: boolean | null; summary: unknown }> {
    return (this.db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as number, startedAt: r.started_at as string, finishedAt: (r.finished_at as string) ?? null, trigger: r.trigger as string,
      ok: r.ok === null || r.ok === undefined ? null : !!r.ok, summary: r.summary ? JSON.parse(r.summary as string) : null,
    }));
  }
  lastRunStartedAt(): string | null {
    const r = this.db.prepare('SELECT started_at FROM runs ORDER BY id DESC LIMIT 1').get() as { started_at: string } | undefined;
    return r?.started_at ?? null;
  }
  /** אחרי שהמשתמש עדכן פרטי התחברות – מאפשרים לנסות שוב */
  clearSourceError(sourceId: string): void {
    this.db.prepare('UPDATE source_status SET last_error=NULL WHERE source_id=?').run(sourceId);
  }
  lastSuccessfulRun(): string | null {
    const r = this.db.prepare('SELECT finished_at FROM runs WHERE ok=1 ORDER BY id DESC LIMIT 1').get() as { finished_at: string } | undefined;
    return r?.finished_at ?? null;
  }
  getKv(k: string): string | null {
    return (this.db.prepare('SELECT v FROM kv WHERE k=?').get(k) as { v: string } | undefined)?.v ?? null;
  }
  setKv(k: string, v: string) {
    this.db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v);
  }
}
