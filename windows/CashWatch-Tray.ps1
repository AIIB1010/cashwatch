# CashWatch – אייקון במגש המערכת (פותחן לדשבורד)
# מפעיל את השרת ברקע, פותח את הדשבורד, ומאפשר לצאת. לא דורש התקנה נוספת.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$port = 8080
$url  = "http://localhost:$port"

# מופע יחיד: אם כבר רץ – רק פותחים את הדשבורד
$mutex = New-Object System.Threading.Mutex($false, 'Local\CashWatchTray')
if (-not $mutex.WaitOne(0, $false)) { Start-Process $url; exit }

function Test-Server {
  try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $port); $c.Close(); return $true } catch { return $false }
}
function Open-Dashboard {
  # חלון "אפליקציה" נקי (בלי לשוניות/כתובת) עם פרופיל נפרד; אם אין Edge/Chrome – דפדפן ברירת המחדל
  $appProfile = Join-Path $root 'data\app-window'
  $candidates = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
  )
  $b = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($b) { Start-Process $b -ArgumentList "--app=$url", "--user-data-dir=`"$appProfile`"", '--window-size=1320,900', '--no-first-run', '--no-default-browser-check' }
  else { Start-Process $url }
}

$rt = Join-Path $root 'runtime'
$bundled = Test-Path (Join-Path $rt 'node.exe')
if ($bundled) { $env:Path = "$rt;$env:Path" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  [System.Windows.Forms.MessageBox]::Show('Node.js לא מותקן. התקן Node.js 22 LTS מ-nodejs.org והפעל שוב.', 'CashWatch') | Out-Null
  exit 1
}

# הרצה ראשונה: התקנת תלויות (חלון גלוי, כמה דקות)
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm install' -WorkingDirectory $root -Wait -PassThru
  if ($p.ExitCode -ne 0) { [System.Windows.Forms.MessageBox]::Show('ההתקנה נכשלה.', 'CashWatch') | Out-Null; exit 1 }
}

 $script:server = $null
function Start-CashWatchServer {
  if (Test-Server) { return $true }
  # אם תהליך קודם עוד עולה, לא מפעילים מופע שני. אם הוא כבר מת – אפשר להתאושש.
  if ($script:server -and -not $script:server.HasExited) { return $false }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  # מפעילים את node.exe ישירות. עטיפת cmd.exe יכולה להיכשל או להישאר כתהליך ביניים
  # אחרי עדכון, בעוד שהפעלה ידנית של אותו node עובדת.
  if ($bundled) {
    $psi.FileName = Join-Path $rt 'node.exe'
    $psi.Arguments = 'node_modules\tsx\dist\cli.mjs src\cli.ts serve'
  } else {
    $psi.FileName = (Get-Command node -ErrorAction Stop).Source
    $psi.Arguments = 'node_modules\tsx\dist\cli.mjs src\cli.ts serve'
  }
  $psi.WorkingDirectory = $root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables['CASHWATCH_NO_OPEN'] = '1'
  try {
    $script:server = [System.Diagnostics.Process]::Start($psi)
    return $true
  } catch {
    return $false
  }
}
Start-CashWatchServer | Out-Null

# אייקון (נצייר אותו, כדי לא להיות תלויים בקובץ)
$bmp = New-Object System.Drawing.Bitmap 32, 32
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.Point 0, 0), (New-Object System.Drawing.Point 32, 32), [System.Drawing.Color]::FromArgb(79, 70, 229), [System.Drawing.Color]::FromArgb(124, 58, 237))
$g.FillEllipse($brush, 1, 1, 30, 30)
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 3)
$pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
$g.DrawLines($pen, [System.Drawing.Point[]]@((New-Object System.Drawing.Point 7, 21), (New-Object System.Drawing.Point 13, 14), (New-Object System.Drawing.Point 18, 18), (New-Object System.Drawing.Point 25, 9)))
$g.Dispose()
$icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icon
$tray.Text = 'CashWatch'
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('פתח את CashWatch')
$open.Font = New-Object System.Drawing.Font($open.Font, [System.Drawing.FontStyle]::Bold)
$open.add_Click({ Open-Dashboard })
$settings = $menu.Items.Add('הגדרות')
$settings.add_Click({ Start-Process "$url/#settings" })
$refresh = $menu.Items.Add('רענן נתונים עכשיו')
$refresh.add_Click({
  try {
    Invoke-RestMethod -Method Post -Uri "$url/api/run" -Headers @{ 'X-Requested-With' = 'cashwatch' } -ContentType 'application/json' -Body '{}' | Out-Null
    $tray.ShowBalloonTip(3000, 'CashWatch', 'מתחיל לרענן נתונים...', 'Info')
  } catch { $tray.ShowBalloonTip(3000, 'CashWatch', 'לא הצלחתי להתחיל רענון (ייתכן שרענון כבר רץ).', 'Warning') }
})
$menu.Items.Add('-') | Out-Null
$exit = $menu.Items.Add('יציאה (עוצר את CashWatch)')
$exit.add_Click({
  $tray.Visible = $false
  if ($server -and -not $server.HasExited) { & taskkill /PID $server.Id /T /F | Out-Null }
  [System.Windows.Forms.Application]::Exit()
})
$tray.ContextMenuStrip = $menu
$tray.add_DoubleClick({ Open-Dashboard })

# מחכים שהשרת יעלה ואז פותחים את הדשבורד
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$script:tries = 0
$timer.add_Tick({
  $script:tries++
  if (Test-Server) {
    $timer.Stop()
    $tray.ShowBalloonTip(4000, 'CashWatch פועל ברקע', 'לחץ על האייקון במגש כדי לפתוח את הדשבורד.', 'Info')
    Open-Dashboard
  } elseif ($script:tries -gt 120) {
    $timer.Stop()
    $tray.ShowBalloonTip(6000, 'CashWatch', 'השרת לא עלה. נסה להריץ start.bat כדי לראות את השגיאה.', 'Error')
  }
})
$timer.Start()

# עדכון/קריסה יכולים לסגור את השרת בלי לסגור את אייקון המגש. בעבר המגש נשאר
# עם mutex חי, ולחיצה נוספת פתחה localhost מת בלי להפעיל שרת. בודקים בעדינות
# כל 15 שניות ומפעילים מחדש רק אם תהליך השרת הקודם כבר הסתיים.
$health = New-Object System.Windows.Forms.Timer
$health.Interval = 15000
$health.add_Tick({
  if (-not (Test-Server) -and (-not $script:server -or $script:server.HasExited)) {
    Start-CashWatchServer | Out-Null
  }
})
$health.Start()

[System.Windows.Forms.Application]::Run((New-Object System.Windows.Forms.ApplicationContext))
$mutex.ReleaseMutex()
