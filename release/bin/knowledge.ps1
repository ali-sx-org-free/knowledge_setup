# knowledge_setup 啟動器（Windows）：knowledge start | stop | restart | status | logs | run | password | upgrade | version
#
# 目錄佈局（install.ps1 建立）：
#   <安裝目錄>\app\           程式（本腳本在 app\bin\ 下），升級時整體替換
#   <安裝目錄>\runtime\node   安裝腳本下載的獨立 Node.js（系統已有 Node.js 20+ 時沒有）
#   <安裝目錄>\runtime\git    沒有 git 時安裝腳本下載的 MinGit
#   <安裝目錄>\config.env     設定（PORT、ADMIN_PASSWORD、KNOWLEDGE_GIT_URL…），升級時保留
#   <安裝目錄>\data\          資料（本地設定、金鑰、知識倉庫工作副本），升級時保留
#   <安裝目錄>\logs\ run\     日誌與 PID
# 直接解壓發佈包、不經安裝腳本時，以解壓目錄本身為安裝目錄。
param(
  [Parameter(Position = 0)][string]$Command = 'help',
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Rest = @()
)

$ErrorActionPreference = 'Stop'

$App = Split-Path -Parent $PSScriptRoot
$Base = if ((Split-Path -Leaf $App) -eq 'app') { Split-Path -Parent $App } else { $App }
$Config = Join-Path $Base 'config.env'
$LogDir = Join-Path $Base 'logs'
$Log = Join-Path $LogDir 'knowledge.log'
$ErrLog = Join-Path $LogDir 'knowledge.err.log'
$PidFile = Join-Path $Base 'run\knowledge.pid'

foreach ($dir in @((Join-Path $Base 'runtime\git\cmd'), (Join-Path $Base 'runtime\node'))) {
  if ((Test-Path -LiteralPath $dir) -and (($env:Path -split ';') -notcontains $dir)) { $env:Path = "$dir;$env:Path" }
}

function Say([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Info([string]$m) { Write-Host "    $m" }
function Fail([string]$m) { Write-Host "錯誤：$m" -ForegroundColor Red; exit 1 }

# 讀取 config.env：一行一個 鍵=值，值原樣使用（可用引號包住），空值跳過；已在環境變數中設定的同名變數優先。
function Import-Config {
  if (Test-Path -LiteralPath $Config) {
    foreach ($line in [System.IO.File]::ReadAllLines($Config)) {
      $l = $line.Trim()
      if (-not $l -or $l.StartsWith('#') -or -not $l.Contains('=')) { continue }
      $i = $l.IndexOf('=')
      $k = $l.Substring(0, $i).Trim()
      $v = $l.Substring($i + 1).Trim()
      if ($k.StartsWith('export ')) { $k = $k.Substring(7).Trim() }
      if ($k -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { continue }
      if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) { $v = $v.Substring(1, $v.Length - 2) }
      if (-not $v) { continue }
      if (-not [Environment]::GetEnvironmentVariable($k)) { [Environment]::SetEnvironmentVariable($k, $v) }
    }
  }
  if (-not $env:DATA_DIR) { $env:DATA_DIR = Join-Path $Base 'data' }
  elseif (-not [System.IO.Path]::IsPathRooted($env:DATA_DIR)) { $env:DATA_DIR = [System.IO.Path]::GetFullPath((Join-Path $Base $env:DATA_DIR)) }
  if (-not $env:NODE_ENV) { $env:NODE_ENV = 'production' }
}

function Get-Port { if ($env:PORT) { $env:PORT } else { '8080' } }
function Get-CheckHost { if (-not $env:HOST -or @('0.0.0.0', '::', '[::]') -contains $env:HOST) { '127.0.0.1' } else { $env:HOST } }
function Get-Version {
  $f = Join-Path $App 'VERSION'
  if (Test-Path -LiteralPath $f) { return ([System.IO.File]::ReadAllText($f)).Trim() }
  return 'unknown'
}

function Get-ServicePid {
  if (-not (Test-Path -LiteralPath $PidFile)) { return 0 }
  $id = 0
  [void][int]::TryParse(([System.IO.File]::ReadAllText($PidFile)).Trim(), [ref]$id)
  return $id
}

function Test-Running {
  $id = Get-ServicePid
  if (-not $id) { return $false }
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  return [bool]($p -and $p.ProcessName -eq 'node')
}

# 不經系統代理直接訪問本機
function Test-Http([string]$url) {
  try {
    $req = [System.Net.HttpWebRequest]::Create($url)
    $req.Proxy = $null
    $req.Timeout = 2000
    $resp = $req.GetResponse()
    $code = [int]$resp.StatusCode
    $resp.Close()
    return $code -eq 200
  } catch { return $false }
}

function Get-NodeExe {
  $c = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $c) { Fail '找不到 Node.js 20+；重新執行安裝腳本會自動下載' }
  $v = "$(& $c.Source -v)".Trim()
  if ($v -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) { Fail "Node.js $v 太舊，需要 20+；重新執行安裝腳本會自動下載獨立的 Node.js" }
  if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { Fail '找不到 git；重新執行安裝腳本會自動下載 MinGit，或自行安裝 Git for Windows' }
  return $c.Source
}

function Show-Access {
  $port = Get-Port
  Info "管理後台：http://localhost:$port"
  Info "智能體教程：http://localhost:$port/api/v1/prompt"
  $pw = Join-Path $env:DATA_DIR 'initial-admin-password.txt'
  if ($env:ADMIN_PASSWORD) { Info '管理員密碼：config.env 中的 ADMIN_PASSWORD' }
  elseif (Test-Path -LiteralPath $pw) { Info "初始管理員密碼：$(([System.IO.File]::ReadAllText($pw)).Trim())（登入後可在「設定」修改，修改後以新密碼為準）" }
  Info "設定檔：$Config（修改後 knowledge restart）"
  Info "日誌：$Log"
}

function Start-Knowledge {
  Import-Config
  if (Test-Running) { Say "服務已在運行（PID $(Get-ServicePid)）"; Show-Access; return 0 }
  $node = Get-NodeExe
  New-Item -ItemType Directory -Force -Path $LogDir, (Split-Path $PidFile), $env:DATA_DIR | Out-Null
  if (Test-Path -LiteralPath $Log) { Move-Item -LiteralPath $Log -Destination (Join-Path $LogDir 'knowledge.prev.log') -Force }
  if (Test-Path -LiteralPath $ErrLog) { Move-Item -LiteralPath $ErrLog -Destination (Join-Path $LogDir 'knowledge.prev.err.log') -Force }
  $server = Join-Path $App 'src\server.js'
  $p = Start-Process -FilePath $node -ArgumentList "`"$server`"" -WorkingDirectory $Base -WindowStyle Hidden -RedirectStandardOutput $Log -RedirectStandardError $ErrLog -PassThru
  [System.IO.File]::WriteAllText($PidFile, "$($p.Id)")
  # 等待服務就緒（公開端點 /api/v1/prompt 返回 200），最多 60 秒；程序提前退出時顯示日誌。
  $url = "http://$(Get-CheckHost):$(Get-Port)/api/v1/prompt"
  $deadline = (Get-Date).AddSeconds(60)
  $ok = $false
  while ((Get-Date) -lt $deadline) {
    if ($p.HasExited) { break }
    if (Test-Http $url) { $ok = $true; break }
    Start-Sleep -Milliseconds 300
  }
  if (-not $ok) {
    Write-Host "錯誤：服務沒有正常啟動，日誌如下（$LogDir）：" -ForegroundColor Red
    foreach ($f in @($Log, $ErrLog)) { if (Test-Path -LiteralPath $f) { Get-Content -LiteralPath $f -Tail 30 -Encoding UTF8 | Write-Host } }
    if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    return 1
  }
  Say "knowledge_setup $(Get-Version) 已啟動（PID $($p.Id)）"
  Show-Access
  return 0
}

function Stop-Knowledge {
  if (-not (Test-Running)) {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    Say '服務未在運行'
    return 0
  }
  $id = Get-ServicePid
  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  Wait-Process -Id $id -Timeout 15 -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  Say '服務已停止'
  return 0
}

function Show-Status {
  Import-Config
  if (Test-Running) {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    $nodeInfo = if ($node) { "$(& $node.Source -v)（$($node.Source)）" } else { '?' }
    Say "運行中（PID $(Get-ServicePid)）· $(Get-Version) · Node.js $nodeInfo"
    Show-Access
    return 0
  }
  Say "未運行 · $(Get-Version)"
  return 3
}

function Invoke-Node([string]$script) {
  Import-Config
  $node = Get-NodeExe
  New-Item -ItemType Directory -Force -Path $env:DATA_DIR | Out-Null
  Push-Location $Base
  try { & $node (Join-Path $App $script) @Rest | Out-Host } finally { Pop-Location }
  return $LASTEXITCODE
}

function Show-Usage {
  @"
用法：knowledge <命令>

  start       在後台啟動服務
  stop        停止服務
  restart     重新啟動（修改 config.env 後執行）
  status      運行狀態、訪問地址與管理員密碼
  logs [-f]   查看日誌（-f 持續跟隨）
  run         在前台運行
  password    顯示初始管理員密碼
  seed        載入示例資料
  ssh-key     顯示 SSH 部署金鑰公鑰（沒有時產生；--rotate 重新產生）
  upgrade     升級到最新版本（參數同 install.ps1，例如 -Version v0.2.0）
  version     顯示版本

安裝目錄：$Base
"@ | Write-Host
}

$code = 0
switch ($Command) {
  'start' { $code = Start-Knowledge }
  'stop' { $code = Stop-Knowledge }
  'restart' { [void](Stop-Knowledge); $code = Start-Knowledge }
  'status' { $code = Show-Status }
  'logs' {
    if (-not (Test-Path -LiteralPath $Log)) { Fail "還沒有日誌：$Log" }
    if ($Rest -contains '-f') { Get-Content -LiteralPath $Log -Tail 100 -Wait -Encoding UTF8 }
    else {
      Get-Content -LiteralPath $Log -Tail 200 -Encoding UTF8 | Write-Host
      if ((Test-Path -LiteralPath $ErrLog) -and (Get-Item -LiteralPath $ErrLog).Length -gt 0) { Write-Host '--- stderr ---'; Get-Content -LiteralPath $ErrLog -Tail 50 -Encoding UTF8 | Write-Host }
    }
  }
  'run' { $code = Invoke-Node 'src\server.js' }
  'password' {
    Import-Config
    $pw = Join-Path $env:DATA_DIR 'initial-admin-password.txt'
    if ($env:ADMIN_PASSWORD) { Info '管理員密碼由 config.env 或環境變數 ADMIN_PASSWORD 提供' }
    elseif (Test-Path -LiteralPath $pw) { Write-Host ([System.IO.File]::ReadAllText($pw)).Trim() }
    else { Fail '沒有初始密碼檔（服務尚未啟動過，或已用 ADMIN_PASSWORD 設定）' }
  }
  'seed' {
    $code = Invoke-Node 'scripts\seed.js'
    if (Test-Running) { Info '服務正在運行：執行 knowledge restart 讓它載入示例資料（或在後台「設定 › 知識倉庫」點「載入示例資料」）' }
  }
  'ssh-key' { $code = Invoke-Node 'scripts\ssh-key.js' }
  'upgrade' {
    if ($Base -eq $App) { Fail '這是直接解壓的發佈包，請用安裝腳本安裝後再升級' }
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) "knowledge-upgrade-$PID.ps1"
    Copy-Item -LiteralPath (Join-Path $App 'install.ps1') -Destination $tmp -Force
    & powershell -NoProfile -ExecutionPolicy Bypass -File $tmp -Prefix $Base @Rest
    $code = $LASTEXITCODE
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
  { $_ -in @('version', '--version', '-v') } { Write-Host (Get-Version) }
  { $_ -in @('help', '--help', '-h') } { Show-Usage }
  default { Show-Usage; $code = 1 }
}
exit $code
