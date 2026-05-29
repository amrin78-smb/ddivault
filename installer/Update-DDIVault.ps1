param(
    [string]$InstallDir = "C:\Apps\ddivault"
)

$AppDir      = "$InstallDir"
$FrontendDir = "$AppDir\frontend"
$LogDir      = "$InstallDir\logs"
$Services    = @("DDIVault-API", "DDIVault-App", "DDIVault-Collector")

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!!] $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "    [XX] $msg" -ForegroundColor Red }

function Get-ServiceStatus($name) {
    $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
    if (-not $svc) { return "NOT_FOUND" }
    return $svc.Status.ToString().ToUpper()
}

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Fail "This script must be run as Administrator."
    exit 1
}

Write-Host ""
Write-Host "  DDIVault Update Script" -ForegroundColor White
Write-Host "  ======================" -ForegroundColor DarkGray
Write-Host "  InstallDir : $InstallDir" -ForegroundColor DarkGray
Write-Host "  AppDir     : $AppDir" -ForegroundColor DarkGray
Write-Host "  FrontendDir: $FrontendDir" -ForegroundColor DarkGray
Write-Host ""

if (-not (Test-Path $AppDir))      { Write-Fail "AppDir not found: $AppDir"; exit 1 }
if (-not (Test-Path $FrontendDir)) { Write-Fail "FrontendDir not found: $FrontendDir"; exit 1 }
if (-not (Test-Path $LogDir))      { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }

# STEP 1 - Stop services
Write-Step "Stopping services..."
foreach ($svc in @("DDIVault-App", "DDIVault-API", "DDIVault-Collector")) {
    $status = Get-ServiceStatus $svc
    if ($status -eq "RUNNING") {
        sc.exe stop $svc | Out-Null
        Write-OK "Stopped $svc"
    } elseif ($status -eq "NOT_FOUND") {
        Write-Warn "$svc not found - skipping"
    } else {
        Write-OK "$svc already stopped ($status)"
    }
}
Write-Host "    Waiting 5 seconds..." -ForegroundColor DarkGray
Start-Sleep -Seconds 8

foreach ($port in @(3006, 3007)) {
    $pids = netstat -ano 2>$null |
        Select-String ":$port\s" |
        ForEach-Object { ($_ -split '\s+')[-1] } |
        Where-Object { $_ -match '^\d+$' } |
        Select-Object -Unique
    foreach ($pid in $pids) {
        try {
            $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
            if ($proc -and $proc.Name -eq 'node') {
                Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
                Write-Warn "Killed lingering node PID $pid on port $port"
            }
        } catch {}
    }
}

# STEP 2 - Backup .env.local
Write-Step "Backing up .env.local files..."
$rootEnvPath     = "$AppDir\.env.local"
$frontendEnvPath = "$FrontendDir\.env.local"
$rootEnvContent     = $null
$frontendEnvContent = $null

if (Test-Path $rootEnvPath) {
    $rootEnvContent = Get-Content -LiteralPath $rootEnvPath -Raw
    Write-OK "Backed up root .env.local"
} else {
    Write-Warn "No .env.local at $rootEnvPath"
}
if (Test-Path $frontendEnvPath) {
    $frontendEnvContent = Get-Content -LiteralPath $frontendEnvPath -Raw
    Write-OK "Backed up frontend .env.local"
} else {
    Write-Warn "No .env.local at $frontendEnvPath"
}

# STEP 3 - Pull latest
Write-Step "Pulling latest from GitHub..."
Set-Location $AppDir
git fetch origin 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
if ($LASTEXITCODE -ne 0) { Write-Fail "git fetch failed"; exit 1 }

git reset --hard origin/main 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
if ($LASTEXITCODE -ne 0) { Write-Fail "git reset failed"; exit 1 }

git clean -fd --exclude=".env.local" --exclude="node_modules" 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }

$commitHash = git rev-parse --short HEAD
$commitMsg  = git log -1 --pretty=format:"%s"
Write-OK "Now at commit $commitHash - $commitMsg"

# STEP 4 - Restore .env.local
Write-Step "Restoring .env.local files..."
if ($rootEnvContent) {
    Set-Content -LiteralPath $rootEnvPath -Value $rootEnvContent -NoNewline -Encoding UTF8
    Write-OK "Restored root .env.local"
}
if ($frontendEnvContent) {
    Set-Content -LiteralPath $frontendEnvPath -Value $frontendEnvContent -NoNewline -Encoding UTF8
    Write-OK "Restored frontend .env.local"
}

# STEP 5 - Root npm install
Write-Step "Installing root dependencies..."
$rootNpmLog = "$LogDir\npm-install-root.log"
$proc = Start-Process "npm.cmd" -ArgumentList "install" -WorkingDirectory $AppDir `
    -RedirectStandardOutput $rootNpmLog -RedirectStandardError "$rootNpmLog.err" `
    -Wait -PassThru -NoNewWindow
if ($proc.ExitCode -ne 0) {
    Write-Warn "Root npm install exit code $($proc.ExitCode) - check $rootNpmLog"
} else {
    Write-OK "Root dependencies installed"
}

# STEP 6 - Frontend npm install + build
Write-Step "Installing frontend dependencies..."
$frontendNpmLog = "$LogDir\npm-install-frontend.log"
$proc = Start-Process "npm.cmd" -ArgumentList "install" -WorkingDirectory $FrontendDir `
    -RedirectStandardOutput $frontendNpmLog -RedirectStandardError "$frontendNpmLog.err" `
    -Wait -PassThru -NoNewWindow
if ($proc.ExitCode -ne 0) {
    Write-Warn "Frontend npm install exit code $($proc.ExitCode) - check $frontendNpmLog"
} else {
    Write-OK "Frontend dependencies installed"
}

Write-Step "Building frontend (Next.js)..."
$buildLog = "$LogDir\npm-build.log"
Write-Host "    Running npm run build..." -ForegroundColor DarkGray
$proc = Start-Process "npm.cmd" -ArgumentList "run", "build" -WorkingDirectory $FrontendDir `
    -RedirectStandardOutput $buildLog -RedirectStandardError "$buildLog.err" `
    -Wait -PassThru -NoNewWindow

if ($proc.ExitCode -ne 0) {
    Write-Fail "Build FAILED (exit code $($proc.ExitCode))"
    Write-Fail "Log: $buildLog"
    if (Test-Path "$buildLog.err") {
        Get-Content "$buildLog.err" -Tail 20 | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    }
    Write-Warn "Services NOT restarted - old version still running."
    exit 1
}
Write-OK "Frontend build succeeded"

# STEP 7 - Start services
Write-Step "Starting services..."
sc.exe start DDIVault-API | Out-Null
Write-Host "    DDIVault-API started - waiting 5s..." -ForegroundColor DarkGray
Start-Sleep -Seconds 8

sc.exe start DDIVault-App | Out-Null
Write-Host "    DDIVault-App started - waiting 8s..." -ForegroundColor DarkGray
Start-Sleep -Seconds 8

sc.exe start DDIVault-Collector | Out-Null
Write-Host "    DDIVault-Collector started - waiting 3s..." -ForegroundColor DarkGray
Start-Sleep -Seconds 3

# STEP 8 - Verify
Write-Step "Verifying services..."
$allOk = $true
foreach ($svc in $Services) {
    $status = Get-ServiceStatus $svc
    if ($status -eq "RUNNING") {
        Write-OK "$svc - $status"
    } else {
        Write-Fail "$svc - $status"
        $allOk = $false
    }
}

Write-Host ""
try {
    $health = Invoke-WebRequest -Uri "http://localhost:3007/api/health" -UseBasicParsing -TimeoutSec 10
    $body   = $health.Content | ConvertFrom-Json
    if ($body.status -eq "ok" -and $body.db -eq "connected") {
        Write-OK "API health check passed - DB connected"
    } else {
        Write-Warn "API unexpected response: $($health.Content)"
        $allOk = $false
    }
} catch {
    Write-Warn "API health check failed: $_"
    $allOk = $false
}

Write-Host ""
if ($allOk) {
    Write-Host "  DDIVault updated successfully to $commitHash" -ForegroundColor Green
    Write-Host "  $commitMsg" -ForegroundColor Green
} else {
    Write-Host "  DDIVault update completed with warnings - check above" -ForegroundColor Yellow
}
Write-Host ""
