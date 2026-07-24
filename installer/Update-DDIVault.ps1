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

# Windows Task Scheduler's default task priority (level 7) maps to the BelowNormal
# process priority class, unlike a manually-run script (Normal). This starves the
# CPU-bound npm build under contention from the rest of the suite, making an
# in-app-triggered update look "stuck" compared to the same update run manually.
# Reset to Normal regardless of how this script was invoked - a no-op when already
# Normal (the manual-run case). Child processes inherit the parent's priority class
# by default, so this also covers the npm/node/Next.js build children it spawns.
# (Same fix as NetVault's Update-NetVault.ps1 1.23.26 - see its own comment for detail.)
try {
    $proc = Get-Process -Id $PID
    if ($proc.PriorityClass -ne 'Normal') { $proc.PriorityClass = 'Normal' }
} catch { Write-Warning "Could not adjust process priority: $($_.Exception.Message)" }

# Self-locate the app root from the script's own location instead of trusting
# -InstallDir. This script lives at <appRoot>\installer\Update-DDIVault.ps1, so the
# real app root is the parent of the installer folder. This works on BOTH a suite
# install (C:\Apps\DDIVault\app) and a standalone install (C:\Apps\ddivault).
# The in-app updater (api/server.js) launches this with only -ServerIp and does NOT
# pass -InstallDir, so the old "$AppDir = $InstallDir" default pointed at the parent
# of the real app dir on a suite install and broke git/npm/schema. -InstallDir is
# kept for backward-compat but no longer drives any path.
# Resolve a path to its TRUE on-disk casing (walking each parent for the real component
# name). Get-Item().FullName only echoes the TYPED casing, which is not enough here.
function Get-TrueCasePath([string]$p) {
    try {
        $di = New-Object System.IO.DirectoryInfo([System.IO.Path]::GetFullPath($p))
        $parts = @()
        while ($null -ne $di.Parent) {
            $m = $di.Parent.GetFileSystemInfos($di.Name)
            if ($m.Count -eq 0) { return [System.IO.Path]::GetFullPath($p) }
            $parts = ,($m[0].Name) + $parts; $di = $di.Parent
        }
        $root = $di.Name; if (-not $root.EndsWith('\')) { $root += '\' }
        return $root + ($parts -join '\')
    } catch { return $p }
}
$AppDir      = Split-Path -Parent $PSScriptRoot
# Normalize the build directory to its true on-disk casing. `next build` caches absolute
# module paths in .next; if a later run's cwd casing differs (e.g. C:\Apps\DDIVault vs
# ...\ddivault, depending on how the invocation path was typed), webpack treats the two
# casings as different modules and loads React twice -> the build crashes with "Cannot read
# properties of null (reading 'useContext')". Pinning to on-disk casing makes it stable.
$AppDir      = Get-TrueCasePath $AppDir
$FrontendDir = "$AppDir\frontend"
$LogDir      = "$AppDir\logs"
$Services    = @("DDIVault-API", "DDIVault-App", "DDIVault-Collector")

# The in-app updater (Settings -> Updates) is fire-and-forget: it schedules this
# script as a SYSTEM task (see api/server.js) and immediately returns { started:
# true } to the browser, with no live output stream. Without a transcript, a run
# triggered that way leaves NO durable record of what happened - every Write-Host/
# Write-Step/Write-Warn line below is otherwise lost the moment the scheduled
# task's process exits, which is exactly the case that most needs diagnosing.
# Start it as early as possible (before the Administrator/pre-flight checks below)
# so even an early failure is captured. Best-effort: a transcript that fails to
# start must never block the actual update.
try {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    $transcriptPath = Join-Path $LogDir "update-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
    Start-Transcript -Path $transcriptPath -Append | Out-Null
} catch { Write-Warning "Could not start transcript: $($_.Exception.Message)" }

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!!] $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "    [XX] $msg" -ForegroundColor Red }

function Get-ServiceStatus($name) {
    $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
    if (-not $svc) { return "NOT_FOUND" }
    return $svc.Status.ToString().ToUpper()
}

# --- Resilience: rollback + structured status reporting -------------------
# DDIVault has no `output: 'standalone'` build - the App service runs `next start`
# directly against a plain `frontend\.next`, sharing the app's normal node_modules
# (root for API/Collector, frontend\node_modules for the Next.js app). Unlike
# NetVault's self-contained standalone bundle, a rollback here has to protect THREE
# things: the git source, root node_modules (API/Collector are plain JS with no
# build step - a broken npm install can break them directly), and both
# frontend\.next and frontend\node_modules (the Next.js build output + its deps).
# Renaming is a metadata-only operation on the same NTFS volume regardless of
# directory size, so snapshotting all three this way is just as cheap as NetVault's
# single-folder version - not three times the cost.
$StatusPath      = "$LogDir\last-update-status.json"
$prevCommit      = $null
$attemptedCommit = $null
$currentStage    = 'init'
$envBackupForRollback = $null  # set once STEP 2 has captured the .env.local backups

$StageCodes = @{
    'init'                 = 5
    'pre-flight'           = 10
    'git-pull'             = 20
    'schema-apply'         = 25
    'npm-install-root'     = 30
    'npm-install-frontend' = 35
    'npm-build'            = 40
    'service-start'        = 50
    'health-check'         = 60
    'rollback-failed'      = 70
}

function Write-StatusJson {
    param(
        [bool]$Success,
        [string]$Stage,
        [int]$ErrorCode = 0,
        [string]$ErrorMessage = $null,
        [bool]$RolledBack = $false,
        [bool]$HealthCheckPassed = $false
    )
    $status = [ordered]@{
        timestamp         = (Get-Date).ToString('o')
        success           = $Success
        stage             = $Stage
        errorCode         = $ErrorCode
        errorMessage      = $ErrorMessage
        previousCommit    = $prevCommit
        attemptedCommit   = $attemptedCommit
        finalCommit       = if ($RolledBack) { $prevCommit } else { $attemptedCommit }
        rolledBack        = $RolledBack
        healthCheckPassed = $HealthCheckPassed
    }
    try {
        $json = $status | ConvertTo-Json
        # Write via .NET directly with a BOM-less UTF8Encoding, not Out-File
        # -Encoding UTF8 (which writes a UTF-8 BOM in Windows PowerShell 5.1) -
        # Node's fs.readFileSync(path, 'utf8') doesn't strip a BOM, which would
        # break JSON.parse on every single write. (Same bug found and fixed in
        # NetVault's Update-NetVault.ps1 1.23.27 - fixed here from the start.)
        [System.IO.File]::WriteAllText($StatusPath, $json, (New-Object System.Text.UTF8Encoding $false))
    } catch {
        Write-Warn "Could not write status file $StatusPath - $($_.Exception.Message)"
    }
}

# Poll the API's /api/health until it reports ok+connected, or $TimeoutSec elapses.
function Wait-Healthy([int]$TimeoutSec = 60) {
    Write-Host "    Waiting for DDIVault API to respond on :3007 " -ForegroundColor Gray -NoNewline
    $healthy = $false
    for ($i = 0; $i -lt $TimeoutSec; $i++) {
        try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:3007/api/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            $body = $resp.Content | ConvertFrom-Json
            if ($resp.StatusCode -eq 200 -and $body.status -eq 'ok' -and $body.db -eq 'connected') { $healthy = $true; break }
        } catch {}
        Write-Host "." -ForegroundColor DarkGray -NoNewline
        Start-Sleep -Seconds 1
    }
    Write-Host ""
    return $healthy
}

# Revert to the pre-update commit + restore the node_modules/.next snapshots,
# restart all 3 services, and confirm the OLD version is actually healthy before
# declaring the rollback itself successful.
#
# Note on database migrations: this rolls back CODE, not schema. STEP 4.5 below
# still refuses to deploy new code against a database it failed to migrate (a
# schema migration is not something a code-level rollback can undo, and DDIVault's
# schema files are not applied inside a single transaction) - but a schema failure
# now triggers this same rollback instead of leaving the app down entirely, since
# the old code is far more likely to tolerate a few extra/partial columns than
# the DDIVault install is to tolerate being completely offline.
function Invoke-Rollback([string]$Reason) {
    Write-Host ""
    Write-Step "ROLLING BACK - reason: $Reason"
    $ok = $true
    try {
        # Stop services BEFORE touching node_modules/.next below. STEP 7 already
        # started all 3 services by the time a failure can trigger this function,
        # so without this, the restore's Remove-Item/Rename-Item would be mutating
        # a directory tree while DDIVault-API/-Collector are still live and
        # actively require()-ing from it - a real race that produced exactly this
        # symptom in production (LogVault's identical bug): the restore reported
        # success, but the resulting node_modules ended up with only a handful of
        # packages, and the Collector crash-looped on a missing module. Mirrors
        # the safe order the main update flow already uses (STEP 1 stops services
        # before STEP 5/6 ever touch node_modules/.next).
        Write-Step "Stopping services before restoring last known-good version"
        foreach ($svc in @("DDIVault-App", "DDIVault-API", "DDIVault-Collector")) {
            if ((Get-ServiceStatus $svc) -eq "RUNNING") { sc.exe stop $svc | Out-Null }
        }
        Start-Sleep -Seconds 3

        Set-Location $AppDir
        if ($prevCommit) {
            Write-Host "    Reverting source to $prevCommit" -ForegroundColor Gray
            $null = git reset --hard $prevCommit 2>&1
            if ($LASTEXITCODE -eq 0) { Write-OK "Source reverted" } else { Write-Warn "git reset during rollback failed (exit $LASTEXITCODE)"; $ok = $false }
        } else {
            Write-Warn "No pre-update commit recorded - skipping source revert"
        }

        $rootModulesBackup     = "$AppDir\node_modules.lastgood"
        $frontendNextBackup    = "$FrontendDir\.next.lastgood"
        $frontendModulesBackup = "$FrontendDir\node_modules.lastgood"

        if (Test-Path $rootModulesBackup) {
            if (Test-Path "$AppDir\node_modules") { Remove-Item "$AppDir\node_modules" -Recurse -Force -ErrorAction SilentlyContinue }
            Rename-Item -Path $rootModulesBackup -NewName 'node_modules' -ErrorAction Stop
            Write-OK "Restored root node_modules"
        } else {
            Write-Warn "No root node_modules snapshot found to restore"
        }
        if (Test-Path $frontendNextBackup) {
            if (Test-Path "$FrontendDir\.next") { Remove-Item "$FrontendDir\.next" -Recurse -Force -ErrorAction SilentlyContinue }
            Rename-Item -Path $frontendNextBackup -NewName '.next' -ErrorAction Stop
            Write-OK "Restored frontend .next build output"
        } else {
            Write-Warn "No frontend .next snapshot found to restore"
            $ok = $false
        }
        if (Test-Path $frontendModulesBackup) {
            if (Test-Path "$FrontendDir\node_modules") { Remove-Item "$FrontendDir\node_modules" -Recurse -Force -ErrorAction SilentlyContinue }
            Rename-Item -Path $frontendModulesBackup -NewName 'node_modules' -ErrorAction Stop
            Write-OK "Restored frontend node_modules"
        } else {
            Write-Warn "No frontend node_modules snapshot found to restore"
            $ok = $false
        }

        if ($envBackupForRollback) {
            if ($envBackupForRollback.Root) {
                Set-Content -LiteralPath "$AppDir\.env.local" -Value $envBackupForRollback.Root -NoNewline -Encoding UTF8
            }
            if ($envBackupForRollback.Frontend) {
                Set-Content -LiteralPath "$FrontendDir\.env.local" -Value $envBackupForRollback.Frontend -NoNewline -Encoding UTF8
            }
        }

        Write-Step "Restarting services on last known-good version"
        sc.exe start DDIVault-API | Out-Null
        Start-Sleep -Seconds 8
        sc.exe start DDIVault-App | Out-Null
        Start-Sleep -Seconds 8
        sc.exe start DDIVault-Collector | Out-Null
        Start-Sleep -Seconds 3

        # Informational only - SCM's STARTPENDING -> RUNNING transition can lag
        # several seconds behind the process actually serving traffic (confirmed
        # live in LogVault's identical rollback code: "Rollback verified...
        # healthy" printed immediately followed by "ROLLBACK ALSO FAILED", from
        # this exact check alone overriding a passing health check). Poll briefly
        # for a clean status line, but only $healthy below decides the return value.
        foreach ($svc in $Services) {
            $status = 'UNKNOWN'
            for ($i = 0; $i -lt 30; $i++) {
                $status = Get-ServiceStatus $svc
                if ($status -eq "RUNNING") { break }
                Start-Sleep -Seconds 1
            }
            if ($status -ne "RUNNING") { Write-Warn "$svc - $status (SCM status can lag - health check below is authoritative)" }
        }

        $healthy = Wait-Healthy -TimeoutSec 30
        if ($healthy) { Write-OK "Rollback verified - last known-good version is up and healthy" }
        else { Write-Warn "Rollback restart did not pass the health check"; $ok = $false }
        return ($ok -and $healthy)
    } catch {
        Write-Warn "Rollback itself failed: $($_.Exception.Message)"
        return $false
    }
}

# Every failure path in this script funnels through here instead of a bare
# `exit 1`, so a failure always attempts recovery and always leaves a structured
# record behind - see the resilience block above.
function Fail-Update {
    param([string]$Stage, [string]$Message)
    $code = if ($StageCodes.ContainsKey($Stage)) { $StageCodes[$Stage] } else { 99 }
    Write-Host ""
    Write-Fail "Update failed at stage '$Stage': $Message"
    $rollbackOk = Invoke-Rollback -Reason $Message
    if (-not $rollbackOk) {
        Write-Fail "!!! ROLLBACK ALSO FAILED - DDIVault may be DOWN. Manual intervention required. !!!"
        $code = $StageCodes['rollback-failed']
    }
    Write-StatusJson -Success $false -Stage $Stage -ErrorCode $code -ErrorMessage $Message -RolledBack $rollbackOk -HealthCheckPassed $rollbackOk
    try { Stop-Transcript | Out-Null } catch {}
    exit 1
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
$envBackupForRollback = @{ Root = $rootEnvContent; Frontend = $frontendEnvContent }

# STEP 2.5 - Snapshot current version for rollback
# Must happen BEFORE git touches anything and BEFORE npm install/build overwrites
# node_modules/.next, so a failure anywhere from here on can be undone by putting
# these exact folders back rather than needing to rebuild (which could itself fail
# for the same reason the original update did).
Write-Step "Snapshotting current version for rollback"
$currentStage = 'pre-flight'
Set-Location $AppDir
try {
    $rp = git rev-parse HEAD 2>&1
    if ($rp -match '^[0-9a-f]{40}$') { $prevCommit = $rp }
} catch { $prevCommit = $null }
if ($prevCommit) { Write-OK "Current commit: $prevCommit" }
else { Write-Warn "Could not determine current commit - rollback will not be able to revert source" }

$rootModulesBackup     = "$AppDir\node_modules.lastgood"
$frontendNextBackup    = "$FrontendDir\.next.lastgood"
$frontendModulesBackup = "$FrontendDir\node_modules.lastgood"
# Clear any stale backups left by a prior interrupted run before snapshotting the
# CURRENTLY-serving version, not an older leftover one.
foreach ($stale in @($rootModulesBackup, $frontendNextBackup, $frontendModulesBackup)) {
    if (Test-Path $stale) { Remove-Item $stale -Recurse -Force -ErrorAction SilentlyContinue }
}
if (Test-Path "$AppDir\node_modules") {
    Rename-Item -Path "$AppDir\node_modules" -NewName 'node_modules.lastgood' -ErrorAction Stop
    Write-OK "Snapshotted root node_modules"
}
if (Test-Path "$FrontendDir\.next") {
    Rename-Item -Path "$FrontendDir\.next" -NewName '.next.lastgood' -ErrorAction Stop
    Write-OK "Snapshotted frontend .next build output"
}
if (Test-Path "$FrontendDir\node_modules") {
    Rename-Item -Path "$FrontendDir\node_modules" -NewName 'node_modules.lastgood' -ErrorAction Stop
    Write-OK "Snapshotted frontend node_modules"
}

# STEP 3 - Pull latest
Write-Step "Pulling latest from GitHub..."
$currentStage = 'git-pull'
Set-Location $AppDir

# SYSTEM has never run git in this repo before (only whichever interactive account
# originally cloned it has), and Git >= 2.35.2 (the CVE-2022-24765 fix) refuses to
# operate in a repo it doesn't consider "owned" by the current account, failing with
# "fatal: detected dubious ownership in repository at '...'". Without this, an
# in-app-triggered update could silently keep redeploying the OLD checkout while
# still reporting success below. Best-effort: never block the update on this.
try { $null = git config --global --add safe.directory $AppDir 2>&1 } catch {}

$null = git fetch origin --quiet 2>&1
if ($LASTEXITCODE -ne 0) { Fail-Update -Stage 'git-pull' -Message "git fetch failed (exit $LASTEXITCODE)" }

$null = git reset --hard origin/main 2>&1
if ($LASTEXITCODE -ne 0) { Fail-Update -Stage 'git-pull' -Message "git reset failed (exit $LASTEXITCODE)" }

$null = git clean -fd --exclude=".env.local" --exclude="node_modules" 2>&1

$commitHash = git rev-parse --short HEAD
$commitMsg  = git log -1 --pretty=format:"%s"
$rp = git rev-parse HEAD 2>&1
if ($rp -match '^[0-9a-f]{40}$') { $attemptedCommit = $rp }
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
$currentStage = 'schema-apply'
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
    $schemaFailed = $false
    $schemaFailure = $null
    foreach ($schema in $schemas) {
        $schemaPath = "$AppDir\scripts\$schema"
        if (Test-Path $schemaPath) {
            $prev = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            # -v ON_ERROR_STOP=1: without this, psql keeps going after a real SQL
            # error (e.g. a typo'd column, a broken migration) and still exits 0,
            # so a broken schema file silently "succeeds" here and the collector
            # crashes on every poll afterwards with "column ... does not exist"
            # (see CLAUDE.md's "Collector crashes with column does not exist").
            # This does NOT affect the idempotent `IF NOT EXISTS`/`ON CONFLICT`
            # statements schema files rely on - those aren't errors on a re-run.
            $output = & $psql -U $dbUser -d $dbName -v ON_ERROR_STOP=1 -f $schemaPath 2>&1
            $schemaExitCode = $LASTEXITCODE
            $ErrorActionPreference = $prev
            $output | Where-Object { $_ -notmatch 'NOTICE|WARNING' } |
                Out-File -FilePath "$LogDir\schema-migration.log" -Append
            if ($schemaExitCode -ne 0) {
                Write-Fail "Schema migration FAILED: $schema (psql exit $schemaExitCode)"
                $output | Select-Object -Last 20 | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
                Write-Fail "Full output: $LogDir\schema-migration.log"
                $schemaFailed = $true
                $schemaFailure = "$schema (psql exit $schemaExitCode)"
                break
            } else {
                Write-OK "Applied $schema"
            }
        } else {
            Write-Warn "$schema not found at $schemaPath - skipping"
        }
    }
    $env:PGPASSWORD = ""

    if ($schemaFailed) {
        # Still refuse to deploy new code against a database it failed to migrate
        # (schema.sql's ON_ERROR_STOP=1 comment explains why) - but recover the
        # SERVICE instead of leaving DDIVault down entirely. This rolls back CODE
        # only; the database itself is left in whatever partial state the failed
        # migration produced (schema files are not applied inside one transaction,
        # so a code-level rollback cannot undo that part).
        Fail-Update -Stage 'schema-apply' -Message "Schema migration failed: $schemaFailure - refusing to deploy new code against a partially-migrated database"
    }
} else {
    Write-Warn "psql not found - skipping schema migration. Run manually if needed."
}

# STEP 5 - Root npm install
Write-Step "Installing root dependencies..."
$currentStage = 'npm-install-root'
$rootNpmLog = "$LogDir\npm-install-root.log"
$proc = Start-Process "npm.cmd" -ArgumentList "install" -WorkingDirectory $AppDir `
    -RedirectStandardOutput $rootNpmLog -RedirectStandardError "$rootNpmLog.err" `
    -Wait -PassThru -NoNewWindow
if ($proc.ExitCode -ne 0) {
    # Previously this only warned and kept going, deploying the API/Collector
    # against a possibly-broken root node_modules. Root deps failing to install
    # is exactly the class of failure the rollback exists for.
    Fail-Update -Stage 'npm-install-root' -Message "Root npm install failed (exit $($proc.ExitCode)) - check $rootNpmLog"
}
Write-OK "Root dependencies installed"

# STEP 6 - Frontend npm install + build
Write-Step "Installing frontend dependencies..."
$currentStage = 'npm-install-frontend'
$frontendNpmLog = "$LogDir\npm-install-frontend.log"
$proc = Start-Process "npm.cmd" -ArgumentList "install" -WorkingDirectory $FrontendDir `
    -RedirectStandardOutput $frontendNpmLog -RedirectStandardError "$frontendNpmLog.err" `
    -Wait -PassThru -NoNewWindow
if ($proc.ExitCode -ne 0) {
    Fail-Update -Stage 'npm-install-frontend' -Message "Frontend npm install failed (exit $($proc.ExitCode)) - check $frontendNpmLog"
}
Write-OK "Frontend dependencies installed"

Write-Step "Building frontend (Next.js)..."
$currentStage = 'npm-build'
$buildLog = "$LogDir\npm-build.log"
Write-Host "    Running npm run build..." -ForegroundColor DarkGray
$proc = Start-Process "npm.cmd" -ArgumentList "run", "build" -WorkingDirectory $FrontendDir `
    -RedirectStandardOutput $buildLog -RedirectStandardError "$buildLog.err" `
    -Wait -PassThru -NoNewWindow

if ($proc.ExitCode -ne 0) {
    if (Test-Path "$buildLog.err") {
        Get-Content "$buildLog.err" -Tail 20 | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    }
    Fail-Update -Stage 'npm-build' -Message "Build failed (exit $($proc.ExitCode)) - check $buildLog"
}
Write-OK "Frontend build succeeded"

# STEP 7 - Start services
Write-Step "Starting services..."
$currentStage = 'service-start'
sc.exe start DDIVault-API | Out-Null
Write-Host "    DDIVault-API started - waiting 5s..." -ForegroundColor DarkGray
Start-Sleep -Seconds 12

sc.exe start DDIVault-App | Out-Null
Write-Host "    DDIVault-App started - waiting 8s..." -ForegroundColor DarkGray
Start-Sleep -Seconds 12

sc.exe start DDIVault-Collector | Out-Null
Write-Host "    DDIVault-Collector started - waiting 3s..." -ForegroundColor DarkGray
Start-Sleep -Seconds 3

# STEP 8 - Verify (now a mandatory gate, not advisory)
Write-Step "Verifying services..."
$currentStage = 'health-check'
# Informational only - do NOT gate on this. SCM's STARTPENDING -> RUNNING
# transition can legitimately lag several seconds behind the underlying process
# actually being up and serving traffic (confirmed live in LogVault's identical
# check: /api/health answered successfully while every service still showed
# STARTPENDING here, and the update was wrongly rolled back because of it). Poll
# for up to 30s so a normal-speed start still reports RUNNING instead of a stale
# snapshot, but never fail the update on this alone - Wait-Healthy below is the
# real, authoritative signal (same reasoning NetVault's single-service gate uses).
foreach ($svc in $Services) {
    $status = 'UNKNOWN'
    for ($i = 0; $i -lt 30; $i++) {
        $status = Get-ServiceStatus $svc
        if ($status -eq "RUNNING") { break }
        Start-Sleep -Seconds 1
    }
    if ($status -eq "RUNNING") {
        Write-OK "$svc - $status"
    } else {
        Write-Warn "$svc - $status (SCM status can lag behind the actual process - the health check below is authoritative)"
    }
}

Write-Host ""
# Mandatory final health check (matches NetVault's resilience upgrade): a service
# reporting RUNNING per SCM is not proof the app is actually serving traffic -
# poll /api/health with retries instead of a single best-effort attempt, and treat
# a failure here the same as any other stage failure (triggers a rollback) rather
# than just printing a warning and reporting success anyway.
$healthy = Wait-Healthy -TimeoutSec 60
if ($healthy) {
    Write-OK "API health check passed - DB connected"
} else {
    Fail-Update -Stage 'health-check' -Message "API did not answer /api/health within 60s of starting - service may be crash-looping or stuck"
}

# Update succeeded and is confirmed healthy - the pre-update snapshots are no
# longer needed. Remove them so they don't accumulate across updates or get
# mistaken for a stale rollback target on the next run.
foreach ($snap in @("$AppDir\node_modules.lastgood", "$FrontendDir\.next.lastgood", "$FrontendDir\node_modules.lastgood")) {
    if (Test-Path $snap) { Remove-Item $snap -Recurse -Force -ErrorAction SilentlyContinue }
}
Write-StatusJson -Success $true -Stage $null -ErrorCode 0 -RolledBack $false -HealthCheckPassed $true

Write-Host ""
Write-Host "  DDIVault updated successfully to $commitHash" -ForegroundColor Green
Write-Host "  $commitMsg" -ForegroundColor Green
Write-Host ""

# Best-effort - if Start-Transcript never succeeded (see top of script), this
# throws harmlessly and is swallowed.
try { Stop-Transcript | Out-Null } catch {}
