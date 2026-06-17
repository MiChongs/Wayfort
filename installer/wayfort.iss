; Wayfort 原生 Windows 安装包(Inno Setup 6)。
;
; 先用 scripts/wayfort-windows.ps1 build 组装出 dist\windows\(含全部二进制 + winsw.exe),
; 再编译本脚本生成 dist\WayfortSetup.exe:
;     iscc installer\wayfort.iss
;   或带版本号:
;     iscc /DMyAppVersion=1.0.0 installer\wayfort.iss
;   (scripts/wayfort-windows.ps1 installer 会自动调用 iscc。)
;
; 安装做什么:把 bundle(只读二进制)释放到 Program Files\Wayfort,调用 setup-windows-service.ps1
; -Install 完成 initdb / 生成密钥 / 注册并启动 5 个 Windows 服务(WinSW),建开始菜单/桌面快捷方式。
; 全部可变数据(数据库 / 密钥 / 会话 / 日志 / 生效配置)按 Windows 规范落在 C:\ProgramData\Wayfort。
; 卸载:停止并移除服务(C:\ProgramData\Wayfort 下的数据与 .env 保留,需手动清)。

#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif
#define MyAppName "Wayfort"
#define MyAppPublisher "Wayfort"
#define MyAppUrl "http://localhost:18080"
; 组装产物目录(相对本 .iss 所在的 installer\)。
#define SrcDir "..\dist\windows"

[Setup]
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\Wayfort
DefaultGroupName=Wayfort
DisableProgramGroupPage=yes
; 注册 Windows 服务需要管理员权限。
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=WayfortSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; 运行时数据在 C:\ProgramData\Wayfort(运行时生成,Inno 不跟踪),卸载默认保留;给出提示。
UninstallDisplayName={#MyAppName}

; 仅用随 Inno 6 一同安装的 Default.isl(英文向导)——ChineseSimplified.isl 不随官方版
; 分发,引用它会导致 iscc 编译失败。本脚本的 StatusMsg/快捷方式名等中文照常显示。
[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; Flags: unchecked

[Files]
; 组装好的整套 bundle(wayfort.exe / freerdp-worker.exe + dll / devolutions / web + node /
; caddy / pgsql / redis / winsw.exe / configs / Caddyfile ...)。
; 排除运行时数据/密钥:var\(数据库/会话/keystore/日志)、.env(密钥)、svc\(安装期生成)。
; 这些绝不能进安装包——既会泄露开发机的密钥与数据,运行中又会被占用导致 ISCC 编译失败;
; 目标机安装时由 setup-windows-service.ps1 重新 initdb + 生成密钥。
Source: "{#SrcDir}\*"; DestDir: "{app}"; Excludes: "var\*,.env,svc\*"; Flags: recursesubdirs createallsubdirs ignoreversion
; 服务安装/卸载脚本(单独放到 {app}\install)。
Source: "setup-windows-service.ps1"; DestDir: "{app}\install"; Flags: ignoreversion
; 互联网快捷方式目标(Inno 无法从裸 URL 直接建快捷方式,故随包一个 .url 文件,图标指向它)。
Source: "console.url"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Wayfort 控制台";  Filename: "{app}\console.url"
Name: "{group}\卸载 Wayfort";    Filename: "{uninstallexe}"
Name: "{autodesktop}\Wayfort 控制台"; Filename: "{app}\console.url"; Tasks: desktopicon

[Run]
; 安装后:初始化数据库 + 生成密钥 + 注册并启动服务(以管理员运行的 PS 5.1)。
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install\setup-windows-service.ps1"" -Install -InstallDir ""{app}"""; \
  StatusMsg: "正在初始化数据库并注册 Windows 服务(首次约需 1 分钟)..."; \
  Flags: waituntilterminated
; 安装完成后可选打开控制台。
Filename: "{#MyAppUrl}"; Description: "打开 Wayfort 控制台"; Flags: postinstall shellexec skipifsilent nowait

[UninstallRun]
; 卸载前:停止并移除服务。
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install\setup-windows-service.ps1"" -Uninstall -InstallDir ""{app}"""; \
  Flags: runhidden waituntilterminated; \
  RunOnceId: "RemoveWayfortServices"

[UninstallDelete]
; 运行时日志可清;数据(C:\ProgramData\Wayfort\var\pgdata 等)默认保留,
; 需要彻底清除请手动删除 C:\ProgramData\Wayfort。
Type: filesandordirs; Name: "{commonappdata}\Wayfort\var\logs"
