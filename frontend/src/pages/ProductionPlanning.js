import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../services/api';
import * as XLSX from 'xlsx';

/**
 * Production Planning (rebuilt 2026-10-18 — routes/Production-planning.routes.js)
 *
 * 1. What customers are waiting for: products with pending sales orders in
 *    Busy vs stock → "add to plan".
 * 2. The plan: one or more products with quantities.
 * 3. Result: every recipe level from Busy's BOMs (correct batch sizes,
 *    semi-finished items netted against their own stock), each material's
 *    live stock, quantity on open POs, pending sales orders and what is
 *    still short — i.e. what to produce and what to buy.
 */
const fmt = (n, dp = 3) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: dp }));
const STATUS_COLOR = {
  'In stock': '#065f46', 'Covered by open PO': '#1d4ed8', 'Short — buy': '#b91c1c', 'Overhead (not stocked)': '#6b7280',
};

export default function ProductionPlanningPage() {
  const [demand, setDemand] = useState(null);
  const [demandError, setDemandError] = useState('');
  const [demandFilter, setDemandFilter] = useState('');

  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef(null);

  const [lines, setLines] = useState([]); // [{ bomCode, name, qty }]
  const [netSemi, setNetSemi] = useState(true);
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [shortOnly, setShortOnly] = useState(false);

  useEffect(() => {
    api.get('/procurement/production-planning/demand')
      .then((r) => setDemand(r.data?.data || []))
      .catch((e) => setDemandError(e.response?.data?.error || 'Could not read sales orders from Busy'));
  }, []);

  const onSearch = (value) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length < 2) { setSuggestions([]); return; }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await api.get('/procurement/production-planning/products', { params: { search: value.trim() } });
        setSuggestions(r.data?.data || []);
      } catch { setSuggestions([]); } finally { setSearching(false); }
    }, 300);
  };

  const addLine = (bomCode, name, qty = '') => {
    setLines((cur) => (cur.some((l) => l.bomCode === bomCode)
      ? cur.map((l) => (l.bomCode === bomCode ? { ...l, qty: qty || l.qty } : l))
      : [...cur, { bomCode, name, qty: qty === '' ? '' : String(qty) }]));
    setPlan(null);
  };
  const pick = (s) => { addLine(s.bomCode, s.bomName); setQuery(''); setSuggestions([]); };
  const setQty = (bomCode, qty) => { setLines((cur) => cur.map((l) => (l.bomCode === bomCode ? { ...l, qty } : l))); setPlan(null); };
  const removeLine = (bomCode) => { setLines((cur) => cur.filter((l) => l.bomCode !== bomCode)); setPlan(null); };

  const generate = useCallback(async () => {
    const valid = lines.filter((l) => Number(l.qty) > 0);
    if (!valid.length) { setError('Add at least one product with a quantity'); return; }
    setLoading(true);
    setError('');
    setPlan(null);
    try {
      const r = await api.post('/procurement/production-planning/plan', {
        lines: valid.map((l) => ({ bomCode: l.bomCode, qty: Number(l.qty) })), netSemiFinishedStock: netSemi,
      });
      setPlan(r.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to generate plan');
    } finally {
      setLoading(false);
    }
  }, [lines, netSemi]);

  const demandRows = useMemo(() => (demand || [])
    .filter((d) => !demandFilter || d.itemName.toLowerCase().includes(demandFilter.toLowerCase()))
    .slice(0, 200), [demand, demandFilter]);

  const materials = plan ? plan.materials.filter((m) => !shortOnly || m.shortage > 0) : [];
  const shortCount = plan ? plan.materials.filter((m) => m.shortage > 0).length : 0;

  const exportExcel = () => {
    if (!plan) return;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(plan.products.map((p) => ({
      Product: p.itemName, Recipe: p.bomName, 'Plan qty': p.planQty, Unit: p.unitName, Stock: p.stock,
      'Pending sales orders': p.pendingSalesOrders, 'Sales order gap': p.salesOrderGap,
    }))), 'Products');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(plan.semiFinished.map((s) => ({
      Level: s.level, Item: s.itemName, Unit: s.unitName, Required: s.required, Stock: s.stock, 'To produce': s.toProduce,
      'Used in': s.usedIn.join(', '),
    }))), 'Semi-finished');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(plan.materials.map((m) => ({
      Item: m.itemName, Group: m.group, Unit: m.unitName, Required: m.required, Stock: m.stock, 'Central Stores': m.centralStores,
      'Pending PO': m.pendingPO, 'Open POs': m.poNos.join(', '), 'Pending sales orders': m.pendingSalesOrders,
      Shortage: m.shortage, Status: m.status, 'Used in': m.usedIn.join(', '),
    }))), 'Materials');
    XLSX.writeFile(wb, `ProductionPlan_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Production Planning</h1>
          <p className="page-subtitle">Sales orders → production plan → every recipe level from Busy → what to make and what to buy</p>
        </div>
      </div>

      {/* 1. Demand */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Customers waiting — pending sales orders vs stock</h3>
          <input className="form-input" style={{ maxWidth: 260 }} placeholder="Filter products" value={demandFilter} onChange={(e) => setDemandFilter(e.target.value)} />
        </div>
        {demandError && <div className="alert alert-error">{demandError}</div>}
        {!demand && !demandError && <div style={{ color: '#6b7280', fontSize: 13 }}>Reading sales orders from Busy…</div>}
        {demand && (
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            <table className="data-table" style={{ fontSize: 13 }}>
              <thead><tr><th>Product</th><th style={{ textAlign: 'right' }}>Pending sales orders</th><th style={{ textAlign: 'right' }}>In stock</th><th style={{ textAlign: 'right' }}>To produce</th><th /></tr></thead>
              <tbody>
                {demandRows.map((d) => (
                  <tr key={d.itemCode}>
                    <td>{d.itemName}<div style={{ fontSize: 11, color: '#6b7280' }}>{d.salesOrders} order(s) · {d.unitName}</div></td>
                    <td style={{ textAlign: 'right' }}>{fmt(d.pendingSalesOrders)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(d.stock)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: d.toProduce > 0 ? '#b91c1c' : '#065f46' }}>{fmt(d.toProduce)}</td>
                    <td>
                      <button type="button" className="btn btn-secondary btn-sm" disabled={!(d.toProduce > 0)}
                        onClick={() => addLine(d.bomCode, d.bomName, Math.ceil(d.toProduce))}>Add to plan</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 2. Plan */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Plan</h3>
        <div style={{ position: 'relative', maxWidth: 520, marginBottom: 10 }}>
          <input className="form-input" value={query} onChange={(e) => onSearch(e.target.value)} placeholder="Add a product — type its name…" />
          {searching && <div style={{ position: 'absolute', right: 10, top: 9, fontSize: 12, color: '#9ca3af' }}>Searching…</div>}
          {suggestions.length > 0 && (
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', maxHeight: 260, overflowY: 'auto' }}>
              {suggestions.map((s) => (
                <div key={s.bomCode} onClick={() => pick(s)} style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid #f3f4f6' }}>
                  <div style={{ fontWeight: 600 }}>{s.bomName}</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>
                    makes {s.itemName}{s.batchQty !== 1 ? ` · batch of ${s.batchQty}` : ''} · {s.components} component(s){s.otherBoms ? ` · ${s.otherBoms} other recipe(s) for this item` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {lines.length === 0 ? <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 10 }}>No products yet — add from the list above or search.</div> : (
          <table className="data-table" style={{ fontSize: 13, marginBottom: 10, maxWidth: 720 }}>
            <thead><tr><th>Product (recipe)</th><th style={{ width: 160 }}>Quantity to make</th><th /></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.bomCode}>
                  <td>{l.name}</td>
                  <td><input type="number" min="0" step="any" className="form-input" value={l.qty} onChange={(e) => setQty(l.bomCode, e.target.value)} /></td>
                  <td><button type="button" className="btn btn-danger btn-sm" onClick={() => removeLine(l.bomCode)}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={generate} disabled={loading || !lines.length}>{loading ? 'Planning…' : 'Generate plan'}</button>
          <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={netSemi} onChange={(e) => { setNetSemi(e.target.checked); setPlan(null); }} />
            Use semi-finished stock first (only make the shortfall)
          </label>
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

      {/* 3. Result */}
      {plan && (
        <>
          {plan.warnings.length > 0 && (
            <div className="alert" style={{ background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', marginBottom: 12, fontSize: 13 }}>
              {plan.warnings.map((w) => <div key={w}>⚠ {w}</div>)}
            </div>
          )}
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>Products</h3>
              <button className="btn btn-secondary btn-sm" onClick={exportExcel}>Export to Excel</button>
            </div>
            <table className="data-table" style={{ fontSize: 13 }}>
              <thead><tr><th>Product</th><th style={{ textAlign: 'right' }}>Plan</th><th style={{ textAlign: 'right' }}>In stock</th><th style={{ textAlign: 'right' }}>Pending sales orders</th><th style={{ textAlign: 'right' }}>Still owed to customers</th></tr></thead>
              <tbody>
                {plan.products.map((p) => (
                  <tr key={p.bomCode}>
                    <td>{p.itemName}<div style={{ fontSize: 11, color: '#6b7280' }}>recipe: {p.bomName}{p.batchQty !== 1 ? ` (batch ${p.batchQty})` : ''}</div></td>
                    <td style={{ textAlign: 'right' }}>{fmt(p.planQty)} {p.unitName}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(p.stock)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(p.pendingSalesOrders)}</td>
                    <td style={{ textAlign: 'right', color: p.salesOrderGap > p.planQty ? '#b91c1c' : undefined }}>{fmt(p.salesOrderGap)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {plan.semiFinished.length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Semi-finished — make in-house</h3>
              <table className="data-table" style={{ fontSize: 13 }}>
                <thead><tr><th>Level</th><th>Item</th><th style={{ textAlign: 'right' }}>Required</th><th style={{ textAlign: 'right' }}>In stock</th><th style={{ textAlign: 'right' }}>To produce</th><th>Used in</th></tr></thead>
                <tbody>
                  {plan.semiFinished.map((s) => (
                    <tr key={s.itemCode}>
                      <td>{s.level}</td>
                      <td>{s.itemName}<div style={{ fontSize: 11, color: '#6b7280' }}>{s.unitName}</div></td>
                      <td style={{ textAlign: 'right' }}>{fmt(s.required)}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(s.stock)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: s.toProduce > 0 ? '#b45309' : '#065f46' }}>{fmt(s.toProduce)}</td>
                      <td style={{ fontSize: 12 }}>{s.usedIn.join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>Materials — {shortCount} short</h3>
              <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={shortOnly} onChange={(e) => setShortOnly(e.target.checked)} /> Only show shortages
              </label>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table" style={{ fontSize: 13 }}>
                <thead>
                  <tr>
                    <th>Material</th><th style={{ textAlign: 'right' }}>Required</th><th style={{ textAlign: 'right' }}>In stock</th>
                    <th style={{ textAlign: 'right' }}>Central Stores</th><th style={{ textAlign: 'right' }}>On open POs</th>
                    <th style={{ textAlign: 'right' }}>Pending sales orders</th><th style={{ textAlign: 'right' }}>Short</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {materials.map((m) => (
                    <tr key={m.itemCode} style={{ opacity: m.overhead ? 0.65 : 1 }}>
                      <td>{m.itemName}<div style={{ fontSize: 11, color: '#6b7280' }}>{m.group} · {m.unitName} · used in {m.usedIn.join(', ')}</div></td>
                      <td style={{ textAlign: 'right' }}>{fmt(m.required)}</td>
                      <td style={{ textAlign: 'right' }}>{m.overhead ? '—' : fmt(m.stock)}</td>
                      <td style={{ textAlign: 'right' }}>{m.overhead ? '—' : fmt(m.centralStores)}</td>
                      <td style={{ textAlign: 'right' }} title={m.poNos.join(', ')}>{m.pendingPO ? fmt(m.pendingPO) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{m.pendingSalesOrders ? fmt(m.pendingSalesOrders) : '—'}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: m.shortage > 0 ? '#b91c1c' : undefined }}>{m.shortage == null ? '—' : fmt(m.shortage)}</td>
                      <td style={{ color: STATUS_COLOR[m.status], fontWeight: 600, whiteSpace: 'nowrap' }}>{m.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
              Short = required − stock − quantity on approved open POs. Overheads (labour, power, fuel, water) are recipe costs, not stock, so they're never short.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
