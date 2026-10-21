import React, { useEffect, useState, useCallback } from 'react';
import api from '../services/api';
import StockPicture from '../components/StockPicture';

const fmtDate = (v) => (v ? new Date(v).toLocaleDateString() : '—');

/**
 * Central Stores review (2026-09-15) — every requisition raised in-system
 * (CreateRequisitionPage.js) lands here first. Central Stores checks it
 * against physical stock, can approve at a reduced quantity (they already
 * have some) or reject an item outright with a reason. What's approved
 * continues on exactly as before this feature existed: a factory Mat
 * Centre requisition still goes to the Ops Manager gate afterward;
 * everything else goes straight to Procurement's Pending queue.
 *
 * Mirrors OpsManagerApprovalPage.js's RequisitionApprovalTab (same
 * per-item approve/reject pattern, Approve All/Reject All helpers), minus
 * the Hold action and the Busy ReorderStatus stock columns — neither
 * applies at this stage.
 */
export default function CentralStoresApprovalPage() {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api.get('/procurement/central-stores/pending')
      .then((r) => setRows(r.data))
      .catch(() => setError('Failed to load pending requisitions'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const [selectedReq, setSelectedReq] = useState(null);
  const [detail, setDetail]           = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // Per-item decision state: { [requisitionItemId]: { decision, approvedQty, rejectionReason } }
  const [itemDecisions, setItemDecisions] = useState({});
  const [notes, setNotes]     = useState('');
  const [deciding, setDeciding] = useState(false);

  const closeModal = useCallback(() => {
    setSelectedReq(null);
    setDetail(null);
    setError('');
  }, []);

  useEffect(() => {
    if (!selectedReq) return;
    const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [selectedReq, closeModal]);

  const openDetail = async (row) => {
    setSelectedReq(row);
    setDetail(null);
    setDetailLoading(true);
    setError(''); setSuccess('');
    try {
      const res = await api.get(`/procurement/central-stores/${row.RequisitionId}`);
      setDetail(res.data);
      setNotes('');
      // Default every item to Approved at its full requested qty — Central
      // Stores only has to touch the ones they're adjusting or dropping.
      const initial = {};
      (res.data.items || []).forEach((it) => {
        initial[it.RequisitionItemId] = {
          decision: 'Approved',
          approvedQty: String(it.Qty),
          rejectionReason: '',
        };
      });
      setItemDecisions(initial);
    } catch {
      setError('Failed to load requisition detail');
    } finally {
      setDetailLoading(false);
    }
  };

  const setItemDecision = (itemId, patch) => {
    setItemDecisions((prev) => ({ ...prev, [itemId]: { ...prev[itemId], ...patch } }));
  };

  const approveAll = () => {
    setItemDecisions((prev) => {
      const next = { ...prev };
      for (const id of Object.keys(next)) next[id] = { ...next[id], decision: 'Approved' };
      return next;
    });
  };
  const rejectAll = () => {
    setItemDecisions((prev) => {
      const next = { ...prev };
      for (const id of Object.keys(next)) next[id] = { ...next[id], decision: 'Rejected' };
      return next;
    });
  };

  const rejectedCount = Object.values(itemDecisions).filter((d) => d.decision === 'Rejected').length;
  const approvedCount = Object.values(itemDecisions).filter((d) => d.decision === 'Approved').length;
  const allRejected = Object.keys(itemDecisions).length > 0 && rejectedCount === Object.keys(itemDecisions).length;

  const handleSubmitDecision = async () => {
    setError('');
    const items = Object.entries(itemDecisions).map(([requisitionItemId, d]) => ({
      requisitionItemId: Number(requisitionItemId),
      decision: d.decision,
      approvedQty: d.decision === 'Approved' ? d.approvedQty : null,
      rejectionReason: d.decision === 'Rejected' ? d.rejectionReason : null,
    }));
    const missingReason = items.find((it) => it.decision === 'Rejected' && !String(it.rejectionReason || '').trim());
    if (missingReason) {
      setError('Every rejected item needs a rejection reason');
      return;
    }
    const badQty = items.find((it) => it.decision === 'Approved' && !(parseFloat(it.approvedQty) > 0));
    if (badQty) {
      setError('Every approved item needs a quantity greater than 0');
      return;
    }
    setDeciding(true);
    try {
      const res = await api.patch(`/procurement/central-stores/${selectedReq.RequisitionId}/decision`, {
        items, notes,
      });
      setSuccess(
        res.data.status === 'RejectedByCentralStores'
          ? `${selectedReq.BusyOrdNo}: every item rejected — sent back to ${selectedReq.CreatedByName || 'the requester'}`
          : `${selectedReq.BusyOrdNo}: ${res.data.approvedCount} item(s) approved${res.data.rejectedCount ? `, ${res.data.rejectedCount} rejected` : ''} — forwarded to ${res.data.status === 'PendingOpsApproval' ? 'the Ops Manager' : 'Procurement'}`
      );
      closeModal();
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to submit decision');
    } finally {
      setDeciding(false);
    }
  };

  return (
    <div>
      <div className="page-header"><h1>Central Stores — Requisition Review</h1></div>

      <style>{`
        @media (max-width: 640px) {
          .csApproval-overlay { padding: 0 !important; align-items: stretch !important; }
          .csApproval-modal { max-width: 100% !important; max-height: 100vh !important; border-radius: 0 !important; }
          .csApproval-form-row { flex-direction: column !important; }
          .csApproval-actions { flex-direction: column !important; }
          .csApproval-actions button { width: 100% !important; }
          .csApproval-table-wrap table { font-size: 12px !important; }
        }
        .csApproval-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
      `}</style>

      {success && <div className="card" style={{ color: 'var(--success)' }}>{success}</div>}
      {error && !selectedReq && <div className="card" style={{ color: 'var(--danger)' }}>{error}</div>}

      <div className="card">
        <h3 style={{ marginBottom: 4 }}>Requisitions Awaiting Central Stores Review ({rows.length})</h3>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
          Check against physical stock — approve at a reduced quantity if you already hold some, or
          reject an item outright with a reason. Factory Mat Centres still go to the Ops Manager
          afterward; everything else goes straight to Procurement.
        </p>
        <div className="csApproval-table-wrap">
        <table className="data-table">
          <thead>
            <tr><th>Busy Ord No</th><th>Date</th><th>Mat Centre</th><th>Raised By</th><th>Items</th><th></th></tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="6" className="text-center text-muted">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan="6" className="text-center text-muted">No requisitions pending review</td></tr>
            ) : rows.map(r => (
              <tr key={r.RequisitionId}>
                <td><strong>{r.BusyOrdNo}</strong></td>
                <td style={{ fontSize: 12, color: 'var(--gray-600)' }}>{fmtDate(r.BusyDate)}</td>
                <td>{r.MatCenter || '—'}</td>
                <td>{r.CreatedByName || '—'}</td>
                <td>{r.ItemCount}</td>
                <td>
                  <button className="btn btn-primary" style={{ padding: '4px 12px', fontSize: 13 }}
                    onClick={() => openDetail(r)}>Review</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      {selectedReq && (
        <div
          onClick={closeModal}
          className="csApproval-overlay"
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.55)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            padding: '5vh 16px', zIndex: 1000, overflowY: 'auto',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="csApproval-modal"
            style={{
              background: '#fff', borderRadius: 12, width: '100%', maxWidth: 900,
              maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            }}
          >
            <div style={{
              position: 'sticky', top: 0, background: '#fff', zIndex: 1,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '18px 24px', borderBottom: '1px solid #e5e7eb', borderRadius: '12px 12px 0 0',
            }}>
              <h3 style={{ margin: 0 }}>{selectedReq.BusyOrdNo}</h3>
              <button onClick={closeModal} aria-label="Close"
                style={{ background: 'none', border: 'none', fontSize: 22, lineHeight: 1, cursor: 'pointer', color: '#6b7280', padding: 4 }}>
                ✕
              </button>
            </div>

            <div style={{ padding: 24 }}>
              {error && <div className="card" style={{ color: 'var(--danger)', marginBottom: 16 }}>{error}</div>}

              {detailLoading && (
                <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Loading…</div>
              )}

              {!detailLoading && detail && (
                <>
                  <div style={{ padding: 12, background: 'var(--gray-50)', borderRadius: 'var(--radius)', marginBottom: 16 }}>
                    <strong>Mat Centre:</strong> {detail.MatCenter || '—'} | <strong>Date:</strong> {fmtDate(detail.BusyDate)} |{' '}
                    <strong>Raised by:</strong> {detail.CreatedByName || '—'}
                  </div>

                  <h4 style={{ margin: '0 0 4px' }}>Items</h4>
                  <p style={{ margin: '0 0 8px', fontSize: 12, color: '#6b7280' }}>
                    Every item defaults to Approved at its full requested qty. Reduce the quantity if
                    you already hold some, or reject the ones you don't need to buy at all.
                  </p>
                  <StockPicture
                    title="Live stock & reorder picture for these items (Busy)"
                    items={detail.items.map((i) => ({ name: i.ItemCode || i.ItemName, requestedQty: i.Qty }))}
                  />
                  <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                    <button className="btn btn-outline" style={{ padding: '4px 10px', fontSize: 12 }} onClick={approveAll}>Approve All</button>
                    <button className="btn btn-outline" style={{ padding: '4px 10px', fontSize: 12 }} onClick={rejectAll}>Reject All</button>
                  </div>
                  <div className="csApproval-table-wrap" style={{ marginBottom: 16 }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Item</th><th>Requested Qty</th><th>Preferred Supplier</th><th>Brand / Quality</th>
                        <th>Decision</th><th>Approved Qty / Rejection Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.items.map(i => {
                        const d = itemDecisions[i.RequisitionItemId] || { decision: 'Approved', approvedQty: String(i.Qty), rejectionReason: '' };
                        const isRejected = d.decision === 'Rejected';
                        return (
                          <tr key={i.RequisitionItemId} style={isRejected ? { background: '#fef2f2' } : undefined}>
                            <td>{i.ItemName}{i.Category && <div style={{ fontSize: 11, color: '#9ca3af' }}>{i.Category}</div>}</td>
                            <td>{i.Qty}</td>
                            <td style={{ fontSize: 12 }}>{i.PreferredSupplierName || <span className="text-muted">—</span>}</td>
                            <td style={{ fontSize: 12 }}>
                              {[i.PreferredBrand, i.PreferredQuality].filter(Boolean).join(' · ') || <span className="text-muted">—</span>}
                            </td>
                            <td style={{ whiteSpace: 'nowrap' }}>
                              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 10, fontSize: 12, cursor: 'pointer' }}>
                                <input type="radio" name={`decide-${i.RequisitionItemId}`} checked={!isRejected}
                                  onChange={() => setItemDecision(i.RequisitionItemId, { decision: 'Approved' })} />
                                Approve
                              </label>
                              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
                                <input type="radio" name={`decide-${i.RequisitionItemId}`} checked={isRejected}
                                  onChange={() => setItemDecision(i.RequisitionItemId, { decision: 'Rejected' })} />
                                Reject
                              </label>
                            </td>
                            <td style={{ minWidth: 160 }}>
                              {isRejected ? (
                                <input className="form-input" style={{ fontSize: 12 }} placeholder="Reason (required)"
                                  value={d.rejectionReason}
                                  onChange={(e) => setItemDecision(i.RequisitionItemId, { rejectionReason: e.target.value })} />
                              ) : (
                                <input type="number" step="0.01" className="form-input" style={{ fontSize: 12, width: 100 }}
                                  value={d.approvedQty}
                                  onChange={(e) => setItemDecision(i.RequisitionItemId, { approvedQty: e.target.value })} />
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  </div>

                  <div style={{ padding: 16, background: '#fffbeb', border: '1px solid #fbbf24', borderRadius: 'var(--radius)' }}>
                    <h4 style={{ margin: '0 0 12px' }}>
                      Decision — {approvedCount} approved, {rejectedCount} rejected
                    </h4>
                    {allRejected && (
                      <p style={{ fontSize: 12, color: '#991b1b', margin: '0 0 10px' }}>
                        Every item is rejected — submitting will dead-end this requisition entirely.
                      </p>
                    )}
                    <div className="form-group">
                      <label>Notes (optional)</label>
                      <textarea rows="2" value={notes} onChange={e => setNotes(e.target.value)} />
                    </div>
                    <div className="csApproval-actions" style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                      <button className="btn btn-success" disabled={deciding}
                        onClick={handleSubmitDecision}>
                        {deciding ? 'Processing…' : allRejected ? '❌ Submit — reject all' : '✅ Submit Decision'}
                      </button>
                      <button className="btn btn-outline" onClick={closeModal}>Cancel</button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
