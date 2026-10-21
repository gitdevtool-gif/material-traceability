import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';

const STATUS_BADGE = {
  GateReceived: 'badge-blue',
  WeighbridgePending: 'badge-yellow',
  WeighbridgeCompleted: 'badge-yellow',
  CentralStoreReceived: 'badge-blue',
  QAPending: 'badge-yellow',
  QAInProgress: 'badge-yellow',
  QAAccepted: 'badge-green',
  QARejected: 'badge-red',
  Quarantine: 'badge-yellow',
  RoutingPending: 'badge-yellow',
  GRNCreated: 'badge-green',
  Closed: 'badge-gray',
  Cancelled: 'badge-red',
};

export default function GateEntryListPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    const params = { page, limit: 25 };
    if (search) params.search = search;
    if (statusFilter) params.status = statusFilter;
    api.get('/entries', { params })
      .then((res) => { setEntries(res.data.data); setTotal(res.data.total); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [page, statusFilter]);

  const handleSearch = (e) => {
    e.preventDefault();
    setPage(1);
    load();
  };

  const handleDelete = async (entryNo) => {
    if (!window.confirm(`Delete entry ${entryNo}? This cannot be undone.`)) return;
    try {
      await api.delete(`/entries/${entryNo}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to delete entry');
    }
  };

  return (
    <div>
      <div className="page-header"><h1>Gate Entries</h1></div>

      <div className="card">
        <form onSubmit={handleSearch} className="flex-between mb-4" style={{ gap: 12 }}>
          <input
            placeholder="Search entry no, consignment, vehicle, supplier…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1, padding: '8px 12px', border: '1px solid var(--gray-300)', borderRadius: 'var(--radius)' }}
          />
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} style={{ padding: '8px 12px', border: '1px solid var(--gray-300)', borderRadius: 'var(--radius)' }}>
            <option value="">All Statuses</option>
            <option value="GateReceived">Gate Received</option>
            <option value="WeighbridgeCompleted">Weighbridge Completed</option>
            <option value="GRNCreated">GRN Created</option>
            <option value="Closed">Closed</option>
            <option value="Cancelled">Cancelled</option>
          </select>
          <button type="submit" className="btn btn-primary">Search</button>
        </form>

        {loading ? <div>Loading…</div> : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Entry No</th>
                <th>Supplier</th>
                <th>Consignment</th>
                <th>Vehicle</th>
                <th>Date</th>
                <th>Net Wt (kg)</th>
                <th>PO</th>
                <th>Status</th>
                {isAdmin && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.EntryId}>
                  <td><strong>{e.EntryNo}</strong></td>
                  <td>{e.SupplierName}</td>
                  <td>{e.ConsignmentNo}</td>
                  <td>{e.VehicleRegNo}</td>
                  <td>{e.DeliveryDate?.slice(0, 10)}</td>
                  <td>{e.NetWeight}</td>
                  <td>{e.PurchaseOrderNo || <span className="text-muted">Non-PO</span>}</td>
                  <td><span className={`badge ${STATUS_BADGE[e.Status] || 'badge-gray'}`}>{e.Status}</span></td>
                  {isAdmin && (
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn btn-outline" style={{ padding: '2px 8px', fontSize: 12 }}
                          onClick={() => navigate(`/entries/edit/${e.EntryNo}`)}>Edit</button>
                        <button className="btn btn-danger" style={{ padding: '2px 8px', fontSize: 12 }}
                          onClick={() => handleDelete(e.EntryNo)}>Delete</button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
              {entries.length === 0 && (
                <tr><td colSpan={isAdmin ? 9 : 8} className="text-center text-muted">No entries found</td></tr>
              )}
            </tbody>
          </table>
        )}

        <div className="flex-between mt-4">
          <span className="text-muted">Showing {entries.length} of {total}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>
            <button className="btn btn-outline" disabled={entries.length < 25} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        </div>
      </div>
    </div>
  );
}
