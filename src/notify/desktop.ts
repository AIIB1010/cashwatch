import { execFile } from 'node:child_process';
import path from 'node:path';

/**
 * התראה על המסך (ליד השעון). בלי שום הגדרה ובלי שירות חיצוני.
 * Windows: Toast דרך PowerShell. Mac: osascript. Linux: notify-send.
 */
/**
 * רושמים מזהה אפליקציה משלנו ("CashWatch") ב-HKCU – כך ההתראה מופיעה בשם CashWatch ובהגדרות ההתראות של Windows,
 * ולא תלויה בכך ש-"Windows PowerShell" מורשה להציג התראות. מדווחים גם את מצב ההרשאה (Setting) כדי שנדע למה לא הופיע כלום.
 */
const WIN_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$appId = 'CashWatch'
try {
  $k = 'HKCU:\\Software\\Classes\\AppUserModelId\\' + $appId
  if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }
  Set-ItemProperty -Path $k -Name DisplayName -Value 'CashWatch' -Type String
  Set-ItemProperty -Path $k -Name ShowInSettings -Value 1 -Type DWord
  if ($env:CW_ICON -and (Test-Path $env:CW_ICON)) { Set-ItemProperty -Path $k -Name IconUri -Value $env:CW_ICON -Type String }
} catch { }
$t = [System.Security.SecurityElement]::Escape($env:CW_TITLE)
$b = [System.Security.SecurityElement]::Escape($env:CW_BODY)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast duration='long'><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual></toast>")
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
$setting = [string]$notifier.Setting
if ($setting -ne 'Enabled') { [Console]::Out.Write('SETTING=' + $setting); exit 0 }
$notifier.Show($toast)
[Console]::Out.Write('SETTING=Enabled')
`;

function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: { ...process.env, ...env }, timeout: 20_000, windowsHide: true }, (err, out, stderr) => {
      if (err) reject(new Error(`${cmd}: ${String(stderr || err.message).trim().slice(0, 200)}`));
      else resolve(String(out ?? ''));
    });
  });
}

/** מתרגם את מצב ההרשאה של Windows להסבר בעברית; null = תקין */
export function explainToastSetting(out: string): string | null {
  const m = /SETTING=(\w+)/.exec(out);
  if (!m || m[1] === 'Enabled') return null;
  const why: Record<string, string> = {
    DisabledForUser: 'ההתראות כבויות עבור המשתמש. פתח הגדרות Windows ← מערכת ← התראות, והפעל את "קבל התראות מאפליקציות ושולחים אחרים"',
    DisabledForApplication: 'ההתראות של CashWatch כבויות. פתח הגדרות Windows ← מערכת ← התראות, מצא את CashWatch והפעל',
    DisabledByGroupPolicy: 'מדיניות הארגון/המחשב חוסמת התראות',
    DisabledByManifest: 'ההתראות חסומות עבור האפליקציה',
  };
  return `Windows חוסם את ההתראה (${m[1]}). ${why[m[1]!] ?? ''}`.trim();
}

export async function sendDesktopNotification(title: string, body: string): Promise<void> {
  const t = title.slice(0, 120);
  const b = body.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (process.platform === 'win32') {
    const encoded = Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64');
    const icon = path.resolve('windows', 'cashwatch.ico');
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { CW_TITLE: t, CW_BODY: b, CW_ICON: icon });
    const problem = explainToastSetting(out);
    if (problem) throw new Error(problem);
  } else if (process.platform === 'darwin') {
    const esc = (x: string) => x.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await run('osascript', ['-e', `display notification "${esc(b)}" with title "${esc(t)}"`]);
  } else {
    await run('notify-send', [t, b]);
  }
}
