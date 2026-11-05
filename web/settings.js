import { h, ils, ago, api, avatar, providerIcon } from './ui.js';

let S = null;
let root = null;
const jobView = new Map(); // sourceId -> () => Node

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = (cls, text) => h('span', { class: `tag ${cls}` }, text);
const field = (label, input, hint) => h('label', { class: 'fld' }, h('span', {}, label), input, hint ? h('small', { class: 'muted' }, hint) : null);
const inp = (attrs = {}) => h('input', { autocomplete: 'off', ...attrs });
function secretInput(placeholder) {
  const el = inp({ type: 'password', placeholder, autocomplete: 'new-password', readonly: true, onfocus: (e) => e.target.removeAttribute('readonly') });
  const btn = h('button', { type: 'button', tabindex: -1, onclick: () => { const show = el.type === 'password'; el.type = show ? 'text' : 'password'; btn.textContent = show ? 'הסתר' : 'הצג'; } }, 'הצג');
  const wrap = h('span', { class: 'pwd' }, el, btn);
  wrap.input = el;
  return wrap;
}
const plainInput = (attrs = {}) => inp({ readonly: true, onfocus: (e) => e.target.removeAttribute('readonly'), ...attrs });
const CALLMEBOT_URL = 'https://www.callmebot.com/blog/free-api-whatsapp-messages/';
const providerName = (id) => S.providers.find((p) => p.id === id)?.name ?? id;

export async function renderSettings(el) {
  root = el;
  await reload();
}

async function reload() {
  S = await api('/api/settings');
  draw();
}

function draw() {
  root.replaceChildren(...[
    !S.editable ? h('p', { class: 'muted' }, 'מצב הדגמה – ההגדרות לקריאה בלבד.') : null,
    S.legacySecretsFile ? h('div', { class: 'alert warn', style: 'flex-direction:column;align-items:flex-start' },
      h('b', {}, 'נמצא קובץ secrets.yaml עם סיסמאות בטקסט גלוי'),
      h('div', { class: 'small' }, 'הוא נשאר מהגרסאות הראשונות. הסיסמאות כבר שמורות מוצפנות במערכת, ולכן הקובץ מיותר ומסוכן: כל מי שמגיע אליו רואה את הסיסמאות. מומלץ למחוק אותו.'),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!confirm('למחוק לצמיתות את secrets.yaml? (הסיסמאות השמורות במערכת לא נפגעות)')) return;
        try { await api('/api/settings/legacy-secrets/delete', { method: 'POST', body: '{}' }); await reload(); } catch (e) { alert(e.message); }
      } }, 'מחק את הקובץ')) : null,
    sourcesSection('bank'),
    sourcesSection('card'),
    notificationsSection(),
    updatesSection(),
    securitySection(),
    apiSection(),
    generalSection(),
    h('p', { class: 'muted small' }, 'פרטי ההתחברות נשמרים מוצפנים במחשב שלך בלבד ואינם נשלחים לשום מקום חוץ מאתר הבנק/חברת האשראי עצמם.'),
  ].filter(Boolean));
}

// ---------------------------------------------------------------- מקורות
function sourcesSection(kind) {
  const list = S.sources.filter((s) => s.kind === kind);
  const title = kind === 'bank' ? 'חשבונות בנק' : 'כרטיסי אשראי';
  const bankLabel = new Map(S.sources.filter((s) => s.kind === 'bank').map((b) => [b.id, b.label]));
  return h('section', {},
    h('div', { class: 'row-between' }, h('h3', {}, title),
      h('button', { class: 'btn', disabled: !S.editable, onclick: () => openSourceDialog(kind, null) }, kind === 'bank' ? '+ הוספת בנק' : '+ הוספת כרטיס אשראי')),
    h('div', { class: 'card' }, list.length ? list.map((src) => sourceRow(src, bankLabel)) : h('div', { class: 'empty' }, kind === 'bank' ? 'עוד לא הוגדר חשבון בנק.' : 'עוד לא הוגדר כרטיס אשראי.')));
}

function sourceRow(src, bankLabel) {
  const st = src.status;
  const failed = st?.lastError && (!st.lastSuccessAt || st.lastAttemptAt > st.lastSuccessAt);
  const status = failed ? tag('bad', 'האיסוף האחרון נכשל') : st?.lastSuccessAt ? tag('ok', `נאסף ${ago(st.lastSuccessAt)}`) : tag('neutral', 'טרם נאסף');
  const jobBox = h('div', { class: 'job', 'data-job': src.id });
  const cur = jobView.get(src.id);
  if (cur) jobBox.replaceChildren(cur());
  return h('div', { class: 'src-row' },
    h('div', { class: 'src-head' }, providerIcon(src.provider, src.label),
      h('div', { class: 'src-main' },
        h('div', {}, h('b', {}, src.label), h('span', { class: 'muted small' }, ` · ${providerName(src.provider)}`),
          src.kind === 'card' ? h('span', { class: 'muted small' }, ` · יורד מ: ${bankLabel.get(src.fundingAccount) ?? '—'}`) : null),
        h('div', {}, status, ' ', src.hasProfile ? tag('neutral', 'מכשיר נשמר') : null,
          failed ? h('a', { class: 'small', style: 'margin-inline-start:8px', href: `/api/failures/${src.id}`, target: '_blank', rel: 'noopener' }, 'צילום מסך של הכישלון ↗') : null))),
    h('div', { class: 'src-actions' },
      h('button', { class: 'btn', onclick: () => startJob(src, 'test') }, 'בדוק חיבור'),
      h('button', { class: 'btn' + (src.hasProfile ? '' : ' primary'), title: 'פותח חלון דפדפן במחשב הזה כדי להתחבר פעם אחת (כולל קוד אימות), והבנק זוכר את המכשיר', onclick: () => startJob(src, 'browser-login') }, 'כניסה ראשונה'),
      h('button', { class: 'btn', onclick: () => openSourceDialog(src.kind, src) }, 'עריכה'),
      h('button', { class: 'btn danger', onclick: () => removeSource(src) }, 'מחיקה')),
    jobBox);
}

function setJob(id, fn) {
  jobView.set(id, fn);
  const box = document.querySelector(`[data-job="${id}"]`);
  if (box) box.replaceChildren(fn());
}

async function startJob(src, what) {
  try {
    setJob(src.id, () => h('div', { class: 'muted' }, 'מתחיל…'));
    const { jobId } = await api(`/api/settings/sources/${src.id}/${what}`, { method: 'POST', body: '{}' });
    for (;;) {
      const j = await api(`/api/jobs/${jobId}`);
      setJob(src.id, () => renderJob(j));
      if (j.state !== 'running') {
        // אחרי כניסה ראשונה מוצלחת – בודקים אוטומטית שההתחברות הרובוטית עובדת
        if (what === 'browser-login' && j.state === 'done') { await sleep(800); return startJob(src, 'test'); }
        if (what === 'test') await reload();
        break;
      }
      await sleep(2000);
    }
  } catch (e) {
    setJob(src.id, () => h('div', { class: 'err' }, e.message));
  }
}

function renderJob(j) {
  if (j.state === 'running') return h('div', { class: 'muted' }, j.kind === 'login' ? j.message || 'פותח חלון…' : 'בודק חיבור… (יכול לקחת עד כמה דקות)');
  if (j.state === 'error') return h('div', { class: 'err', style: 'white-space:pre-wrap' }, '❌ ', j.error);
  if (j.kind === 'login') return h('div', { class: 'ok' }, '✅ ', j.message);
  const accounts = j.result.accounts;
  return h('div', { class: 'ok' }, h('div', {}, `✅ הנתונים נאספו ונשמרו – ${accounts.length} ${accounts.length === 1 ? 'חשבון/כרטיס' : 'חשבונות/כרטיסים'}`),
    j.result.balanceMissing ? h('div', { class: 'small', style: 'color:var(--warn)' }, '⚠️ הבנק לא החזיר יתרה. עבור ללוח הבקרה, בכרטיס החשבון: שם תוכל לבחור את היתרה מתוך הערכים שהבנק החזיר, או להזין אותה ידנית (פעם אחת).', (j.result.balanceHints || []).length ? ` ערכים שהבנק החזיר: ${[...new Set(j.result.balanceHints.map((x) => ils(x.value)))].slice(0, 6).join(' · ')}` : '') : null,
    j.result.newPatterns ? h('div', { class: 'small' }, `🔎 זוהו ${j.result.newPatterns} הוראות קבועות חדשות מההיסטוריה (תוכל לאשר אותן בלוח הבקרה)`) : null,
    accounts.map((a) => h('div', { class: 'small' },
      `${a.account}${a.balance != null ? ` · יתרה ${ils(a.balance)}` : ''} · ${a.txnCount} תנועות${a.pending ? ` (${a.pending} ממתינות)` : ''}${a.from ? ` · מ-${a.from} עד ${a.to}` : ''}`,
      a.latest.map((t) => h('div', { class: 'muted small' }, `   ${t.date}  ${ils(t.amount)}  ${t.description}`)))));
}

async function removeSource(src) {
  if (!confirm(`למחוק את "${src.label}" ואת כל הנתונים שנאספו ממנו?`)) return;
  try { await api(`/api/settings/sources/${src.id}`, { method: 'DELETE' }); jobView.delete(src.id); await reload(); } catch (e) { alert(e.message); }
}

function openSourceDialog(kind, src) {
  const banks = S.sources.filter((s) => s.kind === 'bank');
  const providers = S.providers.filter((p) => p.kind === kind);
  const dlg = h('dialog', {});
  const err = h('p', { class: 'err', hidden: true });
  const provSel = h('select', { disabled: !!src }, providers.map((p) => h('option', { value: p.id, selected: src?.provider === p.id }, p.name)));
  const label = inp({ value: src?.label ?? '', maxlength: 60, placeholder: kind === 'bank' ? 'אופציונלי, למשל: הפועלים – משותף' : 'אופציונלי, למשל: ישראכרט שלי' });
  const credBox = h('div', { class: 'fields' });
  const note = h('p', { class: 'muted small' });
  const credInputs = {};

  const drawCreds = () => {
    const p = providers.find((x) => x.id === provSel.value);
    credBox.replaceChildren();
    for (const k of Object.keys(credInputs)) delete credInputs[k];
    for (const f of p.fields) {
      const have = src?.credentials?.present?.[f.key];
      const holder = f.secret ? secretInput(have ? '•••••• (השאר ריק כדי לא לשנות)' : '') : plainInput({ value: src?.credentials?.values?.[f.key] ?? '', name: `cw-${f.key}` });
      credInputs[f.key] = f.secret ? holder.input : holder;
      credBox.append(field(f.label + (f.optional ? ' (אופציונלי)' : ''), holder, f.hint));
    }
    note.textContent = p.note ?? '';
  };
  provSel.addEventListener('change', drawCreds);

  let extra;
  const alertBelow = inp({ type: 'number', value: src?.alertBelow ?? 0 });
  const overdraft = inp({ type: 'number', min: 0, value: src?.overdraftLimit ?? 0 });
  const funding = h('select', {}, banks.map((b) => h('option', { value: b.id, selected: src?.fundingAccount === b.id }, b.label)));
  const billingDay = inp({ type: 'number', min: 1, max: 31, value: src?.billingDay ?? '', placeholder: 'מזוהה אוטומטית' });
  const chargeMatch = inp({ value: src?.chargeMatch ?? '', placeholder: 'ברירת מחדל לפי החברה' });
  const detected = src?.detectedCards ?? [];
  const refs = [...new Set([...detected.map((d) => d.ref), ...Object.keys(src?.cardOverrides ?? {})])];
  const mapSelects = {};
  const cardMap = h('div', { class: 'card-map' });
  for (const ref of refs) {
    const count = detected.find((d) => d.ref === ref)?.count;
    const sel = h('select', {}, [h('option', { value: '' }, 'כמו ברירת המחדל (למעלה)'), ...banks.map((b) => h('option', { value: b.id, selected: src?.cardOverrides?.[ref] === b.id }, b.label))]);
    mapSelects[ref] = sel;
    cardMap.append(h('div', { class: 'row' }, h('b', {}, `••${ref}`), count != null ? h('span', { class: 'muted small' }, `${count} תנועות`) : null, sel));
  }
  if (!refs.length) cardMap.append(h('p', { class: 'muted small' }, 'אחרי האיסוף הראשון יופיעו כאן כל הכרטיסים שזוהו תחת הכניסה הזו, ותוכל להגדיר לכל כרטיס מאיזה בנק הוא יורד. מספיק להירשם פעם אחת לכל חברת אשראי.'));

  if (kind === 'bank') {
    extra = h('div', { class: 'fields' },
      field('התראה כשהיתרה הצפויה יורדת מתחת ל-₪', alertBelow, '0 = להתריע לפני כניסה למינוס'),
      field('מסגרת אוברדראפט (להצגה בלבד)', overdraft));
  } else {
    extra = h('div', {},
      banks.length ? null : h('p', { class: 'err' }, 'כדי להגדיר כרטיס צריך קודם להוסיף חשבון בנק, שממנו יורד החיוב.'),
      h('div', { class: 'fields' },
        field('החיוב יורד מחשבון', funding, 'כל הכרטיסים של החברה הזו ירדו מהחשבון הזה, אלא אם הגדרת חריג למטה'),
        field('יום חיוב בחודש (אופציונלי)', billingDay)),
      h('h4', {}, 'כרטיסים שזוהו'), cardMap,
      h('details', {}, h('summary', {}, 'הגדרות מתקדמות'),
        h('div', { class: 'fields' }, field('טקסט לזיהוי שורת החיוב בבנק', chargeMatch, 'למשל: ישראכרט. אפשר לכתוב כמה אפשרויות עם |'))));
  }

  const autoLogin = h('input', { type: 'checkbox', checked: true });
  const firstLogin = src ? null : h('label', { class: 'check first-login' }, autoLogin,
    h('span', {}, h('b', {}, 'פתח עכשיו חלון דפדפן להתחברות ראשונה (מומלץ)'), h('div', { class: 'muted small' }, 'תתחבר שם כרגיל, כולל קוד אימות אם הבנק מבקש (גם שיחה קולית). אחרי שנכנסת לחשבון, **לחץ "יציאה" באתר הבנק** (כדי לא להשאיר התחברות פתוחה) ואז סגור את החלון. המערכת תזכור את המכשיר ותתחבר לבד מעכשיו.')));
  // אייקון: אם האייקון שהורד מהאתר שגוי אפשר להחליף בתמונה משלך (או לאפס, והתוכנה תנסה להוריד שוב)
  const iconMsg = h('span', { class: 'small muted' });
  const iconFile = h('input', { type: 'file', accept: 'image/png,image/x-icon,image/jpeg,image/gif', hidden: true });
  iconFile.addEventListener('change', async () => {
    const f = iconFile.files?.[0];
    if (!f) return;
    try {
      const res = await fetch(`/api/logos/${encodeURIComponent(src.provider)}`, { method: 'PUT', headers: { 'X-Requested-With': 'cashwatch', 'Content-Type': 'application/octet-stream' }, body: await f.arrayBuffer() });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'שגיאה');
      iconMsg.className = 'small ok'; iconMsg.textContent = '✅ האייקון הוחלף. הוא יוצג אחרי רענון הדף';
    } catch (e) { iconMsg.className = 'small err'; iconMsg.textContent = `❌ ${e.message}`; }
  });
  const iconBox = src ? h('div', { class: 'row', style: 'gap:10px;align-items:center;flex-wrap:wrap' },
    h('span', {}, 'אייקון:'), providerIcon(src.provider, src.label),
    h('button', { class: 'btn small', type: 'button', onclick: () => iconFile.click() }, 'החלף אייקון…'),
    h('button', { class: 'btn small ghost', type: 'button', onclick: async () => {
      try { await api(`/api/logos/${encodeURIComponent(src.provider)}`, { method: 'DELETE' }); iconMsg.className = 'small ok'; iconMsg.textContent = '✅ אופס. התוכנה תנסה להוריד את האייקון מהאתר הרשמי'; } catch (e) { iconMsg.className = 'small err'; iconMsg.textContent = `❌ ${e.message}`; }
    } }, 'איפוס'), iconFile, iconMsg) : null;
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'שמירה');
  const form = h('form', { method: 'dialog' },
    h('h3', {}, src ? `עריכת ${src.label}` : kind === 'bank' ? 'הוספת חשבון בנק' : 'הוספת כרטיס אשראי'),
    h('div', { class: 'fields' }, field(kind === 'bank' ? 'בנק' : 'חברת אשראי', provSel), field('שם להצגה', label)),
    h('h4', {}, 'פרטי התחברות לאתר'), credBox, note, h('h4', {}, 'הגדרות'), extra, iconBox, firstLogin, err,
    h('div', { class: 'dlg-actions' }, h('span', { class: 'spacer' }), h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'ביטול'), save));
  dlg.append(form);
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  drawCreds();

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const credentials = {};
    for (const [k, el] of Object.entries(credInputs)) if (el.value.trim()) credentials[k] = el.value.trim();
    const body = { label: label.value, credentials };
    if (!src) { body.kind = kind; body.provider = provSel.value; }
    if (kind === 'bank') { body.alertBelow = Number(alertBelow.value || 0); body.overdraftLimit = Number(overdraft.value || 0); }
    else {
      body.fundingAccount = funding.value;
      body.billingDay = billingDay.value ? Number(billingDay.value) : null;
      body.chargeMatch = chargeMatch.value.trim() || null;
      body.cardOverrides = Object.fromEntries(Object.entries(mapSelects).filter(([, sel]) => sel.value).map(([k, sel]) => [k, sel.value]));
    }
    save.disabled = true;
    try {
      const saved = await api(src ? `/api/settings/sources/${src.id}` : '/api/settings/sources', { method: src ? 'PUT' : 'POST', body: JSON.stringify(body) });
      dlg.close();
      await reload();
      if (!src && autoLogin.checked) startJob({ id: saved.id }, 'browser-login');
    } catch (e) { err.textContent = e.message; err.hidden = false; save.disabled = false; }
  });
  dlg.showModal();
}

// ---------------------------------------------------------------- התראות
function notificationsSection() {
  const n = S.notifications;
  const channel = (title, subtitle, enabled, body, buildBody, type) => {
    const en = h('input', { type: 'checkbox', checked: enabled });
    const msg = h('span', { class: 'small' });
    const collect = () => ({ [type]: { enabled: en.checked, ...buildBody() } });
    const doSave = async () => { await api('/api/settings/notifications', { method: 'PUT', body: JSON.stringify(collect()) }); };
    return h('div', { class: 'card chan' },
      h('div', { class: 'row-between' }, h('div', { class: 'chan-title' }, avatar(title), h('div', {}, h('b', {}, title), h('div', { class: 'muted small' }, subtitle))), h('label', { class: 'switch' }, en, h('span', { class: 'slider' }), h('span', {}, 'פעיל'))),
      body,
      h('div', { class: 'dlg-actions' }, msg, h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: async () => {
          msg.className = 'small muted'; msg.textContent = 'שולח…';
          try { await doSave(); const r = await api('/api/settings/notifications/test', { method: 'POST', body: JSON.stringify({ channel: type }) });
            msg.className = r.ok ? 'small ok' : 'small err'; msg.textContent = r.ok ? '✅ נשלחה הודעת בדיקה. בדוק שהיא הגיעה' : `❌ ${r.error}`; } catch (e) { msg.className = 'small err'; msg.textContent = `❌ ${e.message}`; }
        } }, 'שמור ושלח הודעת בדיקה'),
        h('button', { class: 'btn', title: 'שולח התראה לדוגמה בנוסח של חריגה צפויה, בלי קשר למצב החשבון האמיתי', onclick: async () => {
          msg.className = 'small muted'; msg.textContent = 'שולח…';
          try { await doSave(); const r = await api('/api/settings/notifications/test', { method: 'POST', body: JSON.stringify({ channel: type, sample: 'overdraft' }) });
            msg.className = r.ok ? 'small ok' : 'small err'; msg.textContent = r.ok ? '✅ נשלחה התראת חריגה לדוגמה' : `❌ ${r.error}`; } catch (e) { msg.className = 'small err'; msg.textContent = `❌ ${e.message}`; }
        } }, 'שלח התראת חריגה לדוגמה'),
        h('button', { class: 'btn primary', onclick: async () => {
          try { await doSave(); msg.className = 'small ok'; msg.textContent = '✅ נשמר'; } catch (e) { msg.className = 'small err'; msg.textContent = `❌ ${e.message}`; }
        } }, 'שמירה')));
  };

  // ----- התראה על המסך: בלי שום הגדרה
  const desktop = channel('התראה על המסך', 'מומלץ · בלי שום הגדרה, חלון קטן ליד השעון', n.desktop.enabled,
    h('p', { class: 'muted small' }, 'כל התראה חשובה מופיעה על המסך של המחשב, גם בלי לפתוח את התוכנה. עובדת כשהמחשב דלוק (וזה גם התנאי לכך שהתוכנה בכלל רצה).'),
    () => ({}), 'desktop');

  // ----- מייל: כתובת + סיסמת אפליקציה בלבד; השאר מזוהה אוטומטית
  const adv = n.email.advanced;
  const eAddr = plainInput({ type: 'email', value: n.email.address, placeholder: 'you@gmail.com', name: 'cw-email' });
  const ePass = secretInput(n.email.hasPassword ? '•••••• (השאר ריק כדי לא לשנות)' : 'סיסמת אפליקציה (לא הסיסמה הרגילה)');
  const eHint = h('small', { class: 'muted' });
  const eHost = inp({ value: adv.host, placeholder: 'smtp.example.com' });
  const ePort = inp({ type: 'number', value: adv.port });
  const eSecure = h('input', { type: 'checkbox', checked: adv.secure });
  const eFrom = inp({ value: adv.from });
  const eTo = inp({ value: adv.to, placeholder: 'ברירת מחדל: אותה כתובת' });
  let advTouched = false;
  [eHost, ePort, eSecure, eFrom, eTo].forEach((x) => x.addEventListener('input', () => { advTouched = true; }));
  const PRESETS = { 'gmail.com': 'Gmail', 'googlemail.com': 'Gmail', 'yahoo.com': 'Yahoo', 'icloud.com': 'iCloud', 'me.com': 'iCloud' };
  const showPreset = () => {
    const dom = eAddr.value.split('@')[1]?.toLowerCase();
    eHint.textContent = !dom ? 'ההתראות יישלחו מהכתובת הזו אל עצמה.' : PRESETS[dom] ? `✓ זוהה ${PRESETS[dom]} – אין צורך בהגדרות נוספות.` : 'כתובת מסוג אחר: פתח "הגדרות מתקדמות" והכנס את שרת ה-SMTP של הספק שלך.';
  };
  eAddr.addEventListener('input', showPreset); showPreset();
  const email = channel('מייל', 'כתובת וסיסמת אפליקציה, והשאר אוטומטי', n.email.enabled,
    h('div', {},
      h('div', { class: 'fields' }, field('כתובת המייל שלך', eAddr, null), field('סיסמת אפליקציה', ePass)), eHint,
      h('details', {}, h('summary', {}, 'איך מקבלים סיסמת אפליקציה (ב-Gmail)?'),
        h('ol', { class: 'muted small' },
          h('li', {}, 'ודא שהאימות הדו-שלבי פעיל בחשבון Google שלך.'),
          h('li', {}, 'היכנס לדף "סיסמאות אפליקציה": ', h('a', { href: 'https://myaccount.google.com/apppasswords', target: '_blank', rel: 'noopener noreferrer' }, 'myaccount.google.com/apppasswords')),
          h('li', {}, 'תן שם (למשל CashWatch) ולחץ "יצירה". יוצג קוד בן 16 אותיות.'),
          h('li', {}, 'העתק אותו לשדה למעלה. זו לא הסיסמה הרגילה שלך, ואפשר לבטל אותה בכל רגע.'))),
      h('details', {}, h('summary', {}, 'הגדרות מתקדמות'),
        h('div', { class: 'fields' }, field('שרת SMTP', eHost), field('פורט', ePort), field('שולח', eFrom), field('נמענים (בפסיק)', eTo),
          h('label', { class: 'check' }, eSecure, ' חיבור מאובטח ישיר (SSL, פורט 465)')))),
    () => ({ address: eAddr.value.trim(), password: ePass.input.value || undefined, ...(advTouched ? { host: eHost.value.trim(), port: Number(ePort.value || 587), secure: eSecure.checked, from: eFrom.value.trim(), to: eTo.value.trim() } : {}) }), 'email');

  // ----- וואטסאפ
  const wTo = plainInput({ value: n.whatsapp.to, placeholder: '972501234567', name: 'cw-wa' });
  const wKey = secretInput(n.whatsapp.hasKey ? '•••••• (השאר ריק כדי לא לשנות)' : 'מפתח API');
  const whatsapp = channel('וואטסאפ (CallMeBot)', 'חינמי · שירות לא רשמי', n.whatsapp.enabled,
    h('div', {},
      h('div', { style: 'margin:12px 0 4px' }, h('a', { class: 'btn primary', href: CALLMEBOT_URL, target: '_blank', rel: 'noopener noreferrer' }, 'להרשמה ולקבלת מפתח באתר CallMeBot ↗'),
        h('span', { class: 'muted small', style: 'margin-inline-start:10px' }, 'נפתח בלשונית חדשה. אחרי שתקבל את המפתח, חזור והדבק אותו כאן.')),
      h('div', { class: 'fields' }, field('מספר הוואטסאפ שלך (בינלאומי, בלי +)', wTo), field('מפתח API', wKey)),
      h('details', {}, h('summary', {}, 'איך מקבלים מפתח, והאם זה בטוח לחשבון שלי?'),
        h('ol', { class: 'muted small' },
          h('li', {}, 'לחץ על הכפתור למעלה (או ', h('a', { href: CALLMEBOT_URL, target: '_blank', rel: 'noopener noreferrer' }, 'כאן'), ') ופתח את ההוראות ל-WhatsApp.'),
          h('li', {}, 'שולחים פעם אחת הודעת אישור למספר של השירות (לפי ההוראות באתר), ומקבלים בחזרה מפתח API.'),
          h('li', {}, 'מדביקים כאן את המפתח ואת המספר שלך.')),
        h('p', { class: 'muted small' }, 'חשוב: ההודעות נשלחות מהמספר של השירות אליך. אתה לא מחבר את חשבון הוואטסאפ שלך לשום בוט, ולכן אין סיכון שהחשבון שלך ייחסם. הסיכון היחיד הוא שהשירות עצמו (לא רשמי) ייפול או ייחסם, ולכן מומלץ להפעיל גם מייל.'))),
    () => ({ to: wTo.value.trim(), apiKey: wKey.input.value || undefined }), 'whatsapp');

  return h('section', {}, h('h3', {}, 'התראות'),
    h('p', { class: 'muted small' }, 'כל הערוצים חינמיים, ואפשר להפעיל כמה ביחד. ההתראה על המסך לא דורשת שום הגדרה. אם ערוץ אחד נכשל, ההתראה עדיין תישלח בשאר.'),
    h('div', { class: 'chan-list' }, desktop, email, whatsapp));
}

async function refreshState() { S = await api('/api/settings'); }

// ---------------------------------------------------------------- כללי
// ---------------------------------------------------------------- עדכונים
function updatesSection() {
  const box = h('section', { class: 'card' }, h('h3', {}, 'עדכונים'), h('p', { class: 'muted small' }, 'טוען…'));
  const render = (u) => {
    const info = u.info;
    const msg = h('span', { class: 'small' });
    const say = (ok, t) => { msg.className = ok ? 'small ok' : 'small err'; msg.textContent = t; };
    const check = h('button', { class: 'btn', onclick: async () => { say(true, 'בודק…'); try { render(await api('/api/update/check', { method: 'POST', body: '{}' })); } catch (e) { say(false, e.message); } } }, 'בדוק עכשיו');
    const auto = h('input', { type: 'checkbox', checked: u.autoCheck, onchange: async (e) => { try { await api('/api/update/settings', { method: 'PUT', body: JSON.stringify({ autoCheck: e.target.checked }) }); } catch (er) { say(false, er.message); } } });
    const poll = async () => {
      try {
        const v = await api('/api/update');
        if (v.apply.state === 'error') return say(false, v.apply.message || 'העדכון נכשל');
        say(true, v.apply.message || 'מתעדכן…');
        setTimeout(poll, 2500);
      } catch { say(true, 'התוכנה מתעדכנת ותיפתח מחדש בעוד רגע…'); setTimeout(() => location.reload(), 25000); }
    };
    const install = h('button', { class: 'btn primary', onclick: async () => {
      if (!confirm('לעדכן עכשיו? התוכנה תיסגר ותיפתח מחדש. ההגדרות, הנתונים והסיסמאות נשמרים.')) return;
      try { await api('/api/update/apply', { method: 'POST', body: '{}' }); poll(); } catch (e) { say(false, e.message); }
    } }, `עדכן ל-${info?.latest ?? ''}`);
    box.replaceChildren(h('h3', {}, 'עדכונים'),
      h('p', { class: 'small' }, `הגרסה שלך: ${u.current}`, info?.checkedAt ? h('span', { class: 'muted' }, ` · נבדק ${ago(info.checkedAt)}`) : null),
      info?.available
        ? h('div', { class: 'alert warn', style: 'flex-direction:column;align-items:flex-start' },
            h('b', {}, `גרסה ${info.latest} זמינה`),
            info.notes ? h('pre', { class: 'small', style: 'white-space:pre-wrap;max-height:160px;overflow:auto;margin:0' }, info.notes) : null,
            u.canAutoInstall ? install : h('a', { class: 'btn primary', href: info.releaseUrl, target: '_blank', rel: 'noopener' }, 'הורד מדף ה-Release'),
            u.canAutoInstall ? null : h('span', { class: 'small muted' }, 'עדכון אוטומטי זמין בהתקנה מקובץ ההתקנה של Windows. כאן – הורד והתקן ידנית (הנתונים נשמרים בתיקיית data).'))
        : info && !info.error ? h('p', { class: 'small ok' }, '✅ אתה על הגרסה העדכנית') : null,
      info?.error ? h('p', { class: 'small muted' }, `בדיקת העדכון לא הצליחה: ${info.error}`) : null,
      h('div', { class: 'row', style: 'gap:10px;align-items:center;flex-wrap:wrap' }, check,
        h('label', { class: 'check' }, auto, h('span', {}, 'בדוק גרסה חדשה אוטומטית פעם ביום (פנייה ל-GitHub בלבד, בלי שליחת נתונים אישיים)'))),
      msg);
  };
  api('/api/update').then(render).catch(() => {});
  return box;
}

// ---------------------------------------------------------------- אבטחה
function securitySection() {
  const sec = S.security;
  const msg = h('span', { class: 'small' });
  const say = (ok, t) => { msg.className = ok ? 'small ok' : 'small err'; msg.textContent = t; };
  const p1 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'סיסמת נעילה (לפחות 8 תווים)' });
  const p2 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'הקלד שוב' });
  const enable = h('button', { class: 'btn primary', onclick: async () => {
    if (p1.value !== p2.value) return say(false, 'הסיסמאות לא זהות');
    if (!confirm('לאחר ההפעלה, אחרי כל הפעלת מחשב תצטרך להזין את הסיסמה פעם אחת בדשבורד, ועד אז לא יתבצעו בדיקות. אם תשכח אותה – פרטי ההתחברות לא ישוחזרו ותצטרך להזין אותם מחדש. להפעיל?')) return;
    try { await api('/api/settings/security/passphrase', { method: 'POST', body: JSON.stringify({ passphrase: p1.value }) }); await reload(); } catch (e) { say(false, e.message); }
  } }, 'הפעל נעילה בסיסמה');
  const cur = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'הסיסמה הנוכחית' });
  const disable = h('button', { class: 'btn danger', onclick: async () => {
    try { await api('/api/settings/security/passphrase', { method: 'DELETE', body: JSON.stringify({ passphrase: cur.value }) }); await reload(); } catch (e) { say(false, e.message); }
  } }, 'בטל נעילה בסיסמה');
  return h('section', { class: 'card' },
    h('h3', {}, 'אבטחה: מה קורה אם המחשב אבד'),
    h('p', { class: 'muted small' }, sec.platform === 'win32'
      ? 'ברירת המחדל: פרטי ההתחברות מוצפנים והמפתח קשור למשתמש ה-Windows שלך (לא ניתן לפענוח במחשב אחר). מי שנכנס ל-Windows שלך יכול להפעיל את התוכנה. מומלץ גם סיסמת Windows חזקה והצפנת דיסק (BitLocker).'
      : 'פרטי ההתחברות מוצפנים והמפתח נשמר בקובץ מוגן בהרשאות במחשב. מומלץ להצפין את הדיסק.'),
    sec.passphrase
      ? h('div', {}, h('p', { class: 'small ok' }, '🔒 נעילה בסיסמה פעילה: המפתח לא נשמר במחשב בכלל. מי שמוצא את המחשב לא יכול לקרוא את פרטי ההתחברות.'),
          h('div', { class: 'row', style: 'gap:10px;flex-wrap:wrap' }, cur, disable))
      : h('div', {}, h('p', { class: 'small' }, 'נעילה בסיסמה (אופציונלי, אבטחה מקסימלית): המפתח עטוף בסיסמה ששמורה רק אצלך. אחרי כל הפעלת מחשב תזין אותה פעם אחת.'),
          h('div', { class: 'row', style: 'gap:10px;flex-wrap:wrap' }, p1, p2, enable)),
    msg);
}

// ---------------------------------------------------------------- API ואינטגרציות
function apiSection() {
  const a = S.api;
  const base = `http://127.0.0.1:${a.port}`;
  const tokenBox = h('div', { hidden: true, class: 'alert warn', style: 'flex-direction:column;align-items:flex-start;gap:6px' });
  const tokenState = h('span', { class: 'small muted' }, a.hasToken ? 'יש טוקן פעיל (הערך עצמו לא נשמר, רק גיבוב שלו).' : 'ה-API כבוי עד שתיצור טוקן.');
  const msg = h('span', { class: 'small' });
  const say = (ok, t) => { msg.className = ok ? 'small ok' : 'small err'; msg.textContent = t; };

  const create = h('button', { class: 'btn', onclick: async () => {
    if (a.hasToken && !confirm('יצירת טוקן חדש מבטלת את הקודם. להמשיך?')) return;
    try {
      const r = await api('/api/settings/api/token', { method: 'POST', body: '{}' });
      const box = h('input', { readonly: true, value: r.token, style: 'width:100%;direction:ltr', onfocus: (e) => e.target.select() });
      tokenBox.replaceChildren(h('b', {}, 'הטוקן שלך – מוצג פעם אחת בלבד. העתק ושמור אותו במקום בטוח:'), box,
        h('button', { class: 'btn small', onclick: async () => { try { await navigator.clipboard.writeText(r.token); say(true, '✅ הועתק'); } catch { box.select(); say(false, 'סמן והעתק ידנית (Ctrl+C)'); } } }, 'העתק'),
        h('small', {}, 'הטוקן נותן גישת קריאה לכל הנתונים הפיננסיים שלך. אל תשתף אותו.'));
      tokenBox.hidden = false; a.hasToken = true; tokenState.textContent = 'יש טוקן פעיל.';
    } catch (e) { say(false, e.message); }
  } }, a.hasToken ? 'צור טוקן חדש' : 'צור טוקן והפעל API');
  const revoke = h('button', { class: 'btn danger', onclick: async () => {
    if (!confirm('לבטל את הטוקן? כל מי שמשתמש בו יאבד גישה.')) return;
    try { await api('/api/settings/api/token', { method: 'DELETE' }); tokenBox.hidden = true; a.hasToken = false; tokenState.textContent = 'ה-API כבוי עד שתיצור טוקן.'; say(true, '✅ בוטל'); } catch (e) { say(false, e.message); }
  } }, 'בטל טוקן');

  const url = inp({ value: a.webhookUrl, placeholder: 'https://example.com/hooks/cashwatch', style: 'direction:ltr' });
  const secret = secretInput(a.hasWebhookSecret ? '•••••• (השאר ריק כדי לא לשנות)' : 'סוד לחתימה (אופציונלי)');
  const headless = h('input', { type: 'checkbox', checked: a.headless });
  const saveHook = async () => {
    const body = { webhookUrl: url.value.trim(), headless: headless.checked };
    if (secret.input.value) body.webhookSecret = secret.input.value;
    const r = await api('/api/settings/api', { method: 'PUT', body: JSON.stringify(body) });
    a.webhookUrl = body.webhookUrl;
    return r;
  };
  const mcpCfg = JSON.stringify({ mcpServers: { cashwatch: { command: 'node', args: ['node_modules/tsx/dist/cli.mjs', 'src/cli.ts', 'mcp'], cwd: '<תיקיית CashWatch>', env: { CASHWATCH_URL: base, CASHWATCH_TOKEN: '<הטוקן>' } } } }, null, 2);

  return h('section', { class: 'card' },
    h('h3', {}, 'API ואינטגרציות (למתקדמים)'),
    h('p', { class: 'muted small' }, 'אם אתה רוצה את הנתונים בכלי אחר (Excel, Home Assistant, סקריפט, סוכן AI) – בלי הדשבורד. הכול נשאר במחשב שלך ומוגן בטוקן.'),
    h('h4', {}, 'API לקריאה'),
    h('div', { class: 'small', style: 'direction:ltr;text-align:left' }, `${base}/api/v1/accounts · /transactions · /forecast · /recurring · /alerts · /status`),
    h('div', { class: 'row', style: 'gap:10px;align-items:center;flex-wrap:wrap;margin:8px 0' }, create, a.hasToken ? revoke : null, tokenState), tokenBox,
    h('h4', {}, 'Webhook (שליחת תנועות חדשות החוצה)'),
    h('div', { class: 'fields' }, field('כתובת ה-Webhook', url, 'נשלחת הודעה אחרי כל איסוף: תנועות חדשות וסיכום ריצה'), field('סוד חתימה', secret, 'החתימה בכותרת X-CashWatch-Signature (HMAC-SHA256)')),
    h('div', { class: 'row', style: 'gap:10px;margin:8px 0' },
      h('button', { class: 'btn', onclick: async () => { try { await saveHook(); say(true, '✅ נשמר'); } catch (e) { say(false, e.message); } } }, 'שמירה'),
      h('button', { class: 'btn', onclick: async () => { try { await saveHook(); const r = await api('/api/settings/api/webhook-test', { method: 'POST', body: '{}' }); say(r.ok, r.ok ? '✅ אירוע הבדיקה נשלח' : `❌ ${r.error}`); } catch (e) { say(false, e.message); } } }, 'שלח אירוע בדיקה')),
    h('label', { class: 'check' }, headless, h('span', {}, 'מצב בלי דשבורד (רק API). נכנס לתוקף אחרי הפעלה מחדש של התוכנה.')),
    h('details', {}, h('summary', {}, 'חיבור לסוכני AI (MCP)'),
      h('p', { class: 'small muted' }, 'הדבק בהגדרות של לקוח MCP (למשל Claude Desktop). דורש טוקן פעיל. המידע שחוזר הוא הנתונים הפיננסיים הפרטיים שלך.'),
      h('textarea', { readonly: true, rows: 12, style: 'width:100%;direction:ltr;font-family:monospace;font-size:12px' }, mcpCfg)),
    msg);
}

function generalSection() {
  const g = S.general;
  const times = inp({ value: g.schedule.times.join(', '), placeholder: '07:00, 19:00' });
  const mode = h('select', {}, [['auto', 'פעם ביום, ברגע שהמחשב דלוק (מומלץ)'], ['fixed', 'בשעות קבועות']].map(([v, t]) => h('option', { value: v, selected: g.schedule.mode === v }, t)));
  const timesField = field('שעות הבדיקה', times, 'HH:MM, מופרדות בפסיק. אם המחשב כבוי בשעה הזו – הבדיקה תרוץ ברגע שיידלק.');
  const syncMode = () => { timesField.hidden = mode.value !== 'fixed'; };
  mode.addEventListener('change', syncMode); syncMode();
  const horizon = inp({ type: 'number', min: 7, max: 120, value: g.horizonDays });
  const reminder = inp({ type: 'number', min: 1, max: 168, value: g.alerts.reminderHours });
  const digest = h('select', {}, [['daily', 'כל יום'], ['weekly', 'פעם בשבוע (ביום ראשון)'], ['never', 'רק כשיש התראה']].map(([v, t]) => h('option', { value: v, selected: g.alerts.okDigest === v }, t)));
  const url = inp({ value: g.publicUrl ?? '', placeholder: 'http://localhost:8080' });
  const autoDetect = h('input', { type: 'checkbox', checked: g.autoDetect });
  const hist = inp({ type: 'number', min: 60, max: 730, value: g.historyDays ?? 210 });
  const msg = h('span', { class: 'small' });
  return h('section', {}, h('h3', {}, 'כללי'),
    h('div', { class: 'card' },
      h('div', { class: 'fields' },
        field('מתי לבדוק', mode, 'אין צורך להדליק את המחשב בשעה מסוימת: המערכת תבדוק פעם ביום ברגע שהיא מזהה שהמחשב פעיל ומחובר לאינטרנט.'),
        timesField,
        field('כמה ימים קדימה לחשב', horizon),
        field('תזכורת חוזרת על התראה פתוחה (שעות)', reminder),
        field('עדכון קבוע גם כשהכול תקין', digest, 'סיכום יתרות והירידות הקרובות, כדי לדעת שהמערכת חיה'),
        field('כמה ימי היסטוריה למשוך בסריקה היסטורית', hist, 'חד-פעמי לכל מקור, וגם בלחיצה על "סרוק היסטוריה". בנקים מגבילים בדרך כלל ל-12–18 חודשים. ככל שיותר – האיסוף הראשון ארוך יותר'),
        field('כתובת הדשבורד בהודעות (אופציונלי)', url),
        h('label', { class: 'switch wide' }, autoDetect, h('span', { class: 'slider' }), h('span', {}, 'זיהוי אוטומטי של הוצאות והכנסות קבועות מההיסטוריה'))),
      h('div', { class: 'dlg-actions' }, msg, h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary', onclick: async () => {
          try {
            await api('/api/settings/general', { method: 'PUT', body: JSON.stringify({
              schedule: { mode: mode.value, ...(mode.value === 'fixed' ? { times: times.value.split(/[,\s]+/).filter(Boolean) } : {}) }, horizonDays: Number(horizon.value),
              alerts: { reminderHours: Number(reminder.value), okDigest: digest.value }, publicUrl: url.value.trim() || null, autoDetect: autoDetect.checked, historyDays: Number(hist.value || 210) }) });
            msg.className = 'small ok'; msg.textContent = '✅ נשמר';
          } catch (e) { msg.className = 'small err'; msg.textContent = `❌ ${e.message}`; }
        } }, 'שמירה'))));
}
