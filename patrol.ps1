param(
  [string]$Key = "m4",
  [switch]$DryRun
)
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$MAPS = @{
  "m1" = "晴空麦田"
  "m2" = "亚述丘陵"
  "m3" = "亚述草滩"
  "m4" = "莱兴港"
}
$Map = $MAPS[$Key]
if (-not $Map) { Write-Host "未知地图键: $Key"; exit 1 }

Set-Location "D:\workspace2\mrzh-tools"

$ADB = "D:\Program Files\Netease\MuMu\nx_main\adb.exe"
$DEV = "emulator-5554"
$PKGS = @("com.netease.mrzh","com.netease.mrzh.vivo","com.netease.mrzh.mi",
          "com.netease.mrzh.huawei","com.netease.mrzh.oppo","com.netease.mrzh.uc")

function Test-Dev {
  try {
    $o = & $ADB devices 2>$null
    return [bool]($o | Where-Object { $_ -match ("^" + [regex]::Escape($DEV) + "\s+device") })
  } catch { return $false }
}
function Get-GamePid {
  foreach ($p in $PKGS) {
    try {
      $o = (& $ADB -s $DEV shell "pidof $p" 2>$null | Out-String).Trim()
      $n = ($o -split "\s+")[0]
      if ($n -match "^\d+$" -and [int]$n -gt 0) { return @{ pkg = $p; pid = [int]$n } }
    } catch {}
  }
  return $null
}

Write-Host "=========================================="
Write-Host "   白名单巡回  -  $Map"
Write-Host "=========================================="
Write-Host ""

# ---------- 预检：等模拟器与游戏就绪（重启 MuMu 后 adb 需要时间重新登记设备）----------
Write-Host "[预检] 等待模拟器与游戏就绪（最多 90 秒）…"
$ready = $false
for ($i = 1; $i -le 18; $i++) {
  if (-not (Test-Dev)) {
    if ($i -eq 3 -or $i -eq 8) {
      Write-Host "  设备未登记，重启 adb server…"
      & $ADB kill-server 2>$null | Out-Null
      Start-Sleep -Seconds 2
      & $ADB start-server 2>$null | Out-Null
      Start-Sleep -Seconds 3
    } else {
      Write-Host ("  等待设备上线 {0}/18" -f $i)
    }
    Start-Sleep -Seconds 5
    continue
  }
  # 提权放在预检做：adb root 会让设备短暂掉线，不能留到 node 脚本里做
  $idOut = (& $ADB -s $DEV shell "id" 2>$null | Out-String)
  if ($idOut -notmatch "uid=0") {
    Write-Host "  设备已上线，提升 adb root（会短暂掉线，随后重新等设备）…"
    & $ADB -s $DEV root 2>$null | Out-Null
    Start-Sleep -Seconds 4
    continue
  }
  $g = Get-GamePid
  if (-not $g) {
    Write-Host ("  设备已就绪(root)，等游戏进程 {0}/18" -f $i)
    Start-Sleep -Seconds 5
    continue
  }
  Write-Host ("  就绪：{0}  pid {1}" -f $g.pkg, $g.pid)
  $gamePid = [int]$g.pid
  $ready = $true
  break
}
if (-not $ready) {
  Write-Host ""
  Write-Host "[中止] 90 秒内没等到「设备 + 游戏进程」。"
  Write-Host "       请确认：模拟器已启动、游戏已进入世界；然后重开本脚本。"
  Write-Host "       手动排查：& `"$ADB`" devices"
  if (-not $DryRun) { exit 1 }
}
Write-Host ""

$TYPE = "stone"; $ONLY = ""; $LP = ""; $LOC = "n"

# ---------- 检查 session 是否属于当前进程；对不上就强制定位 ----------
$sessPath = "D:\workspace2\mrzh-pkgs\session.json"
$forceLoc = $true
$oldPid = "(无)"
if (Test-Path $sessPath) {
  try {
    $sj = Get-Content $sessPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $oldPid = [string]$sj.pid
    if ($gamePid -and ([int]$sj.pid -eq [int]$gamePid)) { $forceLoc = $false }
  } catch { $forceLoc = $true }
}
if ($forceLoc) {
  Write-Host ("[注意] session.json 属于旧进程（pid {0}），当前是 {1} → 本次必须重新定位。" -f $oldPid, $gamePid)
  Write-Host ""
  $LOC = "y"
}

if ($DryRun) {
  Write-Host "(dry-run：不执行，只打印将要运行的命令)"
} else {
  if (-not $forceLoc) { $LOC = Read-Host "1) 先重新定位相机? (y/N)" }
  $t    = Read-Host "2) 资源类型 (回车=stone)"
  if ($t -ne "" -and $t -ne $null) { $TYPE = $t }
  $ONLY = Read-Host "3) 只跑第几个点 (回车=全部)"
  $LP   = Read-Host "4) 循环模式：1=只跑一轮  2=无限循环 (回车=1)"
  if ($LP -eq "2" -or $LP -eq "y" -or $LP -eq "Y") {
    $LP = "2"
    $GAP = Read-Host "   轮间隔分钟 (回车=3)"
    if ($GAP -eq "" -or $GAP -eq $null) { $GAP = "3" }
    if ($GAP -notmatch '^\d+(\.\d+)?$') { Write-Host "   间隔输入无效，用默认 3 分钟"; $GAP = "3" }
  } else {
    $LP = "1"
  }
}

if ($LOC -eq "y" -or $LOC -eq "Y") {
  Write-Host ""
  Write-Host "--- 定位中，约 15 秒，会让人物走一步 ---"
  if ($DryRun) {
    Write-Host "[dry-run] node camfind6.js"
  } else {
    & node camfind6.js
    if ($LASTEXITCODE -ne 0) {
      Write-Host ""
      Write-Host "[中止] 定位失败，未开始巡回。可单独跑 node camfind6.js 排查。"
      exit 1
    }
  }
  Write-Host ""
}

$argList = @("wlrun2.js", "--type", $TYPE, "--map", $Map)
if ($ONLY -ne "" -and $ONLY -ne $null) { $argList += @("--only", $ONLY) }
if ($LP -eq "2") { $argList += @("--loop", "--loop-gap", $GAP) }

Write-Host ""
Write-Host "------------------------------------------"
Write-Host ("执行: node " + ($argList -join " "))
Write-Host "------------------------------------------"
Write-Host ""

if ($DryRun) { exit 0 }

& node @argList

Write-Host ""
Write-Host "========== 结束 =========="
