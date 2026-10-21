import React, { useEffect, useState, useCallback } from 'react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';

export default function FGReorderLevelPage() {
  const { user } = useAuth();
  const canSync = ['Admin', 'Procurement'].includes(user?.role);

  const [items, setItems]           = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [summary, setSummary]       = useState(null);

  // Filters
  const [search, setSearch]                 = useState('');
  const [factory, setFactory]                = useState('');
  const [itemgrp, setItemgrp]                = useState('');
  const [statusFilter, setStatusFilter]      = useState(''); // '', 'CRITICAL', 'REORDER', 'OK'
  const [unackOnly, setUnackOnly]            = useState(false);

  // Distinct filter options, derived once from a full pull
  const [factoryOptions, setFactoryOptions]   = useState([]);
  const [itemgrpOptions, setItemgrpOptions]   = useState([]);

  // Pagination
  const [page, setPage]           = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal]         = useState(0);
  const LIMIT = 50;

  // Sync
  const [syncing, setSyncing]     = useState(false);
  const [syncMsg, setSyncMsg]     = useState('');

  // Acknowledge modal
  const [ackTarget, setAckTarget] = useState(null); // row object
  const [ackNotes, setAckNotes]   = useState('');
  const [ackSaving, setAckSaving] = useState(false);

  // Batch drilldown modal
  const [batchTarget, setBatchTarget]               = useState(null); // row object (item clicked)
  const [batchRows, setBatchRows]                   = useState([]);
  const [batchTotalSleeping, setBatchTotalSleeping]  = useState(0);
  const [batchLoading, setBatchLoading]              = useState(false);
  const [batchError, setBatchError]                  = useState('');

  const loadSummary = useCallback(async () => {
    try {
      const res = await api.get('/procurement/fg-reorder/summary');
      setSummary(res.data);
    } catch {
      setSummary(null);
    }
  }, []);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { page, limit: LIMIT };
      if (search) params.search = search;
      if (factory) params.factory = factory;
      if (itemgrp) params.itemgrp = itemgrp;
      if (statusFilter) params.status = statusFilter;
      if (unackOnly) params.acknowledged = 'false';

      const res = await api.get('/procurement/fg-reorder', { params });
      setItems(Array.isArray(res.data?.data) ? res.data.data : []);
      setTotalPages(res.data?.totalPages || 1);
      setTotal(res.data?.total || 0);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load finished goods reorder data');
    } finally {
      setLoading(false);
    }
  }, [page, search, factory, itemgrp, statusFilter, unackOnly]);

  useEffect(() => { loadSummary(); }, [loadSummary]);
  useEffect(() => { loadItems(); }, [loadItems]);

  // One-time pull of a larger page to derive distinct filter dropdown values.
  useEffect(() => {
    api.get('/procurement/fg-reorder', { params: { limit: 1000, page: 1 } })
      .then(res => {
        const rows = Array.isArray(res.data?.data) ? res.data.data : [];
        setFactoryOptions([...new Set(rows.map(r => r.Factory).filter(Boolean))].sort());
        setItemgrpOptions([...new Set(rows.map(r => r.ItemGroup).filter(Boolean))].sort());
      })
      .catch(() => {
        setFactoryOptions([]);
        setItemgrpOptions([]);
      });
  }, []);

  // Reset to page 1 whenever a filter changes
  useEffect(() => { setPage(1); }, [search, factory, itemgrp, statusFilter, unackOnly]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      const res = await api.post('/procurement/fg-reorder/sync');
      setSyncMsg(`Synced ${res.data.synced} item(s).`);
      await Promise.all([loadItems(), loadSummary()]);
    } catch (e) {
      setSyncMsg(e.response?.data?.error || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const openAcknowledge = (row) => {
    setAckTarget(row);
    setAckNotes('');
  };
  const closeAcknowledge = () => { setAckTarget(null); setAckNotes(''); };

  const submitAcknowledge = async () => {
    setAckSaving(true);
    try {
      await api.post(`/procurement/fg-reorder/${ackTarget.FGReorderStatusId}/acknowledge`, {
        notes: ackNotes || null,
      });
      closeAcknowledge();
      await Promise.all([loadItems(), loadSummary()]);
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to acknowledge');
    } finally {
      setAckSaving(false);
    }
  };

  const handleUnacknowledge = async (row) => {
    if (!window.confirm(`Undo acknowledgement for "${row.ItemName}"?`)) return;
    try {
      await api.post(`/procurement/fg-reorder/${row.FGReorderStatusId}/unacknowledge`);
      await Promise.all([loadItems(), loadSummary()]);
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to unacknowledge');
    }
  };

  // ── Batch drilldown ─────────────────────────────────────────────────────
  const openBatches = async (row) => {
    setBatchTarget(row);
    setBatchRows([]);
    setBatchTotalSleeping(0);
    setBatchError('');
    setBatchLoading(true);
    try {
      const res = await api.get('/procurement/fg-reorder/batches', {
        params: { itemName: row.ItemName, factory: row.Factory },
      });
      setBatchRows(Array.isArray(res.data?.data) ? res.data.data : []);
      setBatchTotalSleeping(res.data?.totalSleepingAmount || 0);
    } catch (e) {
      setBatchError(e.response?.data?.error || 'Failed to load batch details');
    } finally {
      setBatchLoading(false);
    }
  };
  const closeBatches = () => {
    setBatchTarget(null);
    setBatchRows([]);
    setBatchTotalSleeping(0);
    setBatchError('');
  };

  const fmtDate = (d) => {
    if (!d) return '—';
    const date = new Date(d);
    return date.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const fmtDateTime = (d) => {
    if (!d) return '—';
    const date = new Date(d);
    return date.toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const fmtNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
  const fmtMoney = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }));

  const statusBadgeClass = (status) => {
    switch (status) {
      case 'CRITICAL': return 'badge badge-red';
      case 'REORDER':  return 'badge badge-red';
      case 'OK':       return 'badge badge-green';
      default:         return 'badge';
    }
  };
  const statusLabel = (status) => {
    switch (status) {
      case 'NEEDS GROUP ASSIGNMENT':     return 'Needs Group';
      case 'NEEDS LEAD TIME ASSIGNMENT': return 'Needs Lead Time';
      case 'NEEDS STOCK MASTER REVIEW':  return 'Needs Stock Match';
      default: return status;
    }
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Finished Goods Reorder Levels</h1>
          <p className="page-subtitle">Sales-driven stock status for finished goods — avoid stock-outs and overstocking</p>
        </div>
        {canSync && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <button className="btn btn-primary" onClick={handleSync} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync Finished Goods Stock'}
            </button>
            {syncMsg && <span style={{ fontSize: 12, color: '#6b7280' }}>{syncMsg}</span>}
          </div>
        )}
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

      {/* Summary stat cards */}
      {summary && (
        <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
          <StatCard label="Total Items Tracked" value={summary.TotalItems} />
          <StatCard label="Critical" value={summary.CriticalCount} tone="danger" />
          <StatCard label="Needs Reorder" value={summary.ReorderCount} tone="warning" />
          <StatCard label="Overstocked" value={summary.OverstockedCount} tone="info" />
          <StatCard label="Unacknowledged" value={summary.UnacknowledgedCount} tone="danger" />
          <StatCard label="Last Synced" value={fmtDateTime(summary.LastSyncedAt)} small />
        </div>
      )}

      {/* Filters */}
      <div className="card" style={{ marginBottom: 20, padding: '12px 16px' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="form-control"
            style={{ maxWidth: 220 }}
            placeholder="Search item name…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select className="form-control" style={{ maxWidth: 180 }} value={factory} onChange={e => setFactory(e.target.value)}>
            <option value="">All Factories</option>
            {factoryOptions.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
          <select className="form-control" style={{ maxWidth: 200 }} value={itemgrp} onChange={e => setItemgrp(e.target.value)}>
            <option value="">All Item Groups</option>
            {itemgrpOptions.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <select className="form-control" style={{ maxWidth: 180 }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="">All Statuses</option>
            <option value="CRITICAL">Critical</option>
            <option value="REORDER">Needs Reorder</option>
            <option value="OK">OK</option>
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: '#374151', cursor: 'pointer' }}>
            <input type="checkbox" checked={unackOnly} onChange={e => setUnackOnly(e.target.checked)} />
            Unacknowledged Only
          </label>
          <span style={{ marginLeft: 'auto', fontSize: 13, color: '#6b7280' }}>
            {total} item{total !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading…</div>
        ) : items.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>No items match the current filters.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Factory</th>
                <th>Item Group</th>
                <th>Live Stock</th>
                <th>Min Level</th>
                <th>Reorder Level</th>
                <th>Max Level</th>
                <th>Overstocked</th>
                <th>Lead Time (mo)</th>
                <th>Status</th>
                <th>Acknowledged</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map(r => (
                <tr key={r.FGReorderStatusId}>
                  <td style={{ fontWeight: 500 }}>
                    <button
                      onClick={() => openBatches(r)}
                      title="View batch-wise stock"
                      style={{
                        background: 'none', border: 'none', padding: 0,
                        color: '#2563eb', fontWeight: 500, fontSize: 'inherit',
                        cursor: 'pointer', textAlign: 'left', textDecoration: 'underline',
                        textDecorationColor: 'transparent',
                      }}
                      onMouseEnter={e => e.currentTarget.style.textDecorationColor = '#2563eb'}
                      onMouseLeave={e => e.currentTarget.style.textDecorationColor = 'transparent'}
                    >
                      {r.ItemName}
                    </button>
                  </td>
                  <td>{r.Factory}</td>
                  <td style={{ fontSize: 13 }}>{r.ItemGroup || <span style={{ color: '#9ca3af' }}>—</span>}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{fmtNum(r.LiveStock)}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{fmtNum(r.MinimumStockLevel)}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{fmtNum(r.ReorderLevel)}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{fmtNum(r.MaximumStockLevel)}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 13, color: r.Overstocked > 0 ? '#2563eb' : undefined }}>
                    {r.Overstocked > 0 ? fmtNum(r.Overstocked) : '—'}
                  </td>
                  <td style={{ fontSize: 13 }}>{r.LeadTime != null ? `${Number(r.LeadTime).toFixed(1)} mo` : '—'}</td>
                  <td>
                    <span className={statusBadgeClass(r.StockStatus)}>{statusLabel(r.StockStatus)}</span>
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {r.AcknowledgedAt ? (
                      <div>
                        <div style={{ color: '#059669', fontWeight: 500 }}>{r.AcknowledgedByName || 'Acknowledged'}</div>
                        <div style={{ color: '#9ca3af' }}>{fmtDate(r.AcknowledgedAt)}</div>
                        {r.AcknowledgedNotes && (
                          <div style={{ color: '#6b7280', marginTop: 2 }} title={r.AcknowledgedNotes}>
                            {r.AcknowledgedNotes.length > 30 ? r.AcknowledgedNotes.slice(0, 30) + '…' : r.AcknowledgedNotes}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span style={{ color: '#9ca3af' }}>Not reviewed</span>
                    )}
                  </td>
                  <td>
                    {r.AcknowledgedAt ? (
                      <button className="btn btn-secondary btn-sm" onClick={() => handleUnacknowledge(r)}>Undo</button>
                    ) : (
                      <button className="btn btn-primary btn-sm" onClick={() => openAcknowledge(r)}>Acknowledge</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 16 }}>
          <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
          <span style={{ fontSize: 13, color: '#6b7280' }}>Page {page} of {totalPages}</span>
          <button className="btn btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</button>
        </div>
      )}

      {/* Acknowledge modal */}
      {ackTarget && (
        <div style={overlayStyle}>
          <div style={{ ...modalStyle, maxWidth: 440 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>Acknowledge Stock Alert</h2>
              <button onClick={closeAcknowledge} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#6b7280' }}>×</button>
            </div>
            <p style={{ fontSize: 13, color: '#374151', marginBottom: 4 }}>
              <strong>{ackTarget.ItemName}</strong> ({ackTarget.Factory})
            </p>
            <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
              Live Stock: <strong>{fmtNum(ackTarget.LiveStock)}</strong> · Reorder Level: {fmtNum(ackTarget.ReorderLevel)} · Lead Time: {ackTarget.LeadTime != null ? `${Number(ackTarget.LeadTime).toFixed(1)} mo` : '—'}
            </p>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Notes (optional)</label>
              <textarea
                className="form-control"
                rows={3}
                value={ackNotes}
                onChange={e => setAckNotes(e.target.value)}
                placeholder="e.g. Production batch scheduled for this week"
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
              <button className="btn btn-secondary" onClick={closeAcknowledge} disabled={ackSaving}>Cancel</button>
              <button className="btn btn-primary" onClick={submitAcknowledge} disabled={ackSaving}>
                {ackSaving ? 'Saving…' : 'Acknowledge'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Batch drilldown modal */}
      {batchTarget && (
        <div style={overlayStyle}>
          <div style={{ ...modalStyle, maxWidth: 720 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>Batch-Wise Stock</h2>
              <button onClick={closeBatches} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#6b7280' }}>×</button>
            </div>
            <p style={{ fontSize: 13, color: '#374151', marginBottom: 14 }}>
              <strong>{batchTarget.ItemName}</strong> ({batchTarget.Factory})
            </p>

            {batchLoading ? (
              <div style={{ padding: 30, textAlign: 'center', color: '#6b7280' }}>Loading batches…</div>
            ) : batchError ? (
              <div className="alert alert-error">{batchError}</div>
            ) : batchRows.length === 0 ? (
              <div style={{ padding: 30, textAlign: 'center', color: '#6b7280' }}>No positive-stock batch records found for this item.</div>
            ) : (
              <>
                <div
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8,
                    padding: '10px 14px', marginBottom: 14,
                  }}
                >
                  <span style={{ fontSize: 13, color: '#6b7280' }}>Total Value Sleeping in Stock</span>
                  <span style={{ fontSize: 18, fontWeight: 700, color: '#dc2626' }}>{fmtMoney(batchTotalSleeping)}</span>
                </div>

                <div style={{ overflow: 'auto', maxHeight: '50vh' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Batch No</th>
                        <th>Batch Date</th>
                        <th>Remaining Qty</th>
                        <th>Unit Price</th>
                        <th>Amount</th>
                        <th>Aging (days)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchRows.map((b, i) => (
                        <tr key={`${b.BatchNo}-${i}`}>
                          <td>{b.BatchNo}</td>
                          <td>{fmtDate(b.BatchDate)}</td>
                          <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{fmtNum(b.RemainingQty)}</td>
                          <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{fmtMoney(b.UnitPrice)}</td>
                          <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{fmtMoney(b.Amount)}</td>
                          <td style={{ fontFamily: 'monospace', fontSize: 13, color: b.AgeDays > 90 ? '#dc2626' : undefined }}>
                            {b.AgeDays != null ? b.AgeDays : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button className="btn btn-secondary" onClick={closeBatches}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, tone, small }) {
  const toneColors = {
    warning: '#d97706',
    danger:  '#dc2626',
    info:    '#2563eb',
  };
  return (
    <div className="card" style={{ padding: '14px 20px', minWidth: 150 }}>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: small ? 14 : 24, fontWeight: 700, color: tone ? toneColors[tone] : '#111827' }}>
        {value === undefined || value === null ? '—' : value}
      </div>
    </div>
  );
}

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 1000, padding: 16,
};
const modalStyle = {
  background: '#fff', borderRadius: 12, padding: 28,
  width: '100%', maxWidth: 640,
  maxHeight: '90vh', overflowY: 'auto',
  boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
};