param(
    [ValidateRange(1, 300)]
    [int]$TimeoutSeconds = 60,
    [switch]$RestartExplorerOnce
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows desktop preparation requires Windows.' }
if ($RestartExplorerOnce -and $env:GITHUB_ACTIONS -ne 'true') {
    throw 'Explorer restart is limited to the disposable GitHub Actions machine.'
}

# Explorer can exist before its notification area accepts icons. Probe the actual
# add/tooltip-update/delete operations used by tray-icon before running GUI tests.
# https://learn.microsoft.com/windows/win32/api/shellapi/nf-shellapi-shell_notifyiconw
if (-not ('Blincho.WindowsDesktopProbe' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace Blincho
{
    public static class WindowsDesktopProbe
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct NotifyIconData
        {
            public uint cbSize;
            public IntPtr hWnd;
            public uint uID, uFlags, uCallbackMessage;
            public IntPtr hIcon;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szTip;
            public uint dwState, dwStateMask;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szInfo;
            public uint uVersion;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string szInfoTitle;
            public uint dwInfoFlags;
            public Guid guidItem;
            public IntPtr hBalloonIcon;
        }

        [DllImport("user32.dll", ExactSpelling = true)]
        public static extern IntPtr GetShellWindow();
        [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        public static extern IntPtr FindWindowW(string className, string windowName);
        [DllImport("user32.dll", ExactSpelling = true)]
        public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern IntPtr CreateWindowExW(uint exStyle, string className,
            string title, uint style, int x, int y, int width, int height,
            IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
        [DllImport("user32.dll", ExactSpelling = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DestroyWindow(IntPtr window);
        [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)]
        private static extern IntPtr LoadIconW(IntPtr instance, IntPtr name);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool Shell_NotifyIconW(uint message, ref NotifyIconData data);

        public static string ProbeTray()
        {
            // STATIC is a predefined window class. WS_EX_TOOLWINDOW and the lack
            // of WS_VISIBLE keep the temporary owner window off the taskbar.
            IntPtr window = CreateWindowExW(0x80, "STATIC", "Blincho CI shell probe", 0,
                0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            if (window == IntPtr.Zero)
                return "CreateWindowExW failed: " + Marshal.GetLastWin32Error();
            try
            {
                // IDI_APPLICATION is a shared system icon, so do not destroy it.
                IntPtr icon = LoadIconW(IntPtr.Zero, new IntPtr(32512));
                if (icon == IntPtr.Zero)
                    return "LoadIconW failed: " + Marshal.GetLastWin32Error();
                var data = new NotifyIconData {
                    cbSize = (uint)Marshal.SizeOf(typeof(NotifyIconData)),
                    hWnd = window, uID = 1, uFlags = 0x2 | 0x4, hIcon = icon,
                    szTip = "Blincho CI shell probe", szInfo = "", szInfoTitle = ""
                };
                // Shell_NotifyIcon documents a BOOL result, not GetLastError.
                if (!Shell_NotifyIconW(0, ref data)) return "NIM_ADD returned false";
                string failure = null;
                try
                {
                    data.uFlags = 0x4; // NIF_TIP, matching tray-icon::set_tooltip
                    data.szTip = "Blincho CI shell probe updated";
                    if (!Shell_NotifyIconW(1, ref data)) failure = "NIM_MODIFY returned false";
                }
                finally
                {
                    if (!Shell_NotifyIconW(2, ref data))
                        failure = (failure == null ? "" : failure + "; ") + "NIM_DELETE returned false";
                }
                return failure;
            }
            finally { DestroyWindow(window); }
        }
    }
}
'@
}

$sessionId = (Get-Process -Id $PID).SessionId
Write-Host "Windows desktop: session=$sessionId name=$env:SESSIONNAME interactive=$([Environment]::UserInteractive) architecture=$([Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture)"
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$startedExplorer = $false
$restartedExplorer = $false
$startedAt = [DateTime]::UtcNow
$previousState = ''
do {
    $allExplorers = @(Get-Process -Name explorer -ErrorAction SilentlyContinue)
    $explorers = @($allExplorers | Where-Object { $_.SessionId -eq $sessionId })
    $shellWindow = [Blincho.WindowsDesktopProbe]::GetShellWindow()
    $taskbarWindow = [Blincho.WindowsDesktopProbe]::FindWindowW('Shell_TrayWnd', $null)
    $taskbarProcessId = [uint32]0
    [void][Blincho.WindowsDesktopProbe]::GetWindowThreadProcessId($taskbarWindow, [ref]$taskbarProcessId)
    $explorerDetails = ($allExplorers | ForEach-Object { "$($_.Id)@$($_.SessionId)" }) -join ','
    $failure = 'Waiting for Explorer and its taskbar in the runner session'
    if ($shellWindow -ne [IntPtr]::Zero -and $taskbarWindow -ne [IntPtr]::Zero -and
        @($explorers | ForEach-Object { $_.Id }) -contains $taskbarProcessId) {
        $failure = [Blincho.WindowsDesktopProbe]::ProbeTray()
        if ($null -eq $failure) {
            Write-Host "Windows desktop ready: session=$sessionId explorer=$taskbarProcessId; Shell_NotifyIcon NIM_ADD, NIM_MODIFY and NIM_DELETE succeeded."
            return
        }
    }
    $state = 'explorer={0} shell=0x{1:X} taskbar=0x{2:X} taskbarProcess={3}; {4}' -f
        $explorerDetails, $shellWindow.ToInt64(), $taskbarWindow.ToInt64(), $taskbarProcessId, $failure
    if ($state -ne $previousState) { Write-Host $state; $previousState = $state }
    if (-not $startedExplorer -and $explorers.Count -eq 0) {
        Write-Host "Starting Explorer in runner session $sessionId."
        Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe')
        $startedExplorer = $true
    }
    if ($RestartExplorerOnce -and -not $restartedExplorer -and
        $failure -eq 'NIM_ADD returned false' -and $taskbarProcessId -ne 0 -and
        ([DateTime]::UtcNow - $startedAt).TotalSeconds -ge 10) {
        Write-Host "Restarting Explorer $taskbarProcessId in disposable runner session $sessionId after notification-area rejection."
        Stop-Process -Id $taskbarProcessId -Force
        Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe')
        $restartedExplorer = $true
        $startedExplorer = $true
    }
    Start-Sleep -Seconds 2
} while ([DateTime]::UtcNow -lt $deadline)
throw "Windows desktop was not ready within $TimeoutSeconds seconds: $previousState"
