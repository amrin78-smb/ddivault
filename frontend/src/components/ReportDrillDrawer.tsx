'use client';

import { useEffect, useState } from 'react';
import { ChartSpec, RangeValue, rangeToParams } from './reportTypes';
import { TrendChart } from './TrendChart';

interface DrillFact { label: string; value: string | number; color?: string }
interface DrillColumn { key: string; label: string; align?: string }
interface DrillTable { title: string; columns: DrillColumn[]; rows: Record<string, unknown>[] }
interface DrillPayload {
  title: string;
  subtitle?: string;
  facts?: DrillFact[];
  charts?: ChartSpec[];
  tables?: DrillTable[];
}

export function ReportDrillDrawer({
  open,
  entity,
  id,
  range,
  onClose,
}: {
  open: boolean;
  entity: string | null;
  id: string | number | null;
  range?: RangeValue;
  onClose: () => void;
}): JSX.Element | null {
  const [data, setData] = useState<DrillPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !entity || id === null || id === undefined) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    // Carry the report's current date range so the drill scope-utilization history
    // window (and its dynamic title) matches the report the row came from. Missing
    // range → no params, and the backend falls back to its 90d default.
    const qs = range ? new URLSearchParams(rangeToParams(range)).toString() : '';
    fetch(`/api/reports/drill/${entity}/${id}${qs ? `?${qs}` : ''}`)
      .then(async res => {
        if (!res.ok) {
          let msg = `HTTP ${res.status}`;
          try {
            msg = (await res.json()).error || msg;
          } catch {
            /* non-JSON error body */
          }
          throw new Error(msg);
        }
        return res.json();
      })
      .then((d: DrillPayload) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError((e as Error).message || 'Failed to load details');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, entity, id, range]);

  if (!open || !entity || id === null || id === undefined) return null;

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 999 }}
      />
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          height: '100vh',
          width: 'min(560px, 92vw)',
          background: 'var(--bg-card)',
          borderLeft: '1px solid var(--border)',
          boxShadow: 'var(--shadow-lg, -4px 0 24px rgba(0,0,0,0.18))',
          zIndex: 1000,
          overflow: 'auto',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 12,
            padding: '16px 18px',
            borderBottom: '1px solid var(--border-light)',
            position: 'sticky',
            top: 0,
            background: 'var(--bg-card)',
            zIndex: 5,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-primary)' }}>
              {data?.title || `${entity} detail`}
            </div>
            {data?.subtitle && (
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 2 }}>
                {data.subtitle}
              </div>
            )}
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
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {loading && (
            <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', padding: '24px 0', textAlign: 'center' }}>
              Loading…
            </div>
          )}

          {error && (
            <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
              Could not load details: {error}
            </div>
          )}

          {!loading && !error && data && (
            <>
              {/* Facts grid */}
              {data.facts && data.facts.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, alignItems: 'start' }}>
                  {data.facts.map((f, i) => {
                    // Long values (e.g. a fully-qualified server hostname) need room to
                    // breathe — let the card span two columns so it isn't crushed next to
                    // the compact utilization/percentage cards.
                    const isLong = String(f.value).length > 16;
                    return (
                      <div
                        key={i}
                        style={{
                          background: 'var(--bg-primary)',
                          border: '1px solid var(--border)',
                          borderRadius: 10,
                          padding: '10px 14px',
                          minWidth: 0,
                          gridColumn: isLong ? 'span 2' : undefined,
                        }}
                      >
                        <div
                          title={String(f.value)}
                          style={{
                            fontSize: 'var(--text-xl)',
                            fontWeight: 800,
                            color: f.color || 'var(--text-primary)',
                            lineHeight: 1.15,
                            overflowWrap: 'anywhere',
                            wordBreak: 'break-word',
                          }}
                        >
                          {f.value}
                        </div>
                        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 4 }}>{f.label}</div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Charts */}
              {data.charts && data.charts.map((c, i) => <TrendChart key={i} chart={c} />)}

              {/* Tables */}
              {data.tables && data.tables.map((t, ti) => (
                <div key={ti}>
                  {t.title && (
                    <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
                      {t.title}
                    </div>
                  )}
                  <div style={{ maxHeight: 320, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
                    <table className="data-table">
                      <thead>
                        <tr>
                          {(t.columns || []).map(c => (
                            <th key={c.key} style={{ textAlign: (c.align as 'left' | 'right' | 'center') || 'left' }}>
                              {c.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(t.rows || []).map((row, ri) => (
                          <tr key={ri}>
                            {(t.columns || []).map(c => (
                              <td
                                key={c.key}
                                style={{ textAlign: (c.align as 'left' | 'right' | 'center') || 'left', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}
                              >
                                {String(row[c.key] ?? '—')}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}

              {(!data.facts || data.facts.length === 0) &&
                (!data.charts || data.charts.length === 0) &&
                (!data.tables || data.tables.length === 0) && (
                  <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>No detail available.</div>
                )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
