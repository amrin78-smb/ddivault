'use client';

import { useState, useRef } from 'react';
import { useToast } from '@/components/Toast';

interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
  return res.json();
}

// ── CSV parser ────────────────────────────────────────────────
function parseCSV(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''));
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    if (values.every(v => !v)) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
    rows.push(row);
  }
  return rows;
}

// ── Template CSV content ──────────────────────────────────────
const TEMPLATE_CSV = `network,prefix_length,name,gateway,vlan_id,site,description,owner,location,supernet
192.168.1.0,24,Office LAN,192.168.1.1,10,HQ,Main office network,IT Team,Building A,192.168.0.0/16
192.168.2.0,24,WiFi Guest,192.168.2.1,20,HQ,Guest wireless network,IT Team,Building A,192.168.0.0/16
10.10.0.0,24,Server VLAN,10.10.0.1,100,DC1,Production servers,Infra Team,Data Center,10.0.0.0/8
10.20.0.0,24,Management,10.20.0.1,999,DC1,Network management,NOC Team,Data Center,10.0.0.0/8
`;

function downloadTemplate() {
  const blob = new Blob([TEMPLATE_CSV], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'ddivault-subnet-import-template.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// ── Main component ────────────────────────────────────────────
export default function IPAMImport({ onDone }: { onDone: () => void }) {
  const [step, setStep]         = useState<'upload' | 'preview' | 'done'>('upload');
  const [rows, setRows]         = useState<Record<string, string>[]>([]);
  const [result, setResult]     = useState<ImportResult | null>(null);
  const [loading, setLoading]   = useState(false);
  const [fileName, setFileName] = useState('');
  const fileRef                 = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleFile = (file: File) => {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target?.result as string;
      const parsed = parseCSV(text);
      if (!parsed.length) { toast('No valid rows found in file', 'error'); return; }
      setRows(parsed);
      setStep('preview');
    };
    reader.readAsText(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith('.csv') || file.name.endsWith('.txt'))) handleFile(file);
    else toast('Please upload a CSV file', 'error');
  };

  const runImport = async () => {
    setLoading(true);
    try {
      const res = await api('/ipam/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
      setResult(res);
      setStep('done');
      toast(`Imported ${res.imported} subnets`, 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const COLUMNS = ['network', 'prefix_length', 'name', 'gateway', 'vlan_id', 'site', 'description', 'owner', 'supernet'];

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)',
        width: step === 'preview' ? 900 : 560,
        maxHeight: '85vh', overflow: 'auto', padding: 28,
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)' }}>Import Subnets</div>
            <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', marginTop: 3 }}>
              {step === 'upload' && 'Upload a CSV file to bulk import subnets into IPAM'}
              {step === 'preview' && `Preview ${rows.length} subnet${rows.length !== 1 ? 's' : ''} from ${fileName}`}
              {step === 'done' && 'Import complete'}
            </div>
          </div>
          <button onClick={onDone} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-xl)', color: 'var(--text-muted)', lineHeight: 1 }}>×</button>
        </div>

        {/* Step: Upload */}
        {step === 'upload' && (
          <>
            {/* Template download */}
            <div style={{
              background: '#eff6ff', border: '1px solid #bfdbfe',
              borderRadius: 10, padding: '14px 18px', marginBottom: 20,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div>
                <div style={{ fontSize: 'var(--text-base)', fontWeight: 600, color: '#1d4ed8' }}>📋 Download Template</div>
                <div style={{ fontSize: 'var(--text-sm)', color: '#3b82f6', marginTop: 2 }}>
                  Get the CSV template with all supported columns and example data
                </div>
              </div>
              <button onClick={downloadTemplate} style={{
                padding: '8px 16px', background: '#2563eb', color: '#fff',
                border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 'var(--text-base)', fontWeight: 500,
                whiteSpace: 'nowrap',
              }}>
                ⬇ Download Template
              </button>
            </div>

            {/* Column reference */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Template Columns
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {[
                  { col: 'network', req: true,  desc: 'Network address (e.g. 192.168.1.0)' },
                  { col: 'prefix_length', req: true, desc: 'CIDR prefix (e.g. 24)' },
                  { col: 'name', req: false, desc: 'Friendly name' },
                  { col: 'gateway', req: false, desc: 'Default gateway IP' },
                  { col: 'vlan_id', req: false, desc: 'VLAN number' },
                  { col: 'site', req: false, desc: 'Site name or code (from NocVault)' },
                  { col: 'description', req: false, desc: 'Free text description' },
                  { col: 'owner', req: false, desc: 'Owner or team name' },
                  { col: 'location', req: false, desc: 'Physical location' },
                  { col: 'supernet', req: false, desc: 'Parent supernet (e.g. 10.0.0.0/8)' },
                ].map(f => (
                  <div key={f.col} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 10px', background: 'var(--bg-primary)', borderRadius: 6 }}>
                    <code style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: f.req ? 'var(--primary)' : '#2563eb', whiteSpace: 'nowrap', minWidth: 100 }}>{f.col}</code>
                    <div>
                      <span style={{ fontSize: 'var(--text-xs)', background: f.req ? '#fee2e2' : '#dbeafe', color: f.req ? '#b91c1c' : '#1d4ed8', padding: '1px 6px', borderRadius: 10, fontWeight: 600, marginRight: 6 }}>
                        {f.req ? 'REQUIRED' : 'optional'}
                      </span>
                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{f.desc}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Drop zone */}
            <div
              onDragOver={e => e.preventDefault()}
              onDrop={handleDrop}
              onClick={() => fileRef.current?.click()}
              style={{
                border: '2px dashed var(--border)', borderRadius: 12,
                padding: '40px 24px', textAlign: 'center', cursor: 'pointer',
                transition: 'border-color 0.15s, background 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.background = '#fff8f8'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'transparent'; }}
            >
              <div style={{ fontSize: 'var(--text-2xl)', marginBottom: 8 }}>📂</div>
              <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
                Drop your CSV file here
              </div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                or click to browse · CSV files only (.csv)
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.txt"
                style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              />
            </div>
          </>
        )}

        {/* Step: Preview */}
        {step === 'preview' && (
          <>
            {/* Validation summary */}
            <div style={{
              background: '#f0fdf4', border: '1px solid #bbf7d0',
              borderRadius: 10, padding: '12px 16px', marginBottom: 16,
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ fontSize: 'var(--text-lg)' }}>✓</span>
              <div>
                <div style={{ fontSize: 'var(--text-base)', fontWeight: 600, color: '#15803d' }}>{rows.length} subnets ready to import</div>
                <div style={{ fontSize: 'var(--text-sm)', color: '#16a34a' }}>Existing subnets will be updated (not duplicated)</div>
              </div>
            </div>

            {/* Preview table */}
            <div style={{ overflow: 'auto', maxHeight: '45vh', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 20 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
                <thead>
                  <tr>
                    <th style={{ background: 'var(--bg-primary)', padding: '8px 12px', borderBottom: '1px solid var(--border)', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', fontSize: 'var(--text-xs)', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>#</th>
                    {COLUMNS.filter(c => rows[0]?.[c] !== undefined || ['network','prefix_length','name'].includes(c)).map(c => (
                      <th key={c} style={{ background: 'var(--bg-primary)', padding: '8px 12px', borderBottom: '1px solid var(--border)', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', fontSize: 'var(--text-xs)', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                        {c.replace(/_/g, ' ')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-light)' }}>
                      <td style={{ padding: '7px 12px', color: 'var(--text-muted)', fontWeight: 600 }}>{i + 1}</td>
                      {COLUMNS.filter(c => rows[0]?.[c] !== undefined || ['network','prefix_length','name'].includes(c)).map(c => (
                        <td key={c} style={{ padding: '7px 12px', fontFamily: ['network','gateway','supernet'].includes(c) ? 'var(--font-mono)' : 'inherit', color: !row[c] ? 'var(--text-muted)' : 'var(--text-primary)' }}>
                          {row[c] || '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setStep('upload')} style={{ padding: '9px 18px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 'var(--text-base)' }}>
                ← Back
              </button>
              <button onClick={runImport} disabled={loading} style={{ padding: '9px 20px', background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 'var(--text-base)', fontWeight: 600, opacity: loading ? 0.7 : 1 }}>
                {loading ? 'Importing...' : `✓ Import ${rows.length} Subnets`}
              </button>
            </div>
          </>
        )}

        {/* Step: Done */}
        {step === 'done' && result && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>Import Complete</div>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginBottom: 20 }}>
              <div style={{ padding: '12px 24px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10 }}>
                <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, color: '#16a34a' }}>{result.imported}</div>
                <div style={{ fontSize: 'var(--text-sm)', color: '#15803d', fontWeight: 600 }}>Subnets Imported</div>
              </div>
              {result.skipped > 0 && (
                <div style={{ padding: '12px 24px', background: '#fefce8', border: '1px solid #fde68a', borderRadius: 10 }}>
                  <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, color: '#d97706' }}>{result.skipped}</div>
                  <div style={{ fontSize: 'var(--text-sm)', color: '#b45309', fontWeight: 600 }}>Skipped</div>
                </div>
              )}
            </div>
            {result.errors.length > 0 && (
              <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: 12, marginBottom: 16, textAlign: 'left' }}>
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: '#c2410c', marginBottom: 6 }}>Warnings:</div>
                {result.errors.slice(0, 5).map((e, i) => <div key={i} style={{ fontSize: 'var(--text-xs)', color: '#ea580c' }}>{e}</div>)}
              </div>
            )}
            <button onClick={onDone} style={{ padding: '10px 28px', background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 'var(--text-base)', fontWeight: 600 }}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
