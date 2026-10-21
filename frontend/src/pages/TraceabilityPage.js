import React, { useState } from 'react';
import api from '../services/api';

const STATUS_BADGE = {
  GateReceived: 'badge-blue',
  WeighbridgePending: 'badge-yellow',
  WeighbridgeCompleted: 'badge-yellow',
  QAPending: 'badge-yellow',
  QAInProgress: 'badge-yellow',
  QAAccepted: 'badge-green',
  QARejected: 'badge-red',
  Quarantine: 'badge-yellow',
  Rejected: 'badge-red',
  RoutingPending: 'badge-yellow',
  GRNCreated: 'badge-green',
  Closed: 'badge-gray',
  Cancelled: 'badge-red',
  Created: 'badge-blue',
  FullyReceived: 'badge-green',
  PartiallyReceived: 'badge-yellow',
  Reversed: 'badge-red',
};

export default function TraceabilityPage() {
  const [query, setQuery] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setError('');
    setData(null);
    try {
      const res = await api.get(`/reports/traceability/${encodeURIComponent(query.trim())}`);
      setData(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Not found');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="page-header"><h1>Traceability</h1></div>

      <div className="card">
        <form onSubmit={handleSearch} className="flex-between" style={{ gap: 12 }}>
          <input
            placeholder="Enter Entry No (e.g. ENT-20260330-0001)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: 1, padding: '10px 14px', border: '1px solid var(--gray-300)', borderRadius: 'var(--radius)', fontSize: 15 }}
            autoFocus
          />
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Searching…' : 'Trace'}
          </button>
        </form>
      </div>

      {error && <div className="card" style={{ color: 'var(--danger)' }}>{error}</div>}

      {data && (
        <>
          {/* Entry Summary */}
          <div className="card">
            <h3>Gate Entry — {data.entry.EntryNo}</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 12, fontSize: 14 }}>
              <div><strong>Supplier:</strong> {data.entry.SupplierName} ({data.entry.SupplierCode})</div>
              <div><strong>Consignment:</strong> {data.entry.ConsignmentNo}</div>
              <div><strong>Vehicle:</strong> {data.entry.VehicleRegNo}</div>
              <div><strong>Date:</strong> {data.entry.DeliveryDate?.slice(0, 10)}</div>
              <div><strong>Gate Net Weight:</strong> {data.entry.NetWeight} kg</div>
              <div><strong>Status:</strong> <span className={`badge ${STATUS_BADGE[data.entry.Status]}`}>{data.entry.Status}</span></div>
              <div><strong>PO:</strong> {data.entry.PurchaseOrderNo || 'Non-PO'}</div>
              <div><strong>Created By:</strong> {data.entry.CreatedByName}</div>
            </div>
          </div>

          {/* Materials */}
          {data.items.length > 0 && (
            <div className="card">
              <h3>Material Items</h3>
              <table className="data-table" style={{ marginTop: 8 }}>
                <thead><tr><th>Code</th><th>Material</th><th>Qty</th><th>UOM</th></tr></thead>
                <tbody>
                  {data.items.map((it) => (
                    <tr key={it.EntryItemId}>
                      <td>{it.MaterialCode}</td><td>{it.MaterialName}</td>
                      <td>{it.Quantity}</td><td>{it.UOM}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Weighbridge */}
          {data.weighbridge && (
            <div className="card">
              <h3>Weighbridge</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 8, fontSize: 14 }}>
                <div><strong>1st Weight:</strong> {data.weighbridge.FirstWeight} kg</div>
                <div><strong>2nd Weight:</strong> {data.weighbridge.SecondWeight} kg</div>
                <div><strong>Net Weight:</strong> {data.weighbridge.NetWeight} kg</div>
                <div><strong>Variance:</strong> {data.weighbridge.WeightVariance} kg</div>
                <div><strong>Operator:</strong> {data.weighbridge.OperatorName}</div>
                <div><strong>Weighed:</strong> {new Date(data.weighbridge.WeighmentDate).toLocaleString()}</div>
              </div>
              {data.weighbridge.Remarks && <div className="mt-2 text-muted">Remarks: {data.weighbridge.Remarks}</div>}
            </div>
          )}

          {/* QA Inspection */}
          {data.qaInspection && (
            <div className="card">
              <h3>QA Inspection — {data.qaInspection.InspectionNo}</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 12, fontSize: 14 }}>
                <div><strong>Inspector:</strong> {data.qaInspection.InspectorName}</div>
                <div><strong>Status:</strong> <span className={`badge ${STATUS_BADGE[data.qaInspection.OverallStatus] || 'badge-gray'}`}>{data.qaInspection.OverallStatus}</span></div>
                <div><strong>COA Received:</strong> {data.qaInspection.COAReceived ? 'Yes' : 'No'}</div>
                <div><strong>Samples Collected:</strong> {data.qaInspection.SamplesCollected ? 'Yes' : 'No'}</div>
                <div><strong>Physical Check:</strong> {data.qaInspection.PhysicalCheckPassed ? 'Pass' : 'Fail'}</div>
                <div><strong>Accepted Qty:</strong> {data.qaInspection.AcceptedQty ?? '—'}</div>
                <div><strong>Rejected Qty:</strong> {data.qaInspection.RejectedQty ?? '—'}</div>
                {data.qaInspection.ApprovedByName && <div><strong>Approved By:</strong> {data.qaInspection.ApprovedByName}</div>}
                <div><strong>Created:</strong> {new Date(data.qaInspection.CreatedAt).toLocaleString()}</div>
              </div>
              {data.qaInspection.Remarks && <div style={{ marginTop: 8, fontSize: 13, color: 'var(--gray-600)' }}>Remarks: {data.qaInspection.Remarks}</div>}

              {data.qaTests && data.qaTests.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <h4 style={{ fontSize: 14 }}>Test Results</h4>
                  <table className="data-table" style={{ marginTop: 4 }}>
                    <thead><tr><th>Material</th><th>Test</th><th>Expected</th><th>Actual</th><th>Result</th><th>Tested By</th></tr></thead>
                    <tbody>
                      {data.qaTests.map((t, i) => (
                        <tr key={i}>
                          <td>{t.MaterialName}</td>
                          <td>{t.TestName}</td>
                          <td>{t.ExpectedValue}</td>
                          <td>{t.ActualValue}</td>
                          <td><span className={`badge ${t.Result === 'Pass' ? 'badge-green' : 'badge-red'}`}>{t.Result}</span></td>
                          <td>{t.TestedByName}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Goods Rejection */}
          {data.rejection && (
            <div className="card" style={{ borderLeft: '4px solid var(--danger)' }}>
              <h3 style={{ color: 'var(--danger)' }}>Goods Rejection — {data.rejection.RejectionNo}</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12, fontSize: 14 }}>
                <div><strong>Rejected By:</strong> {data.rejection.RejectedByName}</div>
                <div><strong>Date:</strong> {new Date(data.rejection.RejectedAt).toLocaleString()}</div>
                <div style={{ gridColumn: '1 / -1' }}><strong>Reason:</strong> {data.rejection.RejectionReason}</div>
                <div><strong>Supplier Notified:</strong> {data.rejection.SupplierNotified ? 'Yes' : 'No'}</div>
                {data.rejection.DisposalMethod && <div><strong>Disposal:</strong> {data.rejection.DisposalMethod}</div>}
              </div>
            </div>
          )}

          {/* GRNs */}
          {data.grns.length > 0 && (
            <div className="card">
              <h3>Goods Receipt Notes</h3>
              {data.grns.map((g) => (
                <div key={g.GRNId} style={{ padding: 12, marginTop: 8, background: 'var(--gray-50)', borderRadius: 'var(--radius)' }}>
                  <div className="flex-between">
                    <strong>{g.GRNNo}</strong>
                    <span className={`badge ${STATUS_BADGE[g.GRNStatus]}`}>{g.GRNStatus}</span>
                  </div>
                  <div style={{ fontSize: 14, marginTop: 4 }}>
                    Dept: {g.ReceivingDept === 'CentralStore' ? 'Central Store' : 'Factory'} |
                    Location: {g.LocationName || 'N/A'} |
                    By: {g.ReceivedByName} |
                    At: {new Date(g.ReceivedAt).toLocaleString()}
                  </div>
                  {g.GRNStatus === 'Reversed' && (
                    <div style={{ color: 'var(--danger)', fontSize: 13, marginTop: 4 }}>
                      Reversed by {g.ReversedByName} — {g.ReversalReason}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Status Timeline */}
          {data.statusHistory.length > 0 && (
            <div className="card">
              <h3>Status History</h3>
              <div className="timeline" style={{ marginTop: 12 }}>
                {data.statusHistory.map((h) => (
                  <div className="timeline-item" key={h.HistoryId}>
                    <div className="tl-time">{new Date(h.ChangedAt).toLocaleString()}</div>
                    <div className="tl-title">
                      {h.FromStatus ? `${h.FromStatus} → ` : ''}{h.ToStatus}
                    </div>
                    <div className="tl-detail">
                      By {h.ChangedByName} ({h.EntityType})
                      {h.Remarks && ` — ${h.Remarks}`}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
