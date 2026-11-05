# CashWatch – התקנה והפעלה בלחיצה אחת. בטוח להריץ שוב ושוב (לא מתקין פעמיים).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$wdir = Join-Path $root 'windows'
# התקנה עם Node מובנה (מותקן מקובץ ההתקנה): משתמשים בו ולא תלויים ב-Node של המערכת
$rt = Join-Path $root 'runtime'
if (Test-Path (Join-Path $rt 'node.exe')) { $env:Path = "$rt;$env:Path" }

function Say($m) { Write-Host "[CashWatch] $m" }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function Fail($m) {
  [System.Windows.Forms.MessageBox]::Show($m, 'CashWatch') | Out-Null
  exit 1
}

# 1. Node.js (מתקין אוטומטית אם חסר)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Say 'Node.js is missing - installing it automatically...'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    Refresh-Path
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Start-Process 'https://nodejs.org'
    Fail "לא הצלחתי להתקין את Node.js אוטומטית.`nהתקן Node.js 22 LTS מהאתר שנפתח, ואז הפעל שוב את CashWatch.bat"
  }
}
$major = [int]((node -v).TrimStart('v').Split('.')[0])
if ($major -lt 22) { Start-Process 'https://nodejs.org'; Fail "גרסת Node.js שלך ישנה ($((node -v))). התקן את גרסה 22 LTS והפעל שוב." }

# 2. תלויות (רק בפעם הראשונה)
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Say 'First run: installing components (a few minutes, please wait)...'
  cmd /c "npm install"
  if ($LASTEXITCODE -ne 0) { Fail 'ההתקנה נכשלה. בדוק חיבור לאינטרנט ונסה שוב.' }
}

# 3. קיצורי דרך: שולחן עבודה + הפעלה אוטומטית עם הדלקת המחשב
$vbs = Join-Path $wdir 'CashWatch.vbs'
$ico = Join-Path $wdir 'cashwatch.ico'
$sh = New-Object -ComObject WScript.Shell
function New-Shortcut($path) {
  $s = $sh.CreateShortcut($path)
  $s.TargetPath = 'wscript.exe'
  $s.Arguments = '"' + $vbs + '"'
  $s.WorkingDirectory = $wdir
  $s.IconLocation = $ico
  $s.Description = 'CashWatch'
  $s.Save()
}
$desktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'CashWatch.lnk'
$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'CashWatch.lnk'
$firstTime = -not (Test-Path $startupLnk)
New-Shortcut $desktopLnk
New-Shortcut $startupLnk

# 3.5 עוצרים מופעים ישנים (אחרת הדשבורד עלול להמשיך לעבוד על גרסה ישנה שרצה ברקע)
try {
  # רק תהליכי node של התיקייה הזו ואייקון המגש. (לא נוגעים ב-cmd/powershell של הסקריפט הנוכחי)
  Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and $_.ProcessId -ne $PID -and (
      ($_.Name -eq 'node.exe' -and ($_.CommandLine -like "*$root*" -or $_.CommandLine -match 'cli\.(ts|js)\s+serve')) -or
      ($_.Name -match 'powershell|wscript' -and ($_.CommandLine -like '*CashWatch-Tray.ps1*' -or $_.CommandLine -like '*CashWatch.vbs*'))
    )
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
} catch { }

# 4. מפעילים ברקע (אייקון במגש המערכת; הוא גם פותח את חלון התוכנה)
Start-Process 'wscript.exe' -ArgumentList ('"' + $vbs + '"')
if ($firstTime) {
  [System.Windows.Forms.MessageBox]::Show("CashWatch מותקן ופועל ברקע.`n`n• החלון נפתח עכשיו (אם לא - לחץ על האייקון במגש המערכת, ליד השעון).`n• מעכשיו הוא יעלה לבד בכל הדלקת מחשב ויבדוק את החשבונות פעם ביום.`n• להגדרת בנקים והתראות: לשונית הגדרות.", 'CashWatch') | Out-Null
}
