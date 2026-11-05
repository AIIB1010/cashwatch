import nodemailer from 'nodemailer';
import { sendDesktopNotification } from './desktop.ts';
import type { Config, Secrets } from '../config.ts';

export interface Message {
  subject: string;
  text: string;
  html: string;
}

export interface Channel {
  name: string;
  send(m: Message): Promise<void>;
}

async function httpOk(res: Response, what: string): Promise<void> {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

export type ChannelType = 'desktop' | 'email' | 'whatsapp';
export const CHANNEL_TYPES: ChannelType[] = ['desktop', 'email', 'whatsapp'];

/** בונה ערוץ אחד. force=true מתעלם מ-enabled (לשליחת הודעת בדיקה לפני ההפעלה). מחזיר null אם חסרות הגדרות. */
export function buildChannel(type: ChannelType, config: Config, secrets: Secrets, force = false): Channel | null {
  const n = config.notifications;
  if (type === 'desktop') {
    if (!n.desktop.enabled && !force) return null;
    return {
      name: 'desktop',
      async send(m) {
        // כותרת = ההתראה החשובה הראשונה; גוף = שורת הפירוט
        const lines = m.text.split('\n').map((l) => l.trim()).filter(Boolean);
        const title = lines.find((l) => /^[🔴🟠ℹ✅📊]/u.test(l))?.replace(/^\S+\s*/, '') ?? m.subject.replace('[CashWatch] ', '');
        const body = lines.filter((l) => l !== lines[0] && !l.startsWith('🔗') && !l.startsWith('📊')).slice(1, 4).join(' · ');
        await sendDesktopNotification(`CashWatch: ${title}`, body || m.subject);
      },
    };
  }
  if (type === 'email') {
    const email = n.email;
    if ((!email.enabled && !force) || !email.host) return null;
    const to = (Array.isArray(email.to) ? email.to : [email.to]).filter(Boolean);
    if (!to.length) return null;
    const transport = nodemailer.createTransport({
      host: email.host, port: email.port, secure: email.secure,
      auth: email.user ? { user: email.user, pass: secrets.smtpPassword ?? '' } : undefined,
      connectionTimeout: 20_000, socketTimeout: 30_000,
    });
    return { name: 'email', async send(m) { await transport.sendMail({ from: email.from || email.user, to, subject: m.subject, text: m.text, html: m.html }); } };
  }

  const wa = n.whatsapp;
  if (!wa.enabled && !force) return null;
  const to = wa.to.replace(/\D/g, '');
  const key = secrets.callmebot?.apiKey;
  if (!to || !key) return null;
  return {
    name: 'whatsapp',
    async send(m) {
      const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(to)}&text=${encodeURIComponent(m.text)}&apikey=${encodeURIComponent(key)}`;
      await httpOk(await fetch(url, { signal: AbortSignal.timeout(30_000) }), 'CallMeBot');
    },
  };
}

export function buildChannels(config: Config, secrets: Secrets): Channel[] {
  return CHANNEL_TYPES.map((t) => buildChannel(t, config, secrets)).filter((c): c is Channel => c !== null);
}

export interface DispatchResult {
  sent: string[];
  failed: Array<{ name: string; error: string }>;
}

/** שולח בכל הערוצים הפעילים; מצליח אם לפחות ערוץ אחד עבר */
export async function dispatch(channels: Channel[], m: Message): Promise<DispatchResult> {
  const sent: string[] = [];
  const failed: DispatchResult['failed'] = [];
  await Promise.all(channels.map(async (c) => {
    try { await c.send(m); sent.push(c.name); }
    catch (e) { failed.push({ name: c.name, error: e instanceof Error ? e.message : String(e) }); }
  }));
  return { sent, failed };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface AlertLine {
  severity: 'critical' | 'warning' | 'info';
  title: string;
  body: string;
  tag?: string;
}

const EMOJI = { critical: '🔴', warning: '🟠', info: 'ℹ️' } as const;
const COLOR = { critical: '#d93a3a', warning: '#e8890c', info: '#5b6b8c' } as const;
const SOFT = { critical: '#fdecec', warning: '#fff3e0', info: '#eef1f7' } as const;
const LABEL = { critical: 'דחוף', warning: 'שים לב', info: 'מידע' } as const;
const FONT = "'Segoe UI',Heebo,Arial,sans-serif";
const BRAND = '#4f46e5';

/** מעטפת משותפת למיילים: רקע בהיר, כרטיס לבן, כותרת צבעונית, כפתור לדשבורד, כותרת תחתונה */
function emailShell(opts: { title: string; subtitle?: string; chip?: { text: string; color: string; bg: string }; body: string; url?: string; preheader: string }): string {
  const chip = opts.chip ? `<span style="display:inline-block;margin-top:10px;padding:4px 12px;border-radius:999px;font-size:13px;font-weight:600;color:${opts.chip.color};background:${opts.chip.bg}">${esc(opts.chip.text)}</span>` : '';
  return `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#f1f3f9;font-family:${FONT};color:#1d2433">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f3f9"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 6px 24px rgba(30,40,90,.10)">
<tr><td style="background:${BRAND};background-image:linear-gradient(135deg,#4f46e5,#7c3aed);padding:26px 28px;color:#fff">
<div style="font-size:13px;letter-spacing:.4px;opacity:.85;font-weight:600">CashWatch · העוזר הפיננסי שלך</div>
<div style="font-size:24px;font-weight:700;margin-top:6px;line-height:1.3">${esc(opts.title)}</div>
${opts.subtitle ? `<div style="font-size:14px;opacity:.9;margin-top:4px">${esc(opts.subtitle)}</div>` : ''}${chip}
</td></tr>
<tr><td style="padding:22px 28px 8px">${opts.body}</td></tr>
${opts.url ? `<tr><td align="center" style="padding:10px 28px 26px"><a href="${esc(opts.url)}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 30px;border-radius:12px">פתח את הדשבורד</a></td></tr>` : '<tr><td style="height:18px"></td></tr>'}
<tr><td style="background:#f7f8fc;padding:14px 28px;font-size:12px;color:#7a8499;text-align:center">נשלח אוטומטית מ-CashWatch שרץ על המחשב שלך · הנתונים לא יוצאים ממנו</td></tr>
</table></td></tr></table></body></html>`;
}

export function buildAlertMessage(lines: AlertLine[], dashboardUrl?: string): Message {
  const critical = lines.filter((l) => l.severity === 'critical').length;
  const subject = `[CashWatch] ${critical ? `${critical} התראות דחופות` : `${lines.length} התראות`}`;
  const text = [
    `🔔 CashWatch – ${lines.length} התראות`,
    '',
    ...lines.flatMap((l) => [`${EMOJI[l.severity]} ${l.title}${l.tag ? ` (${l.tag})` : ''}`, l.body, '']),
    dashboardUrl ? `📊 ${dashboardUrl}` : '',
  ].join('\n').trim();
  const cards = lines.map((l) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;background:${SOFT[l.severity]};border-radius:12px;border-right:5px solid ${COLOR[l.severity]}"><tr><td style="padding:14px 16px">
<span style="display:inline-block;padding:2px 10px;border-radius:999px;background:${COLOR[l.severity]};color:#fff;font-size:12px;font-weight:700">${LABEL[l.severity]}</span>${l.tag ? ` <span style="font-size:12px;color:#5b6b8c">${esc(l.tag)}</span>` : ''}
<div style="font-size:16px;font-weight:700;margin-top:8px;line-height:1.4">${esc(l.title)}</div>
<div style="font-size:14px;color:#3a4358;margin-top:4px;line-height:1.6">${esc(l.body).replace(/\n/g, '<br>')}</div></td></tr></table>`).join('');
  const html = emailShell({
    title: critical ? 'דרושה תשומת לב' : 'יש עדכון חשוב', subtitle: `${lines.length} ${lines.length === 1 ? 'התראה' : 'התראות'} חדשות`,
    chip: critical ? { text: `${critical} דחופות`, color: '#fff', bg: 'rgba(255,255,255,.22)' } : undefined,
    body: cards, url: dashboardUrl, preheader: lines[0]?.title ?? 'התראה חדשה',
  });
  return { subject, text, html };
}

/** נתוני העדכון הקבוע, כבר מעוצבים לתצוגה (הסכומים מגיעים עם LRM) */
export interface DigestData {
  ok: boolean;
  headline: string;
  accounts: Array<{ label: string; balance: string; min: string; minDate: string; low: boolean }>;
  upcoming: Array<{ date: string; account: string; name: string; amount: string; after?: string }>;
  notes: string[];
}

export function buildDigestMessage(d: DigestData, dashboardUrl?: string): Message {
  const text = [
    `📊 עדכון CashWatch`, '', d.headline, '',
    ...d.accounts.map((a) => `• ${a.label}: ${a.balance} · השפל הצפוי ${a.min} ב-${a.minDate}`),
    ...(d.upcoming.length ? ['', 'הירידות הקרובות:', ...d.upcoming.map((u) => `• ${u.date} ${u.account}: ${u.name} ${u.amount}${u.after ? ` ← יתרה ${u.after}` : ''}`)] : []),
    ...(d.notes.length ? ['', ...d.notes] : []),
    ...(dashboardUrl ? ['', `🔗 ${dashboardUrl}`] : []),
  ].join('\n');
  const section = (t: string) => `<div style="font-size:13px;font-weight:700;color:#6b7690;margin:18px 0 8px;letter-spacing:.3px">${esc(t)}</div>`;
  const accounts = d.accounts.map((a) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;background:#f7f8fc;border-radius:12px"><tr>
<td style="padding:13px 16px"><div style="font-size:14px;font-weight:700">${esc(a.label)}</div><div style="font-size:12.5px;color:${a.low ? '#d93a3a' : '#6b7690'};margin-top:3px">השפל הצפוי ${esc(a.min)} ב-${esc(a.minDate)}</div></td>
<td align="left" style="padding:13px 16px;font-size:20px;font-weight:700;white-space:nowrap">${esc(a.balance)}</td></tr></table>`).join('');
  const upcoming = d.upcoming.length ? section('הירידות הקרובות') + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${d.upcoming.map((u) => `<tr style="border-bottom:1px solid #eceff6">
<td style="padding:9px 0;font-size:13px;color:#6b7690;white-space:nowrap;width:54px">${esc(u.date)}</td>
<td style="padding:9px 8px;font-size:14px"><b>${esc(u.name)}</b><div style="font-size:12px;color:#8892a8">${esc(u.account)}${u.after ? ` · יתרה אחריה ${esc(u.after)}` : ''}</div></td>
<td align="left" style="padding:9px 0;font-size:14px;font-weight:700;white-space:nowrap">${esc(u.amount)}</td></tr>`).join('')}</table>` : '';
  const notes = d.notes.length ? section('עוד') + d.notes.map((n) => `<div style="font-size:13.5px;color:#3a4358;line-height:1.7">${esc(n)}</div>`).join('') : '';
  const html = emailShell({
    title: 'העדכון שלך', subtitle: d.headline.replace(/^[^\p{L}\p{N}]+/u, ''),
    chip: d.ok ? { text: '✓ הכול תקין', color: '#0f7a3d', bg: '#dcf5e6' } : { text: 'יש דברים לבדוק', color: '#a35200', bg: '#ffe9cc' },
    body: section('יתרות') + accounts + upcoming + notes, url: dashboardUrl, preheader: d.headline,
  });
  return { subject: d.ok ? '[CashWatch] עדכון – הכול תקין' : '[CashWatch] עדכון – יש דברים לבדוק', text, html };
}
