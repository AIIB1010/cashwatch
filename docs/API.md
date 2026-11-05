# CashWatch API, Webhook ו-MCP

מי שלא צריך את הדשבורד יכול להשתמש ב-CashWatch **רק כמנוע שאוסף את הנתונים**: אחרי שהחשבונות הוגדרו, אפשר לשלוף תנועות, יתרות ותחזית דרך API מקומי (קריאה בלבד), לקבל Webhook על תנועות חדשות, או לתת לסוכן AI (דרך MCP) לשאול את הנתונים.

*English summary:* CashWatch can run as a local, read-only data gateway: a token-protected REST API (`/api/v1`), outbound webhooks for new transactions, and an MCP server so AI agents can query your data. Everything stays on your machine.

> ⚠️ **הנתונים כאן הם מידע פיננסי פרטי.** הטוקן נותן גישת קריאה מלאה לכל התנועות והיתרות. אל תשתף אותו, אל תעלה אותו לגיט, ואל תחשוף את השרת לאינטרנט.

---

## 1. הפעלה והרשאות

1. בדשבורד: **הגדרות ← API ואינטגרציות ← צור טוקן**.
2. הטוקן (מתחיל ב-`cw_`) מוצג **פעם אחת בלבד**. נשמר רק גיבוב SHA-256 שלו, ולכן אי אפשר להציג אותו שוב; אם אבד – צור חדש (הישן מתבטל).
3. בכל בקשה:
   ```
   Authorization: Bearer cw_xxxxxxxx
   ```
   (אפשר גם `X-API-Key: cw_xxxxxxxx`.)
4. **בלי טוקן מוגדר** ה-API כבוי (`403`). טוקן שגוי: `401`. מעל **120 בקשות בדקה**: `429`.
5. הכתובת: `http://127.0.0.1:8080/api/v1/...` (הפורט לפי ההגדרות). השרת מאזין **רק ל-127.0.0.1** כברירת מחדל. אל תשנה את `dashboard.host` לכתובת ציבורית ואל תפתח פורט ברשת/בנתב. אם צריך גישה ממחשב אחר – השתמש במנהרה מאובטחת (למשל SSH/VPN) ולא בחשיפה ישירה.

כל התשובות הן JSON (חוץ מ-CSV). סכום שלילי = יציאה. תאריכים בפורמט `YYYY-MM-DD`.

```bash
export CW=http://127.0.0.1:8080/api/v1
export TOKEN=cw_xxxxxxxx
curl -s -H "Authorization: Bearer $TOKEN" $CW/status
```

## 2. נקודות קצה (Endpoints)

### `GET /status`
מצב האיסוף: ריצה אחרונה ולכל מקור – ניסיון אחרון, הצלחה אחרונה ושגיאה אחרונה (שורה ראשונה בלבד).
```json
{
  "running": false,
  "progress": null,
  "lastRun": { "startedAt": "2026-11-05T06:12:01.000Z", "finishedAt": "2026-11-05T06:13:40.000Z", "ok": true, "trigger": "schedule" },
  "sources": [
    { "id": "hapoalim-1", "kind": "bank", "label": "הפועלים", "provider": "hapoalim",
      "lastAttemptAt": "2026-11-05T06:12:05.000Z", "lastSuccessAt": "2026-11-05T06:12:41.000Z", "lastError": null }
  ]
}
```
(השדה `version` מופיע רק כשהשרת הופעל דרך npm.)

### `GET /accounts`
חשבונות בנק (עם יתרה נוכחית) ומקורות אשראי (עם חשבון החיוב וסיומות הכרטיסים שזוהו).
```json
{
  "accounts": [
    { "id": "hapoalim-1", "kind": "bank", "provider": "hapoalim", "label": "הפועלים", "balance": 24310.55, "balanceAt": "2026-11-05T06:12:41Z", "alertBelow": 0 },
    { "id": "isracard-1", "kind": "card", "provider": "isracard", "label": "ישראכרט", "fundingAccount": "hapoalim-1", "cards": [ { "ref": "4580", "count": 112 } ] }
  ]
}
```

### `GET /transactions`
תנועות, מהחדשה לישנה.

| פרמטר | תיאור |
|---|---|
| `source` | מזהה מקור (`id` מ-`/accounts`) |
| `from`, `to` | טווח תאריכים כולל, `YYYY-MM-DD` |
| `status` | `completed` או `pending` |
| `limit` | ברירת מחדל 1000, מקסימום 10000 |
| `offset` | דילוג (לעימוד) |
| `format` | `json` (ברירת מחדל) או `csv` |

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$CW/transactions?source=isracard-1&from=2026-10-01&limit=2"
```
```json
{
  "count": 2,
  "transactions": [
    { "id": "…", "sourceId": "isracard-1", "accountRef": "4580", "date": "2026-11-03", "processedDate": "2026-12-02",
      "amount": -149.9, "description": "שופרסל דיל", "memo": "", "status": "completed", "source": "ישראכרט" }
  ]
}
```
בכרטיס אשראי `accountRef` הוא 4 הספרות האחרונות של הכרטיס; בבנק – מספר/מזהה החשבון. `processedDate` בכרטיס הוא מועד החיוב בבנק (בעסקה ממתינה זה הערכה).

**ייצוא CSV:** `?format=csv` מחזיר קובץ `cashwatch-transactions.csv` בקידוד UTF-8 **עם BOM** (נפתח נכון בעברית ב-Excel), עמודות: `id, source_id, source, account, date, processed_date, amount, description, memo, status`. תאים טקסטואליים שמתחילים ב-`=`, `+`, `-`, `@` מקבלים גרש בהתחלה כדי למנוע הרצת נוסחאות ב-Excel/Sheets ("CSV injection").
```bash
curl -s -H "Authorization: Bearer $TOKEN" -o tx.csv "$CW/transactions?format=csv&from=2026-01-01&limit=10000"
```

### `GET /forecast`
תחזית תזרים לכל חשבון בנק: ציר יומי, אירועים עתידיים (חיובי אשראי, הוראות קבועות), יתרה מינימלית ותאריך החריגה הראשון מהסף; בנוסף חיובי האשראי המחושבים.
```json
{
  "today": "2026-11-05",
  "horizonDays": 30,
  "accounts": [
    { "accountId": "hapoalim-1", "label": "הפועלים", "startBalance": 24310.55, "minBalance": 9120.0, "minDate": "2026-11-28",
      "firstBreachDate": null, "shortfall": 0, "alertBelow": 0, "overdraftLimit": 0,
      "timeline": [ { "date": "2026-11-06", "balance": 24310.55, "delta": 0 } ],
      "events": [ { "date": "2026-11-10", "accountId": "hapoalim-1", "type": "recurring-expense", "name": "ארנונה", "amount": -640, "certainty": "expected", "balanceAfter": 23670.55 } ] }
  ],
  "cardCharges": [ { "sourceId": "isracard-1", "date": "2026-11-10", "amount": -8200, "state": "upcoming", "estimated": false, "txnCount": 41 } ]
}
```

### `GET /recurring`
הוראות קבועות (הכנסות/הוצאות, כולל שזוהו אוטומטית): `{ "items": [ { "id", "name", "kind", "accountId", "amount", "dayOfMonth", "intervalMonths", "match", "tolerancePct", "graceDays", "active", "auto", "reviewed", … } ] }`.

### `GET /alerts`
ממצאים פתוחים כרגע: `{ "alerts": [ { "key", "kind", "severity", "title", "body", "fingerprint" } ] }`. סוגים: `low-balance`, `income-missing`, `expense-missing`, `card-not-charged`, `card-mismatch`, `scrape-failed`, `stale-data`, `no-balance`.

### `POST /refresh`
מפעיל איסוף "שקט" ברקע. תשובה: `202 {"started": true}`, או `409` אם ריצה כבר מתבצעת. בדוק את התוצאה ב-`/status`.

> ⚠️ **זו כניסה אמיתית לאתרי הבנקים.** האיסוף מכבד את הרווח המינימלי בין כניסות (20 דקות לכל מקור) ומדלג על מקור שנכשל בגלל סיסמה שגויה/חסימה, אבל **אל תקרא ל-`/refresh` בלולאה או בתדירות גבוהה** – כניסות חוזרות עלולות לגרום לנעילת חשבון בבנק. התוכנה כבר אוספת לבד פעם ביום; בדרך כלל אין צורך ב-`/refresh`.

## 3. מצב ללא דשבורד (Headless)

אם אתה רוצה רק את ה-API: הגדר `dashboard.headless: true` (בהגדרות, או ב-config). אז ממשק המשתמש לא מוגש ולא נפתח חלון; ה-API, האיסוף היומי, ההתראות והווב-הוק ממשיכים לעבוד כרגיל. נדרשת הפעלה מחדש של התוכנה אחרי השינוי.

## 4. Webhook (דחיפה החוצה)

אפשר להגדיר כתובת `http(s)` שתקבל הודעה אחרי כל איסוף (הגדרות ← API ואינטגרציות, או `integrations.webhookUrl`), ולהוסיף **סוד** לחתימה (נשמר מוצפן).

אירועים (כותרת `X-CashWatch-Event`):

| אירוע | מתי |
|---|---|
| `transactions.new` | אחרי איסוף: תנועות שלא נשלחו קודם. בהפעלה הראשונה מתועדות התנועות הקיימות **בלי** לשלוח אותן, כדי לא להציף. |
| `run.finished` | אחרי כל ריצה: סיכום לפי מקור. |
| `test` | בלחיצה על "שלח אירוע בדיקה". |

גוף הבקשה (`POST`, `application/json`):
```json
{ "event": "transactions.new", "sentAt": "2026-11-05T06:13:40.123Z", "version": "1.2.17",
  "data": { "count": 1, "transactions": [ { "id": "…", "sourceId": "isracard-1", "date": "2026-11-05", "amount": -49.9, "description": "…", "status": "pending", "source": "ישראכרט" } ] } }
```
```json
{ "event": "run.finished", "sentAt": "…", "version": "1.2.17",
  "data": { "ok": true, "findings": 0, "sources": [ { "id": "hapoalim-1", "ok": true, "skipped": false, "error": null } ] } }
```

**אימות חתימה.** כשמוגדר סוד, נשלחת הכותרת `X-CashWatch-Signature: sha256=<hex>` – HMAC-SHA256 של **גוף הבקשה הגולמי** (בייטים, לפני פענוח JSON) בסוד המשותף. חשב מחדש והשווה בהשוואה בזמן קבוע:

Node.js (Express, עם `express.raw`):
```js
import { createHmac, timingSafeEqual } from 'node:crypto';
app.post('/hook', express.raw({ type: 'application/json' }), (req, res) => {
  const want = 'sha256=' + createHmac('sha256', process.env.WEBHOOK_SECRET).update(req.body).digest('hex');
  const got = String(req.headers['x-cashwatch-signature'] ?? '');
  if (got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return res.sendStatus(401);
  const event = JSON.parse(req.body.toString('utf8'));
  // ... לטפל באירוע
  res.sendStatus(204);
});
```
Python (Flask):
```python
import hmac, hashlib, os
from flask import Flask, request, abort
app = Flask(__name__)

@app.post("/hook")
def hook():
    body = request.get_data()  # בייטים גולמיים
    want = "sha256=" + hmac.new(os.environ["WEBHOOK_SECRET"].encode(), body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(want, request.headers.get("X-CashWatch-Signature", "")):
        abort(401)
    event = request.get_json()
    return "", 204
```
הבקשה נשלחת עם timeout של 10 שניות; כשל ב-Webhook רק נרשם ביומן ולא משפיע על הריצה. הגנה נוספת: הגבל את הנמען ל-HTTPS ובדוק שהכתובת שלך אכן שלך – הנתונים הפיננסיים נשלחים אליה.

## 5. MCP (סוכני AI)

שרת MCP (stdio) מאפשר לסוכן AI כמו Claude Desktop לשאול את הנתונים שלך. הוא **לא ניגש למסד הנתונים**: הוא מדבר עם CashWatch שרץ, דרך ה-API שלמעלה, ולכן צריך שהתוכנה תרוץ ושיהיה טוקן.

משתני סביבה:
- `CASHWATCH_URL` – ברירת מחדל `http://127.0.0.1:8080`
- `CASHWATCH_TOKEN` – הטוקן מסעיף 1

**הפקודה** (מתיקיית הפרויקט):
```
node node_modules/tsx/dist/cli.mjs src/cli.ts mcp
```
בהתקנה מקובץ ההתקנה של Windows (Node מובנה):
```
runtime\node.exe node_modules\tsx\dist\cli.mjs src\cli.ts mcp
```

**דוגמה לתצורת Claude Desktop** (`claude_desktop_config.json`, הנתיבים לפי ההתקנה שלך):
```json
{
  "mcpServers": {
    "cashwatch": {
      "command": "C:\\Users\\<you>\\AppData\\Local\\CashWatch\\runtime\\node.exe",
      "args": ["node_modules\\tsx\\dist\\cli.mjs", "src\\cli.ts", "mcp"],
      "cwd": "C:\\Users\\<you>\\AppData\\Local\\CashWatch",
      "env": { "CASHWATCH_URL": "http://127.0.0.1:8080", "CASHWATCH_TOKEN": "cw_xxxxxxxx" }
    }
  }
}
```
(אם הלקוח שלך לא תומך ב-`cwd`, ספק נתיבים מלאים ב-`args`.)

**כלים:**

| כלי | מה הוא עושה |
|---|---|
| `get_status` | מצב האיסוף ולכל מקור: ניסיון/הצלחה/שגיאה אחרונים |
| `list_accounts` | חשבונות בנק (עם יתרה) ומקורות אשראי |
| `get_transactions` | תנועות לפי `source`, `from`, `to`, `status`, `limit` (עד 1000, ברירת מחדל 200) |
| `get_forecast` | תחזית תזרים לכל חשבון |
| `get_recurring` | הוראות קבועות |
| `get_alerts` | ממצאים פתוחים |
| `refresh_data` | **כניסה אמיתית לבנקים** – רק כשהמשתמש ביקש במפורש |

> ⚠️ **פרטיות:** כל מה שהכלים מחזירים (תנועות, שמות, יתרות) נשלח לסוכן ה-AI ולשירות שמפעיל אותו. חבר MCP רק לסוכן שאתה סומך עליו עם המידע הפיננסי שלך. תיאורי התנועות מגיעים מאתרי הבנקים ולכן הם *נתונים* בלבד – שרת ה-MCP מנחה את הסוכן שלא להתייחס אליהם כהוראות.

---

## English quick reference

- **Enable:** Settings → "API & integrations" → create token (shown once; only a SHA-256 hash is stored). Send `Authorization: Bearer cw_…`.
- **Endpoints (GET unless noted):** `/api/v1/status`, `/accounts`, `/transactions?source&from&to&status&limit&offset&format=json|csv`, `/forecast`, `/recurring`, `/alerts`, `POST /refresh` (real bank login — never loop it; accounts can get locked).
- **CSV:** UTF-8 with BOM, formula-injection guarded.
- **Limits:** 120 requests/min per process; server binds to `127.0.0.1` by default — do not expose it to the internet. The token grants full read access to your financial data.
- **Headless:** set `dashboard.headless: true`; restart required.
- **Webhook:** events `transactions.new`, `run.finished`, `test`; body `{event, sentAt, version, data}`; headers `X-CashWatch-Event`, `X-CashWatch-Signature: sha256=<hex HMAC-SHA256 of the raw body>`.
- **MCP:** stdio server (`… src/cli.ts mcp`), env `CASHWATCH_URL`, `CASHWATCH_TOKEN`; tools `get_status`, `list_accounts`, `get_transactions`, `get_forecast`, `get_recurring`, `get_alerts`, `refresh_data`. Returned data is private financial data and untrusted text.


## כמה נתונים אפשר לשלוף / How much data

- **כל התנועות שנאספו**, לכל כרטיס אשראי ולכל חשבון עו"ש: `date`, `processed_date` (מועד החיוב), `amount` (שלילי = יציאה), `description`, `memo`, `status` (`completed` / `pending`), `account` (חשבון, או 4 ספרות אחרונות של כרטיס), `source`.
- **שדות נוספים** כשהבנק/חברת האשראי מספקים: `originalAmount` + `originalCurrency` (למשל קנייה במט"ח), `installmentNo` / `installmentTotal` (תשלומים), `category`, `identifier` (מזהה העסקה), `txnType`. תנועות שנאספו לפני גרסה 1.4.1 יקבלו אותם באיסוף הבא.
- **עד כמה אחורה:** בכל איסוף נמשכים כ-75 ימים אחרונים, ובסריקה היסטורית (חד-פעמית לכל מקור, או בלחיצה על "סרוק היסטוריה") `historyDays` ימים (ברירת מחדל 210, עד 730; הבנקים מגבילים בדרך כלל ל-12–18 חודשים). שינוי: הגדרות ← כללי.
- **עימוד:** `limit` (עד 10,000) ו-`offset`; סינון לפי `source`, `from`, `to`, `status`; `format=csv` לייצוא.
- **לא נשמר:** יתרה אחרי כל שורה בעו"ש (הבנקים לא מחזירים אותה באופן אחיד).
