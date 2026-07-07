'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { EmptyState } from '@/components/ui';
import { useToast } from './Toast';
import type { SavedRow, ScheduleRow, HistoryRow } from './reportTypes';

// Local style tokens — mirror ReportsTab house style (token-only, dark-mode safe).
const CARD: React.CSSProperties = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)' };
const TITLE: React.CSSProperties = { fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-primary)' };
const MUTED: React.CSSProperties = { fontSize: 'var(--text-sm)', color: 'var(--text-muted)' };
const PANEL_HEAD: React.CSSProperties = { padding: '14px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 };
const ROW: React.CSSProperties = { padding: '12px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 };

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtDate(x: string | null | undefined): string {
  if (!x) return '—';
  const d = new Date(x);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// Human cadence summary, e.g. "Weekly · Mon 07:00", "Daily 07:00", "Monthly · day 1 07:00".
function cadenceSummary(s: ScheduleRow): string {
  const time = `${pad2(s.hour ?? 0)}:00`;
  if (s.cadence === 'daily') return `Daily ${time}`;
  if (s.cadence === 'weekly') {
    const dow = s.day_of_week != null ? (WEEKDAYS[s.day_of_week] ?? `day ${s.day_of_week}`) : '—';
    return `Weekly · ${dow} ${time}`;
  }
  if (s.cadence === 'monthly') {
    const dom = s.day_of_month != null ? s.day_of_month : '—';
    return `Monthly · day ${dom} ${time}`;
  }
  return `${String(s.cadence)} ${time}`;
}

function statusBadge(status: string | null | undefined) {
  const v = (status || '').toLowerCase();
  if (v === 'success') return <span className="badge" style={{ background: 'var(--tint-success)', color: 'var(--tint-success-fg)' }}>Success</span>;
  if (v === 'failed' || v === 'error') return <span className="badge" style={{ background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)' }}>Failed</span>;
  if (!status) return <span className="badge badge-gray">—</span>;
  return <span className="badge badge-gray">{String(status)}</span>;
}

export function ReportsManagePanel({ reports, currentContext, refreshKey, onLoadSaved, onOpenSchedule }: {
  reports: { key: string; title: string }[];
  currentContext: { report_type: string; title: string; params: Record<string, unknown> } | null;
  refreshKey: number;
  onLoadSaved: (row: SavedRow) => void;
  onOpenSchedule: (row: ScheduleRow | null) => void;
}): JSX.Element {
  const { toast } = useToast();
  const [saved, setSaved] = useState<SavedRow[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(false);

  // Save-current-view inline input
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState('');

  // Per-schedule "run now" in-flight guard
  const [runningId, setRunningId] = useState<number | null>(null);

  const titleFor = useCallback((key: string): string => {
    const hit = reports.find(r => r.key === key);
    return hit ? hit.title : key;
  }, [reports]);

  // Sequence guard: rapid refreshKey bumps / action-triggered reloads can resolve out
  // of order — only the newest load() is allowed to commit its results.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    const [s, sch, hist] = await Promise.all([
      api('/reports/saved').then(d => (d?.data as SavedRow[]) || []).catch(() => [] as SavedRow[]),
      api('/reports/schedules').then(d => (d?.data as ScheduleRow[]) || []).catch(() => [] as ScheduleRow[]),
      api('/reports/history?limit=50').then(d => (d?.data as HistoryRow[]) || []).catch(() => [] as HistoryRow[]),
    ]);
    if (seq !== loadSeq.current) return; // superseded by a newer load()
    setSaved(s);
    setSchedules(sch);
    setHistory(hist);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  // ── Saved Views actions ──
  const submitSave = useCallback(async () => {
    if (!currentContext) return;
    const name = saveName.trim();
    if (!name) { toast('Enter a name for this view', 'error'); return; }
    try {
      await api('/reports/saved', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, report_type: currentContext.report_type, params: currentContext.params }),
      });
      toast('Saved view created', 'success');
      setSaving(false);
      setSaveName('');
      load();
    } catch (e) {
      toast((e as Error).message || 'Save failed', 'error');
    }
  }, [currentContext, saveName, toast, load]);

  const deleteSaved = useCallback(async (id: number) => {
    try {
      await api(`/reports/saved/${id}`, { method: 'DELETE' });
      toast('Saved view deleted', 'success');
      load();
    } catch (e) {
      toast((e as Error).message || 'Delete failed', 'error');
    }
  }, [toast, load]);

  // ── Schedule actions ──
  const runNow = useCallback(async (id: number) => {
    setRunningId(id);
    try {
      const r = await api(`/reports/schedules/${id}/run`, { method: 'POST' });
      toast((r && (r.message as string)) || 'Schedule run started', 'success');
      load();
    } catch (e) {
      toast((e as Error).message || 'Run failed', 'error');
    } finally {
      setRunningId(null);
    }
  }, [toast, load]);

  const toggleEnabled = useCallback(async (row: ScheduleRow) => {
    try {
      await api(`/reports/schedules/${row.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !row.enabled }),
      });
      load();
    } catch (e) {
      toast((e as Error).message || 'Update failed', 'error');
    }
  }, [toast, load]);

  const deleteSchedule = useCallback(async (id: number) => {
    if (!window.confirm('Delete this scheduled report?')) return;
    try {
      await api(`/reports/schedules/${id}`, { method: 'DELETE' });
      toast('Schedule deleted', 'success');
      load();
    } catch (e) {
      toast((e as Error).message || 'Delete failed', 'error');
    }
  }, [toast, load]);

  const linkBtn: React.CSSProperties = { fontSize: 'var(--text-xs)', color: 'var(--blue)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 };
  const dangerBtn: React.CSSProperties = { fontSize: 'var(--text-xs)', color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14, alignItems: 'start' }}>

      {/* ── Panel 1 — Saved Views ── */}
      <div style={CARD}>
        <div style={PANEL_HEAD}>
          <div style={TITLE}>Saved Views</div>
          <button className="btn" disabled={!currentContext} onClick={() => { setSaveName(''); setSaving(v => !v); }}>
            ＋ Save current view
          </button>
        </div>
        {saving && currentContext && (
          <div style={{ ...ROW, justifyContent: 'flex-start', gap: 8 }}>
            <input
              className="input"
              autoFocus
              placeholder={`Name for "${currentContext.title}"`}
              value={saveName}
              onChange={e => setSaveName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitSave(); if (e.key === 'Escape') { setSaving(false); setSaveName(''); } }}
              style={{ flex: 1, minWidth: 0 }}
            />
            <button className="btn btn-primary" onClick={submitSave}>Save</button>
            <button className="btn" onClick={() => { setSaving(false); setSaveName(''); }}>Cancel</button>
          </div>
        )}
        {saved.length === 0 && !loading ? (
          <EmptyState title="No saved views" message="Configure a report above, then save its filters here for one-click reuse." />
        ) : (
          <div>
            {saved.map(row => (
              <div key={row.id} style={ROW}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ ...TITLE, fontSize: 'var(--text-base)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.name}</div>
                  <div style={{ ...MUTED, marginTop: 2 }}>{titleFor(row.report_type)}</div>
                </div>
                <div style={{ display: 'flex', gap: 12, flexShrink: 0 }}>
                  <button style={linkBtn} onClick={() => onLoadSaved(row)}>Load</button>
                  <button style={dangerBtn} onClick={() => deleteSaved(row.id)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Panel 2 — Scheduled Reports ── */}
      <div style={CARD}>
        <div style={PANEL_HEAD}>
          <div style={TITLE}>Scheduled Reports</div>
          <button className="btn" onClick={() => onOpenSchedule(null)}>＋ New schedule</button>
        </div>
        {schedules.length === 0 && !loading ? (
          <EmptyState title="No scheduled reports" message="Schedule any report to be generated and emailed daily, weekly or monthly." />
        ) : (
          <div>
            {schedules.map(row => (
              <div key={row.id} style={{ ...ROW, flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ ...TITLE, fontSize: 'var(--text-base)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.name}</span>
                      <span className="badge" style={row.enabled
                        ? { background: 'var(--tint-success)', color: 'var(--tint-success-fg)' }
                        : { background: 'var(--surface-subtle)', color: 'var(--text-muted)' }}>
                        {row.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>
                    <div style={{ ...MUTED, marginTop: 2 }}>{titleFor(row.report_type)} · {cadenceSummary(row)}</div>
                  </div>
                  {statusBadge(row.last_status)}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
                  <span style={MUTED}>{(row.recipients?.length ?? 0)} recipient{(row.recipients?.length ?? 0) === 1 ? '' : 's'}</span>
                  <span style={MUTED}>Next: {fmtDate(row.next_run_at)}</span>
                  <span style={{ flex: 1 }} />
                  <button style={linkBtn} onClick={() => onOpenSchedule(row)}>Edit</button>
                  <button style={linkBtn} disabled={runningId === row.id} onClick={() => runNow(row.id)}>
                    {runningId === row.id ? 'Running…' : 'Run now'}
                  </button>
                  <button style={linkBtn} onClick={() => toggleEnabled(row)}>{row.enabled ? 'Disable' : 'Enable'}</button>
                  <button style={dangerBtn} onClick={() => deleteSchedule(row.id)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Panel 3 — Report History ── */}
      <div style={{ ...CARD, gridColumn: '1 / -1' }}>
        <div style={PANEL_HEAD}>
          <div style={TITLE}>Report History</div>
          <span style={MUTED}>{history.length} recent</span>
        </div>
        {history.length === 0 && !loading ? (
          <EmptyState title="No report history" message="Generated and scheduled reports will appear here with their status." />
        ) : (
          <div style={{ maxHeight: 320, overflow: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Report</th>
                  <th>Format</th>
                  <th>Trigger</th>
                  <th style={{ textAlign: 'right' }}>Rows</th>
                  <th>Status</th>
                  <th>When</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {history.map(row => (
                  <tr key={row.id}>
                    <td style={{ fontWeight: 600 }}>{titleFor(row.report_type)}</td>
                    <td><span className="badge badge-gray">{String(row.format ?? '—').toUpperCase()}</span></td>
                    <td style={MUTED}>{String(row.trigger_type ?? '—')}</td>
                    <td style={{ textAlign: 'right', fontSize: 'var(--text-sm)' }}>{String(row.row_count ?? '—')}</td>
                    <td>{statusBadge(row.status)}</td>
                    <td style={MUTED}>{fmtDate(row.created_at)}</td>
                    <td style={MUTED}>{String(row.generated_by ?? '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
