# DDIVault — Complete Setup Guide
# Run all commands in PowerShell as Administrator

# ============================================================
# STEP 1 — Create PostgreSQL database
# Run on NexVault server (192.168.6.111) where PostgreSQL is installed
# ============================================================

# Connect as postgres superuser and create the ddivault DB + user
psql -U postgres -c "CREATE USER ddivault_user WITH PASSWORD 'NVAdmin@2026';"
psql -U postgres -c "CREATE DATABASE ddivault OWNER ddivault_user;"
psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE ddivault TO ddivault_user;"

# Deploy schema
psql -U ddivault_user -d ddivault -f C:\Apps\ddivault\scripts\schema.sql

# Verify tables were created
psql -U ddivault_user -d ddivault -c "\dt"


# ============================================================
# STEP 2 — Enable WinRM on the DHCP/DNS server
# Run this on the DHCP/DNS server, NOT the NexVault server
# ============================================================

# On the DHCP/DNS server (run as Administrator):
Enable-PSRemoting -Force
Set-Item WSMan:\localhost\Client\TrustedHosts -Value "192.168.6.111" -Force
Set-NetFirewallRule -Name "WINRM-HTTP-In-TCP-PUBLIC" -Enabled True

# Verify WinRM is listening
Test-WSMan -ComputerName localhost


# ============================================================
# STEP 3 — Test WinRM from NexVault server to DHCP server
# Run on NexVault server (192.168.6.111)
# ============================================================

# Test connectivity (replace with your DHCP server IP once known)
# Test-WSMan -ComputerName 192.168.X.X

# Test DHCP PowerShell command remotely:
# Invoke-Command -ComputerName 192.168.X.X -ScriptBlock { Get-DhcpServerv4ScopeStatistics } | ConvertTo-Json

# If using credentials (PS_AUTH_MODE=credential in .env.local):
# $cred = Get-Credential
# Invoke-Command -ComputerName 192.168.X.X -Credential $cred -ScriptBlock { Get-DhcpServerv4ScopeStatistics }


# ============================================================
# STEP 4 — Create DHCP log SMB share on DHCP server
# Run on the DHCP/DNS server
# ============================================================

# Default DHCP log location (usually already exists)
# $dhcpLogPath = "C:\Windows\System32\dhcp"

# Create SMB share if not already shared
# New-SmbShare -Name "DHCPLogs" -Path $dhcpLogPath -ReadAccess "Everyone"

# Or restrict to NexVault server only (recommended):
# New-SmbShare -Name "DHCPLogs" -Path $dhcpLogPath -ReadAccess "DOMAIN\svc-ddivault"

# Verify share is accessible from NexVault server:
# Test-Path "\\192.168.X.X\DHCPLogs"
# Get-ChildItem "\\192.168.X.X\DHCPLogs"


# ============================================================
# STEP 5 — Create folder structure on NexVault server
# ============================================================

New-Item -ItemType Directory -Force -Path "C:\Apps\ddivault\api"
New-Item -ItemType Directory -Force -Path "C:\Apps\ddivault\collector"
New-Item -ItemType Directory -Force -Path "C:\Apps\ddivault\scripts"
New-Item -ItemType Directory -Force -Path "C:\Apps\ddivault\logs"
New-Item -ItemType Directory -Force -Path "C:\Apps\ddivault\frontend\src\app\api\auth\[...nextauth]"
New-Item -ItemType Directory -Force -Path "C:\Apps\ddivault\frontend\src\app\sso"
New-Item -ItemType Directory -Force -Path "C:\Apps\ddivault\frontend\src\components"


# ============================================================
# STEP 6 — Copy files to server
# (After copying all files from the Claude session)
# ============================================================

# Copy each file to its destination:
# Copy-Item "C:\Temp\schema.sql"          "C:\Apps\ddivault\scripts\schema.sql" -Force
# Copy-Item "C:\Temp\server.js"           "C:\Apps\ddivault\api\server.js" -Force
# Copy-Item "C:\Temp\collector.js"        "C:\Apps\ddivault\collector\collector.js" -Force
# Copy-Item "C:\Temp\powershellRunner.js" "C:\Apps\ddivault\collector\powershellRunner.js" -Force
# Copy-Item "C:\Temp\dhcpReader.js"       "C:\Apps\ddivault\collector\dhcpReader.js" -Force
# Copy-Item "C:\Temp\.env.local"          "C:\Apps\ddivault\.env.local" -Force
# ... (all frontend files)


# ============================================================
# STEP 7 — Update .env.local with real DHCP server IP
# ============================================================

# Edit C:\Apps\ddivault\.env.local and set:
#   DHCP_SERVER=192.168.X.X        ← real IP
#   DHCP_LOG_UNC=\\192.168.X.X\DHCPLogs
#   PS_AUTH_MODE=kerberos           ← or 'local' if DHCP is on this machine


# ============================================================
# STEP 8 — Install NSSM services
# ============================================================

# API service
nssm install DDIVault-API "C:\Program Files\nodejs\node.exe" "C:\Apps\ddivault\api\server.js"
nssm set DDIVault-API AppDirectory      "C:\Apps\ddivault"
nssm set DDIVault-API AppStdout         "C:\Apps\ddivault\logs\api.log"
nssm set DDIVault-API AppStderr         "C:\Apps\ddivault\logs\api-err.log"
nssm set DDIVault-API AppRotateFiles    1
nssm set DDIVault-API AppRotateBytes    10485760
nssm set DDIVault-API AppRotateOnline   1
nssm set DDIVault-API AppRestartDelay   3000
nssm set DDIVault-API AppThrottle       60000
nssm set DDIVault-API DependOnService   postgresql
nssm set DDIVault-API AppEnvironmentExtra "NEXTAUTH_SECRET=bue3VdWszntJ24GMhfKg1QkPIEaZYC95"

# Frontend (Next.js) service
nssm install DDIVault-App "C:\Program Files\nodejs\node.exe" "C:\Apps\ddivault\frontend\node_modules\.bin\next"
nssm set DDIVault-App AppParameters    "start -p 3006"
nssm set DDIVault-App AppDirectory     "C:\Apps\ddivault\frontend"
nssm set DDIVault-App AppStdout        "C:\Apps\ddivault\logs\app.log"
nssm set DDIVault-App AppStderr        "C:\Apps\ddivault\logs\app-err.log"
nssm set DDIVault-App AppRotateFiles   1
nssm set DDIVault-App AppRotateBytes   10485760
nssm set DDIVault-App AppRotateOnline  1
nssm set DDIVault-App AppRestartDelay  3000
nssm set DDIVault-App DependOnService  postgresql
nssm set DDIVault-App AppEnvironmentExtra "NEXTAUTH_URL=http://192.168.6.111:3006 NEXTAUTH_SECRET=bue3VdWszntJ24GMhfKg1QkPIEaZYC95 NETVAULT_HUB_URL=http://192.168.6.111:3000 NEXT_PUBLIC_NETVAULT_HUB_URL=http://192.168.6.111:3000 NETVAULT_DB_HOST=localhost NETVAULT_DB_PORT=5432 NETVAULT_DB_NAME=netvault NETVAULT_DB_USER=netvault NETVAULT_DB_PASS=PgAdmin@2026!"

# Collector service
nssm install DDIVault-Collector "C:\Program Files\nodejs\node.exe" "C:\Apps\ddivault\collector\collector.js"
nssm set DDIVault-Collector AppDirectory     "C:\Apps\ddivault"
nssm set DDIVault-Collector AppStdout        "C:\Apps\ddivault\logs\collector.log"
nssm set DDIVault-Collector AppStderr        "C:\Apps\ddivault\logs\collector-err.log"
nssm set DDIVault-Collector AppRotateFiles   1
nssm set DDIVault-Collector AppRotateBytes   10485760
nssm set DDIVault-Collector AppRotateOnline  1
nssm set DDIVault-Collector AppRestartDelay  3000
nssm set DDIVault-Collector DependOnService  postgresql


# ============================================================
# STEP 9 — Run Update-DDIVault.ps1 for first build
# ============================================================

cd C:\Apps\ddivault
.\Update-DDIVault.ps1


# ============================================================
# STEP 10 — Verify
# ============================================================

# API health check
Invoke-WebRequest -Uri "http://localhost:3007/api/health" -UseBasicParsing | Select-Object -ExpandProperty Content

# Check services
nssm status DDIVault-API
nssm status DDIVault-App
nssm status DDIVault-Collector

# Tail logs
Get-Content C:\Apps\ddivault\logs\api.log -Tail 20
Get-Content C:\Apps\ddivault\logs\collector.log -Tail 20

# Open app
Start-Process "http://192.168.6.111:3006"


# ============================================================
# STEP 11 — GitHub push
# ============================================================

cd C:\Apps\ddivault
git init
git remote add origin https://github.com/amrin78-smb/ddivault
git add -A
git commit -m "Phase 1-6: Initial DDIVault build — schema, collector, API, frontend, auth"
git branch -M main
git push -u origin main
