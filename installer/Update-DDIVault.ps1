param(
    [string]$InstallDir = "C:\Apps\ddivault",
    [string]$ServerIp
)

$ErrorActionPreference = 'Stop'

# This script runs as a SYSTEM scheduled task, which has a minimal PATH that does
# not include git/node/npm. Without this, "git fetch/reset" and "npm install/build"
# silently exit with no binary found and the update "succeeds" with the OLD code.
# Prepend the standard install locations so the toolchain resolves under SYSTEM.
$env:PATH = @(
    "C:\Program Files\Git\cmd",
    "C:\Program Files\Git\bin",
    "C:\Program Files\nodejs",
    $env:PATH
) -join ";"

# Self-locate the app root from the script's own location instead of trusting
# -InstallDir. This script lives at <appRoot>\installer\Update-DDIVault.ps1, so the
# real app root is the parent of the installer folder. This works on BOTH a suite
# install (C:\Apps\DDIVault\app) and a standalone install (C:\Apps\ddivault).
# The in-app updater (api/server.js) launches this with only -ServerIp and does NOT
# pass -InstallDir, so the old "$AppDir = $InstallDir" default pointed at the parent
# of the real app dir on a suite install and broke git/npm/schema. -InstallDir is
# kept for backward-compat but no longer drives any path.
$AppDir      = Split-Path -Parent $PSScriptRoot
$FrontendDir = "$AppDir\frontend"
$LogDir      = "$AppDir\logs"
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

# Give the API a moment to return its { started: true } response to the in-app
# updater before we start stopping services.
Write-Host "=== Update starting in 5 seconds ===" -ForegroundColor Cyan
Start-Sleep -Seconds 5

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
Start-Sleep -Seconds 12

foreach ($port in @(3006, 3007)) {
    $pids = netstat -ano 2>$null |
        Select-String ":$port\s" |
        ForEach-Object { ($_ -split '\s+')[-1] } |
        Where-Object { $_ -match '^\d+$' } |
        Select-Object -Unique
    foreach ($procPid in $pids) {
        try {
            $proc = Get-Process -Id $procPid -ErrorAction SilentlyContinue
            if ($proc -and $proc.Name -eq 'node') {
                Stop-Process -Id $procPid -Force -ErrorAction SilentlyContinue
                Write-Warn "Killed lingering node PID $procPid on port $port"
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
$null = git fetch origin --quiet 2>&1
if ($LASTEXITCODE -ne 0) { Write-Fail "git fetch failed"; exit 1 }

$null = git reset --hard origin/main 2>&1
if ($LASTEXITCODE -ne 0) { Write-Fail "git reset failed"; exit 1 }

$null = git clean -fd --exclude=".env.local" --exclude="node_modules" 2>&1

$commitHash = git rev-parse --short HEAD
$commitMsg  = git log -1 --pretty=format:"%s"
Write-OK "Now at commit $commitHash - $commitMsg"

# STEP 4 - Restore .env.local
Write-Step "Restoring .env.local files..."
if ($rootEnvContent) {
    Set-Content -LiteralPath $rootEnvPath -Value $rootEnvContent -NoNewline -Encoding UTF8
    Write-OK "Restored root .env.local"
    Copy-Item -LiteralPath $rootEnvPath -Destination $frontendEnvPath -Force
    Write-OK "Copied .env.local to frontend"
}
if ($frontendEnvContent) {
    Set-Content -LiteralPath $frontendEnvPath -Value $frontendEnvContent -NoNewline -Encoding UTF8
    Write-OK "Restored frontend .env.local"
}

# Ensure SERVER_IP is recorded in .env.local so the in-app updater
# (Settings -> Updates) can read it via dotenv to re-run this installer.
# Runs on every update so existing installs get it once; a real value is preserved.
if ($ServerIp -and (Test-Path $rootEnvPath)) {
    $envText = Get-Content -LiteralPath $rootEnvPath -Raw
    if ($envText -match '(?m)^\s*SERVER_IP\s*=\s*(your_server_ip\s*)?$') {
        $envText = $envText -replace '(?m)^\s*SERVER_IP\s*=.*$', "SERVER_IP=$ServerIp"
        Set-Content -LiteralPath $rootEnvPath -Value $envText -NoNewline -Encoding UTF8
        Write-OK "Set SERVER_IP=$ServerIp in .env.local"
    } elseif ($envText -notmatch '(?m)^\s*SERVER_IP\s*=') {
        Add-Content -LiteralPath $rootEnvPath -Value "SERVER_IP=$ServerIp"
        Write-OK "Added SERVER_IP=$ServerIp to .env.local"
    } else {
        Write-OK "Preserving existing SERVER_IP in .env.local"
    }
    if (Test-Path $frontendEnvPath) {
        Copy-Item -LiteralPath $rootEnvPath -Destination $frontendEnvPath -Force
    }
}

# STEP 4.5 - Run schema migrations
Write-Step "Running schema migrations..."
$psql = "C:\Program Files\PostgreSQL\16\bin\psql.exe"
if (Test-Path $psql) {
    $dbPass = (Get-Content $rootEnvPath | Select-String "DDI_DB_PASS=").ToString().Split("=",2)[1].Trim()
    $dbUser = (Get-Content $rootEnvPath | Select-String "DDI_DB_USER=").ToString().Split("=",2)[1].Trim()
    $dbName = (Get-Content $rootEnvPath | Select-String "DDI_DB_NAME=").ToString().Split("=",2)[1].Trim()

    # Self-heal: on fresh installs the tables are owned by postgres, but the schema
    # below is applied as ddivault_user (needs ownership) so CREATE OR REPLACE
    # TRIGGER/FUNCTION and future ALTER TABLE/CREATE INDEX fail "must be owner"
    # silently and migrations don't land. Reassign all public objects to
    # ddivault_user once as the postgres superuser. Idempotent. Needs
    # POSTGRES_PASSWORD from .env.local; soft-skip if absent. Non-fatal.
    Write-Step "Reassigning table ownership (idempotent)..."
    $pgPwLine = Get-Content $rootEnvPath -ErrorAction SilentlyContinue | Where-Object { $_ -match '^POSTGRES_PASSWORD=' } | Select-Object -First 1
    $pgPw = if ($pgPwLine) { $pgPwLine.Substring('POSTGRES_PASSWORD='.Length).Trim() } else { '' }
    if ($pgPw) {
        $reassign = @'
DO $$
DECLARE r RECORD;
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'ddivault_user') THEN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
      EXECUTE format('ALTER TABLE public.%I OWNER TO ddivault_user', r.tablename);
    END LOOP;
    FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname='public' LOOP
      EXECUTE format('ALTER SEQUENCE public.%I OWNER TO ddivault_user', r.sequencename);
    END LOOP;
    FOR r IN SELECT viewname FROM pg_views WHERE schemaname='public' LOOP
      EXECUTE format('ALTER VIEW public.%I OWNER TO ddivault_user', r.viewname);
    END LOOP;
    FOR r IN SELECT p.proname AS nm, pg_get_function_identity_arguments(p.oid) AS args
             FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public'
               AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e') LOOP
      EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO ddivault_user', r.nm, r.args);
    END LOOP;
    GRANT CREATE ON SCHEMA public TO ddivault_user;
  END IF;
END
$$;
'@
        $prevPref = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $env:PGPASSWORD = $pgPw
        $reassignOut = $reassign | & $psql -U postgres -h localhost -p 5432 -d $dbName -f - 2>&1
        $env:PGPASSWORD = ""
        $ErrorActionPreference = $prevPref
        $reassignOut | Where-Object { $_ -notmatch 'NOTICE|WARNING' } |
            Out-File -FilePath "$LogDir\schema-migration.log" -Append
        Write-OK "Reassigned public object ownership to ddivault_user"
    } else {
        Write-Warn "POSTGRES_PASSWORD not in .env.local - skipping ownership reassign"
    }

    $env:PGPASSWORD = $dbPass
    $schemas = @("schema.sql","schema-ipam.sql","schema-server-auth.sql","schema-sites.sql")
    foreach ($schema in $schemas) {
        $schemaPath = "$AppDir\scripts\$schema"
        if (Test-Path $schemaPath) {
            $prev = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            $output = & $psql -U $dbUser -d $dbName -f $schemaPath 2>&1
            $ErrorActionPreference = $prev
            $output | Where-Object { $_ -notmatch 'NOTICE|WARNING' } |
                Out-File -FilePath "$LogDir\schema-migration.log" -Append
            Write-OK "Applied $schema"
        }
    }
    $env:PGPASSWORD = ""
} else {
    Write-Warn "psql not found - skipping schema migration. Run manually if needed."
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
Start-Sleep -Seconds 12

sc.exe start DDIVault-App | Out-Null
Write-Host "    DDIVault-App started - waiting 8s..." -ForegroundColor DarkGray
Start-Sleep -Seconds 12

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
