# Update-DDIVault.ps1
# Run after copying updated files to C:\Apps\ddivault\
# Usage: .\Update-DDIVault.ps1

param(
  [switch]$ApiOnly    # Skip frontend build, restart API only
)

$InstallDir = "C:\Apps\ddivault"
$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Err($msg)  { Write-Host "[!!] $msg" -ForegroundColor Red }

Write-Step "Stopping services"
nssm stop DDIVault-Collector 2>$null
nssm stop DDIVault-API       2>$null
nssm stop DDIVault-App       2>$null
Start-Sleep -Seconds 3
Write-Ok "Services stopped"

# Sync .env.local to frontend
Write-Step "Syncing .env.local"
Copy-Item "$InstallDir\.env.local" "$InstallDir\frontend\.env.local" -Force
Write-Ok ".env.local synced"

# Install root dependencies (API + collector)
Write-Step "Installing root dependencies"
Set-Location $InstallDir
npm install --silent
if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed"; exit 1 }
Write-Ok "Root dependencies installed"

if (-not $ApiOnly) {
  # Install frontend dependencies
  Write-Step "Installing frontend dependencies"
  Set-Location "$InstallDir\frontend"
  npm install --silent
  if ($LASTEXITCODE -ne 0) { Write-Err "Frontend npm install failed"; exit 1 }
  Write-Ok "Frontend dependencies installed"

  # Build frontend
  Write-Step "Building frontend (Next.js)"
  $build = npm run build 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Err "Build failed!"
    Write-Host $build
    exit 1
  }
  Write-Ok "Frontend built successfully"
}

# Start services
Set-Location $InstallDir
Write-Step "Starting services"
nssm start DDIVault-Collector 2>$null
nssm start DDIVault-API
nssm start DDIVault-App
Start-Sleep -Seconds 6

Write-Step "Service status"
$col = nssm status DDIVault-Collector 2>$null
$api = nssm status DDIVault-API
$app = nssm status DDIVault-App
Write-Host "  Collector : $col"
Write-Host "  API       : $api"
Write-Host "  App       : $app"

# Health check
Start-Sleep -Seconds 3
Write-Step "Health check"
try {
  $health = Invoke-WebRequest -Uri "http://localhost:3007/api/health" -UseBasicParsing -TimeoutSec 10
  Write-Ok "API healthy: $($health.Content)"
} catch {
  Write-Err "API health check failed: $_"
}

Write-Host ""
Write-Host "DDIVault update complete" -ForegroundColor Green
Write-Host "App: http://192.168.6.111:3006" -ForegroundColor Cyan
