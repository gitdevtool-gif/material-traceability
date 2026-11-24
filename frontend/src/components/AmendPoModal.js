import React, { useCallback, useEffect, useRef, useState } from 'react';
import AsyncSelect from 'react-select/async';
import api from '../services/api';
import BusyLoginLink from './BusyLoginLink';

/**
 * Amend a PO already pushed to Busy (2026-10-22). The PO is loaded from Busy;
 * quantities, prices, stores and the tax type can be changed, lines removed
 * or added. The SAME Busy PO is updated (same Pur- number) and goes back to
 * "pending approval" in Busy. Only for POs pushed from this system and only
 * until goods are received against them.
 */
const fmtMoney = (n) => `KES ${Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function AmendPoModal({ ordno, onClose, onAmended }) {
  const [base, setBase] = useState(null);     // first load (current PO, stores, busy user)
  const [check, setCheck] = useState(null);   // latest server check of the edited lines
  const [lines, setLines] = useState([]);
  const [taxType, setTaxType] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const timer = useRef(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    api.get('/procurement/busy-lpo/amend-preview', { params: { ordno } })
      .then((r) => {
        setBase(r.data);
        setCheck(r.data);
        setTaxType(r.data.taxType || '');
        setLines((r.data.currentLines || []).map((l) => ({ itemName: l.itemName, unitName: l.unitName, qty: l.qty, price: l.price, store: l.store })));
      })
      .catch((e) => setError(e.response?.data?.error || 'Could not load the PO from Busy'))
      .finally(() => setLoading(false));
  }, [ordno]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const recheck = (nextLines, nextTax) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setChecking(true);
      api.post('/procurement/busy-lpo/amend-preview', { ordno, lines: nextLines, taxType: nextTax })
        .then((r) => setCheck(r.data))
        .catch((e) => setError(e.response?.data?.error || 'Could not check with Busy'))
        .finally(() => setChecking(false));
    }, 450);
  };
  const setLine = (i, patch) => {
    const next = lines.map((l, k) => (k === i ? { ...l, ...patch } : l));
    setLines(next);
    recheck(next, taxType);
  };
  const removeLine = (i) => { const next = lines.filter((_, k) => k !== i); setLines(next); recheck(next, taxType); };
  const addItem = (it) => {
    if (!it) return;
    const next = [...lines, { itemName: it.itemName, unitName: it.unitName, qty: 1, price: 0, store: lines[0]?.store || '' }];
    setLines(next);
    recheck(next, taxType);
  };
  const changeTax = (t) => { setTaxType(t); recheck(lines, t); };

  const searchItems = (input) => (input.trim().length < 2 ? Promise.resolve([])
    : api.get('/busy-receiving/items', { params: { search: input } })
      .then((r) => r.data.map((it) => ({ value: it.itemCode, label: `${it.itemName} · ${it.unitName || ''}`, item: it }))));

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const r = await api.post('/procurement/busy-lpo/amend', { ordno, lines, taxType, reason });
      setDone(r.data);
      onAmended && onAmended(r.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Busy did not save the change');
      if (e.response?.data?.problems) setCheck((c) => ({ ...c, problems: e.response.data.problems }));
    } finally {
      setSaving(false);
    }
  };

  const problems = check?.problems || [];
  const blocked = base && (base.problems || []).some((p) => /entered in Busy by hand|already been received/.test(p));
  const ready = base?.enabled && !base?.needsBusyLink && problems.length === 0 && !checking && !loading && reason.trim().length >= 3;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 16, overflowY: 'auto' }}>
      <div style={{ background: '#fff', borderRadius: 10, padding: 24, width: 900, maxWidth: '100%', margin: '24px 0', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 17 }}>Amend PO in Busy — {ordno}</h2>
        <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
          {base?.party?.Name || ''}{base ? ` · PO date ${base.date} · now ${fmtMoney(base.currentTotal)} in Busy` : ''}
        </div>

        {done ? (
          <div>
            <div className="alert alert-success" style={{ marginBottom: 10 }}>
              {done.ordno} updated in Busy: {fmtMoney(done.previousTotal)} → <strong>{fmtMoney(done.lpo?.grandTotal ?? done.expectedTotal)}</strong>.
              It is back to “pending approval” in Busy for the Director.
            </div>
            {done.warnings?.map((w) => <div key={w} className="alert alert-error" style={{ marginBottom: 8 }}>{w}</div>)}
            <button className="btn btn-secondary" onClick={onClose}>Close</button>
          </div>
        ) : (
          <>
            {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
            {loading && <div style={{ fontSize: 13, color: '#6b7280' }}>Reading the PO from Busy…</div>}

            {base && !loading && (
              blocked ? (
                <div className="alert alert-error" style={{ marginBottom: 12 }}>{base.problems.find((p) => /entered in Busy by hand|already been received/.test(p))}</div>
              ) : (
                <>
                  <div className="form-group" style={{ maxWidth: 260 }}>
                    <label className="form-label">Busy tax type</label>
                    <select className="form-input" value={taxType} disabled={base.isFuel} onChange={(e) => changeTax(e.target.value)}>
                      {(base.taxTypes || []).map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>

                  <table className="data-table" style={{ fontSize: 12, marginBottom: 8 }}>
                    <thead>
                      <tr><th>Item (Busy)</th><th>Store</th><th style={{ textAlign: 'right' }}>Qty</th><th>Unit</th><th style={{ textAlign: 'right' }}>Price</th><th style={{ textAlign: 'right' }}>Amount</th><th /></tr>
                    </thead>
                    <tbody>
                      {lines.map((l, i) => {
                        const was = (base.currentLines || []).find((c) => c.itemName === l.itemName);
                        const changed = !was || Number(was.qty) !== Number(l.qty) || Number(was.price) !== Number(l.price) || was.store !== l.store;
                        return (
                          <tr key={`${l.itemName}-${i}`} style={{ background: changed ? '#fffbeb' : undefined }}>
                            <td>{l.itemName}{!was && <span className="badge badge-blue" style={{ marginLeft: 6, fontSize: 10 }}>new</span>}</td>
                            <td>
                              <select value={l.store || ''} onChange={(e) => setLine(i, { store: e.target.value })} style={{ maxWidth: 170 }}>
                                <option value="">— store —</option>
                                {(base.stores || []).map((s) => <option key={s} value={s}>{s}</option>)}
                              </select>
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <input type="number" min="0" step="any" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} style={{ width: 90 }} />
                              {was && Number(was.qty) !== Number(l.qty) && <div style={{ color: '#6b7280' }}>was {was.qty}</div>}
                            </td>
                            <td>{l.unitName || '—'}</td>
                            <td style={{ textAlign: 'right' }}>
                              <input type="number" min="0" step="any" value={l.price} onChange={(e) => setLine(i, { price: e.target.value })} style={{ width: 100 }} />
                              {was && Number(was.price) !== Number(l.price) && <div style={{ color: '#6b7280' }}>was {was.price}</div>}
                            </td>
                            <td style={{ textAlign: 'right' }}>{fmtMoney((Number(l.qty) || 0) * (Number(l.price) || 0))}</td>
                            <td><button type="button" className="btn btn-danger btn-sm" title="Remove line" onClick={() => removeLine(i)}>✕</button></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  <div className="form-group" style={{ maxWidth: 460 }}>
                    <label className="form-label">Add an item</label>
                    <AsyncSelect cacheOptions loadOptions={searchItems} value={null} onChange={(o) => o && addItem(o.item)}
                      placeholder="Type 2+ letters of the Busy item…" />
                  </div>

                  <div style={{ fontSize: 13, marginBottom: 8 }}>
                    {check?.taxInclusive
                      ? <>Prices include VAT ({fmtMoney(check?.vat)} at {check?.taxRate}%).</>
                      : <>Subtotal {fmtMoney(check?.subtotal)} + VAT {check?.taxRate}% {fmtMoney(check?.vat)}.</>}
                    {check?.roundOff ? <> Round-off {fmtMoney(check.roundOff)}.</> : null}
                    {' '}New total in Busy: <strong>{fmtMoney(check?.total)}</strong> (now {fmtMoney(base.currentTotal)})
                    {checking && <span style={{ color: '#6b7280' }}> · checking with Busy…</span>}
                  </div>

                  {problems.length > 0 && (
                    <div className="alert alert-error" style={{ marginBottom: 12 }}>
                      <ul style={{ margin: 0, paddingLeft: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
                    </div>
                  )}

                  <div className="form-group">
                    <label className="form-label">Reason for the change *</label>
                    <input className="form-input" value={reason} onChange={(e) => setReason(e.target.value)}
                      placeholder="e.g. Supplier revised price; quantity reduced by user department" />
                  </div>
                  <div style={{ fontSize: 12, color: '#92400e', marginBottom: 12 }}>
                    The same Busy PO ({ordno}) is changed and goes back to “pending approval” for the Director in Busy.
                    {base.approvalStatus === 1 && ' It is currently approved — tell the supplier if they already have the old PO.'}
                  </div>
                  {base.busyUser
                    ? <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 14 }}>Changed by in Busy: <strong>{base.busyUser}</strong></div>
                    : <BusyLoginLink onLinked={load} />}
                </>
              )
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={save} disabled={!ready || saving || blocked}>
                {saving ? 'Saving in Busy…' : 'Save change in Busy'}
              </button>
              <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
