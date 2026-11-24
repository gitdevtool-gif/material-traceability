import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Select from 'react-select';
import api from '../services/api';
import BusyLoginLink from './BusyLoginLink';

/**
 * Raise the direct-supply lines of a requisition as Busy POs — no RFQ
 * (2026-11-24). Sawdust / offcuts for F8 are bought from standing
 * suppliers at their standing price (their last Busy PO for the item, the
 * rule Busy's own PO screen follows). Procurement shares each item's tonnes
 * across one or more suppliers; each supplier gets one Busy PO for its
 * share. Lines that are not direct supply (e.g. firewood) stay on the RFQ path.
 * Backend: busy-lpo.routes.js /direct-preview, /direct-push, /direct-link.
 */
const fmtMoney = (n) => `KES ${Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const fmtQty = (n) => Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 2 });
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' }) : '—');
const k = (supplierId, itemName) => `${supplierId}|${itemName}`;

export default function RaiseDirectPoModal({ requisition, onClose, onDone }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // allocations keyed "supplierId|itemName": { qty, price, taxType }
  const [alloc, setAlloc] = useState({});
  // extra (non-standing) suppliers added per item: { itemName: [{ supplierId, supplierName }] }
  const [extra, setExtra] = useState({});
  const [searchOptions, setSearchOptions] = useState([]);
  const [priceReason, setPriceReason] = useState('');
  const [closeRest, setCloseRest] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [linkPicked, setLinkPicked] = useState({});
  const timer = useRef(null);

  const allocations = useMemo(() => Object.entries(alloc)
    .filter(([, a]) => Number(a.qty) > 0)
    .map(([key, a]) => {
      const [supplierId, ...rest] = key.split('|');
      return { supplierId: Number(supplierId), itemName: rest.join('|'), qty: Number(a.qty), price: a.price === '' || a.price == null ? null : Number(a.price), taxType: a.taxType || null };
    }), [alloc]);

  const load = useCallback((allocs, reason) => {
    setLoading(true);
    return api.post('/procurement/busy-lpo/direct-preview', { requisitionId: requisition.RequisitionId, allocations: allocs, priceReason: reason })
      .then((r) => { setPreview(r.data); setError(''); })
      .catch((e) => setError(e.response?.data?.error || 'Could not check these POs against Busy'))
      .finally(() => setLoading(false));
  }, [requisition.RequisitionId]);

  useEffect(() => { load([], ''); }, [load]);

  // Re-check against Busy shortly after the buyer stops typing.
  useEffect(() => {
    if (!preview) return undefined;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load(allocations, priceReason), 450);
    return () => clearTimeout(timer.current);
  }, [allocations, priceReason]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const setField = (supplierId, itemName, field, value) => setAlloc((prev) => ({
    ...prev, [k(supplierId, itemName)]: { ...(prev[k(supplierId, itemName)] || {}), [field]: value },
  }));

  const fillRemaining = (supplierId, item) => {
    const others = allocations.filter((a) => a.itemName === item.name && a.supplierId !== supplierId).reduce((s, a) => s + a.qty, 0);
    const left = Math.max(0, Math.round((item.remaining - others) * 100) / 100);
    setField(supplierId, item.name, 'qty', left ? String(left) : '');
  };

  const searchSuppliers = (text) => {
    if (!text || text.trim().length < 2) return;
    api.get('/suppliers', { params: { search: text.trim(), active: 'true' } })
      .then((r) => {
        const list = Array.isArray(r.data) ? r.data : r.data?.data || [];
        setSearchOptions(list.map((s) => ({ value: s.SupplierId, label: s.SupplierName })));
      })
      .catch(() => {});
  };

  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      const r = await api.post('/procurement/busy-lpo/direct-push', {
        requisitionId: requisition.RequisitionId, allocations, priceReason, closeRest,
      });
      setResult(r.data);
    } catch (e) {
      const d = e.response?.data;
      setError(d?.problems?.length ? d.problems.join(' ') : (d?.error || 'Busy did not save the POs'));
    } finally {
      setSaving(false);
    }
  };

  const linkHandRaised = async () => {
    const ordnos = Object.keys(linkPicked).filter((o) => linkPicked[o]);
    if (!ordnos.length) return;
    setSaving(true);
    setError('');
    try {
      const r = await api.post('/procurement/busy-lpo/direct-link', { requisitionId: requisition.RequisitionId, ordnos, closeRest });
      setLinkPicked({});
      await load(allocations, priceReason);
      if (r.data.requisitionDone) setResult({ raised: [], linked: r.data.linked, requisitionDone: true, closedItems: r.data.closedItems });
    } catch (e) {
      setError(e.response?.data?.error || 'Could not link those POs');
    } finally {
      setSaving(false);
    }
  };

  const problems = preview?.problems || [];
  const items = preview?.items || [];
  const nothingLeft = items.length > 0 && items.every((i) => i.remaining <= 0);
  const ready = preview?.enabled && allocations.length > 0 && problems.length === 0 && !loading && !saving;
  const poCount = new Set(allocations.map((a) => a.supplierId)).size;
  const posBySupplier = new Map((preview?.pos || []).map((p) => [p.supplierId, p]));

  // ── Result screen ───────────────────────────────────────────────────────
  if (result) {
    return (
      <Shell>
        <h2 style={{ margin: '0 0 12px', fontSize: 17 }}>✅ {requisition.BusyOrdNo}</h2>
        {(result.raised || []).map((r) => (
          <div key={r.lpo.ordno} className="alert alert-success" style={{ marginBottom: 8 }}>
            <strong>{r.lpo.ordno}</strong> — {r.supplierName}: {r.lines.map((l) => `${l.itemName} ${fmtQty(l.qty)} ${l.unit || ''}`).join(' + ')} · {fmtMoney(r.lpo.grandTotal)}
            {r.reused && ' (already in Busy from an earlier try — linked)'}
            {r.warnings?.map((w) => <div key={w} style={{ fontSize: 12, color: '#92400e', marginTop: 4 }}>⚠ {w}</div>)}
          </div>
        ))}
        {result.linked?.length > 0 && <div className="alert alert-success" style={{ marginBottom: 8 }}>Linked {result.linked.join(', ')}.</div>}
        {result.failure && <div className="alert alert-error" style={{ marginBottom: 8 }}>{result.failure} The POs above are saved; open this again to raise the rest.</div>}
        <div style={{ fontSize: 13, color: '#374151', margin: '8px 0 16px' }}>
          {result.requisitionDone
            ? 'Every line on this requisition is now ordered — it moves to Reconciled.'
            : result.closedItems?.length
              ? `${result.closedItems.join(', ')} ${result.closedItems.length === 1 ? 'is' : 'are'} fully ordered. Other lines stay open (RFQ or more POs).`
              : 'Some tonnes are still to order on this requisition.'}
          {' '}The POs are pending approval in Busy. Production plans the daily deliveries on the Direct Supply page.
        </div>
        <button className="btn btn-primary" onClick={() => onDone(result)}>Done</button>
      </Shell>
    );
  }

  return (
    <Shell>
      <h2 style={{ margin: '0 0 4px', fontSize: 17 }}>🪵 Raise direct POs in Busy</h2>
      <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
        {requisition.BusyOrdNo} · Store <strong>{requisition.MatCenter || '—'}</strong> · standing suppliers at their
        standing price (their last Busy PO for the item) — no RFQ. Each supplier gets one PO.
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
      {loading && !preview && <div style={{ fontSize: 13, color: '#6b7280' }}>Checking against Busy…</div>}
      {preview && !preview.enabled && <div className="alert alert-error" style={{ marginBottom: 12 }}>{problems[0]}</div>}

      {/* POs Busy users already keyed by hand for this requisition */}
      {preview?.handRaised?.length > 0 && (
        <div className="alert alert-warning" style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Already raised in Busy by hand for {requisition.BusyOrdNo}:</div>
          {preview.handRaised.map((o) => (
            <label key={o.ordno} style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
              <input type="checkbox" checked={!!linkPicked[o.ordno]} onChange={(e) => setLinkPicked({ ...linkPicked, [o.ordno]: e.target.checked })} style={{ marginRight: 6 }} />
              <strong>{o.ordno}</strong> {fmtDate(o.date)} — {o.party}: {o.lines.map((l) => `${l.itemName} ${fmtQty(l.ordered)} @${l.price} (received ${fmtQty(l.received)})`).join(', ')} · {o.approvalLabel}
            </label>
          ))}
          <button className="btn btn-sm btn-primary" style={{ marginTop: 6 }} disabled={saving || !Object.values(linkPicked).some(Boolean)} onClick={linkHandRaised}>
            Link ticked POs to this requisition
          </button>
          <span style={{ fontSize: 12, marginLeft: 8 }}>so nothing is ordered twice.</span>
        </div>
      )}

      {preview?.linked?.length > 0 && (
        <div style={{ fontSize: 12, color: '#374151', marginBottom: 12 }}>
          Already linked: {preview.linked.map((l) => `${l.BusyPurOrdNo} (${l.BusySupplier}${l.lines?.length ? `: ${l.lines.map((x) => `${x.itemName} ${fmtQty(x.ordered)}`).join(', ')}` : ''})`).join('; ')}
        </div>
      )}

      {preview?.requisition?.lines?.some((l) => !l.direct) && (
        <div className="alert alert-info" style={{ marginBottom: 12, fontSize: 12 }}>
          Not direct supply, stays on the RFQ path: {preview.requisition.lines.filter((l) => !l.direct).map((l) => `${l.ItemName} ${fmtQty(l.Qty)} ${l.Unit || ''}`).join(', ')}.
        </div>
      )}

      {items.map((item) => {
        const standingIds = new Set(item.suppliers.filter((s) => s.supplierId).map((s) => s.supplierId));
        const rows = [
          ...item.suppliers.filter((s) => s.supplierId),
          ...(extra[item.name] || []).filter((x) => !standingIds.has(x.supplierId)),
        ];
        const allocated = allocations.filter((a) => a.itemName === item.name).reduce((s, a) => s + a.qty, 0);
        const over = allocated > item.remaining + 0.01;
        return (
          <div key={item.name} className="card" style={{ padding: 12, marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
              <div style={{ fontWeight: 700 }}>{item.name}</div>
              <div style={{ fontSize: 13 }}>
                Asked {fmtQty(item.requested)} {item.unit} · ordered {fmtQty(item.ordered)} ·{' '}
                <strong>left {fmtQty(item.remaining)} {item.unit}</strong>
                {allocated > 0 && (
                  <span style={{ marginLeft: 8, color: over ? '#b91c1c' : '#047857', fontWeight: 600 }}>
                    giving {fmtQty(allocated)} {item.unit}
                  </span>
                )}
              </div>
            </div>
            {item.closed && <div style={{ fontSize: 12, color: '#047857', marginBottom: 6 }}>✓ Closed{item.closedPos ? ` — ${item.closedPos}` : ''}</div>}
            {item.unitNotes?.map((n) => <div key={n} style={{ fontSize: 12, color: '#92400e', marginBottom: 6 }}>⚠ {n}</div>)}
            {item.remaining > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table" style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>Supplier</th>
                      <th style={{ textAlign: 'right' }} title="The supplier's last Busy PO price for this item">Standing price</th>
                      <th>Last PO</th>
                      <th style={{ textAlign: 'right' }} title="Still to be delivered on this supplier's current POs">Open balance</th>
                      <th style={{ textAlign: 'right' }} title="Received in Busy (GRN) in the last 30 days">Delivered 30d</th>
                      <th style={{ width: 90 }}>Qty ({item.unit})</th>
                      <th style={{ width: 90 }} title="Leave blank for the standing price">Price</th>
                      <th style={{ width: 120 }}>Tax type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s) => {
                      const a = alloc[k(s.supplierId, item.name)] || {};
                      const isStanding = standingIds.has(s.supplierId);
                      return (
                        <tr key={s.supplierId} style={Number(a.qty) > 0 ? { background: '#eff6ff' } : undefined}>
                          <td>
                            {s.supplierName}
                            {!isStanding && <span className="badge badge-orange" style={{ marginLeft: 6 }}>not standing</span>}
                          </td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {isStanding ? <>{fmtQty(s.standingPrice)} <span style={{ color: '#6b7280' }}>{s.taxType}</span></> : '—'}
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>{isStanding ? `${String(s.lastPoNo || '').replace('---2026-27', '')} ${fmtDate(s.lastPoDate)}` : '—'}</td>
                          <td style={{ textAlign: 'right' }} title={s.openPos?.join(', ')}>{s.openBalance ? fmtQty(s.openBalance) : '—'}</td>
                          <td style={{ textAlign: 'right' }}>{s.delivered30d ? fmtQty(s.delivered30d) : '—'}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <input className="form-input" type="number" min="0" step="0.01" style={{ width: 70, padding: '2px 6px' }}
                              value={a.qty || ''} onChange={(e) => setField(s.supplierId, item.name, 'qty', e.target.value)} disabled={saving} />
                            <button type="button" title="Give this supplier what is left" className="btn btn-sm btn-secondary" style={{ padding: '1px 6px', marginLeft: 2 }}
                              onClick={() => fillRemaining(s.supplierId, item)} disabled={saving}>↧</button>
                          </td>
                          <td>
                            <input className="form-input" type="number" min="0" step="0.01" style={{ width: 80, padding: '2px 6px' }}
                              placeholder={isStanding ? String(s.standingPrice) : 'price'}
                              value={a.price ?? ''} onChange={(e) => setField(s.supplierId, item.name, 'price', e.target.value)} disabled={saving} />
                          </td>
                          <td>
                            <select className="form-input" style={{ padding: '2px 4px', fontSize: 12 }}
                              value={a.taxType || ''} onChange={(e) => setField(s.supplierId, item.name, 'taxType', e.target.value)} disabled={saving}>
                              <option value="">{isStanding ? `${s.taxType} (standing)` : 'choose…'}</option>
                              {(preview?.taxTypes || []).filter((t) => !isStanding || t !== s.taxType).map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ marginTop: 6, maxWidth: 360 }}>
                  <Select
                    options={searchOptions.filter((o) => !rows.some((r) => r.supplierId === o.value))}
                    value={null}
                    onChange={(opt) => opt && setExtra((prev) => ({ ...prev, [item.name]: [...(prev[item.name] || []), { supplierId: opt.value, supplierName: opt.label }] }))}
                    onInputChange={(text, meta) => { if (meta.action === 'input-change') searchSuppliers(text); }}
                    placeholder="+ another supplier (type to search)…"
                    isDisabled={saving}
                    styles={{ control: (b) => ({ ...b, minHeight: 30, fontSize: 12 }), menu: (b) => ({ ...b, fontSize: 12 }) }}
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* What Busy will get */}
      {preview?.pos?.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{poCount} PO{poCount === 1 ? '' : 's'} to raise in Busy</div>
          {[...posBySupplier.values()].map((p) => (
            <div key={p.supplierId} style={{ fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 10px', marginBottom: 6 }}>
              <strong>{p.supplierName}</strong> · {p.taxType || '—'} ·{' '}
              {p.lines.map((l) => `${l.itemName} ${fmtQty(l.qty)} × ${fmtQty(l.price)}${l.departsFromStanding ? ' ✎' : ''}`).join(' + ')}
              {p.vat > 0 && <> · VAT {fmtMoney(p.vat)}</>} · <strong>Total {fmtMoney(p.total)}</strong>
              <div style={{ color: '#6b7280' }}>Narration “{p.narration}”</div>
            </div>
          ))}
        </div>
      )}

      {preview?.needsReason && (
        <div className="form-group" style={{ marginBottom: 12 }}>
          <label className="form-label">Reason for the price / tax change or the new supplier *</label>
          <input className="form-input" value={priceReason} onChange={(e) => setPriceReason(e.target.value)} maxLength={200}
            placeholder="e.g. supplier raised price from 1 Dec, agreed by Director" disabled={saving} />
        </div>
      )}

      {preview && allocations.length > 0 && problems.length > 0 && (
        <div className="alert alert-error" style={{ marginBottom: 12 }}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
      {preview && allocations.length === 0 && problems.length > 0 && preview.enabled && !preview.handRaised?.length && (
        <div className="alert alert-error" style={{ marginBottom: 12 }}>{problems.join(' ')}</div>
      )}

      {preview?.enabled && !nothingLeft && (
        <label style={{ display: 'block', fontSize: 12, marginBottom: 12 }}>
          <input type="checkbox" checked={closeRest} onChange={(e) => setCloseRest(e.target.checked)} style={{ marginRight: 6 }} disabled={saving} />
          Nothing more to order on these direct-supply lines after this (close them even if some tonnes are left)
        </label>
      )}

      {preview?.enabled && (preview.busyUser
        ? <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>Added by in Busy: <strong>{preview.busyUser}</strong> · POs are saved as pending approval in Busy; Busy assigns the numbers.</div>
        : <BusyLoginLink onLinked={() => load(allocations, priceReason)} />)}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="btn btn-primary" onClick={submit} disabled={!ready}>
          {saving ? 'Saving in Busy…' : `Raise ${poCount || ''} PO${poCount === 1 ? '' : 's'} in Busy`}
        </button>
        <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
        {loading && preview && <span style={{ fontSize: 12, color: '#6b7280' }}>checking…</span>}
      </div>
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '4vh 12px', overflowY: 'auto',
    }}>
      <div style={{
        background: '#fff', borderRadius: 10, padding: 20, width: 960, maxWidth: '100%',
        boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
      }}>
        {children}
      </div>
    </div>
  );
}
