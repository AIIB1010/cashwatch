export const $ = (id) => document.getElementById(id);
export const NS = 'http://www.w3.org/2000/svg';

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
export function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const kid of kids) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
export const ils = (n) => '\u200E' + (n < 0 && Math.round(n) !== 0 ? '-' : '') + '₪' + Math.abs(Math.round(n)).toLocaleString('en-US') + '\u200E';
export const dm = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
export const dmy = (d) => `${dm(d)}/${d.slice(2, 4)}`;
export const ago = (iso) => {
  if (!iso) return 'מעולם';
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'הרגע';
  if (m < 60) return `לפני ${m} דק׳`;
  if (m < 1440) return `לפני ${Math.round(m / 60)} שע׳`;
  return `לפני ${Math.round(m / 1440)} ימים`;
};

export async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'cashwatch', ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `שגיאה ${res.status}`);
  return body;
}


export function avatar(text) {
  let hash = 0;
  for (const ch of String(text)) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return h('span', { class: 'avatar', style: `--h:${hash}` }, String(text).trim().slice(0, 1) || '•');
}

/** אייקון לפי בנק/חברת אשראי: מונוגרמה בצבע מזהה (לא לוגו רשמי). בנק = ריבוע, כרטיס אשראי = כרטיס עם פס */
const BRANDS = {
  hapoalim: ['#d6212a', 'פ'], leumi: ['#1363d6', 'ל'], mizrahi: ['#e8820c', 'מ'], discount: ['#0b8a5f', 'ד'], mercantile: ['#0b6aa8', 'מר'],
  otsarHahayal: ['#1f3f86', 'אה'], union: ['#7a3b9c', 'או'], beinleumi: ['#1b78bd', 'בל'], massad: ['#c0392b', 'מס'], yahav: ['#0f9488', 'יה'],
  oneZero: ['#151a27', '01'], pagi: ['#2e7d32', 'פג'],
  isracard: ['#2552a8', 'י'], amex: ['#0a7fc2', 'AX'], max: ['#f26522', 'M'], visaCal: ['#10a06f', 'כ'], behatsdaa: ['#7c3aed', 'ב'], beyahadBishvilha: ['#d6409f', 'בי'],
};
const CARD_IDS = new Set(['isracard', 'amex', 'max', 'visaCal', 'behatsdaa', 'beyahadBishvilha']);
export function providerIcon(provider, label = '') {
  const b = BRANDS[provider];
  if (!b) return avatar(label || provider || '?');
  const [color, glyph] = b;
  const card = CARD_IDS.has(provider);
  const el = h('span', { class: 'pico' + (card ? ' card' : ''), style: `--c:${color}`, title: card ? 'כרטיס אשראי' : 'חשבון בנק', 'aria-hidden': 'true' },
    card ? h('i', { class: 'stripe' }) : null, h('b', {}, glyph));
  // הלוגו הרשמי (אם הצליח להיטען מהאתר של הספק) מחליף את המונוגרמה
  const img = document.createElement('img');
  img.alt = '';
  img.addEventListener('load', () => { if (img.naturalWidth > 8) el.classList.add('logo'); else img.remove(); });
  img.addEventListener('error', () => img.remove());
  img.src = `/api/logos/${encodeURIComponent(provider)}`;
  el.append(img);
  return el;
}

const ICONS = {
  wallet: ['M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1', 'M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4'],
  down: ['M16 17h6v-6', 'm22 17-8.5-8.5-5 5L2 7'],
  card: ['M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M2 10h20'],
  bell: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
  chart: ['M3 3v18h18', 'm7 15 4-4 3 3 5-6'],
};
export function icon(name) {
  const svg = s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  for (const d of ICONS[name] ?? []) svg.append(s('path', { d }));
  return svg;
}
