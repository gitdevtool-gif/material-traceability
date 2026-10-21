import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';

/**
 * Procurement's follow-up view of what's still sitting with the Director —
 * every RFQ that has at least one quote in but no decision yet (or still
 * has held items waiting on a late supplier), so Procurement can chase the
 * Director directly instead of guessing what's outstanding. Backed by the
 * same GET /procurement/evaluation/pending endpoint the Director's own
 * evaluation queue uses — this page is just a lighter, read-only list for
 * Procurement to check without opening the full comparison UI.
 */
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

export default function PendingDirectorApprovalPage() {
  const navigate = useNavigate();
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const load = () => {
    setLoading(true);
    setError('');
    api.get('/procurement/evaluation/pending')
      .then((res) => setRows(Array.isArray(res.data) ? res.data : []))
      .catch((e) => setError(e.response?.data?.error || 'Failed to load pending evaluations'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const isOverdue = (deadline) => deadline && new Date(deadline) < new Date();

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Pending Director Approval</h1>
          <p className="page-subtitle">
            RFQs with quotes in but no decision yet — follow up with the Director on these.
          </p>
        </div>
        <button className="btn btn-secondary" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>
          Nothing waiting on the Director right now.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
            {rows.length} RFQ{rows.length !== 1 ? 's' : ''} awaiting a decision
          </div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>RFQ No</th>
                  <th>Busy Ord No</th>
                  <th>Mat Centre</th>
                  <th>Issued</th>
                  <th>Deadline</th>
                  <th>Quotes In</th>
                  <th>Suppliers Responded</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.RFQId}>
                    <td><strong>{r.RFQNumber}</strong></td>
                    <td>{r.BusyOrdNo || '—'}</td>
                    <td>{r.MatCenter || '—'}</td>
                    <td style={{ fontSize: 12, color: '#6b7280' }}>{fmtDate(r.IssuedAt)}</td>
                    <td style={{ fontSize: 12, color: isOverdue(r.DeadlineAt) ? '#dc2626' : '#6b7280' }}>
                      {fmtDateTime(r.DeadlineAt)}{isOverdue(r.DeadlineAt) ? ' (overdue)' : ''}
                    </td>
                    <td style={{ textAlign: 'center' }}>{r.QuoteCount}</td>
                    <td style={{ fontSize: 12, color: '#374151', maxWidth: 260 }}>{r.SupplierNames || '—'}</td>
                    <td>
                      {r.HeldCount > 0 ? (
                        <span className="badge badge-yellow" title="Some items already decided; these are still held">
                          {r.HeldCount} item{r.HeldCount !== 1 ? 's' : ''} on hold
                        </span>
                      ) : (
                        <span className="badge badge-gray">Not yet reviewed</span>
                      )}
                    </td>
                    <td>
                      <button className="btn btn-primary btn-sm" style={{ padding: '4px 12px', fontSize: 12 }}
                        onClick={() => navigate(`/director/evaluation?rfqId=${r.RFQId}`)}>
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
