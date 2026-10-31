# input_helper.ps1 - 常驻输入助手（PowerShell 版，已验证 keybd_event 有效）
# 协议：stdin 一行一命令，stdout 一行一回应
#   HWND <hex>      设置窗口句柄
#   REFRESH         重新按进程名找句柄
#   FOCUS           抢前台并校验
#   KD <vkhex>      按下
#   KU <vkhex>      松开
#   TAP <vkhex>     按下+松开(45ms)
#   M <dx> <dy>     鼠标相对移动
#   CLICK           左键点击
#   SLEEP <ms>      等待
#   QUIT            退出
$ErrorActionPreference = 'Continue'
Add-Type -Namespace WIn -Name KB -MemberDefinition @'
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, System.UIntPtr e);
[DllImport("user32.dll")] public static extern uint MapVirtualKey(uint c, uint t);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, System.IntPtr p);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
[DllImport("user32.dll")] public static extern bool IsWindow(System.IntPtr h);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@

$script:hwnd = [IntPtr]::Zero

function Find-Hwnd {
    $p = Get-Process -Name MuMuNxDevice -ErrorAction SilentlyContinue |
         Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($p) { $script:hwnd = [IntPtr][int64]$p.MainWindowHandle; return $true }
    return $false
}

function Do-Focus {
    if ($script:hwnd -eq [IntPtr]::Zero -or -not [WIn.KB]::IsWindow($script:hwnd)) { [void](Find-Hwnd) }
    if ($script:hwnd -eq [IntPtr]::Zero) { return 'ERR no-hwnd' }
    if ([WIn.KB]::GetForegroundWindow() -eq $script:hwnd) { return 'OK focused' }
    $f = [WIn.KB]::GetForegroundWindow()
    $t1 = [WIn.KB]::GetWindowThreadProcessId($f, [IntPtr]::Zero)
    $t2 = [WIn.KB]::GetCurrentThreadId()
    [void][WIn.KB]::AttachThreadInput($t1, $t2, $true)
    [void][WIn.KB]::SetForegroundWindow($script:hwnd)
    [void][WIn.KB]::AttachThreadInput($t1, $t2, $false)
    Start-Sleep -Milliseconds 130
    if ([WIn.KB]::GetForegroundWindow() -eq $script:hwnd) { return 'OK focused' } else { return 'ERR focus-failed' }
}

Write-Output 'READY'
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line.Length -eq 0) { continue }
    $a = $line -split '\s+'
    $res = 'OK'
    try {
        switch ($a[0]) {
            'HWND' {
                $h = [Convert]::ToInt64($a[1].Replace('0x','').Replace('0X',''), 16)
                $script:hwnd = [IntPtr]$h
                if ([WIn.KB]::IsWindow($script:hwnd)) { $res = 'OK 0x' + $script:hwnd.ToString('X') } else { $res = 'ERR bad-hwnd' }
            }
            'REFRESH' {
                if (Find-Hwnd) { $res = 'OK 0x' + $script:hwnd.ToString('X') } else { $res = 'ERR no-hwnd' }
            }
            'FOCUS' { $res = Do-Focus }
            'KD' {
                $vk = [Convert]::ToByte($a[1], 16)
                $sc = [byte][WIn.KB]::MapVirtualKey($vk, 0)
                [WIn.KB]::keybd_event($vk, $sc, 0, [UIntPtr]::Zero)
            }
            'KU' {
                $vk = [Convert]::ToByte($a[1], 16)
                $sc = [byte][WIn.KB]::MapVirtualKey($vk, 0)
                [WIn.KB]::keybd_event($vk, $sc, 2, [UIntPtr]::Zero)
            }
            'TAP' {
                $vk = [Convert]::ToByte($a[1], 16)
                $sc = [byte][WIn.KB]::MapVirtualKey($vk, 0)
                [WIn.KB]::keybd_event($vk, $sc, 0, [UIntPtr]::Zero)
                Start-Sleep -Milliseconds 45
                [WIn.KB]::keybd_event($vk, $sc, 2, [UIntPtr]::Zero)
            }
            'M' { [WIn.KB]::mouse_event(0x0001, [int]$a[1], [int]$a[2], 0, [UIntPtr]::Zero) }
            'CLICK' {
                [WIn.KB]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
                Start-Sleep -Milliseconds 55
                [WIn.KB]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
            }
            'SLEEP' { Start-Sleep -Milliseconds ([int]$a[1]) }
            'QUIT' { Write-Output 'BYE'; [Console]::Out.Flush(); return }
            default { $res = 'ERR unknown' }
        }
    } catch { $res = 'ERR ' + $_.Exception.Message }
    Write-Output $res
    [Console]::Out.Flush()
}
