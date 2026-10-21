import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';

/**
 * Procurement's follow-up queue — every item a Director has put on hold
 * (dbo.RFQItemHolds via GET /procurement/evaluation/held) instead of
 * awarding, because no winning quote is in yet. Grouped by RFQ, each held
 * item lists exactly which suppliers still need chasing and why
 * ('no-response' / 'not-priced' / 'not-available'), with contact details
 * and a one-click resend of the RFQ email where possible.
 *
 * Once the Director awards (or the last needed quote arrives and gets
 * awarded), the item drops off this list automatically — holds are
 * cleared server-side the moment they're resolved.
 */
const STATUS_META = {
  'no-response': { label: 'No response yet', color: '#dc2626', bg: '#fef2f2', border: '#fca5a5' },
  'not-priced':  { label: 'Quoted, but not this item', color: '#b45309', bg: '#fffbeb', border: '#fde68a' },
  'not-available': { label: 'Marked not available', color: '#6b7280', bg: '#f9fafb', border: '#e5e7eb' },
};

export default function HeldItemsPage() {
  const navigate = useNavigate();

  const [items, setItems]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');
  const [resendingKey, setResendingKey] = useState(null); // `${dispatchId}` currently resending
  const [cancelTarget, setCancelTarget] = useState(null); // the held item being cancelled, or null
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling]     = useState(false);

  const load = () => {
    setLoading(true);
    setError('');
    api.get('/procurement/evaluation/held')
      .then((res) => setItems(Array.isArray(res.data) ? res.data : []))
      .catch((e) => setError(e.response?.data?.error || 'Failed to load held items'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  // Live-update once a Director resolves a hold (awards or re-holds)
  // elsewhere, same broadcast key the evaluation page already writes to.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== 'ncf:rfqEvaluationChanged' || !e.newValue) return;
      load();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const groups = useMemo(() => {
    const map = new Map();
    for (const it of items) {
      if (!map.has(it.RFQId)) map.set(it.RFQId, []);
      map.get(it.RFQId).push(it);
    }
    return [...map.values()].sort(
      (a, b) => new Date(a[0].DeadlineAt || 0) - new Date(b[0].DeadlineAt || 0)
    );
  }, [items]);

  const totalFollowUps = items.reduce((sum, it) => sum + it.suppliers.length, 0);

  const fmtDate = (d) =>
    d ? new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const fmtDateTime = (d) =>
    d ? new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

  const openCancel = (item) => {
    setCancelTarget(item);
    setCancelReason('');
    setError('');
  };
  const closeCancel = () => { setCancelTarget(null); setCancelReason(''); };

  const confirmCancel = async () => {
    if (!cancelTarget || !cancelReason.trim()) return;
    setCancelling(true);
    setError(''); setSuccess('');
    try {
      const res = await api.post(`/procurement/evaluation/held/${cancelTarget.RequisitionItemId}/cancel`, {
        reason: cancelReason.trim(),
      });
      setSuccess(
        res.data.requisitionCancelled
          ? `"${cancelTarget.ItemName}" cancelled — it was the last active item, so ${cancelTarget.BusyOrdNo} was cancelled too.`
          : `"${cancelTarget.ItemName}" cancelled — removed from the follow-up queue.`
      );
      closeCancel();
      load();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to cancel this item');
    } finally {
      setCancelling(false);
    }
  };

  const resend = async (rfqId, supplier) => {
    const key = supplier.RFQDispatchId;
    setResendingKey(key);
    setError(''); setSuccess('');
    try {
      const res = await api.post(`/procurement/rfq/${rfqId}/resend`, { dispatchId: supplier.RFQDispatchId });
      setSuccess(
        res.data.sent
          ? `Reminder re-sent to ${supplier.SupplierName}.`
          : `${supplier.SupplierName} has no email on file — could not resend.`
      );
    } catch (e) {
      setError(e.response?.data?.error || `Failed to resend to ${supplier.SupplierName}`);
    } finally {
      setResendingKey(null);
    }
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Held Items — Follow Up With Suppliers</h1>
          <p className="page-subtitle">
            Items a Director has held back for a winner — chase the suppliers listed below to get quotes in.
          </p>
        </div>
        <button className="btn btn-secondary" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}
      {success && <div className="alert alert-success" style={{ marginBottom: 16 }}>{success}</div>}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Loading…</div>
      ) : groups.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>
          Nothing on hold right now — every item on every RFQ has either a winner or hasn't reached evaluation yet.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
            {items.length} item{items.length !== 1 ? 's' : ''} on hold across {groups.length} RFQ{groups.length !== 1 ? 's' : ''}
            {' '}· {totalFollowUps} supplier follow-up{totalFollowUps !== 1 ? 's' : ''} outstanding
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {groups.map((group) => {
              const first = group[0];
              return (
                <div key={first.RFQId} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                  <div style={{
                    padding: '14px 20px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12,
                  }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span className="badge badge-gray" style={{ fontSize: 11 }}>{first.RFQNumber}</span>
                        <span className="badge badge-yellow" style={{ fontSize: 11 }}>
                          {group.length} item{group.length !== 1 ? 's' : ''} on hold
                        </span>
                      </div>
                      {first.BusyOrdNo && (
                        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                          Req: {first.BusyOrdNo} · {first.MatCenter || '—'}
                          {first.DeadlineAt && ` · Deadline: ${fmtDate(first.DeadlineAt)}`}
                        </div>
                      )}
                    </div>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => navigate(`/director/evaluation?rfqId=${first.RFQId}`)}
                    >
                      Open Evaluation
                    </button>
                  </div>

                  {group.map((it) => (
                    <div key={it.RFQItemHoldId} style={{ padding: '14px 20px', borderTop: '1px solid #f3f4f6' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                        <div>
                          <strong style={{ fontSize: 14 }}>{it.ItemName}</strong>
                          <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 8 }}>
                            Qty {Number(it.RequiredQty).toLocaleString()}{it.Category ? ` · ${it.Category}` : ''}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ fontSize: 11, color: '#9ca3af' }}>
                            On hold since {fmtDateTime(it.HeldAt)}{it.HeldByName ? ` by ${it.HeldByName}` : ''}
                          </div>
                          <button className="btn btn-secondary btn-sm" style={{ padding: '3px 10px', fontSize: 12 }}
                            onClick={() => openCancel(it)}
                            title="Give up on this item — removes it from the follow-up queue">
                            Cancel Item
                          </button>
                        </div>
                      </div>
                      {it.Reason && (
                        <div style={{ fontSize: 12, color: '#374151', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 10px', marginBottom: 10 }}>
                          <strong>Director's note:</strong> {it.Reason}
                        </div>
                      )}

                      {it.suppliers.length === 0 ? (
                        <div style={{ fontSize: 12, color: '#9ca3af' }}>
                          No suppliers were dispatched this specific item — nothing to follow up on yet.
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {it.suppliers.map((s) => {
                            const meta = STATUS_META[s.status] || STATUS_META['no-response'];
                            const canResend = s.Channel === 'email' && !!s.Email;
                            const isResending = resendingKey === s.RFQDispatchId;
                            return (
                              <div key={s.RFQDispatchId} style={{
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8,
                                fontSize: 12, background: meta.bg, border: `1px solid ${meta.border}`,
                                borderRadius: 6, padding: '8px 12px',
                              }}>
                                <div>
                                  <strong>{s.SupplierName}</strong>
                                  <span style={{ color: meta.color, fontWeight: 600, marginLeft: 8 }}>{meta.label}</span>
                                  <div style={{ color: '#6b7280', marginTop: 2 }}>
                                    {s.Email && <>{s.Email} · </>}
                                    {s.Phone && <>{s.Phone} · </>}
                                    {s.WhatsApp && <>WhatsApp {s.WhatsApp} · </>}
                                    sent {fmtDate(s.SentAt)} via {s.Channel}
                                    {s.isExpired ? ' · link expired' : ''}
                                  </div>
                                </div>
                                {s.status !== 'not-available' && (
                                  s.isExpired ? (
                                    <span style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>
                                      Link expired — needs a fresh RFQ dispatch
                                    </span>
                                  ) : (
                                    <button
                                      className="btn btn-secondary btn-sm"
                                      disabled={!canResend || isResending}
                                      title={!canResend ? 'No email on file for this supplier/channel' : undefined}
                                      onClick={() => resend(it.RFQId, s)}
                                    >
                                      {isResending ? 'Sending…' : 'Resend Reminder'}
                                    </button>
                                  )
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </>
      )}

      {cancelTarget && (
        <div
          onClick={closeCancel}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16, zIndex: 1000,
          }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{
            background: '#fff', borderRadius: 12, width: '100%', maxWidth: 480,
            padding: 24, boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          }}>
            <h3 style={{ margin: '0 0 8px' }}>Cancel "{cancelTarget.ItemName}"?</h3>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 16px' }}>
              This removes it from the follow-up queue for good — it won't be awarded or asked about
              again. {cancelTarget.BusyOrdNo && <>If it's the last active item on <strong>{cancelTarget.BusyOrdNo}</strong>, that requisition will be cancelled too.</>}
            </p>
            {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
            <div className="form-group">
              <label className="form-label">Reason *</label>
              <textarea className="form-input" rows={3} value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="e.g. No supplier has been able to price this after repeated follow-up" autoFocus />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
              <button className="btn btn-secondary" onClick={closeCancel} disabled={cancelling}>Back</button>
              <button className="btn btn-danger" onClick={confirmCancel} disabled={cancelling || !cancelReason.trim()}>
                {cancelling ? 'Cancelling…' : 'Cancel Item'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
