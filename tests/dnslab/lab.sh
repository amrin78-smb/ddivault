#!/usr/bin/env bash
# lab.sh — bring the DNS test servers up/down for tests/dnsProviders.test.js
#
# Rootless podman. Ports are deliberately NOT 53: an unprivileged container
# cannot bind below net.ipv4.ip_unprivileged_port_start (1024), and on a dev box
# 53 is usually already held by systemd-resolved and/or a bridge dnsmasq.
#
#   ./lab.sh up      start BIND (5354 / stats 8653) and PowerDNS (5355 / API 8081)
#   ./lab.sh down    remove both containers
#   ./lab.sh status  report what is running
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIND_IMG="docker.io/internetsystemsconsortium/bind9:9.20"
PDNS_IMG="docker.io/powerdns/pdns-auth-49:latest"
PDNS_KEY="${DDI_LAB_PDNS_KEY:-ddivault-lab-api-key}"

up() {
  down >/dev/null 2>&1 || true
  # BIND needs to WRITE its journal for RFC 2136 updates; a read-only zone mount
  # fails with SERVFAIL that looks like a protocol problem and is not.
  mkdir -p "$HERE/zones"; chmod 777 "$HERE/zones"; chmod 666 "$HERE"/zones/*.db
  podman run -d --name ddi-bind --network=host \
    -v "$HERE/named.conf:/etc/bind/named.conf:ro,Z" \
    -v "$HERE/zones:/zones:rw,Z" "$BIND_IMG" >/dev/null

  mkdir -p "$HERE/pdns"; chmod 777 "$HERE/pdns"; rm -f "$HERE/pdns/pdns.sqlite3"
  podman run --rm --entrypoint sh -v "$HERE/pdns:/data:rw,Z" -v "$HERE/pdns-seed.sql:/seed.sql:ro,Z" "$PDNS_IMG" -c '
    sqlite3 /data/pdns.sqlite3 < /usr/local/share/doc/pdns/schema.sqlite3.sql
    sqlite3 /data/pdns.sqlite3 < /seed.sql
    chmod 666 /data/pdns.sqlite3' >/dev/null
  podman run -d --name ddi-pdns --network=host -v "$HERE/pdns:/data:rw,Z" "$PDNS_IMG" \
    --launch=gsqlite3 --gsqlite3-database=/data/pdns.sqlite3 \
    --local-address=0.0.0.0 --local-port=5355 \
    --api=yes --api-key="$PDNS_KEY" \
    --webserver=yes --webserver-address=0.0.0.0 --webserver-port=8081 \
    --webserver-allow-from=0.0.0.0/0 --allow-axfr-ips=0.0.0.0/0 \
    --disable-syslog=yes >/dev/null

  # Wait for BOTH to answer. Poll with a real per-attempt delay: a refused
  # connection returns instantly, so a bare retry loop burns all its attempts
  # in milliseconds and reports "not ready" on a server that simply had not
  # finished booting.
  for i in $(seq 1 40); do
    if dig +short +timeout=1 +tries=1 @127.0.0.1 -p 5354 web.lab.example A >/dev/null 2>&1 \
    && dig +short +timeout=1 +tries=1 @127.0.0.1 -p 5355 web.pdns.example A >/dev/null 2>&1 \
    && [ -n "$(dig +short @127.0.0.1 -p 5354 web.lab.example A 2>/dev/null)" ] \
    && [ -n "$(dig +short @127.0.0.1 -p 5355 web.pdns.example A 2>/dev/null)" ]; then
      echo "lab up (bind :5354/:8653, powerdns :5355/:8081)"; return 0
    fi
  done
  echo "lab FAILED to come up" >&2; podman logs ddi-bind 2>&1 | tail -5 >&2; return 1
}
down() { podman rm -f ddi-bind ddi-pdns >/dev/null 2>&1 || true; echo "lab down"; }
status() { podman ps --filter name=ddi-bind --filter name=ddi-pdns --format '{{.Names}} {{.Status}}'; }

case "${1:-}" in
  up) up ;; down) down ;; status) status ;;
  *) echo "usage: $0 {up|down|status}" >&2; exit 2 ;;
esac
