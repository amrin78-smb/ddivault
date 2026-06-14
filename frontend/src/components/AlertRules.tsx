'use client';

import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/components/Toast';
import { useRBAC, ReadOnlyBanner } from '@/components/RBACContext';
import { useLicense } from '@/components/LicenseGuard';
import { PageHeader, EmptyState, TableSkeleton, Spinner, useRefreshKey } from '@/components/ui';

// ════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════
interface AlertRule {
  rule_type: string;
  is_enabled: boolean;
  threshold_value: number | null;
  threshold_unit: string | null;
  severity: string;            // 'critical' | 'warning' | 'info'
  cooldown_mins: number;
  digest_mode: boolean;
}

// ════════════════════════════════════════════════════════════
// API helper
// ════════════════════════════════════════════════════════════
async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
  return res.json();
}

// ════════════════════════════════════════════════════════════
// Shared style tokens
// ════════════════════════════════════════════════════════════
const INPUT: React.CSSProperties = {
  width: '100%', padding: '6px 9px', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)', background: 'var(--bg-primary)',
  color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit', outline: 'none',
};
const TD: React.CSSProperties = { padding: '9px 14px', fontSize: 13, color: 'var(--text-primary)', verticalAlign: 'middle' };

// Friendly name + description per known rule_type
const RULE_INFO: Record<string, { name: string; desc: string }> = {
  scope_critical:             { name: 'Scope Critical',              desc: 'DHCP scope utilization above the critical threshold.' },
  scope_warning:              { name: 'Scope Warning',               desc: 'DHCP scope utilization above the warning threshold.' },
  scope_exhaustion_forecast:  { name: 'Scope Exhaustion Forecast',   desc: 'Scope projected to run out of addresses soon.' },
  unknown_device:             { name: 'Unknown Device',              desc: 'An unrecognized device appeared on a monitored subnet.' },
  server_unreachable:         { name: 'Server Unreachable',          desc: 'A DHCP/DNS server failed to respond to polling.' },
  dhcp_failover_broken:       { name: 'DHCP Failover Broken',        desc: 'DHCP failover relationship is degraded or down.' },
  dns_replication_lag:        { name: 'DNS Replication Lag',         desc: 'DNS zone replication is lagging between servers.' },
  lease_spike:                { name: 'Lease Spike',                 desc: 'Abnormal surge in DHCP lease activity detected.' },
  ip_conflict:                { name: 'IP Conflict',                 desc: 'Duplicate IP address detected on the network.' },
  new_device_vip_subnet:      { name: 'New Device on VIP Subnet',    desc: 'A new device joined a protected/VIP subnet.' },
  after_hours_device:         { name: 'After-Hours Device',          desc: 'Device activity observed outside business hours.' },
  mac_spoofing:               { name: 'MAC Spoofing',                desc: 'Possible MAC address spoofing detected.' },
  dhcp_starvation:            { name: 'DHCP Starvation',             desc: 'Rapid lease consumption suggesting a starvation attack.' },
  subnet_jumping:             { name: 'Subnet Jumping',              desc: 'A device appeared across multiple subnets unexpectedly.' },
};

const SEVERITY_OPTIONS = ['critical', 'warning', 'info'];

// Tier sort order (Critical → Warning → Info → anything unknown last)
const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };

// Badge class per severity, consistent with the app palette
// (critical=red, warning=yellow, info=blue)
function severityBadgeClass(s: string): string {
  if (s === 'critical') return 'badge-red';
  if (s === 'warning') return 'badge-yellow';
  if (s === 'info') return 'badge-blue';
  return 'badge-gray';
}

function ruleName(t: string): string { return RULE_INFO[t]?.name || t; }
function ruleDesc(t: string): string { return RULE_INFO[t]?.desc || ''; }

// ════════════════════════════════════════════════════════════
// MAIN — Alert Rules
// ════════════════════════════════════════════════════════════
export default function AlertRules() {
  const { toast } = useToast();
  const { canWrite: rbacCanWrite } = useRBAC();
  const { state: licenseState } = useLicense();
  const canWrite = rbacCanWrite && licenseState.canWrite;

  const [rules, setRules] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingType, setSavingType] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api('/alert-rule-config');
      setRules((d.data || []).map((r: AlertRule) => ({
        ...r,
        threshold_value: r.threshold_value != null ? Number(r.threshold_value) : null,
        cooldown_mins: r.cooldown_mins != null ? Number(r.cooldown_mins) : 0,
        is_enabled: !!r.is_enabled,
        digest_mode: !!r.digest_mode,
      })));
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);
  useRefreshKey(load);

  const update = (type: string, patch: Partial<AlertRule>) =>
    setRules(prev => prev.map(r => r.rule_type === type ? { ...r, ...patch } : r));

  const save = async (r: AlertRule) => {
    setSavingType(r.rule_type);
    try {
      await api(`/alert-rule-config/${r.rule_type}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_enabled: r.is_enabled,
          threshold_value: r.threshold_value,
          severity: r.severity,
          cooldown_mins: Number(r.cooldown_mins) || 0,
          digest_mode: r.digest_mode,
        }),
      });
      toast(`${ruleName(r.rule_type)} saved`, 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSavingType(null);
    }
  };

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <PageHeader
        title="Alert Rules"
        subtitle="Configure which conditions trigger alerts, their thresholds, severity, and cooldown"
      />

      <ReadOnlyBanner />

      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        Rules are ordered by tier. Info-tier rules are low-signal and hidden from the default alert view.
      </div>

      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
        {loading ? (
          <TableSkeleton rows={8} cols={6} />
        ) : rules.length === 0 ? (
          <EmptyState icon="🔔" title="No alert rules" message="No alert rule configuration is available yet." />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Rule</th>
                <th>Enabled</th>
                <th>Threshold</th>
                <th>Severity</th>
                <th>Cooldown (mins)</th>
                <th>Digest</th>
                {canWrite && <th>Action</th>}
              </tr>
            </thead>
            <tbody>
              {[...rules]
                .sort((a, b) =>
                  (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99) ||
                  ruleName(a.rule_type).localeCompare(ruleName(b.rule_type))
                )
                .map(r => (
                <tr key={r.rule_type}>
                  <td style={{ ...TD, minWidth: 240 }}>
                    <div style={{ fontWeight: 600 }}>{ruleName(r.rule_type)}</div>
                    {ruleDesc(r.rule_type) && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{ruleDesc(r.rule_type)}</div>
                    )}
                  </td>
                  <td style={TD}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: canWrite ? 'pointer' : 'default' }}>
                      <input
                        type="checkbox"
                        checked={r.is_enabled}
                        disabled={!canWrite}
                        onChange={e => update(r.rule_type, { is_enabled: e.target.checked })}
                      />
                      <span className={`badge ${r.is_enabled ? 'badge-green' : 'badge-gray'}`}>{r.is_enabled ? 'On' : 'Off'}</span>
                    </label>
                  </td>
                  <td style={{ ...TD, minWidth: 140 }}>
                    {r.threshold_value != null ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input
                          type="number"
                          value={r.threshold_value}
                          disabled={!canWrite}
                          onChange={e => update(r.rule_type, { threshold_value: e.target.value === '' ? null : Number(e.target.value) })}
                          style={{ ...INPUT, width: 80 }}
                        />
                        {r.threshold_unit && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.threshold_unit}</span>}
                      </div>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </td>
                  <td style={{ ...TD, minWidth: 130 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className={`badge ${severityBadgeClass(r.severity)}`}>{r.severity}</span>
                      <select
                        value={r.severity}
                        disabled={!canWrite}
                        onChange={e => update(r.rule_type, { severity: e.target.value })}
                        style={INPUT}
                        aria-label="Severity"
                      >
                        {SEVERITY_OPTIONS.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
                      </select>
                    </div>
                  </td>
                  <td style={{ ...TD, minWidth: 100 }}>
                    <input
                      type="number"
                      value={r.cooldown_mins}
                      disabled={!canWrite}
                      onChange={e => update(r.rule_type, { cooldown_mins: e.target.value === '' ? 0 : Number(e.target.value) })}
                      style={{ ...INPUT, width: 80 }}
                    />
                  </td>
                  <td style={TD}>
                    <input
                      type="checkbox"
                      checked={r.digest_mode}
                      disabled={!canWrite}
                      onChange={e => update(r.rule_type, { digest_mode: e.target.checked })}
                    />
                  </td>
                  {canWrite && (
                    <td style={TD}>
                      <button
                        className="btn btn-primary"
                        onClick={() => save(r)}
                        disabled={savingType === r.rule_type}
                        style={{ fontSize: 12, opacity: savingType === r.rule_type ? 0.7 : 1 }}
                      >
                        {savingType === r.rule_type ? <><Spinner size={12} color="#fff" /> Saving…</> : 'Save'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
