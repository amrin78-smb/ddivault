'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

interface SearchResult {
  type: 'ip' | 'subnet' | 'supernet' | 'scope' | 'lease' | 'dns';
  title: string;
  subtitle: string;
  status: string | null;
  meta: Record<string, any>;
}

const TYPE_ICON: Record<string, string> = {
  ip: '⬤', subnet: '⬡', supernet: '◈', scope: '⬢', lease: '◉', dns: '◎',
};
const TYPE_COLOR: Record<string, string> = {
  ip: '#2563eb', subnet: '#16a34a', supernet: '#7c3aed',
  scope: '#ca8a04', lease: '#0891b2', dns: '#ea580c',
};
const TYPE_LABEL: Record<string, string> = {
  ip: 'IP Address', subnet: 'Subnet', supernet: 'Supernet',
  scope: 'DHCP Scope', lease: 'DHCP Lease', dns: 'DNS Record',
};

export default function GlobalSearch({ onNavigate }: { onNavigate?: (tab: any) => void }) {
  const [query, setQuery]     = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen]       = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropRef  = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const search = useCallback(async (q: string) => {
    if (q.length < 2) { setResults([]); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const d   = await res.json();
      setResults(d.data || []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (query.length < 2) { setResults([]); setOpen(false); return; }
    timerRef.current = setTimeout(() => { search(query); setOpen(true); }, 300);
    return () => clearTimeout(timerRef.current);
  }, [query, search]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Keyboard shortcut: / to focus
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault(); inputRef.current?.focus();
      }
      if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const handleKey = (e: React.KeyboardEvent) => {
    if (!open || !results.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, results.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setSelected(s => Math.max(s - 1, -1)); }
    if (e.key === 'Enter' && selected >= 0) { handleSelect(results[selected]); }
  };

  const handleSelect = (result: SearchResult) => {
    setOpen(false);
    setQuery('');
    if (!onNavigate) return;
    const tabMap: Record<string, string> = {
      ip: 'ipam', subnet: 'ipam', supernet: 'ipam',
      scope: 'scopes', lease: 'scopes', dns: 'dns',
    };
    onNavigate(tabMap[result.type] || 'dashboard');
  };

  return (
    <div ref={dropRef} style={{ position: 'relative', flex: 1, maxWidth: 480 }}>
      <div style={{ position: 'relative' }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.4)', pointerEvents: 'none' }}>
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => { if (results.length) setOpen(true); }}
          onKeyDown={handleKey}
          placeholder='Search IP, MAC, hostname, subnet... (press / to focus)'
          style={{
            width: '100%',
            padding: '8px 40px 8px 36px',
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 10,
            color: '#fff',
            fontSize: 13,
            outline: 'none',
            transition: 'all 0.15s',
          }}
          onFocusCapture={e => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.12)';
            e.currentTarget.style.borderColor = 'rgba(200,16,46,0.6)';
          }}
          onBlurCapture={e => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)';
          }}
        />
        {query && (
          <button onClick={() => { setQuery(''); setResults([]); setOpen(false); }}
            style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>
            ×
          </button>
        )}
        {!query && (
          <kbd style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
            background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 4, padding: '1px 6px', fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>
            /
          </kbd>
        )}
      </div>

      {/* Results dropdown */}
      {open && (query.length >= 2) && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', left: 0, right: 0,
          background: '#fff', border: '1px solid var(--border)',
          borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.15)',
          zIndex: 9999, overflow: 'hidden', maxHeight: 420, overflowY: 'auto',
        }}>
          {loading && (
            <div style={{ padding: '14px 16px', fontSize: 13, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 12, height: 12, border: '2px solid var(--border)', borderTopColor: '#C8102E', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              Searching...
            </div>
          )}

          {!loading && results.length === 0 && (
            <div style={{ padding: '14px 16px', fontSize: 13, color: 'var(--text-muted)' }}>
              No results for <strong>"{query}"</strong>
            </div>
          )}

          {!loading && results.length > 0 && (
            <>
              {/* Group by type */}
              {(['ip','lease','subnet','supernet','scope','dns'] as const).map(type => {
                const group = results.filter(r => r.type === type);
                if (!group.length) return null;
                return (
                  <div key={type}>
                    <div style={{ padding: '8px 16px 4px', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', background: 'var(--bg-primary)' }}>
                      {TYPE_LABEL[type]}
                    </div>
                    {group.map((r, i) => {
                      const globalIdx = results.indexOf(r);
                      return (
                        <div key={i}
                          onClick={() => handleSelect(r)}
                          style={{
                            padding: '10px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12,
                            background: selected === globalIdx ? '#f8fafc' : '#fff',
                            borderBottom: '1px solid var(--border-light)',
                          }}
                          onMouseEnter={() => setSelected(globalIdx)}
                        >
                          <span style={{ color: TYPE_COLOR[type], fontSize: 16, flexShrink: 0 }}>{TYPE_ICON[type]}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 13, fontFamily: 'monospace', color: 'var(--text-primary)' }}>{r.title}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.subtitle}</div>
                          </div>
                          {r.status && (
                            <span className={`badge ${r.status === 'Active' ? 'badge-green' : r.status === 'dhcp' ? 'badge-blue' : 'badge-gray'}`} style={{ fontSize: 10, flexShrink: 0 }}>
                              {r.status}
                            </span>
                          )}
                          {r.type === 'scope' && r.meta.percent_used !== undefined && (
                            <span style={{ fontSize: 11, color: parseFloat(r.meta.percent_used) > 80 ? '#dc2626' : 'var(--text-muted)', fontWeight: 600, flexShrink: 0 }}>
                              {parseFloat(r.meta.percent_used).toFixed(0)}%
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              <div style={{ padding: '8px 16px', fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-primary)', textAlign: 'center' }}>
                {results.length} results · ↑↓ to navigate · Enter to select
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
