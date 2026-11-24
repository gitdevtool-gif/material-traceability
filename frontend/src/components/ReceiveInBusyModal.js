import React, { useCallback, useEffect, useRef, useState } from 'react';
import api from '../services/api';
import BusyLoginLink from './BusyLoginLink';

/**
 * Receive a delivery as a Busy GRN from here (2026-10-21). Stores confirm,
 * per material, the supplier's Busy PO line(s) and the quantity received —
 * several POs can be ticked and are filled oldest first, any allowance above
 * them stays on the GRN against no PO, as in Busy (2026-10-29); the
 * server checks everything against Busy (pending quantity, approval, tax
 * type, store) and shows exactly what will be saved, batch numbers included.
 * Busy assigns the GRN number; the printable GRN opens afterwards.
 */
const fmtMoney = (n) => `KES ${Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtQty = (n) => (n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 }));

export default function ReceiveInBusyModal({ entry, onClose, onReceived }) {
  const [draft, setDraft] = useState(null);       // last server answer (draft or preview)
  const [lines, setLines] = useState([]);         // [{ entryItemId, refCodes: [PO line ref], qty }]
  const [deliveryNote, setDeliveryNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const timer = useRef(null);

  const loadDraft = useCallback(() => {
    setLoading(true);
    setError('');
    api.get(`/busy-grn/${entry.EntryId}/draft`)
      .then((r) => {
        setDraft(r.data);
        setLines(r.data.draftLines.map((l) => ({ ...l, refCodes: (l.refCodes || []).map(String), qty: l.qty ?? '', rejectionPct: l.rejectionPct ?? '' })));
        setDeliveryNote(r.data.deliveryNote || '');
      })
      .catch((e) => setError(e.response?.data?.error || 'Could not read this delivery against Busy'))
      .finally(() => setLoading(false));
  }, [entry.EntryId]);

  useEffect(() => { loadDraft(); }, [loadDraft]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  // Re-check with Busy shortly after every change.
  const recheck = (nextLines, nextNote) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setChecking(true);
      api.post(`/busy-grn/${entry.EntryId}/preview`, {
        lines: nextLines.filter((l) => l.refCodes.length || l.qty !== ''), deliveryNote: nextNote,
      })
        .then((r) => setDraft((d) => ({ ...d, ...r.data })))
        .catch((e) => setError(e.response?.data?.error || 'Could not check with Busy'))
        .finally(() => setChecking(false));
    }, 450);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const setLine = (entryItemId, patch) => {
    const next = lines.map((l) => (String(l.entryItemId) === String(entryItemId) ? { ...l, ...patch } : l));
    setLines(next);
    recheck(next, deliveryNote);
  };
  const changeNote = (v) => { setDeliveryNote(v); recheck(lines, v); };
  const toggleRef = (entryItemId, refCode, on) => {
    const l = lines.find((x) => String(x.entryItemId) === String(entryItemId));
    const refs = (l?.refCodes || []).filter((r) => r !== refCode);
    setLine(entryItemId, { refCodes: on ? [...refs, refCode] : refs });
  };

  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      const r = await api.post(`/busy-grn/${entry.EntryId}/push`, {
        lines: lines.filter((l) => l.refCodes.length || l.qty !== ''), deliveryNote,
      });
      setDone(r.data);
      onReceived && onReceived(r.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Busy did not save the GRN');
      if (e.response?.data?.problems) setDraft((d) => ({ ...d, problems: e.response.data.problems }));
    } finally {
      setSaving(false);
    }
  };

  const problems = draft?.problems || [];
  const ready = draft?.enabled && !draft?.needsBusyLink && problems.length === 0 && !loading && !checking && (draft?.lines || []).length > 0;
  const linesFor = (it) => (draft?.openLines || []).filter((l) => !it.busyItemCode || l.itemCode === it.busyItemCode);
  const builtLine = (entryItemId) => (draft?.lines || []).find((l) => String(l.entryItemId) === String(entryItemId));

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 16, overflowY: 'auto' }}>
      <div style={{ background: '#fff', borderRadius: 10, padding: 24, width: 920, maxWidth: '100%', boxShadow: '0 8px 32px rgba(0,0,0,0.18)', margin: '24px 0' }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 17 }}>Receive in Busy — {entry.EntryNo}</h2>
        <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
          {draft?.supplierName || entry.SupplierName} · Vehicle {draft?.vehicle || entry.VehicleRegNo || '—'}
          {draft?.ticketNo && <> · Ticket {draft.ticketNo}</>}
          {draft?.qa && <> · QA {draft.qa.OverallStatus}{draft.qa.RejectedQty > 0 ? ` (rejected ${fmtQty(draft.qa.RejectedQty)})` : ''}</>}
        </div>

        {done ? (
          <div>
            <div className="alert alert-success" style={{ marginBottom: 12 }}>
              Received in Busy as <strong>{done.grnNo}</strong>{done.reused ? ' (already saved earlier — now linked)' : ''}.
            </div>
            {done.warnings?.map((w) => <div key={w} className="alert alert-error" style={{ marginBottom: 8 }}>{w}</div>)}
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={() => window.open(`/grn-print/${done.entryId}`, '_blank')}>🖨 Print GRN for Accounts</button>
              <button className="btn btn-secondary" onClick={onClose}>Close</button>
            </div>
          </div>
        ) : (
          <>
            {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
            {loading && <div style={{ fontSize: 13, color: '#6b7280' }}>Reading the supplier's POs from Busy…</div>}

            {draft && !loading && (
              <>
                {!draft.enabled && (
                  <div className="alert alert-error" style={{ marginBottom: 12 }}>
                    Receiving in Busy from here is not switched on yet — you can check the GRN below, but receive it in Busy for now.
                  </div>
                )}
                <table className="data-table" style={{ fontSize: 12, marginBottom: 10 }}>
                  <thead>
                    <tr>
                      <th>Material (gate)</th><th>Weighed</th><th>Busy PO line</th>
                      <th style={{ textAlign: 'right' }}>Qty received</th><th>Store</th>
                      <th style={{ textAlign: 'right' }} title="QA rejection — taken off the price, the full quantity is received (Busy's Disc %)">Rejection %</th>
                      <th style={{ textAlign: 'right' }}>Price</th>
                      <th style={{ textAlign: 'right' }}>Amount</th><th>Batch</th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.entryItems.map((it) => {
                      const l = lines.find((x) => String(x.entryItemId) === String(it.entryItemId)) || {};
                      const options = linesFor(it);
                      const refCodes = l.refCodes || [];
                      const picked = options.filter((o) => refCodes.includes(String(o.refCode)));
                      const chosen = picked[0];
                      const pendingTotal = picked.reduce((s, o) => s + Number(o.pending || 0), 0);
                      const built = builtLine(it.entryItemId);
                      const takes = (refCode) => built?.refs?.find((r) => String(r.refCode) === String(refCode))?.qty;
                      return (
                        <tr key={it.entryItemId}>
                          <td>{it.materialName}{it.remarks && <div style={{ fontSize: 11, color: '#6b7280' }}>{it.remarks}</div>}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>{it.netKg ? `${fmtQty(it.netKg)} kg` : '—'}</td>
                          <td style={{ minWidth: 260 }}>
                            {options.length === 0 ? (
                              <span style={{ color: '#b45309' }}>No open PO in Busy for this — Procurement must raise it</span>
                            ) : (
                              <>
                                {/* tick one or more — Busy fills them oldest first */}
                                {options.map((o) => {
                                  const on = refCodes.includes(String(o.refCode));
                                  return (
                                    <label key={o.refCode} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 3, color: o.approved ? undefined : '#9ca3af', cursor: o.approved ? 'pointer' : 'not-allowed' }}>
                                      <input type="checkbox" checked={on} disabled={!o.approved}
                                        onChange={(e) => toggleRef(it.entryItemId, String(o.refCode), e.target.checked)} />
                                      <span>
                                        {/* date + price so an old PO at another price stands out (Pur-155 vs Pur-2946, 2026-11-02) */}
                                        {o.refNo && o.refNo !== o.poNo ? `${o.poNo} line ${Number(o.refNo.split('/').pop()) + 1}` : o.poNo}
                                        {o.poDate && ` (${new Date(o.poDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })})`}
                                        {' '}· {o.itemName} · @{fmtMoney(o.price)} · pending {fmtQty(o.pending)} {o.unitName || ''}
                                        {!o.approved && ' · awaiting approval'}
                                        {on && takes(o.refCode) != null && <strong style={{ color: '#065f46' }}> → {fmtQty(takes(o.refCode))}</strong>}
                                      </span>
                                    </label>
                                  );
                                })}
                                {picked.length > 1 && <div style={{ fontSize: 11, color: '#6b7280' }}>Pending on the ticked POs: {fmtQty(pendingTotal)} {chosen?.unitName || ''}</div>}
                                {built?.allowance > 0 && (
                                  <div style={{ fontSize: 11, color: '#92400e' }}>+ {fmtQty(built.allowance)} {built.unitName || ''} allowance (on no PO)</div>
                                )}
                              </>
                            )}
                          </td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <input type="number" min="0" step="any" value={l.qty ?? ''} disabled={refCodes.length === 0}
                              onChange={(e) => setLine(it.entryItemId, { qty: e.target.value })} style={{ width: 100 }} />
                            {' '}{chosen?.unitName || ''}
                          </td>
                          <td>{chosen?.store || '—'}</td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <input type="number" min="0" max="99.99" step="0.01" value={l.rejectionPct ?? ''} disabled={refCodes.length === 0}
                              onChange={(e) => setLine(it.entryItemId, { rejectionPct: e.target.value })} style={{ width: 64 }} />
                            {draft.qaRejectionPct > 0 && <div style={{ fontSize: 10, color: '#6b7280' }}>QA {draft.qaRejectionPct}%</div>}
                          </td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {built && built.discountPct > 0
                              ? <><span style={{ textDecoration: 'line-through', color: '#9ca3af' }}>{fmtMoney(built.listPrice)}</span><br />{fmtMoney(built.price)}</>
                              : (chosen ? fmtMoney(chosen.price) : '—')}
                          </td>
                          <td style={{ textAlign: 'right' }}>{built ? fmtMoney(built.amount) : '—'}</td>
                          <td style={{ fontSize: 11, fontFamily: 'monospace' }}>{built?.batchNo || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                <div className="form-group" style={{ maxWidth: 420 }}>
                  <label className="form-label">Delivery note / invoice no. (goes in the Busy narration)</label>
                  <input className="form-input" value={deliveryNote} onChange={(e) => changeNote(e.target.value)} placeholder="e.g. Del.No.LDN043378" />
                </div>

                {(draft.lines || []).length > 0 && (
                  <div style={{ fontSize: 13, marginBottom: 8 }}>
                    {draft.taxType}: {draft.taxInclusive
                      ? <>prices include VAT ({fmtMoney(draft.vat)} at {draft.taxRate}%)</>
                      : <>subtotal {fmtMoney(draft.subtotal)} + VAT {draft.taxRate}% {fmtMoney(draft.vat)}</>}
                    {draft.roundOff !== 0 && <> · round-off {fmtMoney(draft.roundOff)}</>}
                    {' '}· Total in Busy: <strong>{fmtMoney(draft.total)}</strong>
                    {checking && <span style={{ color: '#6b7280' }}> · checking with Busy…</span>}
                  </div>
                )}
                {draft.notReceived?.length > 0 && (draft.lines || []).length > 0 && (
                  <div style={{ fontSize: 12, color: '#92400e', marginBottom: 8 }}>Not on this GRN: {draft.notReceived.join(', ')}</div>
                )}

                {draft.notes?.length > 0 && (
                  <div className="alert" style={{ marginBottom: 10, background: '#fffbeb', border: '1px solid #fcd34d', color: '#92400e', fontSize: 13 }}>
                    {draft.notes.map((n) => <div key={n}>{n}</div>)}
                  </div>
                )}

                {problems.filter((p) => !/Link your own Busy login|not switched on/.test(p)).length > 0 && (
                  <div className="alert alert-error" style={{ marginBottom: 12 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Can't receive this yet:</div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {problems.filter((p) => !/Link your own Busy login|not switched on/.test(p)).map((p) => <li key={p}>{p}</li>)}
                    </ul>
                  </div>
                )}

                {draft.busyUser
                  ? <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 14 }}>Added by in Busy: <strong>{draft.busyUser}</strong> · Busy assigns the GRN number.</div>
                  : <BusyLoginLink onLinked={() => { loadDraft(); }} />}
              </>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={submit} disabled={!ready || saving}>
                {saving ? 'Saving in Busy…' : 'Receive in Busy'}
              </button>
              <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
