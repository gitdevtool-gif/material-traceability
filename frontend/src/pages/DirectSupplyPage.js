import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../services/api';

/**
 * Direct Supply (2026-11-24) — sawdust / offcuts for F8 from standing
 * suppliers. Procurement raises the Busy POs (50–100 t each) from
 * Requisitions; the production side then says which supplier delivers on
 * which day. This page is that plan, side by side with what actually came:
 * trucks booked in at the gate (with weighbridge kg) and tonnes received in
 * Busy (GRN). Plus every PO's ordered / received / balance, live from Busy.
 * Backend: routes/procurement/direct-supply.routes.js.
 */
const fmtQty = (n) => (n == null || n === '' ? '' : Number(n).toLocaleString('en-KE', { maximumFractionDigits: 2 }));
const dayLabel = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short' });
const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + n); return iso(x); };
const mondayOf = (d) => { const x = new Date(`${d}T00:00:00`); const wd = (x.getDay() + 6) % 7; x.setDate(x.getDate() - wd); return iso(x); };
const shortPo = (no) => String(no || '').replace(/---\d{4}-\d{2}$/, '');

export default function DirectSupplyPage() {
  const [items, setItems] = useState([]);
  const [item, setItem] = useState('');
  const [tab, setTab] = useState('plan');
  const [weekStart, setWeekStart] = useState(mondayOf(iso(new Date())));
  const [plan, setPlan] = useState(null);
  const [orders, setOrders] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [editing, setEditing] = useState(null); // { supplier, day, cell }
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [showStale, setShowStale] = useState(false);

  useEffect(() => {
    api.get('/procurement/direct-supply/items')
      .then((r) => {
        const list = (r.data.items || []).filter((i) => i.inBusy);
        setItems(list);
        if (list.length) setItem(list[0].name);
      })
      .catch((e) => setError(e.response?.data?.error || 'Could not load the direct-supply items'));
  }, []);

  const loadPlan = useCallback(() => {
    if (!item) return;
    setLoading(true);
    api.get('/procurement/direct-supply/plan', { params: { item, from: weekStart, to: addDays(weekStart, 6), _: Date.now() } })
      .then((r) => { setPlan(r.data); setError(''); })
      .catch((e) => setError(e.response?.data?.error || 'Could not load the plan'))
      .finally(() => setLoading(false));
  }, [item, weekStart]);

  const loadOrders = useCallback(() => {
    if (!item) return;
    setLoading(true);
    api.get('/procurement/direct-supply/orders', { params: { item, _: Date.now() } })
      .then((r) => { setOrders(r.data); setError(''); })
      .catch((e) => setError(e.response?.data?.error || 'Could not load the orders'))
      .finally(() => setLoading(false));
  }, [item]);

  useEffect(() => { if (tab === 'plan') loadPlan(); else loadOrders(); }, [tab, loadPlan, loadOrders]);

  const cells = useMemo(() => {
    const m = new Map();
    for (const p of plan?.plan || []) m.set(`${p.PlanDate}|${p.SupplierId}`, { plan: p });
    for (const a of plan?.actuals || []) {
      const key = `${a.day}|${a.supplierId}`;
      m.set(key, { ...(m.get(key) || {}), actual: a });
    }
    return m;
  }, [plan]);

  const rows = useMemo(() => {
    if (!plan) return [];
    const active = new Set([...(plan.plan || []).map((p) => p.SupplierId), ...(plan.actuals || []).map((a) => a.supplierId)]);
    return plan.rows.filter((r) => !onlyOpen || r.openBalance > 0 || active.has(r.supplierId));
  }, [plan, onlyOpen]);

  const dayTotals = useMemo(() => (plan?.days || []).map((d) => {
    let planned = 0; let trucks = 0; let suppliers = 0; let gateTrucks = 0; let gateKg = 0; let grn = 0;
    for (const r of plan.rows) {
      const c = cells.get(`${d}|${r.supplierId}`);
      if (c?.plan) { suppliers += 1; planned += Number(c.plan.PlannedQty) || 0; trucks += Number(c.plan.Trucks) || 0; }
      if (c?.actual) { gateTrucks += c.actual.gateTrucks; gateKg += c.actual.gateNetKg; grn += c.actual.grnQty; }
    }
    return { d, planned, trucks, suppliers, gateTrucks, gateKg, grn };
  }), [plan, cells]);

  const unit = plan?.item?.unit || orders?.item?.unit || 't';
  const today = plan?.today || iso(new Date());

  const copyLastWeek = async () => {
    try {
      const r = await api.post('/procurement/direct-supply/plan/copy', { item, fromStart: addDays(weekStart, -7), toStart: weekStart < today ? today : weekStart, days: 7 });
      setMsg(`Copied ${r.data.copied} day(s) from last week${r.data.skipped ? ` — ${r.data.skipped} already planned, left as they were` : ''}.`);
      loadPlan();
    } catch (e) {
      setError(e.response?.data?.error || 'Copy failed');
    }
  };

  // Plain text of the week's plan, for WhatsApp / SMS to the suppliers and the gate.
  const copyText = async () => {
    const lines = [`${plan.item.name} — delivery plan ${dayLabel(plan.days[0])} – ${dayLabel(plan.days[plan.days.length - 1])}`];
    for (const d of plan.days) {
      const who = plan.rows.map((r) => ({ r, c: cells.get(`${d}|${r.supplierId}`)?.plan })).filter((x) => x.c);
      if (!who.length) continue;
      lines.push('', dayLabel(d));
      for (const { r, c } of who) {
        lines.push(`• ${r.supplierName}${c.PlannedQty ? ` — ${fmtQty(c.PlannedQty)} ${unit}` : ''}${c.Trucks ? ` (${c.Trucks} truck${c.Trucks === 1 ? '' : 's'})` : ''}${c.BusyPurOrdNo ? ` on ${shortPo(c.BusyPurOrdNo)}` : ''}${c.Notes ? ` — ${c.Notes}` : ''}`);
      }
    }
    const text = lines.join('\n');
    try { await navigator.clipboard.writeText(text); setMsg('Plan copied — paste it into WhatsApp or SMS.'); } catch { window.prompt('Copy the plan:', text); }
  };

  const todayPlan = plan && plan.days.includes(today)
    ? plan.rows.map((r) => ({ r, c: cells.get(`${today}|${r.supplierId}`) })).filter((x) => x.c?.plan || x.c?.actual)
    : [];

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Direct Supply — delivery plan</h1>
          <p className="page-subtitle">
            Standing suppliers at their standing price, no RFQ. Procurement raises the POs from Requisitions;
            production decides who delivers each day. Arrivals come live from the gate and Busy GRNs.
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        {items.map((i) => (
          <button key={i.name} className={`btn ${item === i.name ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setItem(i.name)}>{i.name}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button className={`btn ${tab === 'plan' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setTab('plan')}>📅 Delivery plan</button>
        <button className={`btn ${tab === 'orders' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setTab('orders')}>📑 Orders &amp; balances</button>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
      {msg && <div className="alert alert-success" style={{ marginBottom: 12 }} onClick={() => setMsg('')}>{msg}</div>}

      {tab === 'plan' && plan && (
        <>
          {todayPlan.length > 0 && (
            <div className="card" style={{ padding: 12, marginBottom: 12, background: '#f0fdf4' }}>
              <strong>Today, {dayLabel(today)}:</strong>{' '}
              {todayPlan.map(({ r, c }) => (
                <span key={r.supplierId} style={{ marginRight: 14, whiteSpace: 'nowrap' }}>
                  {c.plan ? '📌' : '➕'} {r.supplierName}
                  {c.plan?.PlannedQty ? ` ${fmtQty(c.plan.PlannedQty)} ${unit}` : ''}
                  {c.actual?.gateTrucks ? ` · 🚛 ${c.actual.gateTrucks} in` : c.plan ? ' · not arrived yet' : ''}
                </span>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
            <button className="btn btn-secondary" onClick={() => setWeekStart(addDays(weekStart, -7))}>‹ Previous week</button>
            <button className="btn btn-secondary" onClick={() => setWeekStart(mondayOf(iso(new Date())))}>This week</button>
            <button className="btn btn-secondary" onClick={() => setWeekStart(addDays(weekStart, 7))}>Next week ›</button>
            <label style={{ fontSize: 13, marginLeft: 8 }}>
              <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} style={{ marginRight: 4 }} />
              Only suppliers with an open PO (or planned / delivering this week)
            </label>
            <div style={{ flex: 1 }} />
            {plan.canPlan && <button className="btn btn-outline" onClick={copyLastWeek} title="Fill this week with last week's plan; days already planned are not touched">⧉ Same as last week</button>}
            <button className="btn btn-outline" onClick={copyText} disabled={!plan.plan.length}>📋 Copy plan for WhatsApp</button>
            {loading && <span style={{ fontSize: 12, color: '#6b7280' }}>loading…</span>}
          </div>

          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table className="data-table" style={{ fontSize: 12, minWidth: 900 }}>
              <thead>
                <tr>
                  <th style={{ minWidth: 200 }}>Supplier · open on POs</th>
                  {plan.days.map((d) => (
                    <th key={d} style={{ textAlign: 'center', background: d === today ? '#ecfdf5' : undefined, minWidth: 96 }}>{dayLabel(d)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={plan.days.length + 1} style={{ textAlign: 'center', padding: 24, color: '#6b7280' }}>
                    No supplier has an open {plan.item.name} PO. Raise the POs from Requisitions first, or untick the filter.
                  </td></tr>
                )}
                {rows.map((r) => (
                  <tr key={r.supplierId}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{r.supplierName}</div>
                      <div style={{ color: r.openBalance > 0 ? '#047857' : '#9ca3af' }} title={r.openPos.map((p) => `${p.ordno}: ${fmtQty(p.balance)} of ${fmtQty(p.ordered)} left (${p.approvalLabel})`).join('\n')}>
                        {r.openBalance > 0 ? `${fmtQty(r.openBalance)} ${unit} open · ${r.openPos.map((p) => shortPo(p.ordno)).join(', ')}` : 'no open PO'}
                      </div>
                    </td>
                    {plan.days.map((d) => {
                      const c = cells.get(`${d}|${r.supplierId}`) || {};
                      const past = d < today;
                      const came = c.actual && (c.actual.gateTrucks > 0 || c.actual.grnQty > 0);
                      const bg = c.plan ? (came ? '#dcfce7' : past ? '#fee2e2' : '#dbeafe') : came ? '#fef3c7' : d === today ? '#f0fdf4' : undefined;
                      const editable = plan.canPlan && d >= addDays(today, -7);
                      return (
                        <td key={d}
                          onClick={() => editable && setEditing({ supplier: r, day: d, cell: c.plan || null })}
                          title={[
                            c.plan ? `Planned${c.plan.PlannedQty ? ` ${fmtQty(c.plan.PlannedQty)} ${unit}` : ''}${c.plan.Trucks ? `, ${c.plan.Trucks} truck(s)` : ''}${c.plan.BusyPurOrdNo ? ` on ${c.plan.BusyPurOrdNo}` : ''}${c.plan.Notes ? ` — ${c.plan.Notes}` : ''} (by ${c.plan.UpdatedByName || c.plan.CreatedByName})` : null,
                            c.actual?.gateTrucks ? `Gate: ${c.actual.gateTrucks} truck(s), weighed ${fmtQty(c.actual.gateNetKg / 1000)} ${unit}` : null,
                            c.actual?.grnQty ? `Busy GRN: ${fmtQty(c.actual.grnQty)} ${unit} (${c.actual.grns})` : null,
                            !c.plan && came ? 'Delivered without being planned' : null,
                            editable ? 'Click to plan' : null,
                          ].filter(Boolean).join('\n')}
                          style={{ textAlign: 'center', background: bg, cursor: editable ? 'pointer' : 'default', verticalAlign: 'top' }}>
                          {c.plan && (
                            <div style={{ fontWeight: 700 }}>
                              📌 {c.plan.PlannedQty ? `${fmtQty(c.plan.PlannedQty)} ${unit}` : '✓'}
                              {c.plan.Trucks ? <span style={{ fontWeight: 400 }}> · {c.plan.Trucks}🚛</span> : null}
                            </div>
                          )}
                          {c.actual?.gateTrucks > 0 && <div>🚛 {c.actual.gateTrucks}{c.actual.gateNetKg ? ` · ${fmtQty(c.actual.gateNetKg / 1000)} ${unit}` : ''}</div>}
                          {c.actual?.grnQty > 0 && <div style={{ color: '#065f46' }}>GRN {fmtQty(c.actual.grnQty)}</div>}
                          {!c.plan && !came && editable && <div style={{ color: '#d1d5db' }}>+</div>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: '#f9fafb', fontWeight: 600 }}>
                  <td>Day total</td>
                  {dayTotals.map((t) => (
                    <td key={t.d} style={{ textAlign: 'center' }}>
                      {t.suppliers > 0 && <div>📌 {t.planned ? `${fmtQty(t.planned)} ${unit}` : `${t.suppliers} supplier(s)`}{t.trucks ? ` · ${t.trucks}🚛` : ''}</div>}
                      {t.gateTrucks > 0 && <div style={{ fontWeight: 400 }}>🚛 {t.gateTrucks} in</div>}
                      {t.grn > 0 && <div style={{ fontWeight: 400, color: '#065f46' }}>GRN {fmtQty(t.grn)}</div>}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>
            📌 planned · 🚛 trucks booked in at the gate (weighbridge tonnes once weighed) · GRN = received in Busy.
            Blue = planned, green = planned and came, red = planned but nothing came, yellow = came without being planned.
            {plan.canPlan ? ' Click a day to plan it.' : ' Planning is done by production (Production Manager, Head of Production Planning, Ops Manager).'}
            {plan.unmatchedGrns > 0 && ` ${plan.unmatchedGrns} GRN day(s) are from Busy parties not in the supplier list.`}
          </div>
        </>
      )}

      {tab === 'orders' && orders && (
        <>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
            <Stat label="Open POs" value={orders.totals.open} />
            <Stat label={`Still to deliver (${orders.item.unit})`} value={fmtQty(orders.totals.balance)} />
            <Stat label="Old balances (no delivery 30+ days)" value={`${orders.totals.stale} · ${fmtQty(orders.totals.staleBalance)} ${orders.item.unit}`} muted />
          </div>
          {orders.bySupplier.length > 0 && (
            <div className="card" style={{ padding: 0, marginBottom: 16 }}>
              <table className="data-table" style={{ fontSize: 12 }}>
                <thead><tr><th>Supplier</th><th style={{ textAlign: 'right' }}>Open POs</th><th style={{ textAlign: 'right' }}>Ordered</th><th style={{ textAlign: 'right' }}>Received</th><th style={{ textAlign: 'right' }}>Still to deliver</th></tr></thead>
                <tbody>
                  {orders.bySupplier.map((s) => (
                    <tr key={s.supplierId || s.partyCode}>
                      <td>{s.supplierName}</td><td style={{ textAlign: 'right' }}>{s.pos}</td>
                      <td style={{ textAlign: 'right' }}>{fmtQty(s.ordered)}</td><td style={{ textAlign: 'right' }}>{fmtQty(s.received)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtQty(s.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <label style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>
            <input type="checkbox" checked={showStale} onChange={(e) => setShowStale(e.target.checked)} style={{ marginRight: 4 }} />
            Show old balances (POs over 45 days with no delivery for 30 days — usually finished; short-close them in Busy)
          </label>
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table className="data-table" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>PO</th><th>Date</th><th>Supplier</th><th>Requisition</th><th style={{ textAlign: 'right' }}>Price</th>
                  <th style={{ textAlign: 'right' }}>Ordered</th><th style={{ textAlign: 'right' }}>Received</th><th style={{ textAlign: 'right' }}>Balance</th>
                  <th>Last delivery</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.orders.filter((o) => showStale || !o.stale).map((o) => (
                  <tr key={o.ordno} style={o.stale ? { color: '#9ca3af' } : undefined}>
                    <td><strong>{o.ordno}</strong>{o.raisedHere && <span className="badge badge-blue" style={{ marginLeft: 4 }} title="Raised from this system">MTS</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{new Date(o.date).toLocaleDateString('en-KE')}</td>
                    <td>{o.supplierName}</td>
                    <td>{o.requisitionNo || '—'}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtQty(o.price)} <span style={{ color: '#9ca3af' }}>{o.taxType}</span></td>
                    <td style={{ textAlign: 'right' }}>{fmtQty(o.ordered)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtQty(o.received)}{o.grns ? <span style={{ color: '#9ca3af' }}> ({o.grns})</span> : ''}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtQty(o.balance)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{o.lastReceived ? new Date(o.lastReceived).toLocaleDateString('en-KE') : '—'}</td>
                    <td>
                      {o.stale ? <span className="badge badge-gray">old balance</span> : <span className="badge badge-green">open</span>}
                      {o.approvalStatus === 2 && <span className="badge badge-yellow" style={{ marginLeft: 4 }}>pending approval</span>}
                    </td>
                  </tr>
                ))}
                {orders.orders.length === 0 && <tr><td colSpan={10} style={{ textAlign: 'center', padding: 24, color: '#6b7280' }}>No open POs.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {editing && plan && (
        <PlanCellEditor
          item={plan.item}
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); loadPlan(); }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, muted }) {
  return (
    <div className="card" style={{ padding: '10px 16px', minWidth: 160, opacity: muted ? 0.75 : 1 }}>
      <div style={{ fontSize: 12, color: '#6b7280' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function PlanCellEditor({ item, editing, onClose, onSaved }) {
  const { supplier, day, cell } = editing;
  const [qty, setQty] = useState(cell?.PlannedQty ?? '');
  const [trucks, setTrucks] = useState(cell?.Trucks ?? '');
  const [po, setPo] = useState(cell?.BusyPurOrdNo || (supplier.openPos.length === 1 ? supplier.openPos[0].ordno : ''));
  const [notes, setNotes] = useState(cell?.Notes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async (clear) => {
    setSaving(true);
    setError('');
    try {
      await api.put('/procurement/direct-supply/plan', clear
        ? { item: item.name, planDate: day, supplierId: supplier.supplierId, remove: true }
        : { item: item.name, planDate: day, supplierId: supplier.supplierId, plannedQty: qty, trucks, notes, busyPurOrdNo: po || null });
      onSaved();
    } catch (e) {
      setError(e.response?.data?.error || 'Save failed');
      setSaving(false);
    }
  };

  const balance = po ? supplier.openPos.find((p) => p.ordno === po)?.balance : supplier.openBalance;

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10, padding: 20, width: 420, maxWidth: '100%' }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>{supplier.supplierName}</h3>
        <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>{dayLabel(day)} · {item.name}</div>
        {error && <div className="alert alert-error" style={{ marginBottom: 10 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label">Tonnes to deliver ({item.unit})</label>
            <input className="form-input" type="number" min="0" step="0.5" value={qty} onChange={(e) => setQty(e.target.value)} autoFocus placeholder="optional" />
          </div>
          <div className="form-group" style={{ width: 110 }}>
            <label className="form-label">Trucks</label>
            <input className="form-input" type="number" min="0" step="1" value={trucks} onChange={(e) => setTrucks(e.target.value)} placeholder="optional" />
          </div>
        </div>
        <div className="form-group" style={{ marginBottom: 10 }}>
          <label className="form-label">Against PO</label>
          <select className="form-input" value={po} onChange={(e) => setPo(e.target.value)}>
            <option value="">— any of their open POs —</option>
            {supplier.openPos.map((p) => <option key={p.ordno} value={p.ordno}>{p.ordno} · {fmtQty(p.balance)} of {fmtQty(p.ordered)} left</option>)}
          </select>
          {balance != null && Number(qty) > balance + 0.01 && (
            <div style={{ fontSize: 12, color: '#b45309', marginTop: 4 }}>⚠ More than the {fmtQty(balance)} {item.unit} still open — Procurement needs to raise another PO.</div>
          )}
          {supplier.openPos.length === 0 && <div style={{ fontSize: 12, color: '#b45309', marginTop: 4 }}>⚠ No open PO for this supplier — ask Procurement to raise one before it delivers.</div>}
        </div>
        <div className="form-group" style={{ marginBottom: 14 }}>
          <label className="form-label">Note</label>
          <input className="form-input" maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. morning only, dry sawdust" />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" disabled={saving} onClick={() => save(false)}>{saving ? 'Saving…' : cell ? 'Save' : 'Plan this delivery'}</button>
          {cell && <button className="btn btn-danger" disabled={saving} onClick={() => save(true)}>Remove</button>}
          <button className="btn btn-secondary" disabled={saving} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
