import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';

const STATUS_BADGE = {
  GateReceived: 'badge-blue',
  WeighbridgePending: 'badge-yellow',
  WeighbridgeCompleted: 'badge-yellow',
  QAPending: 'badge-yellow',
  QAInProgress: 'badge-yellow',
  QAAccepted: 'badge-green',
  OpsManagerApproved: 'badge-green',
  QARejected: 'badge-red',
  Quarantine: 'badge-yellow',
  Rejected: 'badge-red',
  RoutingPending: 'badge-yellow',
  GRNCreated: 'badge-green',
  Closed: 'badge-gray',
  Cancelled: 'badge-red',
};

export default function DashboardPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchDashboard = () => {
      api.get('/reports/dashboard')
        .then((res) => setData(res.data))
        .catch(() => setError('Failed to load dashboard'));
    };
    fetchDashboard();
    const interval = setInterval(fetchDashboard, 60000);
    return () => clearInterval(interval);
  }, []);

  if (error) return <div className="card">{error}</div>;
  if (!data) return <div>Loading…</div>;

  return (
    <div>
      <div className="page-header">
        <h1>Dashboard</h1>
        <Link to="/entries/new" className="btn btn-primary">+ New Gate Entry</Link>
      </div>

      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-value">{data.stats.todayEntries}</div>
          <div className="stat-label">Today's Entries</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{data.stats.pendingWeighbridge}</div>
          <div className="stat-label">Pending Weighbridge</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{data.stats.pendingReceiving}</div>
          <div className="stat-label">Pending Receiving</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{data.stats.pendingQA}</div>
          <div className="stat-label">Pending QA</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{data.stats.qaAccepted}</div>
          <div className="stat-label">QA Accepted</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{data.stats.qaRejected}</div>
          <div className="stat-label">QA Rejected</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{data.stats.todayGRNs}</div>
          <div className="stat-label">Today's GRNs</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{data.stats.todayReversals}</div>
          <div className="stat-label">Reversals Today</div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>Recent Deliveries</h3>
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Entry No</th>
                <th>Supplier</th>
                <th>Consignment</th>
                <th>Vehicle</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {data.recentEntries.map((e) => (
                <tr key={e.EntryNo}>
                  <td><strong>{e.EntryNo}</strong></td>
                  <td>{e.SupplierName}</td>
                  <td>{e.ConsignmentNo}</td>
                  <td>{e.VehicleRegNo}</td>
                  <td><span className={`badge ${STATUS_BADGE[e.Status] || 'badge-gray'}`}>{e.Status}</span></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{new Date(e.CreatedAt).toLocaleString()}</td>
                </tr>
              ))}
              {data.recentEntries.length === 0 && (
                <tr><td colSpan="6" className="text-center text-muted">No entries yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}