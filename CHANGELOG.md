<!--
RELEASE PROCESS:
1. Update version in package.json
2. Add new section to CHANGELOG.md:
   ## v1.x.x — YYYY-MM-DD
   ### What's New
   - Feature 1
   - Feature 2
3. git add package.json CHANGELOG.md
4. git commit -m "chore: bump version to v1.x.x"
5. git push
6. Users see update available in Settings → Updates
-->

# DDIVault Changelog

## v1.0.0 — 2026-06-08
### Initial Release
- DNS, DHCP & IPAM monitoring across multiple servers
- Zone Sync Matrix with replication health across all DNS servers
- DHCP scope utilization forecasting and capacity planning
- IPAM auto-sync from DHCP with parallel subnet scanning
- Behavioral anomaly detection (subnet jumping, MAC spoofing, after-hours, DHCP starvation)
- Device fingerprinting with 39,000+ IEEE OUI entries
- Site health scoring per site with DHCP/DNS/IPAM/Security components
- DNS Intelligence — stale records, forwarder health, scavenging status
- Interactive dashboard with clickable KPIs and device type drill-down
- License enforcement with grace period and read-only mode
- RBAC with 4 roles and site-level filtering
- Audit trail, reports (6 types PDF/CSV), REST API v1
- Email alerting with SMTP, cooldown, and HMAC acknowledge links
- Self-updating from web UI via Windows Task Scheduler
