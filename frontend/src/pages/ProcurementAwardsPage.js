import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import MarkLpoRaisedModal from '../components/MarkLpoRaisedModal';
import RaisePoInBusyModal from '../components/RaisePoInBusyModal';

/**
 * Procurement's "raise this in Busy" queue — every RFQ a Director has
 * already approved winner(s) for, but which doesn't have an LPO reconciled
 * yet. Once Procurement creates the LPO in Busy ERP, the ordno gets matched
 * back on the LPO Reconciliation page, which removes it from this list.
 *
 * The /awarded API returns one row PER (RFQ, awarded supplier) — a "full"
 * award RFQ has exactly one row, a "split" award RFQ has one row per
 * supplier who won at least one item, ALL sharing the same
 * QuoteEvaluationId. This page groups rows by RFQId so a split award shows
 * as one RFQ card with multiple supplier sub-cards inside it.
 *
 * Undo Approval (2026-07-31): sends the RFQ back to the Director Evaluation
 * pending queue. This is RFQ-level, not supplier-level — even on a split
 * award, undoing removes the QuoteEvaluations row for the WHOLE RFQ (every
 * supplier's awarded items), reverting all linked requisitions. It never
 * touches Quotations or the RFQ itself, so the record of what suppliers
 * quoted is preserved. Blocked server-side (409) if ANY supplier's LPO has
 * already been reconciled for the RFQ.
 *
 * Mark LPO Raised in Busy (2026-10-15): links the supplier's award to the
 * Busy Purchase Order Procurement raised (see MarkLpoRaisedModal and
 * routes/procurement/busy-lpo.routes.js). It creates the same record as
 * LPO Reconciliation, so the award drops off this list and shows on the
 * "LPOs Raised in Busy" page.
 */
export default function ProcurementAwardsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canMarkRaised = ['Admin', 'Procurement'].includes(user?.role);
  const isViewer = user?.role === 'Viewer';
  const [markTarget, setMarkTarget] = useState(null); // award row being marked raised
  const [raiseTarget, setRaiseTarget] = useState(null); // award row being raised in Busy from here
  const [successMsg, setSuccessMsg] = useState('');

  const [awards, setAwards]       = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [expandedKey, setExpandedKey] = useState(null); // composite key, see awardKey()
  const [copiedKey, setCopiedKey] = useState(null);
  const [undoingRfqId, setUndoingRfqId] = useState(null); // RFQId currently being undone

  const load = () => {
    setLoading(true);
    setError('');
    api.get('/procurement/evaluation/awarded')
      .then((res) => setAwards(Array.isArray(res.data) ? res.data : []))
      .catch((e) => setError(e.response?.data?.error || 'Failed to load awarded suppliers'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  // Live-update as soon as a Director approves (or undoes) an evaluation
  // elsewhere — either another browser tab (storage event) or this same
  // tab regaining focus — so Procurement doesn't have to remember to hit
  // Refresh to see a newly-awarded RFQ show up here.
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

  // Split rows share QuoteEvaluationId across suppliers on the same RFQ,
  // so a per-row unique key needs the supplier (or quotation, for legacy
  // full-award rows which have no SupplierId collision risk anyway).
  const awardKey = (a) => `${a.QuoteEvaluationId}:${a.SupplierId ?? a.QuotationId}`;

  // Group rows by RFQ so a split award renders as one RFQ card containing
  // several supplier sub-rows, instead of several disconnected cards.
  const groups = useMemo(() => {
    const map = new Map();
    for (const a of awards) {
      if (!map.has(a.RFQId)) map.set(a.RFQId, []);
      map.get(a.RFQId).push(a);
    }
    return [...map.values()].sort(
      (x, y) => new Date(y[0].ApprovedAt) - new Date(x[0].ApprovedAt)
    );
  }, [awards]);

  const fmtMoney = (n) =>
    n === null || n === undefined
      ? '—'
      : Number(n).toLocaleString(undefined, { style: 'currency', currency: 'KES', maximumFractionDigits: 2 });
  const fmtDate = (d) =>
    d ? new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

  const copyItemsForBusy = (award) => {
    const lines = award.lineItems.map((li) =>
      `${li.ItemName}\tQty: ${Number(li.Qty).toLocaleString()}\tUnit Price: KES ${Number(li.UnitPrice).toLocaleString(undefined, { minimumFractionDigits: 2 })}${li.Brand ? `\tBrand: ${li.Brand}` : ''}`
    );
    const text = [
      `Supplier: ${award.SupplierName}`,
      `RFQ: ${award.RFQNumber}${award.BusyOrdNo ? ` (Requisition ${award.BusyOrdNo})` : ''}`,
      award.awardType === 'split' ? '(Split award — items below are only this supplier\'s portion)' : null,
      `Payment Terms: ${award.PaymentTerms || '—'}`,
      `Delivery: ${award.DeliveryDays != null ? `${award.DeliveryDays} days` : '—'}`,
      '',
      ...lines,
    ].filter(Boolean).join('\n');

    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(awardKey(award));
      setTimeout(() => setCopiedKey(null), 2000);
    });
  };

  const goToReconciliation = (award) => {
    // Reconciliation matches on RFQId alone for full awards, and on
    // RFQId + SupplierId for split awards (mirrors the router's join).
    const params = new URLSearchParams({ rfqId: award.RFQId, quoteEvaluationId: award.QuoteEvaluationId });
    if (award.awardType === 'split') params.set('supplierId', award.SupplierId);
    navigate(`/procurement/reconciliation?${params.toString()}`);
  };

  const undoApproval = async (group) => {
    const first = group[0];
    const isSplit = first.awardType === 'split';
    const supplierNames = group.map((a) => a.SupplierName).join(', ');
    const confirmed = window.confirm(
      isSplit
        ? `Undo the approval for ${first.RFQNumber}?\n\n` +
          `This RFQ was split-awarded to ${group.length} suppliers (${supplierNames}). ` +
          `Undoing removes ALL of their awarded items, not just one — the RFQ goes back to ` +
          `pending evaluation entirely. Quotations already submitted are not affected.`
        : `Undo the approval of ${first.SupplierName} for ${first.RFQNumber}?\n\n` +
          `This removes the director's decision and sends the RFQ back to pending evaluation. ` +
          `Quotations already submitted are not affected.`
    );
    if (!confirmed) return;

    setUndoingRfqId(first.RFQId);
    setError('');
    try {
      await api.delete(`/procurement/evaluation/${first.RFQId}`);
      load();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to undo approval');
    } finally {
      setUndoingRfqId(null);
    }
  };

  const renderSupplierBlock = (a, group) => {
    const key = awardKey(a);
    const isOpen = expandedKey === key;
    const isCopied = copiedKey === key;

    return (
      <div key={key} style={{ borderTop: group.length > 1 ? '1px solid #e5e7eb' : 'none' }}>
        <div
          onClick={() => setExpandedKey(isOpen ? null : key)}
          style={{
            padding: '14px 20px', cursor: 'pointer', display: 'flex',
            justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12,
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <strong style={{ fontSize: 15 }}>{a.SupplierName}</strong>
              {a.awardType === 'split' && (
                <span className="badge badge-blue" style={{ fontSize: 11 }}>Split award</span>
              )}
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
              Approved by {a.DirectorName || 'Director'} on {fmtDate(a.ApprovedAt)} ·
              {' '}{a.lineItems.length} item{a.lineItems.length !== 1 ? 's' : ''}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: '#1e3a5f' }}>
              {fmtMoney(a.TotalAmount)}
            </div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              {isOpen ? 'Click to collapse ▲' : 'Click to view items ▼'}
            </div>
          </div>
        </div>

        {isOpen && (
          <div style={{ padding: '0 20px 16px' }}>
            <div style={{
              display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 16,
              fontSize: 13, color: '#374151',
            }}>
              <div><strong>Contact:</strong> {a.Phone || a.WhatsApp || '—'}{a.Email ? ` · ${a.Email}` : ''}</div>
              <div><strong>Payment Terms:</strong> {a.PaymentTerms || '—'}</div>
              <div><strong>Delivery:</strong> {a.DeliveryDays != null ? `${a.DeliveryDays} days` : '—'}</div>
              <div><strong>Quote Valid Until:</strong> {fmtDate(a.ValidUntil)}</div>
            </div>

            {a.EvalNotes && (
              <div style={{
                fontSize: 13, color: '#374151', background: '#f9fafb',
                border: '1px solid #e5e7eb', borderRadius: 6, padding: '8px 12px', marginBottom: 16,
              }}>
                <strong>Director's Notes:</strong> {a.EvalNotes}
              </div>
            )}

            <table className="data-table" style={{ marginBottom: 12 }}>
              <thead>
                <tr>
                  <th>Item</th>
                  <th style={{ textAlign: 'center' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Unit Price</th>
                  <th style={{ textAlign: 'right' }}>Line Total</th>
                  <th>Brand</th>
                  <th>Quality</th>
                  <th>Photo</th>
                </tr>
              </thead>
              <tbody>
                {a.lineItems.map((li) => (
                  <tr key={li.RequisitionItemId}>
                    <td>{li.ItemName}</td>
                    <td style={{ textAlign: 'center', fontFamily: 'monospace' }}>{Number(li.Qty).toLocaleString()}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{fmtMoney(li.UnitPrice)}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>
                      {fmtMoney(Number(li.UnitPrice) * Number(li.Qty))}
                    </td>
                    <td style={{ fontSize: 13 }}>{li.Brand || <span style={{ color: '#9ca3af' }}>—</span>}</td>
                    <td style={{ fontSize: 13 }}>{li.QualityDescription || <span style={{ color: '#9ca3af' }}>—</span>}</td>
                    <td>
                      {li.PhotoUrl
                        ? (
                          <a href={li.PhotoUrl} target="_blank" rel="noopener noreferrer">
                            <img src={li.PhotoUrl} alt="Supplier item" style={{ width: 32, height: 32, objectFit: 'cover', borderRadius: 4, border: '1px solid #e5e7eb' }} />
                          </a>
                        )
                        : <span style={{ color: '#9ca3af' }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => copyItemsForBusy(a)}>
                {isCopied ? 'Copied ✓' : 'Copy Items for Busy'}
              </button>
              {canMarkRaised && (
                <button className="btn btn-primary btn-sm" onClick={() => { setSuccessMsg(''); setRaiseTarget(a); }}>
                  Raise PO in Busy
                </button>
              )}
              {canMarkRaised && (
                <button className="btn btn-success btn-sm" onClick={() => { setSuccessMsg(''); setMarkTarget(a); }}>
                  ✓ Mark LPO Raised in Busy
                </button>
              )}
              {!isViewer && (
                <button className="btn btn-primary btn-sm" onClick={() => goToReconciliation(a)}>
                  Go to LPO Reconciliation
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Awarded Suppliers — Raise LPO in Busy</h1>
          <p className="page-subtitle">
            Directors have approved these winning quotations. Create the corresponding LPO in
            Busy ERP, then match it on the LPO Reconciliation page.
          </p>
        </div>
        <button className="btn btn-secondary" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}
      {successMsg && (
        <div className="alert alert-success" style={{ marginBottom: 16 }}>
          {successMsg}{' '}
          <a href="/procurement/lpo-raised" onClick={(e) => { e.preventDefault(); navigate('/procurement/lpo-raised'); }}>
            View LPOs Raised in Busy →
          </a>
        </div>
      )}

      {markTarget && (
        <MarkLpoRaisedModal
          award={markTarget}
          onClose={() => setMarkTarget(null)}
          onMarked={(lpo) => {
            // The award is now linked to a Busy LPO, so /awarded no longer
            // returns it. Drop it immediately (just this supplier's share on
            // a split award), then reload to stay in sync with the server.
            const doneKey = awardKey(markTarget);
            setAwards((prev) => prev.filter((a) => awardKey(a) !== doneKey));
            setExpandedKey(null);
            setSuccessMsg(`${markTarget.SupplierName} on ${markTarget.RFQNumber} marked as raised in Busy (${lpo.ordno}) and moved to LPOs Raised in Busy.`);
            setMarkTarget(null);
            // Refresh other open Awarded Suppliers tabs (they listen for this key).
            try { localStorage.setItem('ncf:rfqEvaluationChanged', String(Date.now())); } catch { /* storage unavailable */ }
            load();
          }}
        />
      )}

      {raiseTarget && (
        <RaisePoInBusyModal
          award={raiseTarget}
          onClose={() => setRaiseTarget(null)}
          onRaised={(lpo, data) => {
            const doneKey = awardKey(raiseTarget);
            setAwards((prev) => prev.filter((a) => awardKey(a) !== doneKey));
            setExpandedKey(null);
            setSuccessMsg(`${lpo.ordno} raised in Busy for ${raiseTarget.SupplierName} on ${raiseTarget.RFQNumber} (${lpo.approvalLabel}) and moved to LPOs Raised in Busy.${data?.approvalWarning ? ` ⚠ ${data.approvalWarning}` : ''}${data?.totalWarning ? ` ⚠ ${data.totalWarning}` : ''}${data?.userWarning ? ` ⚠ ${data.userWarning}` : ''}`);
            setRaiseTarget(null);
            try { localStorage.setItem('ncf:rfqEvaluationChanged', String(Date.now())); } catch { /* storage unavailable */ }
            load();
          }}
        />
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Loading…</div>
      ) : groups.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>
          Nothing waiting — every approved award already has an LPO reconciled.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {groups.map((group) => {
            const first = group[0];
            const isSplit = first.awardType === 'split';
            const isUndoing = undoingRfqId === first.RFQId;
            return (
              <div key={first.RFQId} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{
                  padding: '14px 20px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12,
                }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span className="badge badge-gray" style={{ fontSize: 11 }}>{first.RFQNumber}</span>
                      {isSplit ? (
                        <span className="badge badge-blue" style={{ fontSize: 11 }}>
                          Split award · {group.length} supplier{group.length !== 1 ? 's' : ''}
                        </span>
                      ) : (
                        <span className="badge badge-green" style={{ fontSize: 11 }}>Full award</span>
                      )}
                    </div>
                    {first.BusyOrdNo && (
                      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                        Req: {first.BusyOrdNo} · {first.MatCenter || first.Warehouse || '—'}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>Total across supplier(s)</div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: '#1e3a5f' }}>
                        {fmtMoney(group.reduce((sum, a) => sum + Number(a.TotalAmount || 0), 0))}
                      </div>
                    </div>
                    {!isViewer && (
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => undoApproval(group)}
                        disabled={isUndoing}
                      >
                        {isUndoing ? 'Undoing…' : 'Undo Approval'}
                      </button>
                    )}
                  </div>
                </div>

                {group.map((a) => renderSupplierBlock(a, group))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}