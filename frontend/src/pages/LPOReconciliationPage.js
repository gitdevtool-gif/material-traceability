import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../services/api';

export default function LPOReconciliationPage() {
  const [searchParams] = useSearchParams();
  const [tab, setTab]                   = useState('pending'); // 'pending' | 'done'
  const [pendingLPOs, setPendingLPOs]   = useState([]);
  const [doneList, setDoneList]         = useState([]);
  const [loading, setLoading]           = useState(false);
  const [dateFrom, setDateFrom]         = useState('');
  const [dateTo, setDateTo]             = useState('');
  const [search, setSearch]             = useState('');

  // Reconcile modal state
  const [modalLPO, setModalLPO]                 = useState(null);
  const [rfqId, setRfqId]                       = useState('');
  const [requisitionId, setRequisitionId]       = useState('');
  const [quoteEvaluationId, setQuoteEvalId]     = useState('');
  const [supplierId, setSupplierId]             = useState('');
  const [reconNotes, setReconNotes]             = useState('');
  const [submitting, setSubmitting]             = useState(false);
  const [error, setError]                       = useState('');
  const [success, setSuccess]                   = useState('');

  // Context passed in from the Awards page's "Go to LPO Reconciliation"
  // link (?rfqId=&quoteEvaluationId=&supplierId=) so the matching fields
  // below don't have to be re-typed manually.
  const prefill = {
    rfqId:             searchParams.get('rfqId') || '',
    quoteEvaluationId: searchParams.get('quoteEvaluationId') || '',
    supplierId:        searchParams.get('supplierId') || '',
  };
  const hasPrefill = !!(prefill.rfqId || prefill.quoteEvaluationId || prefill.supplierId);

  const loadPending = () => {
    setLoading(true);
    const params = {};
    if (dateFrom) params.dateFrom = dateFrom;
    if (dateTo)   params.dateTo   = dateTo;
    if (search)   params.search   = search;
    api.get('/procurement/reconciliation/pending-lpos', { params })
      .then((r) => setPendingLPOs(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  const loadDone = () => {
    setLoading(true);
    api.get('/procurement/reconciliation')
      .then((r) => setDoneList(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (tab === 'pending') loadPending();
    else loadDone();
  }, [tab, dateFrom, dateTo, search]);

  const openModal = (lpo) => {
    setModalLPO(lpo);
    setRfqId(prefill.rfqId);
    setRequisitionId('');
    setQuoteEvalId(prefill.quoteEvaluationId);
    setSupplierId(prefill.supplierId);
    setReconNotes('');
    setError('');
    setSuccess('');
  };

  const handleReconcile = async () => {
    if (!modalLPO) return;
    setSubmitting(true);
    setError('');
    try {
      await api.post('/procurement/reconciliation', {
        busyPurOrdNo:      modalLPO.ordno,
        busySupplier:      modalLPO.supplier,
        busyDate:          modalLPO.date ? new Date(modalLPO.date).toISOString().split('T')[0] : null,
        totalActualAmt:    modalLPO.totalAmt,
        rfqId:             rfqId ? parseInt(rfqId, 10) : null,
        requisitionId:     requisitionId ? parseInt(requisitionId, 10) : null,
        quoteEvaluationId: quoteEvaluationId ? parseInt(quoteEvaluationId, 10) : null,
        supplierId:        supplierId ? parseInt(supplierId, 10) : null,
        notes:             reconNotes || null,
      });
      setSuccess(`LPO ${modalLPO.ordno} reconciled successfully.`);
      setModalLPO(null);
      loadPending();
    } catch (e) {
      setError(e.response?.data?.error || 'Reconciliation failed');
    } finally {
      setSubmitting(false);
    }
  };

  const varianceColor = (v) => {
    if (v === null || v === undefined) return '#6b7280';
    const n = Number(v);
    if (n > 0)  return '#dc2626';
    if (n < 0)  return '#059669';
    return '#374151';
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">LPO Reconciliation</h1>
          <p className="page-subtitle">Match Busy PurOrder rows back to requisitions and approved quotations</p>
        </div>
      </div>

      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '2px solid #e5e7eb' }}>
        {[['pending', 'Unreconciled LPOs'], ['done', 'Completed']].map(([key, label]) => (
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

      {tab === 'pending' && (
        <>
          {/* Filters */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <input className="form-input" placeholder="Search ordno / supplier…"
              value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 220 }} />
            <input type="date" className="form-input" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ width: 150 }} />
            <input type="date" className="form-input" value={dateTo}   onChange={(e) => setDateTo(e.target.value)}   style={{ width: 150 }} />
          </div>

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Busy Ord No</th>
                  <th>Date</th>
                  <th>Supplier</th>
                  <th>Mat Centre</th>
                  <th>Items</th>
                  <th>Total Amt (KES)</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={7} style={{ textAlign: 'center', padding: 32, color: '#6b7280' }}>Loading…</td></tr>
                )}
                {!loading && pendingLPOs.length === 0 && (
                  <tr><td colSpan={7} style={{ textAlign: 'center', padding: 32, color: '#6b7280' }}>No unreconciled LPOs found</td></tr>
                )}
                {pendingLPOs.map((lpo) => (
                  <tr key={lpo.ordno}>
                    <td><strong>{lpo.ordno}</strong></td>
                    <td>{lpo.date ? new Date(lpo.date).toLocaleDateString('en-KE') : '—'}</td>
                    <td>{lpo.supplier || '—'}</td>
                    <td>{lpo.matCenter || '—'}</td>
                    <td style={{ textAlign: 'center' }}>{lpo.items.length}</td>
                    <td style={{ fontWeight: 600 }}>KES {Number(lpo.totalAmt).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                    <td>
                      <button className="btn btn-primary" style={{ padding: '4px 12px', fontSize: 12 }}
                        onClick={() => openModal(lpo)}>
                        Reconcile
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'done' && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Busy PurOrd No</th>
                <th>Supplier</th>
                <th>Date</th>
                <th>Req Ordno(s)</th>
                <th>RFQ No</th>
                <th>Quoted (KES)</th>
                <th>Actual (KES)</th>
                <th>Benchmark (KES)</th>
                <th>Variance</th>
                <th>Reconciled By</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={10} style={{ textAlign: 'center', padding: 32, color: '#6b7280' }}>Loading…</td></tr>
              )}
              {!loading && doneList.length === 0 && (
                <tr><td colSpan={10} style={{ textAlign: 'center', padding: 32, color: '#6b7280' }}>No reconciled LPOs yet</td></tr>
              )}
              {doneList.map((rec) => (
                <tr key={rec.LPOReconciliationId}>
                  <td><strong>{rec.BusyPurOrdNo}</strong></td>
                  <td>{rec.BusySupplier || rec.WinningSupplierName || '—'}</td>
                  <td>{rec.BusyDate ? new Date(rec.BusyDate).toLocaleDateString('en-KE') : '—'}</td>
                  <td>{rec.RequisitionOrdNo || '—'}</td>
                  <td>{rec.RFQNumber || '—'}</td>
                  <td>{rec.TotalQuotedAmt != null ? `KES ${Number(rec.TotalQuotedAmt).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '—'}</td>
                  <td style={{ fontWeight: 600 }}>KES {Number(rec.TotalActualAmt).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                  <td style={{ color: '#6b7280' }}>{rec.BenchmarkAmt != null ? `KES ${Number(rec.BenchmarkAmt).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '—'}</td>
                  <td style={{ fontWeight: 600, color: varianceColor(rec.VarianceAmt) }}>
                    {rec.VarianceAmt != null
                      ? `${rec.VarianceAmt > 0 ? '+' : ''}KES ${Number(rec.VarianceAmt).toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                      : '—'}
                  </td>
                  <td style={{ fontSize: 12, color: '#6b7280' }}>{rec.ReconciledByName || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Reconcile modal */}
      {modalLPO && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{ background: '#fff', borderRadius: 10, padding: 28, width: 520, maxHeight: '90vh', overflow: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
            <h2 style={{ margin: '0 0 16px', fontSize: 17 }}>Reconcile — {modalLPO.ordno}</h2>

            {hasPrefill && (
              <div className="alert alert-info" style={{ marginBottom: 12, fontSize: 12 }}>
                RFQ / evaluation / supplier fields below were pre-filled from the Awards page.
              </div>
            )}
            {error   && <div className="alert alert-error"   style={{ marginBottom: 12 }}>{error}</div>}
            {success && <div className="alert alert-success" style={{ marginBottom: 12 }}>{success}</div>}

            {/* LPO items summary */}
            <div style={{ background: '#f9fafb', borderRadius: 6, padding: 12, marginBottom: 16, fontSize: 13 }}>
              <div><strong>Supplier:</strong> {modalLPO.supplier || '—'}</div>
              <div><strong>Date:</strong> {modalLPO.date ? new Date(modalLPO.date).toLocaleDateString('en-KE') : '—'}</div>
              <div><strong>Total Amount:</strong> KES {Number(modalLPO.totalAmt).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
              <div style={{ marginTop: 8 }}>
                <strong>Items:</strong>
                <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                  {modalLPO.items.map((it, i) => (
                    <li key={i}>{it.itemName} — Qty {it.Qty}, Price KES {Number(it.Price).toLocaleString()}</li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Link to RFQ (recommended)</label>
              <input className="form-input" type="number" value={rfqId}
                onChange={(e) => setRfqId(e.target.value)}
                placeholder="RFQ ID from our system" />
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                Use this for RFQs that bundle one or more requisitions — every requisition linked to the RFQ will be marked Reconciled.
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Or link to a single Requisition (legacy, no RFQ)</label>
              <input className="form-input" type="number" value={requisitionId}
                onChange={(e) => setRequisitionId(e.target.value)}
                placeholder="Requisition ID from our system" />
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                Only use this for a one-off manual match outside the normal RFQ flow. If an RFQ ID is entered above, it takes precedence.
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Link to Quote Evaluation (optional)</label>
              <input className="form-input" type="number" value={quoteEvaluationId}
                onChange={(e) => setQuoteEvalId(e.target.value)}
                placeholder="QuoteEvaluation ID" />
            </div>

            <div className="form-group">
              <label className="form-label">Supplier ID (required for split awards)</label>
              <input className="form-input" type="number" value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                placeholder="SupplierId from our system" />
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                On a split-awarded RFQ (different suppliers won different items), set this to the
                supplier whose LPO you&apos;re reconciling here — otherwise reconciling one supplier
                would incorrectly hide the other still-pending suppliers on the same RFQ.
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Notes</label>
              <textarea className="form-input" rows={2} value={reconNotes}
                onChange={(e) => setReconNotes(e.target.value)}
                placeholder="e.g. Price negotiated down from quoted amount" />
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={handleReconcile} disabled={submitting}>
                {submitting ? 'Saving…' : 'Confirm Reconciliation'}
              </button>
              <button className="btn btn-secondary" onClick={() => setModalLPO(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}