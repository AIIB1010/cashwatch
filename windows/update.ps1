# CashWatch – עדכון אוטומטי: עוצר את התוכנה, מריץ את המתקין בשקט (נתוני data לא נוגעים) ומפעיל מחדש.
# מופעל מתוך התוכנה (src/update.ts) ואינו מיועד להרצה ידנית.
param([Parameter(Mandatory = $true)][string]$Installer, [Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Continue'
$log = Join-Path $Root 'data\update.log'
function Log($m) { try { Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format 's'), $m) -Encoding UTF8 } catch { } }
Log "update start: $Installer"
try {
  Start-Sleep -Seconds 2
  # עוצרים רק תהליכים של ההתקנה הזו (node של התיקייה, המגש, ה-wscript) – לא את הסקריפט הנוכחי
  Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and $_.ProcessId -ne $PID -and (
      ($_.Name -eq 'node.exe' -and ($_.CommandLine -like "*$Root*" -or $_.ExecutablePath -like "$Root*")) -or
      ($_.Name -match 'powershell|wscript' -and ($_.CommandLine -like '*CashWatch-Tray.ps1*' -or $_.CommandLine -like '*CashWatch.vbs*'))
    )
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  $p = Start-Process -FilePath $Installer -ArgumentList '/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait -PassThru
  Log "installer exit code: $($p.ExitCode)"
} catch { Log "error: $($_.Exception.Message)" }
finally {
  try { Remove-Item -Path $Installer -Force -ErrorAction SilentlyContinue } catch { }
  Start-Process 'wscript.exe' -ArgumentList ('"' + (Join-Path $Root 'windows\CashWatch.vbs') + '"')
  Log 'relaunched'
}
