'use client';

import { RangePreset, RangeValue, isCustomRangeInverted } from './reportTypes';

const PRESETS: { key: RangePreset; label: string; days?: number }[] = [
  { key: '24h', label: '24h', days: 1 },
  { key: '7d', label: '7d', days: 7 },
  { key: '30d', label: '30d', days: 30 },
  { key: '90d', label: '90d', days: 90 },
  { key: 'custom', label: 'Custom' },
  { key: 'asof', label: 'As of' },
];

// today as YYYY-MM-DD (local)
function todayStr(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function minStr(maxDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() - maxDays);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function DateRangePicker({
  value,
  onChange,
  maxDays,
}: {
  value: RangeValue;
  onChange: (v: RangeValue) => void;
  maxDays?: number;
}): JSX.Element {
  const minAttr = maxDays != null ? minStr(maxDays) : undefined;
  const maxAttr = todayStr();
  const inverted = isCustomRangeInverted(value);

  const setPreset = (preset: RangePreset) => onChange({ ...value, preset });

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      {PRESETS.map(p => {
        const tooWide = maxDays != null && p.days != null && p.days > maxDays;
        return (
          <button
            key={p.key}
            className={value.preset === p.key ? 'btn btn-primary' : 'btn'}
            disabled={tooWide}
            style={tooWide ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
            onClick={() => !tooWide && setPreset(p.key)}
          >
            {p.label}
          </button>
        );
      })}

      {value.preset === 'custom' && (
        <>
          <input
            className="input"
            type="date"
            value={value.from || ''}
            min={minAttr}
            max={value.to || maxAttr}
            title="From"
            onChange={e => onChange({ ...value, from: e.target.value })}
          />
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>to</span>
          <input
            className="input"
            type="date"
            value={value.to || ''}
            min={value.from || minAttr}
            max={maxAttr}
            title="To"
            onChange={e => onChange({ ...value, to: e.target.value })}
          />
          {inverted && (
            <span style={{ color: 'var(--tint-danger-fg, var(--primary))', fontSize: 'var(--text-sm)' }}>
              Start date must be on or before end date.
            </span>
          )}
        </>
      )}

      {value.preset === 'asof' && (
        <input
          className="input"
          type="date"
          value={value.asOf || ''}
          min={minAttr}
          max={maxAttr}
          title="As of"
          onChange={e => onChange({ ...value, asOf: e.target.value })}
        />
      )}
    </div>
  );
}
