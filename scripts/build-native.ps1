$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskVersion = (Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json).version
Set-Content -LiteralPath (Join-Path $taskRoot 'native\windows\Version.h') -Value "#define AMG_VERSION L`"$taskVersion`"" -Encoding utf8
$taskCompiler = Get-ChildItem -Path 'C:\Program Files (x86)\Microsoft Visual Studio\2022\*\VC\Tools\MSVC\*\bin\Hostx64\x64\cl.exe' | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $taskCompiler) { throw 'Visual C++ Build Tools x64 are required.' }
$taskVcRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $taskCompiler.FullName)))
$taskSdkRoot = 'C:\Program Files (x86)\Windows Kits\10'
$taskSdkVersion = Get-ChildItem -LiteralPath (Join-Path $taskSdkRoot 'Include') -Directory | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty Name
$taskOutput = Join-Path $taskRoot 'native\bin'
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskIncludes = @((Join-Path $taskVcRoot 'include'))
foreach ($taskPart in @('um','shared','ucrt','cppwinrt')) { $taskIncludes += Join-Path $taskSdkRoot "Include\$taskSdkVersion\$taskPart" }
$taskArguments = @('/nologo','/utf-8','/std:c++20','/EHsc','/MT','/O2','/DUNICODE','/D_UNICODE','/DWIN32_LEAN_AND_MEAN','/DNOMINMAX','/D_WIN32_WINNT=0x0A00','/DNTDDI_VERSION=0x0A00000C')
foreach ($taskInclude in $taskIncludes) { $taskArguments += "/I$taskInclude" }
$taskCompileOptions = @($taskArguments)
$taskArguments += @((Join-Path $taskRoot 'native\windows\CloudHost.cpp'),"/Fe:$(Join-Path $taskOutput 'amg-cloud.exe')","/Fo:$(Join-Path $taskOutput 'CloudHost.obj')",'/link',"/LIBPATH:$(Join-Path $taskVcRoot 'lib\x64')","/LIBPATH:$(Join-Path $taskSdkRoot "Lib\$taskSdkVersion\um\x64")","/LIBPATH:$(Join-Path $taskSdkRoot "Lib\$taskSdkVersion\ucrt\x64")",'cldapi.lib','windowsapp.lib','advapi32.lib','user32.lib','ole32.lib','shell32.lib','propsys.lib')
$env:PATH = $taskCompiler.Directory.FullName + ';' + $env:PATH
& $taskCompiler.FullName @taskArguments
if ($LASTEXITCODE -ne 0) { throw "Native build failed: $LASTEXITCODE" }

$taskResourceCompiler = Join-Path $taskSdkRoot "bin\$taskSdkVersion\x64\rc.exe"
$taskIcon = (Join-Path $taskOutput 'app.ico').Replace('\','\\')
$taskVersionNumbers = ($taskVersion.Split('.') -join ',') + ',0'
$taskResourceSource = @"
1 ICON "$taskIcon"
1 VERSIONINFO
 FILEVERSION $taskVersionNumbers
 PRODUCTVERSION $taskVersionNumbers
 FILEFLAGSMASK 0x3fL
 FILEFLAGS 0
 FILEOS 0x40004L
 FILETYPE 0x1L
BEGIN
 BLOCK "StringFileInfo"
 BEGIN
  BLOCK "040904b0"
  BEGIN
   VALUE "FileDescription", "AMG rclone UI"
   VALUE "FileVersion", "$taskVersion"
   VALUE "ProductName", "AMG rclone UI"
   VALUE "ProductVersion", "$taskVersion"
   VALUE "OriginalFilename", "AMG rclone UI.exe"
  END
 END
 BLOCK "VarFileInfo"
 BEGIN
  VALUE "Translation", 0x409, 1200
 END
END
"@
$taskResourceFile = Join-Path $taskOutput 'Launcher.rc'
$taskResourceObject = Join-Path $taskOutput 'Launcher.res'
Set-Content -LiteralPath $taskResourceFile -Value $taskResourceSource -Encoding utf8
& $taskResourceCompiler /nologo "/fo$taskResourceObject" $taskResourceFile
if ($LASTEXITCODE -ne 0) { throw "Launcher resource build failed: $LASTEXITCODE" }
$taskLauncherArguments = $taskCompileOptions + @((Join-Path $taskRoot 'native\windows\Launcher.cpp'),$taskResourceObject,"/Fe:$(Join-Path $taskOutput 'amg-launcher.exe')","/Fo:$(Join-Path $taskOutput 'Launcher.obj')",'/link','/SUBSYSTEM:WINDOWS',"/LIBPATH:$(Join-Path $taskVcRoot 'lib\x64')","/LIBPATH:$(Join-Path $taskSdkRoot "Lib\$taskSdkVersion\um\x64")","/LIBPATH:$(Join-Path $taskSdkRoot "Lib\$taskSdkVersion\ucrt\x64")",'user32.lib')
& $taskCompiler.FullName @taskLauncherArguments
if ($LASTEXITCODE -ne 0) { throw "Launcher build failed: $LASTEXITCODE" }
