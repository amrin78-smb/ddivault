'use client';

import { useState, useEffect } from 'react';
import { useToast } from '@/components/Toast';
import type { ScheduleRow } from './reportTypes';

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

const LABEL: React.CSSProperties = { fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6, display: 'block' };
const FIELD: React.CSSProperties = { display: 'flex', flexDirection: 'column' };

type Format = 'pdf' | 'csv';
type Cadence = 'daily' | 'weekly' | 'monthly';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// Split a textarea value (newline OR comma separated) into trimmed, non-empty emails.
function parseRecipients(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

export function ReportScheduleModal({
  open,
  initial,
  reports,
  defaults,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: ScheduleRow | null;
  reports: { key: string; title: string }[];
  defaults?: { report_type?: string; params?: Record<string, unknown>; name?: string } | null;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element | null {
  const { toast } = useToast();

  const [name, setName] = useState('');
  const [reportType, setReportType] = useState('');
  const [format, setFormat] = useState<Format>('pdf');
  const [cadence, setCadence] = useState<Cadence>('weekly');
  const [hour, setHour] = useState(7);
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [recipients, setRecipients] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // (Re)initialise the form each time the modal is opened or the target changes.
  useEffect(() => {
    if (!open) return;
    if (initial) {
      setName(initial.name ?? '');
      setReportType(initial.report_type ?? '');
      setFormat(initial.format === 'csv' ? 'csv' : 'pdf');
      setCadence(initial.cadence ?? 'weekly');
      setHour(typeof initial.hour === 'number' ? initial.hour : 7);
      setDayOfWeek(typeof initial.day_of_week === 'number' ? initial.day_of_week : 1);
      setDayOfMonth(typeof initial.day_of_month === 'number' ? initial.day_of_month : 1);
      setRecipients(Array.isArray(initial.recipients) ? initial.recipients.join('\n') : '');
      setEnabled(initial.enabled !== false);
      setParams(initial.params ?? {});
    } else {
      setName(defaults?.name ?? '');
      setReportType(defaults?.report_type ?? '');
      setFormat('pdf');
      setCadence('weekly');
      setHour(7);
      setDayOfWeek(1);
      setDayOfMonth(1);
      setRecipients('');
      setEnabled(true);
      setParams(defaults?.params ?? {});
    }
    setError(null);
    setSaving(false);
  }, [open, initial, defaults]);

  if (!open) return null;

  const paramEntries = Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== '');

  const submit = async () => {
    const trimmedName = name.trim();
    const parsedRecipients = parseRecipients(recipients);

    let msg: string | null = null;
    if (!trimmedName) msg = 'Name is required.';
    else if (!reportType) msg = 'Select a report type.';
    else if (parsedRecipients.length === 0) msg = 'Add at least one recipient email.';
    else {
      const bad = parsedRecipients.find(e => !EMAIL_RE.test(e));
      if (bad) msg = `Invalid email address: ${bad}`;
    }

    if (msg) {
      setError(msg);
      toast(msg, 'error');
      return;
    }
    setError(null);

    const body = {
      name: trimmedName,
      report_type: reportType,
      params,
      format,
      cadence,
      hour,
      day_of_week: cadence === 'weekly' ? dayOfWeek : null,
      day_of_month: cadence === 'monthly' ? dayOfMonth : null,
      recipients: parsedRecipients,
      enabled,
    };

    setSaving(true);
    try {
      const path = initial ? `/reports/schedules/${initial.id}` : '/reports/schedules';
      await api(path, {
        method: initial ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      toast('Schedule saved', 'success');
      onSaved();
      onClose();
    } catch (e) {
      toast((e as Error).message || 'Failed to save schedule', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 999 }}
      />
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(520px, 94vw)',
          maxHeight: '90vh',
          overflow: 'auto',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-lg, 0 12px 40px rgba(0,0,0,0.28))',
          zIndex: 1000,
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-light)',
            position: 'sticky',
            top: 0,
            background: 'var(--bg-card)',
            zIndex: 5,
          }}
        >
          <div style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-primary)' }}>
            {initial ? 'Edit Scheduled Report' : 'New Scheduled Report'}
          </div>
          <button
            aria-label="Close"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-muted)',
              fontSize: 24,
              lineHeight: 1,
              padding: 0,
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={FIELD}>
            <label style={LABEL}>Name</label>
            <input
              className="input"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Weekly Subnet Utilization"
            />
          </div>

          <div style={FIELD}>
            <label style={LABEL}>Report type</label>
            <select className="input" value={reportType} onChange={e => setReportType(e.target.value)}>
              <option value="">Select a report…</option>
              {reports.map(r => (
                <option key={r.key} value={r.key}>{r.title}</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={FIELD}>
              <label style={LABEL}>Format</label>
              <select className="input" value={format} onChange={e => setFormat(e.target.value as Format)}>
                <option value="pdf">PDF</option>
                <option value="csv">CSV</option>
              </select>
            </div>
            <div style={FIELD}>
              <label style={LABEL}>Cadence</label>
              <select className="input" value={cadence} onChange={e => setCadence(e.target.value as Cadence)}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={FIELD}>
              <label style={LABEL}>Time (server local)</label>
              <select className="input" value={hour} onChange={e => setHour(Number(e.target.value))}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>{`${pad2(h)}:00`}</option>
                ))}
              </select>
            </div>

            {cadence === 'weekly' && (
              <div style={FIELD}>
                <label style={LABEL}>Day of week</label>
                <select className="input" value={dayOfWeek} onChange={e => setDayOfWeek(Number(e.target.value))}>
                  {DOW.map((d, i) => (
                    <option key={i} value={i}>{d}</option>
                  ))}
                </select>
              </div>
            )}

            {cadence === 'monthly' && (
              <div style={FIELD}>
                <label style={LABEL}>Day of month</label>
                <select className="input" value={dayOfMonth} onChange={e => setDayOfMonth(Number(e.target.value))}>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div style={FIELD}>
            <label style={LABEL}>Recipients</label>
            <textarea
              className="input"
              value={recipients}
              onChange={e => setRecipients(e.target.value)}
              placeholder="one email per line, or comma-separated"
              rows={3}
              style={{ resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>

          {/* Read-only note of the params carried by this schedule */}
          <div
            style={{
              fontSize: 'var(--text-sm)',
              color: 'var(--text-muted)',
              background: 'var(--bg-primary)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '10px 12px',
            }}
          >
            {paramEntries.length > 0
              ? `Filters: ${paramEntries.map(([k, v]) => `${k}=${String(v)}`).join(', ')}`
              : 'No filters — the full report will be delivered.'}
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-base)', color: 'var(--text-primary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
            Enabled
          </label>

          {error && (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--tint-danger-fg, var(--primary))' }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '14px 20px',
            borderTop: '1px solid var(--border-light)',
            position: 'sticky',
            bottom: 0,
            background: 'var(--bg-card)',
          }}
        >
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </>
  );
}
