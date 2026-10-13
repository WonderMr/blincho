Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'The SDK tray diagnostic requires Windows.' }
Write-Host "Apartment=$([Threading.Thread]::CurrentThread.GetApartmentState()) OS=$([Environment]::OSVersion)"
foreach ($scope in 'HKCU', 'HKLM') {
    $key = "${scope}:\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer"
    $value = Get-ItemPropertyValue $key -Name NoTrayItemsDisplay -ErrorAction SilentlyContinue
    Write-Host "${scope} NoTrayItemsDisplay=$(if ($null -eq $value) { 'absent' } else { $value })"
}
foreach ($name in 'EnableLUA', 'ConsentPromptBehaviorAdmin', 'FilterAdministratorToken') {
    $value = Get-ItemPropertyValue 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Policies\System' -Name $name -ErrorAction SilentlyContinue
    Write-Host "${name}=$(if ($null -eq $value) { 'absent' } else { $value })"
}
Get-Service -Name StateRepository, AppXSvc, WpnService, 'WpnUserService*' -ErrorAction SilentlyContinue | Select-Object Name, Status, StartType | Format-Table
$vs = & "${env:ProgramFiles(x86)}/Microsoft Visual Studio/Installer/vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.ARM64 -property installationPath
if (-not $vs) { throw 'Native ARM64 Visual Studio tools are required.' }
$environment = & cmd.exe /d /s /c "`"$vs\Common7\Tools\VsDevCmd.bat`" -arch=arm64 -host_arch=arm64 >nul && set"
if ($LASTEXITCODE -ne 0) { throw 'Native compiler environment failed.' }
foreach ($line in $environment) {
    if ($line -match '^(INCLUDE|LIB|PATH)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
}
$temporary = Join-Path $env:RUNNER_TEMP ('blincho-sdk-probe-' + [Guid]::NewGuid())
New-Item -ItemType Directory $temporary | Out-Null
try {
    $executable = Join-Path $temporary 'tray-probe.exe'
    Push-Location $temporary
    try {
        & cl.exe /nologo /W4 /EHsc /std:c++17 /DUNICODE /D_UNICODE (Join-Path $PSScriptRoot 'windows-tray-sdk-probe.cpp') "/Fe$executable" /link user32.lib shell32.lib ole32.lib
        if ($LASTEXITCODE -ne 0) { throw 'Native SDK probe compilation failed.' }
        & $executable
        if ($LASTEXITCODE -ne 0) { throw 'Native SDK diagnostic process failed.' }
    } finally { Pop-Location }
} finally { Remove-Item -Recurse -Force $temporary }
