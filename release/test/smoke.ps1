# 一鍵安裝冒煙測試（Windows）：與 smoke.sh 相同的場景，驗證 install.ps1 與 knowledge.ps1。
#   bash release/build.sh   # 在 Linux / macOS / Git Bash 中打包
#   powershell -NoProfile -ExecutionPolicy Bypass -File release\test\smoke.ps1 -Dist dist
# SMOKE_REAL_NODE=1：強制從 nodejs.org 下載獨立的 Node.js；SMOKE_REAL_GIT=1：強制從 GitHub 下載 MinGit。
# 斷言只比對輸出中的 ASCII 部分（網址、雜湊、版本號），不受主控台編碼影響。
param([string]$Dist = 'dist')

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Dist = (Resolve-Path -LiteralPath $Dist).Path
$Work = Join-Path ([System.IO.Path]::GetTempPath()) ('knowledge-smoke-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$Prefix = Join-Path $Work 'home with space'
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$Mirrors = @()
$EnvKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$OrigUserPath = $EnvKey.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)

function Assert([bool]$cond, [string]$msg) { if (-not $cond) { throw "FAIL: $msg" } }

function Start-Mirror([string]$name, [string[]]$extra) {
  $portFile = Join-Path $Work "$name.port"
  $log = Join-Path $Work "$name.log"
  $argList = @("`"$Root\release\test\mirror-server.js`"", '--dir', "`"$Dist`"", '--port-file', "`"$portFile`"") + $extra
  $p = Start-Process -FilePath node -ArgumentList $argList -RedirectStandardOutput $log -RedirectStandardError "$log.err" -WindowStyle Hidden -PassThru
  $script:Mirrors += $p
  for ($i = 0; $i -lt 150; $i++) {
    if (Test-Path -LiteralPath $portFile) { return [int]([System.IO.File]::ReadAllText($portFile)).Trim() }
    if ($p.HasExited) { break }
    Start-Sleep -Milliseconds 100
  }
  $err = ''
  try { $err = Get-Content -LiteralPath "$log.err" -Raw -ErrorAction SilentlyContinue } catch {}
  throw "模擬來源 $name 沒有啟動（退出碼 $(if ($p.HasExited) { $p.ExitCode } else { '仍在運行' })）：$err"
}

function Get-FreePort {
  $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $l.Start(); $port = $l.LocalEndpoint.Port; $l.Stop()
  return $port
}

# 輸出寫入檔案（不經管道），並設超時：即使安裝腳本卡住，也能看到它已輸出的內容
function Invoke-Installer([string]$log, [string[]]$installerArgs) {
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $Dist 'install.ps1')`"") + @($installerArgs | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } })
  $p = Start-Process -FilePath powershell -ArgumentList $argList -RedirectStandardOutput $log -RedirectStandardError "$log.err" -NoNewWindow -PassThru
  $null = $p.Handle  # Windows PowerShell 5.1：先取控制代碼，結束後才讀得到 ExitCode
  $finished = $p.WaitForExit(600000)
  if (-not $finished) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  $text = [System.IO.File]::ReadAllText($log)
  $err = if (Test-Path -LiteralPath "$log.err") { [System.IO.File]::ReadAllText("$log.err") } else { '' }
  Write-Host $text
  if ($err.Trim()) { Write-Host "--- stderr ---`n$err" }
  if (-not $finished) { throw 'FAIL: install.ps1 超過 10 分鐘沒有結束' }
  if ($p.ExitCode -ne 0) { throw "FAIL: install.ps1 退出碼 $($p.ExitCode)" }
  return $text + "`n" + $err
}

function Test-Http([string]$url) {
  try { return (Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 5).StatusCode -eq 200 } catch { return $false }
}

function Test-Login([int]$port, [string]$password) {
  $body = @{ password = $password } | ConvertTo-Json
  try { return (Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$port/admin/api/login" -ContentType 'application/json' -Body $body -TimeoutSec 10).StatusCode -eq 200 } catch { return $false }
}

function Get-ServicePid { [int]([System.IO.File]::ReadAllText((Join-Path $Prefix 'run\knowledge.pid'))).Trim() }

try {
  $good = Start-Mirror 'good' @('--throttle', '4194304')
  $slow = Start-Mirror 'slow' @('--throttle', '65536')
  $corrupt = Start-Mirror 'corrupt' @('--corrupt')
  $appPort = Get-FreePort

  $env:KNOWLEDGE_GITHUB_MIRRORS = "http://127.0.0.1:$good http://127.0.0.1:1 http://127.0.0.1:$slow/https://github.com http://127.0.0.1:$corrupt"
  $env:KNOWLEDGE_PROBE_TIME = '3'
  $env:KNOWLEDGE_CONNECT_TIMEOUT = '2'
  $env:KNOWLEDGE_SUMS_TIME = '5'
  $extra = @()
  if ($env:SMOKE_REAL_NODE) { $env:KNOWLEDGE_NODE_MIRRORS = 'https://nodejs.org/dist http://127.0.0.1:1'; $extra += '-ForceNode' }
  if ($env:SMOKE_REAL_GIT) { $env:KNOWLEDGE_MINGIT_MIRRORS = 'https://github.com/git-for-windows/git/releases/download http://127.0.0.1:1'; $extra += '-ForceGit' }

  $sums = @{}
  foreach ($line in [System.IO.File]::ReadAllLines((Join-Path $Dist 'SHA256SUMS'))) { if ($line -match '^([0-9a-f]{64}) [ *](.+)$') { $sums[$Matches[2]] = $Matches[1] } }
  $zip = @($sums.Keys | Where-Object { $_ -match '^knowledge_setup-v.+\.zip$' })[0]
  $version = ($zip -replace '^knowledge_setup-', '') -replace '\.zip$', ''
  $v = [regex]::Escape($version)

  Write-Host '== 1. 首次安裝（期望：選中 corrupt → 校驗失敗 → 回退 good）'
  $t = Invoke-Installer (Join-Path $Work 'install.log') (@('-Prefix', $Prefix, '-Port', "$appPort") + $extra)
  Assert ($t -match "SHA-256.*127\.0\.0\.1:$corrupt\D.*$($sums[$zip])") '沒有拒絕被篡改的發佈包'
  $bad = [regex]::Match($t, "$v.*127\.0\.0\.1:$corrupt\D")
  $ok = [regex]::Match($t, "$v.*127\.0\.0\.1:$good\D")
  Assert ($bad.Success -and $ok.Success -and $ok.Index -gt $bad.Index) '沒有先試最快的來源、再回退到正常來源'
  Assert (Test-Http "http://127.0.0.1:$appPort/api/v1/prompt") '服務沒有啟動'
  if ($env:SMOKE_REAL_NODE) {
    Assert (Test-Path -LiteralPath (Join-Path $Prefix 'runtime\node\node.exe')) '沒有安裝獨立的 Node.js'
    $proc = Get-Process -Id (Get-ServicePid)
    Assert ($proc.Path -eq (Join-Path $Prefix 'runtime\node\node.exe')) "服務沒有使用獨立的 Node.js（$($proc.Path)）"
  }
  if ($env:SMOKE_REAL_GIT) { Assert (Test-Path -LiteralPath (Join-Path $Prefix 'runtime\git\cmd\git.exe')) '沒有安裝 MinGit' }
  Assert (([Environment]::GetEnvironmentVariable('Path', 'User') -split ';') -contains (Join-Path $Prefix 'bin')) '沒有把 bin 加入使用者 PATH'

  Write-Host '== 2. 服務可用、管理員可用初始密碼登入、status'
  $pw = ([System.IO.File]::ReadAllText((Join-Path $Prefix 'data\initial-admin-password.txt'))).Trim()
  Assert (Test-Login $appPort $pw) '初始密碼登入失敗'
  & (Join-Path $Prefix 'bin\knowledge.cmd') status
  Assert ($LASTEXITCODE -eq 0) 'status 不是運行中'
  $ver = "$(& (Join-Path $Prefix 'bin\knowledge.cmd') version)".Trim()
  Assert ($ver -eq $version) "版本不符：$ver"

  Write-Host '== 3. 再次執行：已是最新版本，服務保持運行'
  $pidBefore = Get-ServicePid
  $t = Invoke-Installer (Join-Path $Work 'install2.log') @('-Prefix', $Prefix)
  Assert (-not ($t -match "$v.*127\.0\.0\.1:\d+\D")) '已是最新版本時不應下載'
  Assert ((Get-ServicePid) -eq $pidBefore) '不應重啟服務'

  Write-Host '== 4. -Force 重裝：停止 → 替換程式 → 啟動，資料與設定保留'
  Add-Content -LiteralPath (Join-Path $Prefix 'config.env') -Value '# smoke-marker'
  $t = Invoke-Installer (Join-Path $Work 'install3.log') @('-Prefix', $Prefix, '-Force', '-Mirror', "http://127.0.0.1:$good")
  Assert ((Get-ServicePid) -ne $pidBefore) '重裝後沒有重啟服務'
  Assert ((Get-Content -LiteralPath (Join-Path $Prefix 'config.env') -Raw) -match 'smoke-marker') 'config.env 被覆蓋'
  Assert (Test-Login $appPort $pw) '重裝後原密碼登入失敗（資料沒有保留？）'

  Write-Host '== 5. 從本地發佈包安裝（離線）'
  & (Join-Path $Prefix 'bin\knowledge.cmd') stop
  $offline = Join-Path $Work 'offline'
  $t = Invoke-Installer (Join-Path $Work 'install4.log') @('-Prefix', $offline, '-Package', (Join-Path $Dist $zip), '-NoStart')
  Assert ($t -match 'SHA-256') '本地發佈包沒有校驗'
  Assert (Test-Path -LiteralPath (Join-Path $offline 'app\src\server.js')) '本地發佈包沒有安裝'

  Write-Host '== 6. 停止'
  & (Join-Path $Prefix 'bin\knowledge.cmd') status
  Assert ($LASTEXITCODE -eq 3) 'stop 後仍在運行'
  Assert (-not (Test-Http "http://127.0.0.1:$appPort/api/v1/prompt")) 'stop 後端口仍可訪問'
  Write-Host 'PASS'
} finally {
  if (Test-Path -LiteralPath (Join-Path $Prefix 'bin\knowledge.cmd')) { & (Join-Path $Prefix 'bin\knowledge.cmd') stop | Out-Null }
  foreach ($p in $Mirrors) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  if ($null -eq $OrigUserPath) { $EnvKey.DeleteValue('Path', $false) } else { $EnvKey.SetValue('Path', $OrigUserPath, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
  $EnvKey.Close()
  [Environment]::SetEnvironmentVariable('KNOWLEDGE_SETUP_HOME', $null, 'User')
  Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
}
