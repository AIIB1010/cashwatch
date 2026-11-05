import { $, s, h, ils, dm, dmy, ago, api, avatar, icon, providerIcon } from './ui.js';
import { renderSettings } from './settings.js';
let state = null;
let sig = '';
const onDashboard = () => location.hash !== '#settings';

/** טוען מצב. מרנדר מחדש רק כשהנתונים באמת השתנו (מונע הבהוב). */
async function load(force = false) {
  const next = await api('/api/state');
  // דלי של 5 דקות בחתימה: כך הטקסטים היחסיים ("לפני X") מתעדכנים גם כשהנתונים עצמם לא השתנו
  const nextSig = JSON.stringify(next, (k, v) => (k === 'now' || k === 'progress' ? undefined : v)) + Math.floor(Date.now() / 300_000);
  const changed = force || nextSig !== sig;
  sig = nextSig;
  state = next;
  updateChrome();
  if (changed && onDashboard()) renderDash();
  return state;
}

function updateChrome() {
  const { alerts } = state;
  const crit = alerts.filter((a) => a.severity === 'critical').length;
  const pill = $('statusPill');
  pill.className = 'pill ' + (crit ? 'bad' : alerts.length ? 'warn' : 'ok');
  pill.textContent = crit ? `${crit} התראות דחופות` : alerts.length ? `${alerts.length} התראות` : 'הכול תקין';
  const lastRun = state.runs[0];
  $('lastRun').textContent = state.running ? 'בודק עכשיו…' : lastRun ? `עודכן ${ago(lastRun.finishedAt || lastRun.startedAt)}` : 'עוד לא הייתה ריצה';
  $('runBtn').disabled = state.running;
  $('runBtn').textContent = state.running ? 'בודק…' : 'רענן נתונים עכשיו';
  const prog = state.progress;
  const active = prog ? Object.values(prog.items).find((i) => ['running', 'retry-wait', 'waiting'].includes(i.state)) : null;
  const doneItems = prog ? Object.values(prog.items).filter((i) => ['done', 'skipped', 'failed'].includes(i.state)) : [];
  $('runInfo').hidden = !state.running;
  $('runInfo').textContent = !state.running ? '' : prog?.canceling ? 'מבטל…' : active ? `${active.label}: ${active.message ?? ''}` : doneItems.length ? doneItems.map((i) => `${i.label}: ${i.message ?? ''}`).join(' · ') : 'מתחיל…';
  $('cancelBtn2').hidden = !state.running || !!prog?.canceling;
  $('version').textContent = state.version ? `גרסה ${state.version}` : '';
  const badge = $('bellBadge');
  badge.hidden = alerts.length === 0;
  badge.textContent = String(alerts.length);
  $('bellBtn').classList.toggle('has-alerts', crit > 0);
}

function alertCard(a) {
  const [first, ...rest] = a.body.split('\n');
  return h('div', { class: `alert ${a.severity}` }, h('div', { class: 'alert-ico' }, a.severity === 'info' ? 'i' : '!'),
    h('div', { class: 'alert-body' }, h('b', {}, a.title), h('div', { class: 'small' }, first),
      rest.length ? h('details', {}, h('summary', {}, 'פרטים'), h('pre', {}, rest.join('\n'))) : null,
      a.key.startsWith('scrape-failed:') ? h('a', { class: 'small', href: `/api/failures/${a.key.split(':')[1]}`, target: '_blank', rel: 'noopener' }, 'צילום מסך של הכישלון ↗') : null));
}

function openAlerts() {
  const list = $('alertsList');
  list.replaceChildren(...(state.alerts.length ? state.alerts.map(alertCard) : [h('div', { class: 'empty' }, '🎉 אין התראות פעילות. הכול תקין.')]));
  $('alertsDlg').showModal();
}

function renderDash() {
  const { analysis, alerts } = state;
  $('horizonNote').textContent = `בדיקה לכל ירידה צפויה (חיובי אשראי, הוראות קבע, הוצאות והכנסות קבועות) ב-${analysis.horizonDays} הימים הקרובים · ${state.schedule.mode === 'auto' ? 'בדיקה אוטומטית פעם ביום, כשהמחשב דלוק' : `בדיקה אוטומטית ב-${state.schedule.times.join(', ')}`}`;
  $('onboard').hidden = state.banks.length + state.cards.length > 0;
  renderHero();
  renderAccounts();
  renderCards();
  renderRecurring();
  renderSources();
}

function tile(cls, ico, label, value, sub, onclick) {
  return h('div', { class: `card tile ${cls}${onclick ? ' clickable' : ''}`, onclick, role: onclick ? 'button' : null, tabindex: onclick ? 0 : null },
    h('div', { class: 'ico' }, icon(ico)), h('div', {}, h('div', { class: 'lbl' }, label), h('div', { class: 'val' }, value), h('div', { class: 'sub' }, sub || ' ')));
}

function renderHero() {
  const accs = state.analysis.accounts.filter((a) => a.startBalance != null);
  const n = state.alerts.length;
  const crit = state.alerts.some((a) => a.severity === 'critical');
  const alertsTile = tile(n ? (crit ? 'bad' : 'warn') : 'good', 'bell', 'התראות פעילות', n ? String(n) : 'אין', n ? 'לחץ לצפייה' : 'הכול תקין', openAlerts);
  if (!accs.length) return void $('hero').replaceChildren(alertsTile);
  const total = accs.reduce((t, a) => t + a.startBalance, 0);
  const debits = accs.flatMap((a) => a.events.filter((e) => e.amount < 0).map((e) => ({ a, e }))).sort((x, y) => (x.e.date < y.e.date ? -1 : x.e.date > y.e.date ? 1 : x.e.amount - y.e.amount));
  const next = debits[0];
  const breach = accs.filter((a) => a.firstBreachDate).sort((a, b) => (a.firstBreachDate < b.firstBreachDate ? -1 : 1))[0];
  const lowest = accs.reduce((w, a) => (!w || a.minBalance - a.alertBelow < w.minBalance - w.alertBelow ? a : w), null);
  $('hero').replaceChildren(
    tile('', 'wallet', 'סך יתרות בנק', ils(total), `${accs.length} חשבונות`),
    next ? tile('', 'card', 'הירידה הקרובה', ils(Math.abs(next.e.amount)), `${dm(next.e.date)} · ${next.e.name}`) : tile('', 'card', 'הירידה הקרובה', '—', 'אין ירידות צפויות'),
    breach ? tile('bad', 'down', 'מינוס צפוי', dm(breach.firstBreachDate), `${breach.label} · חסרים ${ils(breach.shortfall)}`)
      : tile('good', 'down', 'אין חשש למינוס', 'בטוח', `הנמוכה ביותר ${ils(lowest.minBalance)} · ${lowest.label} ב-${dm(lowest.minDate)}`),
    alertsTile);
}

function renderAccounts() {
  const box = $('accounts');
  if (!state.analysis.accounts.length) return void box.replaceChildren();
  box.replaceChildren(...state.analysis.accounts.map((a) => {
    const bad = a.firstBreachDate;
    const head = h('div', { class: 'acc-head' },
      h('div', {}, h('div', { class: 'acc-id' }, providerIcon(state.banks.find((b) => b.id === a.accountId)?.provider, a.label), h('div', {}, h('div', { class: 'acc-name' }, a.label), h('div', { class: 'muted small' }, a.balanceAt ? `יתרה מ${ago(a.balanceAt)}` : 'אין נתוני יתרה'))),
        h('div', { class: 'bal' + (a.startBalance != null && a.startBalance < 0 ? ' neg' : '') }, a.startBalance == null ? '—' : ils(a.startBalance))),
      h('span', { class: 'tag ' + (a.startBalance == null ? 'neutral' : bad ? 'bad' : 'ok') }, a.startBalance == null ? 'אין נתונים' : bad ? `מינוס צפוי ב-${dm(a.firstBreachDate)}` : 'בטוח – אין מינוס צפוי'));
    const kv = a.startBalance == null ? null : h('div', { class: 'kv' },
      h('div', {}, h('span', { class: 'muted small' }, 'היתרה הנמוכה הצפויה'), h('b', { class: a.minBalance < a.alertBelow ? 'neg' : '', style: 'direction:ltr;display:inline-block' }, ils(a.minBalance)), ` · ${dm(a.minDate)}`),
      bad ? h('div', {}, h('span', { class: 'muted small' }, 'להפקיד לפחות'), h('b', {}, ils(a.shortfall))) : null,
      a.overdraftLimit ? h('div', {}, h('span', { class: 'muted small' }, 'מסגרת אוברדראפט'), ils(a.overdraftLimit)) : null);
    const evs = a.events;
    const outs = evs.filter((e) => e.amount < 0).slice(0, 4);
    const debitList = a.startBalance == null || !outs.length ? null : h('div', { class: 'debits' }, h('h5', {}, 'הירידות הקרובות והיתרה אחריהן'),
      outs.map((e) => h('div', { class: 'debit' + (e.balanceAfter != null && e.balanceAfter < a.alertBelow ? ' risk' : '') },
        h('span', { class: 'd' }, dm(e.date)), h('span', {}, e.name, e.certainty === 'estimated' ? h('span', { class: 'tag warn', style: 'margin-inline-start:6px' }, 'הערכה') : null),
        h('span', { class: 'amt' }, ils(e.amount)), h('span', { class: 'after' }, e.balanceAfter != null ? `יתרה אחרי ${ils(e.balanceAfter)}` : ''))));
    const list = h('details', {}, h('summary', {}, `כל האירועים הצפויים (${evs.length})`),
      evs.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ...['תאריך', 'אירוע', 'סכום', 'יתרה אחרי', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, evs.map((e) => h('tr', {}, h('td', {}, dmy(e.date)), h('td', {}, e.name),
          h('td', { class: 'num ' + (e.amount < 0 ? 'neg' : 'pos') }, ils(e.amount)),
          h('td', { class: 'num' + (e.balanceAfter != null && e.balanceAfter < a.alertBelow ? ' neg' : '') }, e.balanceAfter != null ? ils(e.balanceAfter) : ''),
          h('td', {}, e.certainty === 'estimated' ? h('span', { class: 'tag warn' }, 'הערכה') : e.certainty === 'assumed' ? h('span', { class: 'tag bad' }, 'טרם ירד') : null)))))) : h('div', { class: 'empty' }, 'אין אירועים צפויים'));
    let noBal = null;
    if (a.startBalance == null) {
      const src = state.sources.find((x) => x.id === a.accountId);
      if (!src?.lastSuccessAt) {
        noBal = h('div', { class: 'banner' }, h('div', {}, h('b', {}, 'עדיין לא נאספו נתונים מהחשבון הזה'), h('span', { class: 'muted small' }, 'היכנס להגדרות ולחץ "בדוק חיבור" כדי למשוך נתונים.')), h('a', { class: 'btn primary', href: '#settings' }, 'להגדרות'));
      } else {
        const amount = h('input', { type: 'number', step: '0.01', placeholder: 'היתרה הנוכחית ₪', style: 'max-width:180px' });
        const saveBalance = async (val, btn) => {
          if (btn) btn.disabled = true;
          try { await api(`/api/settings/sources/${a.accountId}/balance`, { method: 'PUT', body: JSON.stringify({ amount: Number(val) }) }); await load(true); } catch (e) { alert(e.message); if (btn) btn.disabled = false; }
        };
        const save = h('button', { class: 'btn primary', onclick: () => { if (amount.value !== '') saveBalance(amount.value, save); } }, 'שמור יתרה');
        const hints = (src?.balanceHints ?? []).filter((x, i, arr) => arr.findIndex((y) => y.value === x.value) === i);
        const hintBox = hints.length ? h('div', { style: 'margin-top:8px' }, h('div', { class: 'small muted' }, 'הבנק החזיר את הערכים האלה. אם אחד מהם הוא היתרה שמופיעה באפליקציית הבנק שלך, לחץ עליו:'),
          h('div', { class: 'row-actions', style: 'flex-wrap:wrap;margin-top:6px' }, hints.map((x) => { const b = h('button', { class: 'btn', title: x.from, onclick: () => saveBalance(x.value, b) }, ils(x.value)); return b; }))) : null;
        noBal = h('div', { class: 'banner', style: 'display:block' }, h('div', { class: 'row-between', style: 'flex-wrap:wrap;gap:10px' }, h('div', {}, h('b', {}, 'הבנק לא החזיר יתרה'), h('span', { class: 'muted small' }, 'הזן פעם אחת את היתרה הנוכחית (כמו באפליקציית הבנק). מכאן היא תתעדכן לבד לפי התנועות.')), h('div', { class: 'row-actions' }, amount, save)), hintBox);
      }
    }
    return h('div', { class: 'card' }, head, noBal, kv, debitList, a.startBalance == null ? null : chart(a), list);
  }));
}

let uid = 0;
function chart(a) {
  const W = Math.max(300, Math.min(640, document.documentElement.clientWidth - 64)), H = W < 480 ? 170 : 190, pl = 8, pr = 8, pt = 14, pb = 24;
  const pts = a.timeline;
  const vals = pts.map((p) => p.balance).concat([a.alertBelow]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.12 || 500;
  lo -= pad; hi += pad;
  const x = (i) => pl + (i / (pts.length - 1)) * (W - pl - pr); // ציר זמן משמאל לימין, כמקובל בתרשימים
  const y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
  // קו מדרגות
  let d = `M${x(0)},${y(pts[0].balance)}`;
  for (let i = 1; i < pts.length; i++) d += ` H${x(i)} V${y(pts[i].balance)}`;
  const area = d + ` V${y(lo)} H${x(0)} Z`;
  const id = `c${++uid}`;
  const yT = y(a.alertBelow);
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, style: 'direction:ltr', role: 'img', 'aria-label': `תחזית יתרה ל${a.label}` },
    s('defs', {},
      s('clipPath', { id: `${id}a` }, s('rect', { x: 0, y: 0, width: W, height: yT })),
      s('clipPath', { id: `${id}b` }, s('rect', { x: 0, y: yT, width: W, height: H })),
      s('linearGradient', { id: `${id}g`, x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: '0%', style: 'stop-color:var(--accent);stop-opacity:.32' }), s('stop', { offset: '100%', style: 'stop-color:var(--accent);stop-opacity:0' })),
      s('linearGradient', { id: `${id}r`, x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: '0%', style: 'stop-color:var(--bad);stop-opacity:.05' }), s('stop', { offset: '100%', style: 'stop-color:var(--bad);stop-opacity:.32' }))));
  // רשת
  for (let k = 0; k <= 3; k++) {
    const v = lo + ((hi - lo) * k) / 3;
    svg.append(s('line', { x1: pl, x2: W - pr, y1: y(v), y2: y(v), stroke: 'var(--grid)', 'stroke-width': 1 }));
  }
  svg.append(
    s('path', { d: area, fill: `url(#${id}g)`, 'clip-path': `url(#${id}a)` }),
    s('path', { d: area, fill: `url(#${id}r)`, 'clip-path': `url(#${id}b)` }),
    s('path', { d, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2.4, 'clip-path': `url(#${id}a)`, 'stroke-linejoin': 'round' }),
    s('path', { d, fill: 'none', stroke: 'var(--bad)', 'stroke-width': 2.4, 'clip-path': `url(#${id}b)`, 'stroke-linejoin': 'round' }),
    s('line', { x1: pl, x2: W - pr, y1: yT, y2: yT, stroke: 'var(--bad)', 'stroke-dasharray': '4 4', 'stroke-width': 1 }),
    s('text', { x: W - pr, y: yT - 4, 'text-anchor': 'end' }, a.alertBelow === 0 ? 'גבול: ₪0' : `גבול: ${ils(a.alertBelow)}`));
  // סימוני אירועים
  pts.forEach((p, i) => { if (p.delta !== 0) svg.append(s('circle', { cx: x(i), cy: y(p.balance), r: 2.6, fill: p.delta < 0 ? 'var(--bad)' : 'var(--good)' })); });
  // תוויות ציר X
  const last = pts.length - 1;
  const ticks = W < 480 ? [0, 12, 24, last] : [0, 7, 14, 21, 28, last];
  ticks.filter((i, k, arr) => i <= last && arr.indexOf(i) === k && (i === last || last - i >= 4)).forEach((i) =>
    svg.append(s('text', { x: x(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === last ? 'end' : 'middle' }, i === 0 ? 'היום' : dm(pts[i].date))));
  // נקודת שפל
  const mi = pts.findIndex((p) => p.date === a.minDate);
  if (mi >= 0) svg.append(s('circle', { cx: x(mi), cy: y(a.minBalance), r: 5, fill: 'none', stroke: a.minBalance < a.alertBelow ? 'var(--bad)' : 'var(--accent)', 'stroke-width': 2 }));
  // מעבר עכבר/מגע
  const cross = s('line', { y1: pt, y2: H - pb, stroke: 'var(--muted)', 'stroke-width': 1, visibility: 'hidden' });
  const tip = s('text', { y: pt + 10, 'text-anchor': 'middle', style: 'fill:var(--text);font-size:12.5px;font-weight:700;paint-order:stroke;stroke:var(--surface);stroke-width:6px;stroke-linejoin:round', visibility: 'hidden' });
  svg.append(cross, tip);
  svg.addEventListener('pointermove', (ev) => {
    const r = svg.getBoundingClientRect();
    const vx = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((vx - pl) / (W - pl - pr)) * (pts.length - 1))));
    const cx = x(i);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
    tip.textContent = `${dm(pts[i].date)}: ${ils(pts[i].balance)}`;
    tip.setAttribute('x', Math.min(W - 60, Math.max(60, cx))); tip.setAttribute('visibility', 'visible');
  });
  svg.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tip.setAttribute('visibility', 'hidden'); });
  return svg;
}

const CARD_STATE = {
  upcoming: ['neutral', 'צפוי'], due: ['warn', 'אמור לרדת'], matched: ['ok', 'ירד ✓'], missing: ['bad', 'לא ירד!'], mismatch: ['warn', 'סכום שונה'],
};
function renderCards() {
  const t = $('cardsTable');
  const rows = state.analysis.cardCharges;
  const bankLabel = new Map(state.banks.map((b) => [b.id, b.label]));
  if (!rows.length) return void t.replaceChildren(h('tbody', {}, h('tr', {}, h('td', { class: 'empty' }, 'אין חיובי אשראי להצגה'))));
  t.replaceChildren(
    h('thead', {}, h('tr', {}, ...['תאריך חיוב', 'כרטיס', 'יורד מחשבון', 'סכום', 'עסקאות', 'סטטוס'].map((x) => h('th', {}, x)))),
    h('tbody', {}, rows.map((c) => {
      const [cls, label] = CARD_STATE[c.state] || ['neutral', c.state];
      return h('tr', {}, h('td', {}, dmy(c.date)), h('td', {}, c.label), h('td', {}, bankLabel.get(c.fundingAccount) || c.fundingAccount),
        h('td', { class: 'num neg' }, ils(c.amount)), h('td', {}, String(c.txnCount)),
        h('td', {}, h('span', { class: `tag ${cls}` }, label), c.estimated ? h('span', { class: 'tag warn', title: 'כולל עסקאות שעדיין ממתינות לחיוב' }, ' הערכה') : null,
          c.state === 'mismatch' ? h('span', { class: 'muted small' }, ` בבנק: ${ils(c.bankAmount)}`) : null));
    })));
}

function renderReviewBanner() {
  const pending = state.recurring.filter((r) => r.auto && !r.reviewed);
  const b = $('reviewBanner');
  b.hidden = !pending.length;
  if (!pending.length) return;
  b.replaceChildren(h('div', {}, h('b', {}, `זוהו ${pending.length} הוראות קבועות חדשות מההיסטוריה שלך`), h('span', { class: 'muted small' }, 'הן כבר נלקחות בחשבון בתחזית. בדוק שהן נכונות: לחץ על שורה כדי לערוך או למחוק.')),
    h('button', { class: 'btn primary', onclick: async () => { await api('/api/recurring/approve-all', { method: 'POST', body: '{}' }); await load(true); } }, 'אשר הכול'));
}

/** הרשימה נשארת פתוחה אחרי "התעלם" (המסך נבנה מחדש אחרי כל פעולה) */
let nearOpen = false;
function renderDetectInfo() {
  const d = state.detection;
  const box = $('detectInfo');
  if (!d || !d.accounts.length) { box.hidden = true; return; }
  const noAuto = !state.recurring.some((r) => r.auto);
  if (!d.needsHistory && !d.nearMisses.length && !noAuto) { box.hidden = true; return; }
  box.hidden = false;
  const lines = d.accounts.filter((a) => a.txnCount > 0).map((a) => `${a.label}: ${a.txnCount} תנועות, היסטוריה של ${a.historyDays} ימים`);
  box.replaceChildren(
    h('b', {}, d.needsHistory ? 'עוד אין מספיק היסטוריה כדי לזהות הוצאות והכנסות שחוזרות' : 'למה לא זוהו הוצאות חוזרות נוספות?'),
    h('div', { class: 'small muted' }, lines.join(' · '), d.needsHistory ? ' · כדי לזהות דפוס צריך לפחות 3 חודשים. לחץ "סרוק היסטוריה" והמערכת תמשוך היסטוריה ארוכה מהבנק.' : ''),
    d.nearMisses.length ? h('details', { open: nearOpen, ontoggle: (e) => { nearOpen = e.target.open; } }, h('summary', {}, `קבוצות שכמעט זוהו (${d.nearMisses.length})`),
      h('div', { class: 'row-between' },
        h('p', { class: 'small muted' }, 'אפשר להוסיף כל אחת כהוראה קבועה בעצמך (תוכל לתקן שם יום וסכום), או ללחוץ "התעלם" כדי שלא תוצג שוב.'),
        h('button', { class: 'btn small ghost', onclick: async () => {
          if (!confirm(`להתעלם מכל ${d.nearMisses.length} ההצעות? הן לא יוצגו שוב.`)) return;
          await api('/api/recurring/dismiss', { method: 'POST', body: JSON.stringify({ keys: d.nearMisses.map((m) => m.key) }) }); await load(true);
        } }, 'התעלם מכל ההצעות')),
      h('ul', { class: 'small nearmiss' }, d.nearMisses.map((m) => h('li', {},
        h('span', {}, h('b', {}, m.name), ` · ${m.kind === 'income' ? 'הכנסה' : 'הוצאה'} · `, h('bdi', {}, `כ-${ils(m.amount)}`), ` · ${m.occurrences} הופעות ב-${m.months} חודשים`, h('div', { class: 'muted' }, m.reason)),
        h('span', { class: 'row-actions' },
          h('button', { class: 'btn small', onclick: () => openForm({ name: m.name.replace(/\s*\(כ-.*$/, ''), kind: m.kind, accountId: m.accountId, amount: m.amount, dayOfMonth: m.day, intervalMonths: 1, match: m.match, tolerancePct: 40, graceDays: 4, active: true, note: 'נוספה ידנית מרשימת ההצעות' }, m.key) }, 'הוסף כהוראה קבועה'),
          h('button', { class: 'btn small ghost', onclick: async () => { await api('/api/recurring/dismiss', { method: 'POST', body: JSON.stringify({ key: m.key }) }); await load(true); } }, 'התעלם')))))) : null);
}

function renderRecurring() {
  renderReviewBanner();
  renderDetectInfo();
  const t = $('recTable');
  const bankLabel = new Map(state.banks.map((b) => [b.id, b.label]));
  const today = state.today;
  const info = (it) => {
    const occ = state.analysis.occurrences.filter((o) => o.itemId === it.id).sort((a, b) => (a.date < b.date ? -1 : 1));
    const past = occ.filter((o) => o.date <= today).pop();
    const next = occ.find((o) => o.date > today && o.state !== 'matched') || occ.find((o) => o.date > today);
    return { past, next };
  };
  const stateTag = (o, kind) => {
    if (!o) return h('span', { class: 'muted' }, '—');
    const map = { matched: ['ok', kind === 'income' ? 'נכנס ✓' : 'ירד ✓'], due: ['warn', 'ממתין'], missing: ['bad', kind === 'income' ? 'לא נכנס!' : 'לא ירד!'], upcoming: ['neutral', 'צפוי'] };
    const [c, l] = map[o.state];
    return h('span', {}, h('span', { class: `tag ${c}` }, l), h('span', { class: 'muted small' }, ` ${dm(o.date)}`));
  };
  if (!state.recurring.length) return void t.replaceChildren(h('tbody', {}, h('tr', {}, h('td', { class: 'empty' }, 'עוד לא הוגדרו הוראות קבועות. לחץ "הוספה".'))));
  t.replaceChildren(
    h('thead', {}, h('tr', {}, ...['שם', 'סוג', 'חשבון', 'סכום', 'יום', 'מחזור אחרון', 'הבא'].map((x) => h('th', {}, x)))),
    h('tbody', {}, state.recurring.map((it) => {
      const { past, next } = info(it);
      return h('tr', { class: 'clickable' + (it.active ? '' : ' inactive'), onclick: () => openForm(it) },
        h('td', {}, it.name, (it.startDate && it.startDate === it.endDate) ? h('span', { class: 'tag neutral', style: 'margin-inline-start:6px' }, `חד-פעמי · ${dmy(it.startDate)}`) : it.intervalMonths > 1 ? h('span', { class: 'muted small' }, ` (כל ${it.intervalMonths} חו׳)`) : null,
          it.auto ? h('span', { class: 'tag ' + (it.reviewed ? 'neutral' : 'warn'), style: 'margin-inline-start:6px' }, it.reviewed ? 'אוטומטי' : 'חדש – נא לאשר') : null),
        h('td', {}, h('span', { class: 'tag ' + (it.kind === 'income' ? 'ok' : 'neutral') }, it.kind === 'income' ? 'הכנסה' : 'הוצאה')),
        h('td', {}, bankLabel.get(it.accountId) || it.accountId),
        h('td', { class: 'num ' + (it.kind === 'income' ? 'pos' : 'neg') }, ils(it.kind === 'income' ? it.amount : -it.amount)),
        h('td', {}, String(it.dayOfMonth)), h('td', {}, stateTag(past, it.kind)),
        h('td', {}, next ? dm(next.date) : '—'));
    })));
}

function renderSources() {
  const t = $('srcTable');
  t.replaceChildren(
    h('thead', {}, h('tr', {}, ...['מקור', 'ניסיון אחרון', 'הצלחה אחרונה', 'היסטוריה', 'מצב'].map((x) => h('th', {}, x)))),
    h('tbody', {}, state.sources.map((src) => {
      const failed = src.lastError && (!src.lastSuccessAt || src.lastAttemptAt > src.lastSuccessAt);
      return h('tr', {}, h('td', {}, h('span', { class: 'src-name' }, providerIcon(src.provider, src.label), src.label), h('span', { class: 'muted small' }, ` · ${src.provider}`)), h('td', {}, ago(src.lastAttemptAt)), h('td', {}, ago(src.lastSuccessAt)),
        h('td', {}, (src.attempts || []).length ? (src.attempts || []).map((a) => h('span', { class: 'dot ' + (a.ok ? 'ok' : 'bad'), title: `${ago(a.at)} · ${a.ok ? 'הצליח' : a.errorType}` })) : h('span', { class: 'muted small' }, '—')),
        h('td', {}, failed ? h('span', {}, h('span', { class: 'tag bad' }, 'נכשל'), h('div', { class: 'small muted', style: 'white-space:pre-wrap;max-width:520px' }, src.lastError))
          : src.lastSuccessAt ? h('span', { class: 'tag ok' }, 'תקין') : h('span', { class: 'tag neutral' }, 'טרם נאסף')));
    })));
}

// ----- טופס הוראה קבועה -----
const dlg = $('dlg'), form = $('form');
function syncOneTime() {
  const once = form.elements.oneTime.checked;
  $('oneTimeBox').hidden = !once; $('dayBox').hidden = once; $('freqBox').hidden = once;
  form.elements.dayOfMonth.required = !once; form.elements.oneTimeDate.required = once;
}
form.elements.oneTime.addEventListener('change', syncOneTime);
function openForm(it, dismissKey) {
  form.reset();
  form.dataset.dismissKey = dismissKey || '';
  $('formErr').hidden = true;
  const sel = form.elements.accountId;
  sel.replaceChildren(...state.banks.map((b) => h('option', { value: b.id }, b.label)));
  $('dlgTitle').textContent = it && !dismissKey ? 'עריכת הוראה קבועה' : 'הוראה קבועה חדשה';
  form.dataset.id = it && !dismissKey ? it.id : '';
  $('delBtn').hidden = !it || !!dismissKey;
  if (it) {
    for (const k of ['name', 'kind', 'accountId', 'amount', 'dayOfMonth', 'intervalMonths', 'match', 'tolerancePct', 'graceDays', 'note']) form.elements[k].value = it[k] ?? '';
    form.elements.active.checked = it.active;
    form.dataset.anchor = it.anchorMonth || '';
    const once = !!(it.startDate && it.endDate && it.startDate === it.endDate);
    form.elements.oneTime.checked = once;
    form.elements.oneTimeDate.value = once ? it.startDate : '';
  } else form.dataset.anchor = '';
  syncOneTime();
  dlg.showModal();
}
form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = form.elements;
  const body = {
    name: f.name.value, kind: f.kind.value, accountId: f.accountId.value, amount: Number(f.amount.value), dayOfMonth: Number(f.dayOfMonth.value),
    intervalMonths: Number(f.intervalMonths.value), anchorMonth: form.dataset.anchor || null, match: f.match.value.trim() || null,
    tolerancePct: Number(f.tolerancePct.value), graceDays: Number(f.graceDays.value), active: f.active.checked, startDate: null, endDate: null, note: f.note.value,
  };
  if (f.oneTime.checked) {
    // חד-פעמי = אירוע אחד בדיוק: תאריך התחלה = תאריך סיום = התאריך שנבחר
    const d = f.oneTimeDate.value;
    Object.assign(body, { startDate: d, endDate: d, dayOfMonth: Number(d.slice(8, 10)), intervalMonths: 1, anchorMonth: null });
  }
  try {
    const id = form.dataset.id;
    await api(id ? `/api/recurring/${id}` : '/api/recurring', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    if (form.dataset.dismissKey) await api('/api/recurring/dismiss', { method: 'POST', body: JSON.stringify({ key: form.dataset.dismissKey }) });
    dlg.close();
    await load();
  } catch (e) { $('formErr').textContent = e.message; $('formErr').hidden = false; }
});
$('cancelBtn').onclick = () => dlg.close();
$('addBtn').onclick = () => openForm(null);
$('delBtn').onclick = async () => {
  if (!confirm('למחוק את ההוראה הקבועה?')) return;
  await api(`/api/recurring/${form.dataset.id}`, { method: 'DELETE' });
  dlg.close(); await load();
};

$('runBtn').onclick = async () => {
  $('runBtn').disabled = true;
  try { await api('/api/run', { method: 'POST', body: '{}' }); } catch (e) { alert(e.message); }
  const poll = async () => { const st = await load(); if (st.running) setTimeout(poll, 3000); };
  setTimeout(poll, 1500);
};

let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => state && onDashboard() && renderAccounts(), 200); });

$('detectBtn').onclick = async () => {
  const b = $('detectBtn');
  b.disabled = true;
  try {
    if (state.detection?.needsHistory) {
      // אין מספיק היסטוריה: מושכים אותה מהבנקים (כמה דקות), ואז מזהים
      b.textContent = 'מושך היסטוריה…';
      const { jobId } = await api('/api/recurring/backfill', { method: 'POST', body: '{}' });
      for (;;) {
        const j = await api(`/api/jobs/${jobId}`);
        $('detectInfo').hidden = false;
        $('detectInfo').textContent = j.state === 'running' ? `מושך היסטוריה מהבנקים… ${j.message ?? ''} (יכול לקחת כמה דקות)` : '';
        if (j.state !== 'running') {
          if (j.state === 'error') throw new Error(j.error);
          b.textContent = j.result.added ? `נמצאו ${j.result.added} חדשות` : 'לא נמצאו חדשות';
          break;
        }
        await new Promise((r) => setTimeout(r, 2500));
      }
    } else {
      b.textContent = 'סורק…';
      const r = await api('/api/recurring/detect', { method: 'POST', body: '{}' });
      b.textContent = r.added ? `נמצאו ${r.added} חדשות` : 'לא נמצאו חדשות';
    }
    await load(true);
  } catch (e) { b.textContent = 'שגיאה'; alert(e.message); }
  setTimeout(() => { b.disabled = false; b.textContent = 'סרוק היסטוריה'; }, 3000);
};

$('bellBtn').onclick = openAlerts;
$('cancelBtn2').onclick = async () => { $('cancelBtn2').disabled = true; try { await api('/api/run/cancel', { method: 'POST', body: '{}' }); await load(); } catch (e) { alert(e.message); } $('cancelBtn2').disabled = false; };
$('statusPill').style.cursor = 'pointer';
$('statusPill').onclick = openAlerts;
$('alertsClose').onclick = () => $('alertsDlg').close();

function route() {
  const settings = location.hash === '#settings';
  $('dashView').hidden = settings;
  $('settingsView').hidden = !settings;
  $('navDash').classList.toggle('active', !settings);
  $('navSettings').classList.toggle('active', settings);
  $('pageTitle').textContent = settings ? 'הגדרות' : 'לוח בקרה';
  $('pageSub').textContent = settings ? 'בנקים, כרטיסי אשראי, התראות והעדפות' : '';
  $('runBtn').hidden = settings;
  $('runInfo').hidden = settings || !state?.running;
  document.body.classList.add('anim');
  setTimeout(() => document.body.classList.remove('anim'), 700);
  if (settings) renderSettings($('settingsView')).catch((e) => { $('settingsView').textContent = e.message; });
  load(true).catch((e) => { $('statusPill').textContent = 'שגיאה בטעינה'; console.error(e); });
}
addEventListener('hashchange', route);
route();
setInterval(() => { if (!dlg.open && !$('alertsDlg').open) load().catch(() => {}); }, 60000);
