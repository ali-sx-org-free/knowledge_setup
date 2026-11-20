# knowledge_setup 一鍵安裝與啟動（Windows 10 / 11，Windows PowerShell 5.1 或 PowerShell 7）
#
#   在 PowerShell 中執行（GitHub 慢時把網址換成 https://ghfast.top/https://github.com/...）：
#   $f="$env:TEMP\knowledge-install.ps1"; curl.exe -fsSL -o $f https://github.com/ali-sx-org-free/knowledge_setup/releases/latest/download/install.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File $f
#
# 做的事：
#   1. 並行向 GitHub 與多個國內代理取得 SHA256SUMS，逐個測速，從最快的來源下載發佈包並校驗 SHA-256（校驗失敗自動換下一個）；
#   2. 沒有 Node.js 20+ 時，從 nodejs.org 與國內鏡像中測速選最快的下載；沒有 git 時下載 MinGit（固定版本並校驗 SHA-256）；
#   3. 安裝到 %LOCALAPPDATA%\knowledge_setup（資料、設定、日誌都在這裡，升級時保留），把 knowledge 命令加入使用者 PATH，並在後台啟動服務。
# 再次執行即升級；已是最新版本時只確保服務在運行。
param(
  [string]$Prefix = $(if ($env:KNOWLEDGE_HOME) { $env:KNOWLEDGE_HOME } else { Join-Path $env:LOCALAPPDATA 'knowledge_setup' }),
  [string]$Version = $(if ($env:KNOWLEDGE_VERSION) { $env:KNOWLEDGE_VERSION } else { 'latest' }),
  [string]$Ref = $env:KNOWLEDGE_REF,
  [string]$Package = '',
  [string]$Port = $env:KNOWLEDGE_PORT,
  [string]$Mirror = '',
  [string]$NodeMirror = '',
  [string]$Registry = '',
  [switch]$ForceNode,
  [switch]$ForceGit,
  [switch]$Force,
  [switch]$NoStart,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# 輸出被重定向（寫入日誌、被其他程式讀取）時改用 UTF-8，避免中文變成問號；結束時還原。互動主控台不受影響。
$OrigOutputEncoding = $null
try { if ([Console]::IsOutputRedirected) { $OrigOutputEncoding = [Console]::OutputEncoding; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } } catch {}

$Repo = if ($env:KNOWLEDGE_REPO) { $env:KNOWLEDGE_REPO } else { 'ali-sx-org-free/knowledge_setup' }
$NodeMajor = if ($env:KNOWLEDGE_NODE_MAJOR) { $env:KNOWLEDGE_NODE_MAJOR } else { '22' }
if ($env:KNOWLEDGE_FORCE_NODE) { $ForceNode = $true }
if ($env:KNOWLEDGE_FORCE_GIT) { $ForceGit = $true }

# 下載來源。第一個是官方來源：可達時以它的校驗清單為準。
function Split-List([string]$s) { @($s -split '[\s,]+' | Where-Object { $_ }) }
$GithubMirrors = Split-List $(if ($Mirror) { $Mirror } elseif ($env:KNOWLEDGE_GITHUB_MIRRORS) { $env:KNOWLEDGE_GITHUB_MIRRORS } else { 'https://github.com https://ghfast.top/https://github.com https://gh-proxy.com/https://github.com https://ghproxy.net/https://github.com https://gh.llkk.cc/https://github.com' })
$NodeMirrors = Split-List $(if ($NodeMirror) { $NodeMirror } elseif ($env:KNOWLEDGE_NODE_MIRRORS) { $env:KNOWLEDGE_NODE_MIRRORS } else { 'https://nodejs.org/dist https://registry.npmmirror.com/-/binary/node https://mirrors.tuna.tsinghua.edu.cn/nodejs-release https://mirrors.ustc.edu.cn/node https://repo.huaweicloud.com/nodejs https://mirrors.cloud.tencent.com/nodejs-release https://mirrors.aliyun.com/nodejs-release' })
$NpmRegistries = Split-List $(if ($Registry) { $Registry } elseif ($env:KNOWLEDGE_NPM_REGISTRIES) { $env:KNOWLEDGE_NPM_REGISTRIES } else { 'https://registry.npmjs.org https://registry.npmmirror.com https://mirrors.cloud.tencent.com/npm https://repo.huaweicloud.com/repository/npm' })

# MinGit（只在沒有 git 時下載）：固定版本與 SHA-256，任何鏡像下載的都能校驗。
$MinGitVersion = if ($env:KNOWLEDGE_MINGIT_VERSION) { $env:KNOWLEDGE_MINGIT_VERSION } else { '2.56.1' }
$MinGitSha256 = @{
  '64-bit' = '4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd'
  'arm64'  = '96571e442e90523a90e5fd8661b4c4e43bc192910f3c6db938816e6955b4cc8c'
}
$MinGitMirrors = if ($env:KNOWLEDGE_MINGIT_MIRRORS) { Split-List $env:KNOWLEDGE_MINGIT_MIRRORS } else { @('https://registry.npmmirror.com/-/binary/git-for-windows', 'https://repo.huaweicloud.com/git-for-windows') }

# 測速參數：每個來源下載前 ProbeBytes 字節，最多 ProbeTime 秒。
$ProbeBytes = if ($env:KNOWLEDGE_PROBE_BYTES) { [int]$env:KNOWLEDGE_PROBE_BYTES } else { 524288 }
$ProbeTime = if ($env:KNOWLEDGE_PROBE_TIME) { [int]$env:KNOWLEDGE_PROBE_TIME } else { 6 }
$ConnectTimeout = if ($env:KNOWLEDGE_CONNECT_TIMEOUT) { [int]$env:KNOWLEDGE_CONNECT_TIMEOUT } else { 5 }
$SumsTime = if ($env:KNOWLEDGE_SUMS_TIME) { [int]$env:KNOWLEDGE_SUMS_TIME } else { 10 }

function Say([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Info([string]$m) { Write-Host "    $m" }
function Warn([string]$m) { Write-Host "!!  $m" -ForegroundColor Yellow }
function Fail([string]$m) { throw [System.Exception]::new($m) }

if ($Help) {
  @'
knowledge_setup 一鍵安裝與啟動（Windows）

用法：powershell -ExecutionPolicy Bypass -File install.ps1 [選項]

  -Prefix DIR        安裝目錄（預設 %LOCALAPPDATA%\knowledge_setup）
  -Version vX.Y.Z    安裝指定版本（預設最新版本）
  -Ref BRANCH|TAG    從源碼安裝某個分支或標籤（依賴從最快的 npm 鏡像安裝）
  -Package FILE      從本地發佈包 .zip 安裝（離線；同目錄有 SHA256SUMS 時會校驗）
  -Port PORT         服務端口（寫入 config.env，預設 8080）
  -Mirror URL        只用這個 GitHub 來源，例如 https://ghfast.top/https://github.com
  -NodeMirror URL    只用這個 Node.js 鏡像
  -Registry URL      只用這個 npm 鏡像（僅 -Ref 時用到）
  -ForceNode         即使系統已有 Node.js 20+，也下載獨立的 Node.js 到安裝目錄
  -ForceGit          即使系統已有 git，也下載 MinGit 到安裝目錄
  -Force             版本相同也重新安裝
  -NoStart           只安裝，不啟動
'@ | Write-Host
  exit 0
}

if ($Version -ne 'latest' -and -not $Version.StartsWith('v')) { $Version = "v$Version" }
if ($Port -and $Port -notmatch '^\d+$') { Write-Host "錯誤：-Port 必須是數字：$Port" -ForegroundColor Red; exit 1 }
$Prefix = [System.IO.Path]::GetFullPath($Prefix).TrimEnd('\')

$Curl = (Get-Command curl.exe -ErrorAction SilentlyContinue)
if (-not $Curl) { Write-Host '錯誤：需要 curl.exe（Windows 10 1803 及以後自帶）' -ForegroundColor Red; exit 1 }
$Curl = $Curl.Source

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("knowledge-install-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem

# ---------- 工具函數 ----------

function Get-Label([string]$url) { ($url -replace '^[A-Za-z]+://', '') -replace '/.*$', '' }

function Format-Speed([double]$s) {
  if ($s -ge 1048576) { return ('{0:N1} MB/s' -f ($s / 1048576)) }
  if ($s -ge 1024) { return ('{0:N0} KB/s' -f ($s / 1024)) }
  return ('{0:N0} B/s' -f $s)
}

function Get-Sha256([string]$file) { (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() }

# 校驗清單：返回 @{ 檔名 = 雜湊 }
function Read-Sums([string]$file) {
  $map = @{}
  foreach ($line in [System.IO.File]::ReadAllLines($file)) {
    if ($line -match '^([0-9a-fA-F]{64}) [ *](.+?)\s*$') { $map[$Matches[2]] = $Matches[1].ToLowerInvariant() }
  }
  return $map
}

# 並行從每個來源取得校驗清單；返回 @{ Alive = 可達序號陣列; Ref = 第一個可達的序號; Sums = 其清單 }
function Get-SumsFromAll([string]$tag, [string[]]$urls, [string]$pattern) {
  $procs = @()
  for ($i = 0; $i -lt $urls.Count; $i++) {
    $dest = Join-Path $Tmp "$tag.sums.$i"
    $curlArgs = "-fsSL --connect-timeout $ConnectTimeout -m $SumsTime -o `"$dest`" `"$($urls[$i])`""
    $procs += Start-Process -FilePath $Curl -ArgumentList $curlArgs -NoNewWindow -PassThru
  }
  foreach ($p in $procs) { $p.WaitForExit() }
  $alive = @(); $ref = -1; $sums = $null
  for ($i = 0; $i -lt $urls.Count; $i++) {
    $dest = Join-Path $Tmp "$tag.sums.$i"
    if (-not (Test-Path -LiteralPath $dest)) { continue }
    $map = Read-Sums $dest
    if (@($map.Keys | Where-Object { $_ -match $pattern }).Count -eq 0) { continue }
    $alive += $i
    if ($ref -lt 0) { $ref = $i; $sums = $map }
  }
  return @{ Alive = $alive; Ref = $ref; Sums = $sums }
}

# 逐個測速（順序測，避免互相搶頻寬），返回按速度從快到慢排列的序號
function Get-RankedUrls([string]$what, [string[]]$urls) {
  if ($urls.Count -eq 1) { return @(0) }
  Say "測試下載速度：$what"
  $results = @()
  for ($i = 0; $i -lt $urls.Count; $i++) {
    $out = & $Curl -sL -o NUL -r "0-$($ProbeBytes - 1)" --connect-timeout $ConnectTimeout -m $ProbeTime -w '%{http_code} %{size_download} %{speed_download}' $urls[$i]
    $parts = "$out".Trim() -split '\s+'
    $code = if ($parts.Count -ge 1 -and $parts[0]) { $parts[0] } else { '000' }
    $size = 0.0; $speed = 0.0
    if ($parts.Count -ge 3) { [void][double]::TryParse($parts[1], [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$size); [void][double]::TryParse($parts[2], [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$speed) }
    $label = (Get-Label $urls[$i]).PadRight(28)
    if (($code -eq '200' -or $code -eq '206') -and $size -gt 0) {
      Info "$label $(Format-Speed $speed)"
      $results += [pscustomobject]@{ Index = $i; Speed = $speed }
    } elseif ($code -eq '000') {
      Info "$label 無法連接"
    } else {
      Info "$label 不可用（HTTP $code）"
    }
  }
  return @($results | Sort-Object -Property Speed -Descending | ForEach-Object { $_.Index })
}

function Test-Zip([string]$file) {
  try { $z = [System.IO.Compression.ZipFile]::OpenRead($file); $n = $z.Entries.Count; $z.Dispose(); return $n -gt 0 } catch { return $false }
}

# 測速後從最快的來源下載；給了 sha256 就校驗，失敗換下一個來源。返回成功的網址。
function Get-Fastest([string]$what, [string]$dest, [string]$sha, [string[]]$urls) {
  $ranked = @(Get-RankedUrls $what $urls)
  if ($ranked.Count -eq 0) { return $null }
  $progress = if ([Environment]::UserInteractive -and -not $env:CI) { '-#' } else { '-sS' }
  foreach ($i in $ranked) {
    $u = $urls[$i]
    Say "下載$what（來源 $(Get-Label $u)）"
    Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
    & $Curl -fL $progress --connect-timeout $ConnectTimeout --speed-limit 2048 --speed-time 30 --retry 2 -o $dest $u
    if ($LASTEXITCODE -ne 0) { Warn "從 $(Get-Label $u) 下載失敗，換下一個來源"; continue }
    if ($sha) {
      $got = Get-Sha256 $dest
      if ($got -ne $sha) { Warn "SHA-256 校驗失敗（來源 $(Get-Label $u)：期望 $sha，實際 $got），換下一個來源"; continue }
      Info 'SHA-256 校驗通過'
    } elseif (-not (Test-Zip $dest)) {
      Warn "從 $(Get-Label $u) 下載的壓縮包不完整，換下一個來源"; continue
    }
    return $u
  }
  return $null
}

function Expand-Zip([string]$zip, [string]$dest) {
  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $dest)
}

function Get-Arch {
  $a = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  switch ($a) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } 'x86' { 'x86' } default { Fail "不支持的 CPU 架構 $a" } }
}

# 不用 node -e/-p：Windows PowerShell 5.1 傳給原生程式的參數中的雙引號會被吃掉
function Test-NodeOk([string]$node) {
  try {
    $v = "$(& $node -v)".Trim()
    return ($LASTEXITCODE -eq 0 -and $v -match '^v(\d+)\.' -and [int]$Matches[1] -ge 20)
  } catch { return $false }
}

# ---------- Node.js 與 git ----------

$script:NodeExe = $null
function Initialize-Node {
  $rt = Join-Path $Prefix 'runtime\node\node.exe'
  if ((Test-Path -LiteralPath $rt) -and (Test-NodeOk $rt)) {
    $script:NodeExe = $rt; Info "Node.js $(& $rt -v)（安裝目錄內的獨立版本）"; return
  }
  $sys = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $ForceNode -and $sys -and (Test-NodeOk $sys.Source)) {
    $script:NodeExe = $sys.Source; Info "Node.js $(& $sys.Source -v)（系統已安裝：$($sys.Source)）"; return
  }
  Info "下載獨立的 Node.js $NodeMajor 到安裝目錄（不影響系統）"
  $arch = Get-Arch
  $pattern = "^node-v[0-9.]+-win-$arch\.zip$"
  Say "取得 Node.js $NodeMajor 版本資訊"
  $r = Get-SumsFromAll 'node' @($NodeMirrors | ForEach-Object { "$($_.TrimEnd('/'))/latest-v$NodeMajor.x/SHASUMS256.txt" }) $pattern
  if ($r.Ref -lt 0) { Fail '所有 Node.js 鏡像都無法訪問；請檢查網絡，或自行安裝 Node.js 20+ 後重試' }
  if ($r.Ref -ne 0) { Warn "無法訪問 $(Get-Label $NodeMirrors[0])，Node.js 校驗值取自 $(Get-Label $NodeMirrors[$r.Ref])" }
  $file = @($r.Sums.Keys | Where-Object { $_ -match $pattern })[0]
  $ver = ($file -replace '^node-', '') -replace '-.*$', ''
  $urls = @($r.Alive | ForEach-Object { "$($NodeMirrors[$_].TrimEnd('/'))/$ver/$file" })
  $zip = Join-Path $Tmp $file
  if (-not (Get-Fastest " Node.js $ver" $zip $r.Sums[$file] $urls)) { Fail 'Node.js 下載失敗' }
  $x = Join-Path $Tmp 'node'
  Expand-Zip $zip $x
  New-Item -ItemType Directory -Force -Path (Join-Path $Prefix 'runtime') | Out-Null
  $target = Join-Path $Prefix 'runtime\node'
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  Move-Item -LiteralPath (Join-Path $x ($file -replace '\.zip$', '')) -Destination $target
  $script:NodeExe = $rt
  Info "Node.js $(& $rt -v) 已安裝到 $target"
}

function Initialize-Git {
  $rt = Join-Path $Prefix 'runtime\git\cmd\git.exe'
  if (Test-Path -LiteralPath $rt) { Info "git：安裝目錄內的 MinGit"; return }
  $sys = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($sys -and -not $ForceGit) { Info "git：$($sys.Source)"; return }
  $flavor = if ((Get-Arch) -eq 'arm64') { 'arm64' } else { '64-bit' }
  $file = "MinGit-$MinGitVersion-$flavor.zip"
  $tag = "v$MinGitVersion.windows.1"
  Info "沒有找到 git，下載 MinGit $MinGitVersion 到安裝目錄（不影響系統）"
  $urls = @($GithubMirrors | ForEach-Object { "$($_.TrimEnd('/'))/git-for-windows/git/releases/download/$tag/$file" })
  $urls += @($MinGitMirrors | ForEach-Object { "$($_.TrimEnd('/'))/$tag/$file" })
  $sha = if ($env:KNOWLEDGE_MINGIT_SHA256) { $env:KNOWLEDGE_MINGIT_SHA256.ToLowerInvariant() } else { $MinGitSha256[$flavor] }
  $zip = Join-Path $Tmp $file
  if (-not (Get-Fastest " MinGit $MinGitVersion" $zip $sha $urls)) { Fail 'MinGit 下載失敗；也可以自行安裝 Git for Windows 後重試' }
  Expand-Zip $zip (Join-Path $Prefix 'runtime\git')
  Info "MinGit 已安裝到 $(Join-Path $Prefix 'runtime\git')"
}

# ---------- 發佈包 ----------

$script:NewApp = $null
$script:NewVersion = $null

function Get-InstalledVersion {
  $f = Join-Path $Prefix 'app\VERSION'
  if (Test-Path -LiteralPath $f) { return ([System.IO.File]::ReadAllText($f)).Trim() }
  return ''
}

function Expand-App([string]$zip) {
  $x = Join-Path $Tmp 'app'
  Expand-Zip $zip $x
  $top = @(Get-ChildItem -LiteralPath $x -Directory)[0]
  if (-not $top -or -not (Test-Path -LiteralPath (Join-Path $top.FullName 'src\server.js'))) { Fail '壓縮包內容不是 knowledge_setup' }
  $script:NewApp = $top.FullName
}

function Get-Release {
  $path = if ($Version -eq 'latest') { "/$Repo/releases/latest/download/SHA256SUMS" } else { "/$Repo/releases/download/$Version/SHA256SUMS" }
  Say "取得發佈資訊（$Repo · $Version）"
  $pattern = '^knowledge_setup-v.+\.zip$'
  $r = Get-SumsFromAll 'gh' @($GithubMirrors | ForEach-Object { "$($_.TrimEnd('/'))$path" }) $pattern
  if ($r.Ref -lt 0) { Fail "所有來源都取不到 $Version 的發佈資訊。可能還沒有發佈版本（可用 -Ref main 從源碼安裝），或網絡不通（可用 -Mirror 指定可用的 GitHub 代理）" }
  if ($r.Ref -ne 0) { Warn "無法直接訪問 $(Get-Label $GithubMirrors[0])，校驗值取自 $(Get-Label $GithubMirrors[$r.Ref])" }
  $file = @($r.Sums.Keys | Where-Object { $_ -match $pattern })[0]
  $script:NewVersion = ($file -replace '^knowledge_setup-', '') -replace '\.zip$', ''
  Info "版本 $script:NewVersion"
  if (-not $Force -and (Get-InstalledVersion) -eq $script:NewVersion) { Info "已是最新版本 $script:NewVersion（重新安裝請加 -Force）"; return }
  $urls = @($r.Alive | ForEach-Object { "$($GithubMirrors[$_].TrimEnd('/'))/$Repo/releases/download/$script:NewVersion/$file" })
  $zip = Join-Path $Tmp $file
  if (-not (Get-Fastest "發佈包 $script:NewVersion" $zip $r.Sums[$file] $urls)) { Fail '發佈包下載失敗；可稍後重試，或用 -Mirror 指定其他 GitHub 代理' }
  Expand-App $zip
}

function Get-LocalPackage {
  if (-not (Test-Path -LiteralPath $Package)) { Fail "找不到發佈包：$Package" }
  $full = (Resolve-Path -LiteralPath $Package).Path
  $sumsFile = Join-Path (Split-Path $full) 'SHA256SUMS'
  if (Test-Path -LiteralPath $sumsFile) {
    $sha = (Read-Sums $sumsFile)[(Split-Path $full -Leaf)]
    if ($sha) {
      if ((Get-Sha256 $full) -ne $sha) { Fail "SHA-256 校驗失敗：$full" }
      Info 'SHA-256 校驗通過'
    }
  }
  Say "從本地發佈包安裝：$full"
  Expand-App $full
  $vf = Join-Path $script:NewApp 'VERSION'
  $script:NewVersion = if (Test-Path -LiteralPath $vf) { ([System.IO.File]::ReadAllText($vf)).Trim() } else { 'unknown' }
  if (-not $Force -and (Get-InstalledVersion) -eq $script:NewVersion) { Info "已是版本 $script:NewVersion（重新安裝請加 -Force）"; $script:NewApp = $null }
}

function Get-Source {
  $urls = @($GithubMirrors | ForEach-Object { "$($_.TrimEnd('/'))/$Repo/archive/$Ref.zip" })
  $zip = Join-Path $Tmp 'source.zip'
  if (-not (Get-Fastest "源碼 $Ref" $zip '' $urls)) { Fail "源碼下載失敗：$Repo@$Ref" }
  Expand-App $zip
  $app = $script:NewApp
  if (-not (Test-Path -LiteralPath (Join-Path $app 'release\bin'))) { Fail '這個版本的源碼還沒有一鍵安裝支持（缺少 release\bin）' }
  Copy-Item -LiteralPath (Join-Path $app 'release\bin') -Destination (Join-Path $app 'bin') -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $app 'release\install.ps1'), (Join-Path $app 'release\install.sh') -Destination $app -Force
  $script:NewVersion = "source:$Ref"
  [System.IO.File]::WriteAllText((Join-Path $app 'VERSION'), "$script:NewVersion`n")

  $ranked = @(Get-RankedUrls 'npm 鏡像' @($NpmRegistries | ForEach-Object { "$($_.TrimEnd('/'))/express" }))
  if ($ranked.Count -eq 0) { Fail '所有 npm 鏡像都無法訪問' }
  $npm = Join-Path (Split-Path $script:NodeExe) 'npm.cmd'
  if (-not (Test-Path -LiteralPath $npm)) { $c = Get-Command npm.cmd -ErrorAction SilentlyContinue; if ($c) { $npm = $c.Source } else { Fail '找不到 npm' } }
  $env:Path = "$(Split-Path $script:NodeExe);$env:Path"
  foreach ($i in $ranked) {
    $reg = $NpmRegistries[$i].TrimEnd('/')
    Say "安裝依賴（npm 鏡像 $(Get-Label $reg)）"
    Push-Location $app
    try { & $npm ci --omit=dev --ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=error --registry "$reg/" | Out-Host } finally { Pop-Location }
    if ($LASTEXITCODE -eq 0) { return }
    Warn "經 $(Get-Label $reg) 安裝依賴失敗，換下一個鏡像"
  }
  Fail '依賴安裝失敗'
}

# ---------- 安裝與啟動 ----------

function Write-Utf8([string]$file, [string]$text) { [System.IO.File]::WriteAllText($file, $text, [System.Text.UTF8Encoding]::new($false)) }

function Set-ConfigValue([string]$key, [string]$value) {
  $cfg = Join-Path $Prefix 'config.env'
  $lines = @([System.IO.File]::ReadAllLines($cfg))
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match "^$key=") { $lines[$i] = "$key=$value"; $found = $true } }
  if (-not $found) { $lines += "$key=$value" }
  Write-Utf8 $cfg (($lines -join "`r`n") + "`r`n")
}

function Initialize-Config {
  $cfg = Join-Path $Prefix 'config.env'
  if (-not (Test-Path -LiteralPath $cfg)) {
    $header = "# knowledge_setup 設定檔（一行一個 鍵=值；值原樣使用）`r`n# 修改後執行 knowledge restart 生效；同名環境變數優先於這裡的值。`r`n# DATA_DIR 的相對路徑相對於安裝目錄 $Prefix`r`n`r`n"
    $example = [System.IO.File]::ReadAllText((Join-Path $Prefix 'app\.env.example'))
    Write-Utf8 $cfg ($header + ($example -replace "`r?`n", "`r`n"))
    Info "已建立設定檔 $cfg"
  }
  if ($Port) { Set-ConfigValue 'PORT' $Port }
}

function Install-Command {
  $bin = Join-Path $Prefix 'bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $cmd = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0..\app\bin\knowledge.ps1`" %*`r`n"
  [System.IO.File]::WriteAllText((Join-Path $bin 'knowledge.cmd'), $cmd, [System.Text.Encoding]::ASCII)
  # 直接改登錄檔並保留 REG_EXPAND_SZ，避免把使用者 PATH 中的 %USERPROFILE% 之類展開寫死
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  try {
    $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $parts = @($raw -split ';' | Where-Object { $_ })
    if ($parts -notcontains $bin) {
      $key.SetValue('Path', (($parts + $bin) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
      $script:PathAdded = $true
    }
  } finally { $key.Close() }
  # 經 .NET 設一個使用者變數，順帶廣播環境變更，新開的終端就能看到新的 PATH
  [Environment]::SetEnvironmentVariable('KNOWLEDGE_SETUP_HOME', $Prefix, 'User')
  if (($env:Path -split ';') -notcontains $bin) { $env:Path = "$env:Path;$bin" }
}

function Test-Running {
  $pidFile = Join-Path $Prefix 'run\knowledge.pid'
  if (-not (Test-Path -LiteralPath $pidFile)) { return $false }
  $id = 0
  if (-not [int]::TryParse(([System.IO.File]::ReadAllText($pidFile)).Trim(), [ref]$id)) { return $false }
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  return [bool]($p -and $p.ProcessName -eq 'node')
}

# 在本程序內執行啟動器（保留顏色）；返回它的退出碼
function Invoke-Launcher([string]$command) {
  $global:LASTEXITCODE = 0
  & (Join-Path $Prefix 'app\bin\knowledge.ps1') $command | Out-Host
  return $global:LASTEXITCODE
}

function Main {
  Say "安裝 knowledge_setup 到 $Prefix"
  New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
  Initialize-Node
  Initialize-Git
  if ($Package) { Get-LocalPackage } elseif ($Ref) { Get-Source } else { Get-Release }

  $wasRunning = $false
  if ($script:NewApp) {
    if ((Test-Path -LiteralPath (Join-Path $Prefix 'app\bin\knowledge.ps1')) -and (Test-Running)) {
      $wasRunning = $true
      Say "停止正在運行的舊版本 $(Get-InstalledVersion)"
      [void](Invoke-Launcher 'stop')
    }
    $app = Join-Path $Prefix 'app'
    $old = Join-Path $Prefix 'app.old'
    if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force }
    if (Test-Path -LiteralPath $app) { Move-Item -LiteralPath $app -Destination $old }
    Move-Item -LiteralPath $script:NewApp -Destination $app
    if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue }
    Say "已安裝 $script:NewVersion"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $Prefix 'app\src\server.js'))) { Fail '安裝目錄中沒有程式' }

  Initialize-Config
  Install-Command

  if (-not $NoStart -or $wasRunning) { $script:ExitCode = Invoke-Launcher 'start' }
  else { Say "已安裝，未啟動。啟動：knowledge start" }

  Write-Host ''
  Info '命令：knowledge start | stop | restart | status | logs | upgrade'
  if ($script:PathAdded) { Info "已把 $(Join-Path $Prefix 'bin') 加入使用者 PATH；新開的終端可直接輸入 knowledge" }
}

$script:ExitCode = 0
$script:PathAdded = $false
try {
  Main | Out-Host
} catch {
  Write-Host "錯誤：$($_.Exception.Message)" -ForegroundColor Red
  $script:ExitCode = 1
} finally {
  Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue
  if ($OrigOutputEncoding) { try { [Console]::OutputEncoding = $OrigOutputEncoding } catch {} }
}
exit $script:ExitCode
