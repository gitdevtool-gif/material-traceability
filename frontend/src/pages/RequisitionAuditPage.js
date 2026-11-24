import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';

/**
 * Requisition Audit (2026-10-22) — every requisition line from every factory
 * with the stock position at the time it was requested (from Busy's ledger),
 * the full approval → quotes → award → PO → receipt chain, and red flags.
 * Built for an auditor: filter to the findings, open the chain, export CSV.
 */
const fmtKes = (n) => (n == null ? '—' : `KES ${Number(n).toLocaleString('en-KE', { maximumFractionDigits: 0 })}`);
const fmtQty = (n) => (n == null ? '—' : Number(n).toLocaleString('en-KE', { maximumFractionDigits: 2 }));
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const SEV_BADGE = { high: 'badge-red', medium: 'badge-orange', low: 'badge-gray' };
const OUTCOME_BADGE = {
  Open: 'badge-gray', Held: 'badge-yellow', Rejected: 'badge-gray', Sourcing: 'badge-blue', Awarded: 'badge-purple',
  'PO raised': 'badge-teal', 'Part received': 'badge-yellow', Received: 'badge-green',
};
// Where company stock stood against the reorder levels on the request date.
const POSITION_BADGE = {
  out: 'badge-red', critical: 'badge-red', reorder: 'badge-yellow', ok: 'badge-blue', above_max: 'badge-orange', no_use: 'badge-purple',
};
const POSITION_HELP = {
  out: 'Nothing in stock company-wide — order justified',
  critical: 'Below the minimum level — order urgently justified',
  reorder: 'At or below the reorder level — an order was due',
  ok: 'Above the reorder level — an order was not yet due',
  above_max: 'Above the maximum level — no order should have been needed',
  no_use: 'No use in the 6 months before — no reorder level applies',
};
const LEVELS = [
  { value: 'flagged', label: 'Findings (high + medium)' },
  { value: 'high', label: 'High only' },
  { value: 'any', label: 'Any flag incl. notes' },
  { value: 'all', label: 'All lines' },
];
const PAGE = 100;

function fyStart() {
  const d = new Date();
  return `${d.getMonth() >= 4 ? d.getFullYear() : d.getFullYear() - 1}-05-01`;
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function RequisitionAuditPage() {
  const navigate = useNavigate();
  const [from, setFrom] = useState(fyStart());
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [level, setLevel] = useState('flagged');
  const [factory, setFactory] = useState('');
  const [flagCode, setFlagCode] = useState('');
  const [outcome, setOutcome] = useState('');
  const [posFilter, setPosFilter] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(null);
  const [shown, setShown] = useState(PAGE);

  const load = useCallback((refresh) => {
    setLoading(true);
    setError('');
    api.get('/reports/requisition-audit', { params: { from, to, ...(refresh ? { refresh: 1 } : {}) } })
      .then((r) => setData(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not build the audit report'))
      .finally(() => setLoading(false));
  }, [from, to]);
  useEffect(() => { load(false); }, [load]);
  useEffect(() => { setShown(PAGE); }, [level, factory, flagCode, outcome, posFilter, search, data]);

  const rows = useMemo(() => {
    if (!data) return [];
    const s = search.trim().toUpperCase();
    return data.lines.filter((l) => {
      if (factory && l.factory !== factory) return false;
      if (outcome && l.outcome !== outcome) return false;
      if (posFilter && l.position?.code !== posFilter) return false;
      if (flagCode && !l.flags.some((f) => f.code === flagCode)) return false;
      if (level === 'flagged' && l.risk < 2) return false;
      if (level === 'high' && l.risk < 3) return false;
      if (level === 'any' && l.flags.length === 0) return false;
      if (s && ![l.reqNo, l.item, l.busyItem, l.factory, l.award?.supplier, l.po?.poNo, l.raisedBy]
        .some((v) => String(v || '').toUpperCase().includes(s))) return false;
      return true;
    }).sort((a, b) => b.risk - a.risk || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }, [data, factory, outcome, posFilter, flagCode, level, search]);

  const exportCsv = () => {
    const head = ['Requisition', 'Date', 'Factory', 'Item', 'Busy item', 'Unit', 'Busy unit', 'Qty asked', 'Qty approved', 'Outcome',
      'Factory stock then', 'Central Stores stock then', 'Company stock then', 'Avg use / month (3 months before)', 'Months of cover then',
      'Reorder level then', 'Min level then', 'Max level then', 'Position then',
      'If bought: months of use', 'If bought: lasts until', 'If bought: above max by',
      'Company stock now', 'Reorder level today', 'Max level today', 'Raised by', 'Central Stores', 'Ops', 'RFQ', 'Suppliers quoted', 'Lowest quote ex VAT', 'Lowest supplier',
      'Awarded supplier', 'Awarded qty', 'Awarded price', 'Awarded value ex VAT', 'Awarded by', 'PO', 'PO date', 'PO qty', 'PO price', 'PO value',
      'Received', 'Days to PO', 'Days to receipt', 'Risk', 'Flags'];
    const lines = rows.map((l) => [
      l.reqNo, l.date, l.factory, l.item, l.busyItem, l.unit, l.busyUnit, l.qty, l.approvedQty, l.outcome,
      l.stockAtRequest?.own, l.stockAtRequest?.central, l.stockAtRequest?.company, l.avgMonthlyUse, l.monthsCover,
      l.levelsThen?.reorderLevel, l.levelsThen?.minLevel, l.levelsThen?.maxLevel, l.position?.label,
      l.ifBought?.months, l.ifBought?.lastsUntil, l.ifBought?.overMax,
      l.stockNow?.company, l.levelsToday?.reorderLevel, l.levelsToday?.maxLevel, l.raisedBy,
      l.centralStores ? `${l.centralStores.decision} ${l.centralStores.qty ?? ''} by ${l.centralStores.by || ''}` : '',
      l.ops ? `${l.ops.decision} ${l.ops.qty ?? ''} by ${l.ops.by || ''}` : '',
      l.rfq?.number, l.quotes?.priced, l.quotes?.lowestExVat, l.quotes?.lowestSupplier,
      l.award?.supplier, l.award?.qty, l.award?.unitPrice, l.award?.valueExVat, l.award?.by,
      l.po?.poNo, l.po?.date ? String(l.po.date).slice(0, 10) : '', l.po?.qty, l.po?.price, l.po?.value,
      l.received?.qty, l.cycleDays.toPo, l.cycleDays.toReceipt,
      ['', 'low', 'medium', 'high'][l.risk], l.flags.map((f) => `${f.label}: ${f.text}`).join(' | '),
    ]);
    const csv = [head, ...lines].map((r) => r.map(csvCell).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
    a.download = `requisition-audit_${data.from}_${data.to}${factory ? `_${factory}` : ''}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const s = data?.summary;
  const factories = s ? s.byFactory.map((f) => f.factory).sort() : [];
  const outcomes = data ? [...new Set(data.lines.map((l) => l.outcome))] : [];
  const flagList = data ? Object.entries(data.flagInfo).filter(([code]) => s.flagCounts[code]) : [];

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Requisition Audit</h1>
          <p className="page-subtitle">
            Every requisition from every factory, with the stock held when it was requested, who approved it, how it was sourced, and what was received.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-outline" onClick={exportCsv} disabled={!data || rows.length === 0}>⬇ Export CSV ({rows.length})</button>
          <button className="btn btn-secondary" onClick={() => load(true)} disabled={loading}>{loading ? 'Building…' : 'Refresh'}</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ fontSize: 13 }}>From <input type="date" className="form-input" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }} /></label>
        <label style={{ fontSize: 13 }}>To <input type="date" className="form-input" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }} /></label>
        {data && <span style={{ fontSize: 12, color: '#6b7280' }}>Built {new Date(data.generatedAt).toLocaleTimeString('en-KE')} from Busy</span>}
        <button type="button" className="btn btn-sm btn-outline" style={{ marginLeft: 'auto' }} onClick={() => setShowHelp(!showHelp)}>
          {showHelp ? 'Hide' : 'ℹ️ How to read this report'}
        </button>
      </div>

      {showHelp && (
        <div className="card" style={{ marginBottom: 16, fontSize: 13, lineHeight: 1.6 }}>
          <strong>Stock then</strong> is Busy&apos;s stock at the start of the day the requisition was raised — in the requesting
          factory&apos;s store, in Central Stores, and company-wide (all stores).<br />
          <strong>Reorder level then</strong> uses the same formula as the Reorder Levels page, worked out from the 6 months of use
          <em> before</em> the request: reorder level = highest monthly use × lead time; the maximum adds the usual order quantity.<br />
          <strong>Position then</strong> compares company stock with those levels:{' '}
          {Object.entries(POSITION_HELP).map(([k, v]) => (
            <span key={k} style={{ display: 'inline-block', marginRight: 10 }}>
              <span className={`badge ${POSITION_BADGE[k]}`}>{{ out: 'Out of stock', critical: 'Below minimum', reorder: 'Below reorder level', ok: 'Above reorder level', above_max: 'Above maximum', no_use: 'No use in 6 months' }[k]}</span> {v}
            </span>
          ))}<br />
          <strong>Findings</strong> are <span className="badge badge-red">high</span> / <span className="badge badge-orange">medium</span> when
          money was committed (the line went to RFQ, award or PO), and <span className="badge badge-gray">low</span> notes when the request
          was not acted on yet. Quantities are compared only when the requisition unit matches Busy&apos;s unit for the item.
        </div>
      )}

      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}
      {loading && !data && <div className="card" style={{ padding: 32, textAlign: 'center', color: '#6b7280' }}>Rebuilding stock positions from Busy for every requisition…</div>}

      {s && (
        <>
          <div className="stats-row">
            <div className="stat-card"><div className="stat-value">{s.requisitions}</div><div className="stat-label">Requisitions · {s.lines} lines</div></div>
            <div className="stat-card"><div className="stat-value" style={{ color: '#b91c1c' }}>{s.highRiskLines}</div><div className="stat-label">High-risk lines</div></div>
            <div className="stat-card"><div className="stat-value" style={{ color: '#c2410c' }}>{s.flaggedLines}</div><div className="stat-label">Lines with findings · {fmtKes(s.flaggedValue)}</div></div>
            <div className="stat-card"><div className="stat-value" style={{ fontSize: 22 }}>{fmtKes(s.value)}</div><div className="stat-label">Committed (awards / POs, ex VAT)</div></div>
            <div className="stat-card"><div className="stat-value" style={{ fontSize: 22 }}>{s.avgDays.toPo ?? '—'} d</div><div className="stat-label">Avg request → PO · {s.avgDays.toReceipt ?? '—'} d to receipt</div></div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Red flags <span style={{ fontWeight: 400, fontSize: 12, color: '#6b7280' }}>— click to filter</span></div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {flagList.map(([code, info]) => {
                const c = s.flagCounts[code];
                const active = flagCode === code;
                return (
                  <button key={code} type="button" onClick={() => { setFlagCode(active ? '' : code); if (!active) setLevel('any'); }}
                    style={{ border: active ? '2px solid #1d4ed8' : '1px solid #e5e7eb', background: '#fff', borderRadius: 8, padding: '6px 10px', cursor: 'pointer', textAlign: 'left' }}>
                    <span className={`badge ${SEV_BADGE[info.severity]}`} style={{ marginRight: 6 }}>{c.total}</span>
                    <span style={{ fontSize: 13 }}>{info.label}</span>
                    {(c.high > 0 && c.high !== c.total) && <span style={{ fontSize: 11, color: '#b91c1c', marginLeft: 6 }}>{c.high} high</span>}
                    {(c.low > 0 && c.low !== c.total) && <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 6 }}>{c.low} notes</span>}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="card" style={{ padding: 0, overflowX: 'auto', marginBottom: 16 }}>
            <table className="data-table" style={{ fontSize: 13 }}>
              <thead>
                <tr>
                  <th>Factory / store</th><th style={{ textAlign: 'right' }}>Requisitions</th><th style={{ textAlign: 'right' }}>Lines</th>
                  <th style={{ textAlign: 'right' }}>Rejected</th><th style={{ textAlign: 'right' }}>On a PO</th><th style={{ textAlign: 'right' }}>Received</th>
                  <th style={{ textAlign: 'right' }}>Findings</th><th style={{ textAlign: 'right' }}>High</th><th style={{ textAlign: 'right' }}>Committed</th><th style={{ textAlign: 'right' }}>Committed with findings</th>
                </tr>
              </thead>
              <tbody>
                {s.byFactory.map((f) => (
                  <tr key={f.factory} onClick={() => setFactory(factory === f.factory ? '' : f.factory)}
                    style={{ cursor: 'pointer', background: factory === f.factory ? '#eff6ff' : undefined }}>
                    <td><strong>{f.factory}</strong></td>
                    <td style={{ textAlign: 'right' }}>{f.requisitions}</td>
                    <td style={{ textAlign: 'right' }}>{f.lines}</td>
                    <td style={{ textAlign: 'right' }}>{f.rejected}</td>
                    <td style={{ textAlign: 'right' }}>{f.ordered}</td>
                    <td style={{ textAlign: 'right' }}>{f.received}</td>
                    <td style={{ textAlign: 'right', color: f.flagged ? '#c2410c' : undefined }}>{f.flagged} <span style={{ color: '#9ca3af' }}>({Math.round((f.flagged / f.lines) * 100)}%)</span></td>
                    <td style={{ textAlign: 'right', color: f.high ? '#b91c1c' : undefined, fontWeight: f.high ? 600 : 400 }}>{f.high}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{fmtKes(f.value)}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{fmtKes(f.flaggedValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="form-input" placeholder="Search requisition, item, supplier, PO, person…" value={search}
              onChange={(e) => setSearch(e.target.value)} style={{ width: 300, maxWidth: '100%' }} />
            <select className="form-input" value={level} onChange={(e) => setLevel(e.target.value)} style={{ width: 210 }}>
              {LEVELS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
            </select>
            <select className="form-input" value={factory} onChange={(e) => setFactory(e.target.value)} style={{ width: 180 }}>
              <option value="">All factories / stores</option>
              {factories.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <select className="form-input" value={outcome} onChange={(e) => setOutcome(e.target.value)} style={{ width: 150 }}>
              <option value="">Any outcome</option>
              {outcomes.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <select className="form-input" value={posFilter} onChange={(e) => setPosFilter(e.target.value)} style={{ width: 190 }} title="Stock position against the reorder levels on the request date">
              <option value="">Any stock position</option>
              <option value="out">Out of stock</option>
              <option value="critical">Below minimum</option>
              <option value="reorder">Below reorder level</option>
              <option value="ok">Above reorder level</option>
              <option value="above_max">Above maximum</option>
              <option value="no_use">No use in 6 months</option>
            </select>
            {(factory || flagCode || outcome || posFilter || search || level !== 'flagged') && (
              <button className="btn btn-sm btn-outline" onClick={() => { setFactory(''); setFlagCode(''); setOutcome(''); setPosFilter(''); setSearch(''); setLevel('flagged'); }}>Clear filters</button>
            )}
            <span style={{ fontSize: 13, color: '#6b7280', marginLeft: 'auto' }}>{rows.length} line{rows.length !== 1 ? 's' : ''}</span>
          </div>

          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table className="data-table" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th rowSpan={2}>Requisition</th><th rowSpan={2}>Factory</th><th rowSpan={2}>Item</th><th rowSpan={2} style={{ textAlign: 'right' }}>Asked</th>
                  <th colSpan={3} style={{ textAlign: 'center', borderBottom: '1px solid #e5e7eb' }} title="Busy stock at the start of the requisition date">Stock when requested</th>
                  <th rowSpan={2} style={{ textAlign: 'right' }} title="Reorder level on the request date (min – max)">Reorder level then</th>
                  <th rowSpan={2}>Position then</th>
                  <th rowSpan={2} style={{ textAlign: 'right' }} title="Average monthly use, 3 complete months before the request">Use / month</th>
                  <th rowSpan={2} title="Company stock then + quantity asked, at the average use of the time">If bought, lasts</th>
                  <th rowSpan={2} style={{ textAlign: 'right' }}>Company stock now</th>
                  <th rowSpan={2}>Award / PO</th><th rowSpan={2}>Outcome</th><th rowSpan={2}>Findings</th>
                </tr>
                <tr>
                  <th style={{ textAlign: 'right' }}>This factory</th><th style={{ textAlign: 'right' }}>Central Stores</th><th style={{ textAlign: 'right' }}>Company</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={15} style={{ textAlign: 'center', padding: 28, color: '#6b7280' }}>No lines match these filters</td></tr>
                )}
                {rows.slice(0, shown).map((l) => {
                  const isOpen = open === l.requisitionItemId;
                  return (
                    <React.Fragment key={l.requisitionItemId}>
                      <tr onClick={() => setOpen(isOpen ? null : l.requisitionItemId)} style={{ cursor: 'pointer', borderLeft: `4px solid ${['transparent', '#d1d5db', '#fb923c', '#dc2626'][l.risk]}` }}>
                        <td><strong>{l.reqNo}</strong><div style={{ color: '#6b7280' }}>{fmtDate(l.date)}</div></td>
                        <td>{l.factory}</td>
                        <td style={{ maxWidth: 220 }}>{l.item}{l.busyItem && l.busyItem !== l.item && <div style={{ color: '#6b7280' }}>{l.busyItem}</div>}</td>
                        <td style={{ textAlign: 'right' }}>
                          {fmtQty(l.qty)} {l.unit || ''}
                          {l.approvedQty != null && l.approvedQty !== l.qty && <div style={{ color: '#6b7280' }}>appr. {fmtQty(l.approvedQty)}</div>}
                          {!l.unitOk && <div style={{ color: '#b45309' }} title="Requisition unit differs from Busy's unit">Busy: {l.busyUnit}</div>}
                        </td>
                        <td style={{ textAlign: 'right' }}>{l.stockAtRequest ? fmtQty(l.stockAtRequest.own) : '—'}</td>
                        <td style={{ textAlign: 'right' }}>{l.stockAtRequest ? fmtQty(l.stockAtRequest.central) : '—'}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{l.stockAtRequest ? fmtQty(l.stockAtRequest.company) : '—'}</td>
                        <td style={{ textAlign: 'right' }}>
                          {l.levelsThen && !(l.position?.code === 'no_use') ? (
                            <>
                              <strong>{fmtQty(l.levelsThen.reorderLevel)}</strong>
                              <div style={{ color: '#6b7280' }}>{fmtQty(l.levelsThen.minLevel)} – {fmtQty(l.levelsThen.maxLevel)}</div>
                            </>
                          ) : '—'}
                        </td>
                        <td>{l.position ? <span className={`badge ${POSITION_BADGE[l.position.code]}`} title={POSITION_HELP[l.position.code]}>{l.position.label}</span> : '—'}</td>
                        <td style={{ textAlign: 'right' }}>{fmtQty(l.avgMonthlyUse)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {l.ifBought ? (
                            <>
                              <strong style={{ color: l.ifBought.overMax > 0 ? '#c2410c' : undefined }}>{fmtQty(l.ifBought.months)} months</strong>
                              <div style={{ color: '#6b7280' }}>until {fmtDate(l.ifBought.lastsUntil)}</div>
                            </>
                          ) : '—'}
                        </td>
                        <td style={{ textAlign: 'right' }}>{l.stockNow ? fmtQty(l.stockNow.company) : '—'}</td>
                        <td>
                          {l.award ? <div>{l.award.supplier}</div> : null}
                          {l.po ? <div style={{ color: '#6b7280' }}>{l.po.poNo}{l.po.value != null ? ` · ${fmtKes(l.po.value)}` : ''}</div> : l.award ? <div style={{ color: '#6b7280' }}>{fmtKes(l.award.valueExVat)}</div> : '—'}
                        </td>
                        <td><span className={`badge ${OUTCOME_BADGE[l.outcome] || 'badge-gray'}`}>{l.outcome}</span></td>
                        <td style={{ maxWidth: 260 }}>
                          {l.flags.map((f) => <span key={f.code} className={`badge ${SEV_BADGE[f.severity]}`} style={{ marginRight: 4, marginBottom: 2, display: 'inline-block' }} title={f.text}>{f.label}</span>)}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={15} style={{ background: '#f9fafb', padding: '14px 20px' }}>
                            <AuditDetail l={l} onTrace={() => navigate(`/procurement/trace/${l.requisitionId}`)} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
            {rows.length > shown && (
              <div style={{ padding: 12, textAlign: 'center' }}>
                <button className="btn btn-outline btn-sm" onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more of {rows.length - shown}</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function AuditDetail({ l, onTrace }) {
  const step = (label, done, info) => (
    <div style={{ display: 'flex', gap: 10, padding: '4px 0', fontSize: 12 }}>
      <span style={{ width: 16, color: done === false ? '#dc2626' : done ? '#059669' : '#9ca3af' }}>{done === false ? '✕' : done ? '●' : '○'}</span>
      <span style={{ width: 130, fontWeight: 600 }}>{label}</span>
      <span style={{ color: '#374151' }}>{info || '—'}</span>
    </div>
  );
  const at = l.stockAtRequest;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20 }}>
      <div>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Approval &amp; sourcing chain</div>
        {step('Raised', true, `${fmtDate(l.date)} by ${l.raisedBy || '—'} · ${l.source}`)}
        {step('Central Stores', l.centralStores ? l.centralStores.decision !== 'Rejected' : null,
          l.centralStores && `${l.centralStores.decision}${l.centralStores.qty != null ? ` ${fmtQty(l.centralStores.qty)}` : ''} by ${l.centralStores.by || '—'} · ${fmtDate(l.centralStores.at)}${l.centralStores.reason ? ` — ${l.centralStores.reason}` : ''}`)}
        {step('Ops Manager', l.ops ? l.ops.decision !== 'Rejected' : null,
          l.ops && `${l.ops.decision}${l.ops.qty != null ? ` ${fmtQty(l.ops.qty)}` : ''} by ${l.ops.by || '—'} · ${fmtDate(l.ops.at)}${l.ops.reason ? ` — ${l.ops.reason}` : ''}`)}
        {l.hold && step('Held', null, `${l.hold.reason} · ${fmtDate(l.hold.at)}`)}
        {step('RFQ', !!l.rfq, l.rfq && `${l.rfq.number} sent to ${l.rfq.suppliersAsked} supplier(s) by ${l.rfq.by || '—'} · ${fmtDate(l.rfq.sentAt)}`)}
        {step('Quotes', l.quotes ? l.quotes.priced > 0 : null, l.quotes && `${l.quotes.priced} priced quote(s)${l.quotes.lowestExVat != null ? ` · lowest ${fmtQty(l.quotes.lowestExVat)} ex VAT (${l.quotes.lowestSupplier})` : ''}`)}
        {step('Award', !!l.award, l.award && `${l.award.supplier} · ${fmtQty(l.award.qty)} @ ${fmtQty(l.award.unitPrice)}${l.award.vatInclusive ? ' incl. VAT' : ''} = ${fmtKes(l.award.valueExVat)} ex VAT · by ${l.award.by || '—'} ${fmtDate(l.award.at)}`)}
        {step('Busy PO', l.po ? l.po.found : null, l.po && (l.po.found
          ? `${l.po.poNo} · ${fmtDate(l.po.date)} · ${fmtQty(l.po.qty)} @ ${fmtQty(l.po.price)} = ${fmtKes(l.po.value)}${l.po.approved ? '' : ' · not approved in Busy'}`
          : `${l.po.poNo} — not found in Busy`))}
        {step('Received', l.received ? l.received.qty > 0 : null, l.received && `${fmtQty(l.received.qty)} received${l.received.pending > 0 ? `, ${fmtQty(l.received.pending)} pending` : ''}${l.received.firstAt ? ` · first ${fmtDate(l.received.firstAt)}` : ''}`)}
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
          Days: to Ops {l.cycleDays.toOps ?? '—'} · to PO {l.cycleDays.toPo ?? '—'} · to receipt {l.cycleDays.toReceipt ?? '—'}
        </div>
      </div>
      <div>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Stock position (Busy, {l.busyUnit || l.unit || ''})</div>
        <table className="data-table" style={{ fontSize: 12, background: '#fff' }}>
          <thead><tr><th /><th style={{ textAlign: 'right' }}>{l.factory}</th><th style={{ textAlign: 'right' }}>Central Stores</th><th style={{ textAlign: 'right' }}>Company</th></tr></thead>
          <tbody>
            <tr><td>When requested ({fmtDate(l.date)})</td><td style={{ textAlign: 'right' }}>{fmtQty(at?.own)}</td><td style={{ textAlign: 'right' }}>{fmtQty(at?.central)}</td><td style={{ textAlign: 'right' }}>{fmtQty(at?.company)}</td></tr>
            <tr><td>Now</td><td style={{ textAlign: 'right' }}>{fmtQty(l.stockNow?.own)}</td><td style={{ textAlign: 'right' }}>{fmtQty(l.stockNow?.central)}</td><td style={{ textAlign: 'right' }}>{fmtQty(l.stockNow?.company)}</td></tr>
          </tbody>
        </table>
        <div style={{ fontWeight: 600, margin: '12px 0 6px' }}>
          Reorder picture {l.position && <span className={`badge ${POSITION_BADGE[l.position.code]}`} style={{ marginLeft: 6 }}>{l.position.label}</span>}
        </div>
        {l.position && <div style={{ fontSize: 12, color: '#374151', marginBottom: 6 }}>{POSITION_HELP[l.position.code]}.</div>}
        <table className="data-table" style={{ fontSize: 12, background: '#fff' }}>
          <thead><tr><th /><th style={{ textAlign: 'right' }}>Minimum</th><th style={{ textAlign: 'right' }}>Reorder level</th><th style={{ textAlign: 'right' }}>Maximum</th></tr></thead>
          <tbody>
            <tr>
              <td>On the request date{l.levelsThen && <div style={{ color: '#6b7280' }}>lead time {l.levelsThen.leadWeeks} wk{l.levelsThen.leadDefaulted ? ' (default)' : ''}</div>}</td>
              <td style={{ textAlign: 'right' }}>{fmtQty(l.levelsThen?.minLevel)}</td>
              <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtQty(l.levelsThen?.reorderLevel)}</td>
              <td style={{ textAlign: 'right' }}>{fmtQty(l.levelsThen?.maxLevel)}</td>
            </tr>
            <tr>
              <td>Today (Reorder Levels page)</td>
              <td style={{ textAlign: 'right' }}>{fmtQty(l.levelsToday?.minLevel)}</td>
              <td style={{ textAlign: 'right' }}>{fmtQty(l.levelsToday?.reorderLevel)}</td>
              <td style={{ textAlign: 'right' }}>{fmtQty(l.levelsToday?.maxLevel)}</td>
            </tr>
            {(l.levelsToday?.busyReorder || l.levelsToday?.busyMin || l.levelsToday?.busyMax) ? (
              <tr>
                <td>Set in Busy (item critical levels)</td>
                <td style={{ textAlign: 'right' }}>{fmtQty(l.levelsToday.busyMin)}</td>
                <td style={{ textAlign: 'right' }}>{fmtQty(l.levelsToday.busyReorder)}</td>
                <td style={{ textAlign: 'right' }}>{fmtQty(l.levelsToday.busyMax)}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {l.useMonths && (
          <div style={{ fontSize: 12, color: '#374151', marginTop: 8 }}>
            Company use in the 6 months before ({l.busyUnit || l.unit || ''}):
            <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 54, marginTop: 4 }}>
              {(() => {
                const top = Math.max(1, ...l.useMonths.map((m) => m.qty));
                return l.useMonths.map((m) => (
                  <div key={m.month} style={{ flex: 1, textAlign: 'center' }} title={`${m.month}: ${fmtQty(m.qty)}`}>
                    <div style={{ height: Math.max(2, (m.qty / top) * 34), background: '#93c5fd', borderRadius: 2 }} />
                    <div style={{ fontSize: 10, color: '#6b7280' }}>{m.month.slice(5)}/{m.month.slice(2, 4)}</div>
                    <div style={{ fontSize: 10 }}>{fmtQty(m.qty)}</div>
                  </div>
                ));
              })()}
            </div>
            Average of the last 3 months: <strong>{fmtQty(l.avgMonthlyUse)}</strong> / month
            {l.monthsCover != null && <> · company stock then covered <strong>{l.monthsCover}</strong> months</>}
            {l.ifBought && (
              <div style={{ marginTop: 4 }}>
                <strong>Looking ahead:</strong> if the {fmtQty(l.qty)} asked is bought, stock reaches {fmtQty(l.ifBought.stockAfter)} —
                enough for <strong>{fmtQty(l.ifBought.months)} months</strong>, lasting until about <strong>{fmtDate(l.ifBought.lastsUntil)}</strong>
                {l.ifBought.overMax > 0 && <span style={{ color: '#c2410c' }}> ({fmtQty(l.ifBought.overMax)} above the maximum level)</span>}.
              </div>
            )}
            {l.group && <> · group {l.group}</>}
          </div>
        )}
        {!l.unitOk && (
          <div style={{ fontSize: 12, color: '#b45309', marginTop: 6 }}>
            Asked in &quot;{l.unit}&quot; but Busy counts this item in &quot;{l.busyUnit}&quot; — the quantity can&apos;t be compared with stock.
          </div>
        )}
        {l.flags.length > 0 && (
          <>
            <div style={{ fontWeight: 600, margin: '12px 0 6px' }}>Findings</div>
            {l.flags.map((f) => (
              <div key={f.code} style={{ fontSize: 12, marginBottom: 4 }}>
                <span className={`badge ${SEV_BADGE[f.severity]}`} style={{ marginRight: 6 }}>{f.severity}</span>
                <strong>{f.label}:</strong> {f.text}
              </div>
            ))}
          </>
        )}
        <button className="btn btn-outline btn-sm" style={{ marginTop: 10 }} onClick={onTrace}>🧭 Full order trace (GRN, bill, payment)</button>
      </div>
    </div>
  );
}
