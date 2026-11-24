import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../services/api';

/**
 * Long-held items clean-up (2026-10-22) — on the Director's evaluation page.
 * Items the Director put on hold stay open (and keep their RFQ on the
 * "Pending Evaluation" list) until a supplier prices them. Here the Director
 * sees every held item with how long it has been held, and can cancel the
 * stale ones — one or many at once — so the list stays short and the rest
 * can be approved. Cancelling uses the same server action as the Held Items
 * page: the item drops off the supplier portal, the requisition is
 * cancelled if nothing else is left on it, and the RFQ completes when no
 * holds remain.
 */
const daysSince = (d) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 864e5) : null);

export default function HeldItemsCleanup({ onChanged }) {
  const [held, setHeld] = useState([]);
  const [open, setOpen] = useState(false);
  const [minDays, setMinDays] = useState(30);
  const [picked, setPicked] = useState({});
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.get('/procurement/evaluation/held').then((r) => setHeld(r.data || [])).catch(() => setHeld([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => held
    .map((h) => ({ ...h, days: daysSince(h.HeldAt) }))
    .filter((h) => (h.days ?? 0) >= minDays)
    .sort((a, b) => (b.days ?? 0) - (a.days ?? 0)), [held, minDays]);
  const old30 = held.filter((h) => (daysSince(h.HeldAt) ?? 0) >= 30).length;
  const pickedIds = Object.keys(picked).filter((k) => picked[k]).map(Number);
  const allShownPicked = rows.length > 0 && rows.every((r) => picked[r.RequisitionItemId]);

  const toggleAll = () => {
    const next = { ...picked };
    for (const r of rows) next[r.RequisitionItemId] = !allShownPicked;
    setPicked(next);
  };

  const cancelPicked = async () => {
    if (!pickedIds.length) return;
    if (!reason.trim()) { setError('Give the reason for cancelling these items'); return; }
    if (!window.confirm(`Cancel ${pickedIds.length} held item(s)? Suppliers will no longer be asked to price them.`)) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const r = await api.post('/procurement/evaluation/held/cancel-bulk', { requisitionItemIds: pickedIds, reason: reason.trim() });
      const reqs = r.data.cancelled.filter((c) => c.requisitionCancelled).length;
      setMessage(`Cancelled ${r.data.cancelled.length} held item(s)${reqs ? ` — ${reqs} requisition(s) had nothing left and were closed` : ''}.`
        + (r.data.failed.length ? ` ${r.data.failed.length} could not be cancelled: ${r.data.failed.map((f) => f.error).join('; ')}` : ''));
      setPicked({});
      setReason('');
      load();
      onChanged && onChanged();
    } catch (e) {
      setError(e.response?.data?.error || 'Could not cancel the items');
    } finally {
      setSaving(false);
    }
  };

  if (!held.length) return null;

  return (
    <div className="card" style={{ marginBottom: 16, border: '1px solid #fde68a', background: '#fffbeb' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14 }}>
          ⏸ <strong>{held.length}</strong> item(s) on hold
          {old30 > 0 && <> — <strong style={{ color: '#b45309' }}>{old30}</strong> held for 30 days or more</>}
        </div>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Review & cancel long-held items'}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 12 }}>
          {message && <div className="alert alert-success" style={{ marginBottom: 10 }}>{message}</div>}
          {error && <div className="alert alert-error" style={{ marginBottom: 10 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10, fontSize: 13 }}>
            <label>Show items held for at least</label>
            <select value={minDays} onChange={(e) => { setMinDays(Number(e.target.value)); setPicked({}); }}>
              <option value={0}>any time</option>
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
            </select>
            <span style={{ color: '#6b7280' }}>{rows.length} shown</span>
          </div>

          <div style={{ maxHeight: 360, overflowY: 'auto', background: '#fff', borderRadius: 6 }}>
            <table className="data-table" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th><input type="checkbox" checked={allShownPicked} onChange={toggleAll} title="Select all shown" /></th>
                  <th>Item</th><th>RFQ</th><th>Requisition</th><th style={{ textAlign: 'right' }}>Held</th><th>Why held</th><th>Still waiting on</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((h) => (
                  <tr key={h.RequisitionItemId} style={{ background: picked[h.RequisitionItemId] ? '#fef3c7' : undefined }}>
                    <td><input type="checkbox" checked={!!picked[h.RequisitionItemId]}
                      onChange={(e) => setPicked({ ...picked, [h.RequisitionItemId]: e.target.checked })} /></td>
                    <td style={{ fontWeight: 500 }}>{h.ItemName}{h.RequiredQty != null && <span style={{ color: '#6b7280' }}> · {h.RequiredQty}</span>}</td>
                    <td>{h.RFQNumber}</td>
                    <td>{h.BusyOrdNo}{h.MatCenter && <div style={{ color: '#6b7280' }}>{h.MatCenter}</div>}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap', color: h.days >= 30 ? '#b45309' : undefined, fontWeight: h.days >= 30 ? 600 : 400 }}>
                      {h.days} day(s)
                    </td>
                    <td>{h.Reason || '—'}</td>
                    <td>{(h.suppliers || []).length ? `${h.suppliers.length} supplier(s)` : 'nobody'}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan="7" className="text-center text-muted">No item held that long</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginTop: 10, flexWrap: 'wrap' }}>
            <div className="form-group" style={{ margin: 0, flex: '1 1 320px' }}>
              <label className="form-label">Reason for cancelling *</label>
              <input className="form-input" value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. No supplier priced it after 30+ days — not needed any more" />
            </div>
            <button type="button" className="btn btn-danger" disabled={saving || !pickedIds.length} onClick={cancelPicked}>
              {saving ? 'Cancelling…' : `Cancel selected (${pickedIds.length})`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
