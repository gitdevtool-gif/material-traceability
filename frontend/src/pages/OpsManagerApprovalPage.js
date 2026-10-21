import React, { useEffect, useState, useCallback } from 'react';
import api from '../services/api';
import StockPicture from '../components/StockPicture';
import { useAuth } from '../context/AuthContext';

const fmtDT = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
const fmtDate = (v) => (v ? new Date(v).toLocaleDateString() : '—');

/**
 * Ops Manager Approval — merged page.
 *
 * Tab 1 "Goods Receiving": original QA-inspection approval flow,
 * unchanged — list + review modal.
 *
 * Tab 2 "Requisition Approval": gates Busy-synced requisitions before
 * Procurement ever sees them (replaces the scrapped "Production
 * Requests" tab — see migration 020/021). Every requisition synced from
 * Busy lands with Status = 'PendingOpsApproval'. Here, the Ops Manager
 * reviews each line item next to its current stock picture (joined live
 * from dbo.ReorderStatus by item name) and Approves (-> 'Pending',
 * enters Procurement's existing RFQ dispatch flow unchanged) or Rejects
 * (-> 'RejectedByOps', dead-ends). Uses the same modal review pattern as
 * Goods Receiving for consistency.
 */
export default function OpsManagerApprovalPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState('goods-receiving'); // 'goods-receiving' | 'requisition-approval'

  return (
    <div>
      <div className="page-header"><h1>Ops Manager Approval</h1></div>

      {/* Scoped responsive rules — shared by both tabs' modals */}
      <style>{`
        @media (max-width: 640px) {
          .opsApproval-overlay { padding: 0 !important; align-items: stretch !important; }
          .opsApproval-modal { max-width: 100% !important; max-height: 100vh !important; border-radius: 0 !important; }
          .opsApproval-modal-header { padding: 14px 16px !important; }
          .opsApproval-modal-header h3 { font-size: 16px !important; }
          .opsApproval-modal-body { padding: 16px !important; }
          .opsApproval-form-row { flex-direction: column !important; }
          .opsApproval-actions { flex-direction: column !important; }
          .opsApproval-actions button { width: 100% !important; }
          .opsApproval-table-wrap table { font-size: 12px !important; }
        }
        .opsApproval-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
      `}</style>

      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '2px solid #e5e7eb' }}>
        {[['goods-receiving', 'Goods Receiving'], ['requisition-approval', 'Requisition Approval']].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            style={{
              padding: '10px 20px', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600,
              background: 'none', color: tab === key ? '#1a73e8' : '#6b7280',
              borderBottom: tab === key ? '2px solid #1a73e8' : '2px solid transparent',
              marginBottom: -2,
            }}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'goods-receiving' && <GoodsReceivingTab />}
      {tab === 'requisition-approval' && <RequisitionApprovalTab user={user} />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// TAB 1: Goods Receiving — original QA-inspection approval flow, unchanged
// ════════════════════════════════════════════════════════════════════════
function GoodsReceivingTab() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [form, setForm] = useState({ acceptedQty: '', rejectedQty: '', remarks: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const load = () => {
    setLoading(true);
    api.get('/ops-approval')
      .then(r => setEntries(r.data.data || []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const closeModal = useCallback(() => {
    setSelected(null);
    setDetail(null);
    setError('');
  }, []);

  useEffect(() => {
    if (!selected) return;
    const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [selected, closeModal]);

  const handleSelect = async (entry) => {
    setSelected(entry);
    setDetail(null);
    setDetailLoading(true);
    setError('');
    setSuccess('');
    try {
      const res = await api.get(`/ops-approval/${entry.EntryNo}`);
      setDetail(res.data);
      setForm({
        acceptedQty: res.data.AcceptedQty != null ? res.data.AcceptedQty : '',
        rejectedQty: res.data.RejectedQty != null ? res.data.RejectedQty : '',
        remarks: '',
      });
    } catch {
      setError('Failed to load entry details');
    } finally {
      setDetailLoading(false);
    }
  };

  const handleDecision = async (decision) => {
    setError('');
    setSuccess('');
    if (decision === 'Rejected' && !form.remarks.trim()) {
      setError('Please provide remarks when rejecting');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        decision,
        acceptedQty: form.acceptedQty !== '' ? parseFloat(form.acceptedQty) : null,
        rejectedQty: form.rejectedQty !== '' ? parseFloat(form.rejectedQty) : null,
        remarks: form.remarks,
      };
      const res = await api.patch(`/ops-approval/${selected.EntryNo}`, payload);
      setSuccess(`${selected.EntryNo}: ${res.data.message}`);
      closeModal();
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to process approval');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {success && <div className="card" style={{ color: 'var(--success)' }}>{success}</div>}
      {error && !selected && <div className="card" style={{ color: 'var(--danger)' }}>{error}</div>}

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>Entries Awaiting Ops Manager Approval ({entries.length})</h3>
        {loading ? <div>Loading…</div> : (
          <div className="opsApproval-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Entry No</th>
                <th>Supplier</th>
                <th>Consignment</th>
                <th>Vehicle</th>
                <th>Delivery Date</th>
                <th>QA Decision</th>
                <th>Accepted Qty</th>
                <th>Rejected Qty</th>
                <th>QA Inspector</th>
                <th>QA Approved At</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.EntryId}>
                  <td><strong>{e.EntryNo}</strong></td>
                  <td>{e.SupplierName}</td>
                  <td>{e.ConsignmentNo}</td>
                  <td>{e.VehicleRegNo}</td>
                  <td style={{ fontSize: 12, whiteSpace: 'nowrap', color: 'var(--gray-600)' }}>
                    {fmtDate(e.DeliveryDate)}
                    {e.DeliveryTime && <><br /><span style={{ color: 'var(--gray-500)' }}>{String(e.DeliveryTime).slice(0, 5)}</span></>}
                  </td>
                  <td>
                    <span className="badge badge-green">{e.QADecision}</span>
                  </td>
                  <td>{e.AcceptedQty != null ? `${e.AcceptedQty} kg` : '—'}</td>
                  <td>{e.RejectedQty > 0 ? <span style={{ color: '#dc2626' }}>{e.RejectedQty} kg</span> : '—'}</td>
                  <td>{e.InspectorName || '—'}</td>
                  <td style={{ fontSize: 12, whiteSpace: 'nowrap', color: 'var(--gray-600)' }}>{fmtDT(e.QADecisionAt || e.InspectionDate)}</td>
                  <td>
                    <button className="btn btn-primary" style={{ padding: '4px 12px', fontSize: 13 }}
                      onClick={() => handleSelect(e)}>Review</button>
                  </td>
                </tr>
              ))}
              {entries.length === 0 && (
                <tr><td colSpan="11" className="text-center text-muted">No entries pending Ops Manager approval</td></tr>
              )}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {selected && (
        <div
          onClick={closeModal}
          className="opsApproval-overlay"
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.55)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            padding: '5vh 16px', zIndex: 1000, overflowY: 'auto',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="opsApproval-modal"
            style={{
              background: '#fff', borderRadius: 12, width: '100%', maxWidth: 900,
              maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            }}
          >
            <div className="opsApproval-modal-header" style={{
              position: 'sticky', top: 0, background: '#fff', zIndex: 1,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '18px 24px', borderBottom: '1px solid #e5e7eb', borderRadius: '12px 12px 0 0',
            }}>
              <h3 style={{ margin: 0 }}>Review — {selected.EntryNo}</h3>
              <button
                onClick={closeModal}
                aria-label="Close"
                style={{
                  background: 'none', border: 'none', fontSize: 22, lineHeight: 1,
                  cursor: 'pointer', color: '#6b7280', padding: 4,
                }}
              >
                ✕
              </button>
            </div>

            <div className="opsApproval-modal-body" style={{ padding: 24 }}>
              {error && <div className="card" style={{ color: 'var(--danger)', marginBottom: 16 }}>{error}</div>}

              {detailLoading && (
                <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Loading entry details…</div>
              )}

              {!detailLoading && detail && (
                <>
                  <div style={{ padding: 12, background: 'var(--gray-50)', borderRadius: 'var(--radius)', marginBottom: 16 }}>
                    <strong>Supplier:</strong> {detail.SupplierName} |
                    <strong> Consignment:</strong> {detail.ConsignmentNo} |
                    <strong> Vehicle:</strong> {detail.VehicleRegNo} |
                    <strong> P.O:</strong> {detail.PurchaseOrderNo || 'N/A'}
                    {(detail.DeliveryDate || detail.DeliveryTime) && (
                      <> | <strong>Delivery:</strong> {fmtDate(detail.DeliveryDate)}{detail.DeliveryTime ? ' ' + String(detail.DeliveryTime).slice(0, 5) : ''}</>
                    )}
                    {detail.WBNetWeight && (<><br /><strong>Weighbridge Net:</strong> {detail.WBNetWeight} kg | <strong>Variance:</strong> {detail.WeightVariance} kg</>)}
                  </div>

                  <div style={{ padding: 12, background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 'var(--radius)', marginBottom: 16 }}>
                    <h4 style={{ margin: '0 0 8px' }}>QA Inspection Summary</h4>
                    <strong>Inspector:</strong> {detail.InspectorName || '—'} |
                    <strong> QA Approver:</strong> {detail.QAApproverName || '—'} |
                    <strong> Decision:</strong> <span style={{ color: '#16a34a', fontWeight: 600 }}>{detail.QADecision}</span>
                    <br />
                    <strong>COA Provided:</strong> {detail.COAProvided ? '✅ Yes' : '❌ No'}
                    {detail.COAReference && <> | <strong>COA Ref:</strong> {detail.COAReference}</>}
                    {' | '}<strong>Samples Taken:</strong> {detail.SamplesTaken ? '✅ Yes' : '❌ No'}
                    {' | '}<strong>Physical Check:</strong> {detail.PhysicalCheckDone ? '✅ Yes' : '❌ No'}
                    {' | '}<strong>Vehicle Inspection:</strong> {detail.VehicleInspectionDone ? '✅ Yes' : '❌ No'}
                    <br />
                    <strong>Accepted Qty:</strong> {detail.AcceptedQty != null ? `${detail.AcceptedQty} kg` : '—'} |
                    <strong> Rejected Qty:</strong> {detail.RejectedQty > 0 ? `${detail.RejectedQty} kg` : '0'} |
                    <strong> QA Remarks:</strong> {detail.QARemarks || '—'}
                  </div>

                  <h4 style={{ margin: '0 0 8px' }}>Materials</h4>
                  <div className="opsApproval-table-wrap" style={{ marginBottom: 16 }}>
                  <table className="data-table">
                    <thead>
                      <tr><th>Material</th><th>Quantity</th><th>UOM</th></tr>
                    </thead>
                    <tbody>
                      {(detail.items || []).map((it, i) => (
                        <tr key={i}>
                          <td>{it.MaterialCode} — {it.MaterialName}</td>
                          <td>{it.Quantity}</td>
                          <td>{it.UOM}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>

                  {detail.testResults && detail.testResults.length > 0 && (
                    <>
                      <h4 style={{ margin: '0 0 8px' }}>QA Test Results</h4>
                      <div className="opsApproval-table-wrap" style={{ marginBottom: 16 }}>
                      <table className="data-table">
                        <thead>
                          <tr><th>Material</th><th>Test</th><th>Spec Min</th><th>Spec Max</th><th>Actual</th><th>Result</th></tr>
                        </thead>
                        <tbody>
                          {detail.testResults.map((t, i) => (
                            <tr key={i}>
                              <td>{t.MaterialName}</td>
                              <td>{t.TestName}</td>
                              <td>{t.SpecMin != null ? t.SpecMin : '—'}</td>
                              <td>{t.SpecMax != null ? t.SpecMax : '—'}</td>
                              <td>{t.ActualValue != null ? t.ActualValue : '—'}</td>
                              <td>
                                <span className={`badge ${t.Result === 'Pass' ? 'badge-green' : t.Result === 'Fail' ? 'badge-red' : 'badge-yellow'}`}>
                                  {t.Result || 'Pending'}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      </div>
                    </>
                  )}

                  <div style={{ padding: 16, background: '#fffbeb', border: '1px solid #fbbf24', borderRadius: 'var(--radius)' }}>
                    <h4 style={{ margin: '0 0 12px' }}>Ops Manager Decision</h4>
                    <div className="form-row opsApproval-form-row" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      <div className="form-group" style={{ flex: '1 1 200px' }}>
                        <label>Accepted Qty (kg) — editable</label>
                        <input type="number" step="0.01" value={form.acceptedQty}
                          onChange={e => setForm({ ...form, acceptedQty: e.target.value })} />
                      </div>
                      <div className="form-group" style={{ flex: '1 1 200px' }}>
                        <label>Rejected Qty (kg) — editable</label>
                        <input type="number" step="0.01" value={form.rejectedQty}
                          onChange={e => setForm({ ...form, rejectedQty: e.target.value })} />
                      </div>
                    </div>
                    <div className="form-group">
                      <label>Remarks</label>
                      <textarea rows="3" value={form.remarks}
                        onChange={e => setForm({ ...form, remarks: e.target.value })}
                        placeholder="Required if rejecting — QA will see this when they re-inspect…" />
                    </div>
                    <p style={{ fontSize: 12, color: '#92400e', margin: '0 0 8px' }}>
                      Rejecting sends this entry back to QA for a fresh inspection — it is not a
                      dead end. Your remarks above explain why to whoever picks it up next.
                    </p>
                    <div className="opsApproval-actions" style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                      <button className="btn btn-success" disabled={saving}
                        onClick={() => handleDecision('Approved')}>
                        {saving ? 'Processing…' : '✅ Approve for Receiving'}
                      </button>
                      <button className="btn" style={{ background: '#dc2626', color: '#fff', border: 'none' }} disabled={saving}
                        onClick={() => handleDecision('Rejected')}>
                        {saving ? 'Processing…' : '↩️ Reject — send back to QA'}
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
    </>
  );
}

// ════════════════════════════════════════════════════════════════════════
// TAB 2: Requisition Approval — gates Busy-synced requisitions before
// Procurement sees them. Shows each item's live stock next to the
// requested qty so the Ops Manager can judge if it's genuinely still
// needed, then Approves (-> Procurement's existing list) or Rejects.
// ════════════════════════════════════════════════════════════════════════
function RequisitionApprovalTab({ user }) {
  const canDecide = ['OpsManager', 'Director', 'Admin'].includes(user?.role);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const load = () => {
    setLoading(true);
    api.get('/procurement/requisition-approval/pending')
      .then(r => setRows(r.data))
      .catch(() => setError('Failed to load pending requisitions'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const [selectedReq, setSelectedReq] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // Per-item decision state: { [requisitionItemId]: { decision, approvedQty, rejectionReason } }
  const [itemDecisions, setItemDecisions] = useState({});
  const [notes, setNotes] = useState('');
  const [deciding, setDeciding] = useState(false);
  const [holding, setHolding] = useState(false);
  const [holdReason, setHoldReason] = useState('');
  const [showHoldPrompt, setShowHoldPrompt] = useState(false);

  const closeModal = useCallback(() => {
    setSelectedReq(null);
    setDetail(null);
    setError('');
    setShowHoldPrompt(false);
    setHoldReason('');
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
    setShowHoldPrompt(false);
    setHoldReason('');
    try {
      const res = await api.get(`/procurement/requisition-approval/${row.RequisitionId}`);
      setDetail(res.data);
      setNotes('');
      // Default every item to Approved at its full requested qty — the
      // Ops Manager only has to touch the items they actually want to
      // turn down, same "default to yes, flag exceptions" pattern as the
      // Director's per-item award screen.
      const initial = {};
      (res.data.items || []).forEach((it) => {
        initial[it.RequisitionItemId] = {
          decision: it.ItemDecision || 'Approved',
          approvedQty: it.ItemApprovedQty != null ? String(it.ItemApprovedQty) : String(it.Qty),
          rejectionReason: it.ItemRejectionReason || '',
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
    setDeciding(true);
    try {
      const res = await api.patch(`/procurement/requisition-approval/${selectedReq.RequisitionId}/decision`, {
        items, notes,
      });
      setSuccess(
        res.data.status === 'Pending'
          ? `${selectedReq.BusyOrdNo}: ${res.data.approvedCount} item(s) approved — now visible to Procurement${res.data.rejectedCount ? `, ${res.data.rejectedCount} item(s) rejected` : ''}`
          : `${selectedReq.BusyOrdNo}: all items rejected — requisition dead-ended`
      );
      closeModal();
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to submit decision');
    } finally {
      setDeciding(false);
    }
  };

  const handleHold = async () => {
    setError('');
    setHolding(true);
    try {
      await api.patch(`/procurement/requisition-approval/${selectedReq.RequisitionId}/hold`, { reason: holdReason });
      setSuccess(`${selectedReq.BusyOrdNo} put on hold — it'll stay in this list until you decide it.`);
      closeModal();
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to hold requisition');
    } finally {
      setHolding(false);
    }
  };

  return (
    <>
      {success && <div className="card" style={{ color: 'var(--success)' }}>{success}</div>}
      {error && !selectedReq && <div className="card" style={{ color: 'var(--danger)' }}>{error}</div>}

      <div className="card">
        <h3 style={{ marginBottom: 4 }}>
          Requisitions Awaiting Ops Manager Approval ({rows.length})
          {rows.some((r) => r.Status === 'OnHold') && (
            <span style={{ fontSize: 12, fontWeight: 400, color: '#92400e', marginLeft: 10 }}>
              {rows.filter((r) => r.Status === 'OnHold').length} on hold
            </span>
          )}
        </h3>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
          A notification email goes out automatically as soon as a requisition lands here, with
          one-click "Approve All" and "Hold for Review" links — no need to log in just to approve.
        </p>
        <div className="opsApproval-table-wrap">
        <table className="data-table">
          <thead>
            <tr><th>Busy Ord No</th><th>Date</th><th>Warehouse</th><th>Mat Centre</th><th>Items</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="7" className="text-center text-muted">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan="7" className="text-center text-muted">No requisitions pending approval</td></tr>
            ) : rows.map(r => (
              <tr key={r.RequisitionId} style={r.Status === 'OnHold' ? { background: '#fffbeb' } : undefined}>
                <td><strong>{r.BusyOrdNo}</strong></td>
                <td style={{ fontSize: 12, color: 'var(--gray-600)' }}>{fmtDate(r.BusyDate)}</td>
                <td>{r.Warehouse || '—'}</td>
                <td>{r.MatCenter || '—'}</td>
                <td>{r.ItemCount}</td>
                <td>
                  {r.Status === 'OnHold' ? (
                    <span className="badge badge-yellow" title={r.HoldReason || undefined}>⏸ On Hold</span>
                  ) : (
                    <span className="badge badge-gray">Pending</span>
                  )}
                </td>
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
          className="opsApproval-overlay"
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.55)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            padding: '5vh 16px', zIndex: 1000, overflowY: 'auto',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="opsApproval-modal"
            style={{
              background: '#fff', borderRadius: 12, width: '100%', maxWidth: 900,
              maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            }}
          >
            <div className="opsApproval-modal-header" style={{
              position: 'sticky', top: 0, background: '#fff', zIndex: 1,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '18px 24px', borderBottom: '1px solid #e5e7eb', borderRadius: '12px 12px 0 0',
            }}>
              <h3 style={{ margin: 0 }}>{selectedReq.BusyOrdNo}</h3>
              <button
                onClick={closeModal}
                aria-label="Close"
                style={{
                  background: 'none', border: 'none', fontSize: 22, lineHeight: 1,
                  cursor: 'pointer', color: '#6b7280', padding: 4,
                }}
              >
                ✕
              </button>
            </div>

            <div className="opsApproval-modal-body" style={{ padding: 24 }}>
              {error && <div className="card" style={{ color: 'var(--danger)', marginBottom: 16 }}>{error}</div>}

              {detailLoading && (
                <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Loading…</div>
              )}

              {!detailLoading && detail && (
                <>
                  <div style={{ padding: 12, background: 'var(--gray-50)', borderRadius: 'var(--radius)', marginBottom: 16 }}>
                    <strong>Warehouse:</strong> {detail.Warehouse || '—'} | <strong>Mat Centre:</strong> {detail.MatCenter || '—'} |{' '}
                    <strong>Date:</strong> {fmtDate(detail.BusyDate)}
                  </div>

                  {detail.Status === 'OnHold' && (
                    <div style={{ padding: 12, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 'var(--radius)', marginBottom: 16, fontSize: 13, color: '#92400e' }}>
                      ⏸ <strong>On hold</strong> since {fmtDT(detail.HoldAt)}{detail.HoldByName ? ` by ${detail.HoldByName}` : ''}.
                      {detail.HoldReason && <div style={{ marginTop: 4 }}>Reason: {detail.HoldReason}</div>}
                      {' '}Decide the items below whenever you're ready — no need to un-hold first.
                    </div>
                  )}

                  <h4 style={{ margin: '0 0 4px' }}>Items — decide per item against current stock</h4>
                  <p style={{ margin: '0 0 8px', fontSize: 12, color: '#6b7280' }}>
                    Every item defaults to Approved at its full requested qty. Reject the ones that
                    aren't needed (e.g. sufficient live stock) — the rest still go to Procurement.
                  </p>
                  <StockPicture
                    title="Whole picture for these items (live from Busy)"
                    items={detail.items.map((i) => ({ name: i.ItemCode || i.ItemName, requestedQty: i.Qty }))}
                  />
                  {canDecide && (
                    <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                      <button className="btn btn-outline" style={{ padding: '4px 10px', fontSize: 12 }} onClick={approveAll}>Approve All</button>
                      <button className="btn btn-outline" style={{ padding: '4px 10px', fontSize: 12 }} onClick={rejectAll}>Reject All</button>
                    </div>
                  )}
                  <div className="opsApproval-table-wrap" style={{ marginBottom: 16 }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Item</th><th>Requested Qty</th><th>Live Stock</th><th>Reorder Level</th><th>Needs Reorder?</th>
                        {canDecide && <><th>Decision</th><th>Approved Qty / Rejection Reason</th></>}
                      </tr>
                    </thead>
                    <tbody>
                      {detail.items.map(i => {
                        const d = itemDecisions[i.RequisitionItemId] || { decision: 'Approved', approvedQty: String(i.Qty), rejectionReason: '' };
                        const isRejected = d.decision === 'Rejected';
                        return (
                          <tr key={i.RequisitionItemId} style={isRejected ? { background: '#fef2f2' } : undefined}>
                            <td>{i.ItemName}</td>
                            <td>{i.Qty}</td>
                            <td>{i.LiveStock != null ? i.LiveStock : <span className="text-muted">no stock data</span>}</td>
                            <td>{i.ReorderLevel != null ? i.ReorderLevel : '—'}</td>
                            <td>
                              {i.LiveStock == null ? '—' : (
                                <span className={`badge ${i.NeedsReorder ? 'badge-red' : 'badge-green'}`}>
                                  {i.NeedsReorder ? 'Yes' : 'No — sufficient stock'}
                                </span>
                              )}
                            </td>
                            {canDecide && (
                              <>
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
                              </>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  </div>

                  {canDecide && (
                    <div style={{ padding: 16, background: '#fffbeb', border: '1px solid #fbbf24', borderRadius: 'var(--radius)' }}>
                      <h4 style={{ margin: '0 0 12px' }}>
                        Decision — {approvedCount} approved, {rejectedCount} rejected
                      </h4>
                      {allRejected && (
                        <p style={{ fontSize: 12, color: '#991b1b', margin: '0 0 10px' }}>
                          Every item is rejected — submitting will dead-end this requisition entirely (RejectedByOps).
                        </p>
                      )}
                      <div className="form-group">
                        <label>Notes (optional)</label>
                        <textarea rows="2" value={notes} onChange={e => setNotes(e.target.value)} />
                      </div>

                      {showHoldPrompt && (
                        <div className="form-group">
                          <label>Hold Reason (optional)</label>
                          <textarea rows="2" value={holdReason} onChange={e => setHoldReason(e.target.value)}
                            placeholder="e.g. waiting on a stock recount…" autoFocus />
                        </div>
                      )}

                      <div className="opsApproval-actions" style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                        <button className="btn btn-success" disabled={deciding || holding}
                          onClick={handleSubmitDecision}>
                          {deciding ? 'Processing…' : allRejected ? '❌ Submit — reject all' : '✅ Submit Decision'}
                        </button>
                        {detail.Status !== 'OnHold' && (
                          showHoldPrompt ? (
                            <button className="btn" style={{ background: '#d97706', color: '#fff', border: 'none' }}
                              disabled={holding || deciding} onClick={handleHold}>
                              {holding ? 'Holding…' : 'Confirm Hold'}
                            </button>
                          ) : (
                            <button className="btn btn-outline" disabled={deciding || holding}
                              onClick={() => setShowHoldPrompt(true)}>
                              ⏸ Hold for Now
                            </button>
                          )
                        )}
                        <button className="btn btn-outline" onClick={closeModal}>Cancel</button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}