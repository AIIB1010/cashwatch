; CashWatch – קובץ התקנה ל-Windows (Inno Setup 6). נבנה אוטומטית ב-GitHub Actions (.github/workflows/build-windows.yml).
; התקנה למשתמש הנוכחי בלבד (בלי הרשאות מנהל), כולל Node מובנה. נתוני המשתמש (תיקיית data) לא נמחקים בעדכון/הסרה.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6B7E0C52-5C1D-4C3B-9A3E-0CA51FA17C01}
AppName=CashWatch
AppVersion={#AppVersion}
AppPublisher=CashWatch
DefaultDirName={localappdata}\CashWatch
DefaultGroupName=CashWatch
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\build
OutputBaseFilename=CashWatch-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\windows\cashwatch.ico
UninstallDisplayIcon={app}\windows\cashwatch.ico
CloseApplications=no

[Files]
Source: "..\build\stage\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autodesktop}\CashWatch"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\windows\CashWatch.vbs"""; WorkingDir: "{app}\windows"; IconFilename: "{app}\windows\cashwatch.ico"
Name: "{userstartup}\CashWatch"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\windows\CashWatch.vbs"""; WorkingDir: "{app}\windows"; IconFilename: "{app}\windows\cashwatch.ico"
Name: "{group}\CashWatch"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\windows\CashWatch.vbs"""; WorkingDir: "{app}\windows"; IconFilename: "{app}\windows\cashwatch.ico"

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\windows\CashWatch.vbs"""; WorkingDir: "{app}\windows"; Description: "הפעל את CashWatch עכשיו"; Flags: postinstall nowait skipifsilent

; הערה: תיקיית data נוצרת בזמן ריצה ואינה חלק מ-[Files], ולכן אינה נמחקת בהסרה או בעדכון.
