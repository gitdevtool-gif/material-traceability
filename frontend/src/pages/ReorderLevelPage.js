import React, { useEffect, useState, useCallback } from 'react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';

export default function ReorderLevelPage() {
  const { user } = useAuth();
  const canSync = ['Admin', 'Procurement'].includes(user?.role);

  const [items, setItems]           = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [summary, setSummary]       = useState(null);

  // Filters
  const [search, setSearch]                 = useState('');
  const [itemgrp, setItemgrp]                = useState('');
  const [needsReorderOnly, setNeedsReorderOnly] = useState(false);
  const [overstockedOnly, setOverstockedOnly]   = useState(false);
  const [unackOnly, setUnackOnly]            = useState(false);

  // Distinct filter options, derived once from a full pull
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
  const [batchTarget, setBatchTarget]         = useState(null); // row object (item clicked)
  const [batchRows, setBatchRows]             = useState([]);
  const [batchTotalSleeping, setBatchTotalSleeping] = useState(0);
  const [batchRecon, setBatchRecon] = useState([]);
  const [batchLoading, setBatchLoading]       = useState(false);
  const [batchError, setBatchError]           = useState('');

  const loadSummary = useCallback(async () => {
    try {
      const res = await api.get('/procurement/reorder/summary');
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
      if (itemgrp) params.itemgrp = itemgrp;
      if (needsReorderOnly) params.needsReorder = 'true';
      if (overstockedOnly) params.overstocked = 'true';
      if (unackOnly) params.acknowledged = 'false';

      const res = await api.get('/procurement/reorder', { params });
      setItems(Array.isArray(res.data?.data) ? res.data.data : []);
      setTotalPages(res.data?.totalPages || 1);
      setTotal(res.data?.total || 0);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load reorder data');
    } finally {
      setLoading(false);
    }
  }, [page, search, itemgrp, needsReorderOnly, overstockedOnly, unackOnly]);

  useEffect(() => { loadSummary(); }, [loadSummary]);
  useEffect(() => { loadItems(); }, [loadItems]);

  // One-time pull of a larger page to derive distinct item-group dropdown values.
  // 538 known total rows as of last count — 1000 is a safe ceiling.
  useEffect(() => {
    api.get('/procurement/reorder', { params: { limit: 1000, page: 1 } })
      .then(res => {
        const rows = Array.isArray(res.data?.data) ? res.data.data : [];
        setItemgrpOptions([...new Set(rows.map(r => r.ItemGroup).filter(Boolean))].sort());
      })
      .catch(() => {
        setItemgrpOptions([]);
      });
  }, []);

  // Reset to page 1 whenever a filter changes
  useEffect(() => { setPage(1); }, [search, itemgrp, needsReorderOnly, overstockedOnly, unackOnly]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      const res = await api.post('/procurement/reorder/sync');
      setSyncMsg(`Synced ${res.data.synced} item(s) — ${res.data.needsReorder} need reorder.`);
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
      await api.post(`/procurement/reorder/${ackTarget.ReorderStatusId}/acknowledge`, {
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
      await api.post(`/procurement/reorder/${row.ReorderStatusId}/unacknowledge`);
      await Promise.all([loadItems(), loadSummary()]);
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to unacknowledge');
    }
  };

  // ── Batch drilldown ─────────────────────────────────────────────────────
  // Company-wide, same as reorder status itself — no factory param, since
  // dbo.ReorderStatus rows no longer carry one.
  const openBatches = async (row) => {
    setBatchTarget(row);
    setBatchRows([]);
    setBatchRecon([]);
    setBatchTotalSleeping(0);
    setBatchError('');
    setBatchLoading(true);
    try {
      const res = await api.get('/procurement/reorder/batches', {
        params: { itemName: row.ItemName },
      });
      setBatchRows(Array.isArray(res.data?.data) ? res.data.data : []);
      setBatchTotalSleeping(res.data?.totalSleepingAmount || 0);
      setBatchRecon(Array.isArray(res.data?.reconciliation) ? res.data.reconciliation : []);
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

  // MonthsOfSupply display: distinguishes "no consumption history" (null)
  // from "0 required, nothing to order" (RequiredQty === 0) from a real
  // N-month coverage figure. See reorder-sync.service.js for how this is
  // computed and why it's left null rather than 0 when consumption is unknown.
  const fmtMonths = (row) => {
    if (row.RequiredQty === 0) return 'No order needed';
    if (row.MonthsOfSupply === null || row.MonthsOfSupply === undefined) return 'N/A — no consumption history';
    return `${fmtNum(row.MonthsOfSupply)} month${row.MonthsOfSupply === 1 ? '' : 's'}`;
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Reorder Levels</h1>
          <p className="page-subtitle">Stock items at or below reorder level, synced from Busy ERP</p>
        </div>
        {canSync && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <button className="btn btn-primary" onClick={handleSync} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync from Busy ERP'}
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
          <StatCard label="Need Reorder" value={summary.NeedsReorderCount} tone="warning" />
          <StatCard label="Unacknowledged" value={summary.UnacknowledgedCount} tone="danger" />
          <StatCard label="Overstocked Items" value={summary.OverstockedCount} tone="info" />
          <StatCard label="Total Overstocked Qty" value={fmtNum(summary.TotalOverstockedQty)} small />
          <StatCard label="Total Stock Value" value={fmtMoney(summary.TotalStockValue)} small />
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
          <select className="form-control" style={{ maxWidth: 200 }} value={itemgrp} onChange={e => setItemgrp(e.target.value)}>
            <option value="">All Item Groups</option>
            {itemgrpOptions.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: '#374151', cursor: 'pointer' }}>
            <input type="checkbox" checked={needsReorderOnly} onChange={e => setNeedsReorderOnly(e.target.checked)} />
            Needs Reorder Only
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: '#374151', cursor: 'pointer' }}>
            <input type="checkbox" checked={overstockedOnly} onChange={e => setOverstockedOnly(e.target.checked)} />
            Overstocked Only
          </label>
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
      <div className="card" style={{ padding: 0, overflow: 'auto', maxHeight: '70vh' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading…</div>
        ) : items.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>No items match the current filters.</div>
        ) : (
          <table className="data-table" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
            <thead>
              <tr>
                <th style={stickyFirstColThStyle}>Item</th>
                <th style={stickyThStyle}>Item Group</th>
                <th style={stickyThStyle}>Live Stock</th>
                <th style={stickyThStyle}>Reorder Level</th>
                <th style={stickyThStyle}>Required Qty</th>
                <th style={stickyThStyle}>Avg Monthly Use</th>
                <th style={stickyThStyle}>Months of Supply</th>
                <th style={stickyThStyle}>Overstocked Qty</th>
                <th style={stickyThStyle}>Stock Value</th>
                <th style={stickyThStyle}>Lead Time (days)</th>
                <th style={stickyThStyle}>Status</th>
                <th style={stickyThStyle}>Acknowledged</th>
                <th style={stickyThStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map(r => {
                const overstockedQty = r.Overstocked != null ? Number(r.Overstocked) : 0;
                return (
                <tr key={r.ReorderStatusId}>
                  <td style={{ ...stickyFirstColTdStyle, fontWeight: 500 }}>
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
                  <td style={{ fontSize: 13 }}>{r.ItemGroup || <span style={{ color: '#9ca3af' }}>—</span>}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{fmtNum(r.LiveStock)}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{fmtNum(r.ReorderLevel)}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 600 }}>{fmtNum(r.RequiredQty)}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{fmtNum(r.AvgMonthlyConsumption)}</td>
                  <td style={{ fontSize: 13 }}>{fmtMonths(r)}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: overstockedQty > 0 ? 600 : 400, color: overstockedQty > 0 ? '#d97706' : undefined }}>
                    {r.Overstocked != null ? fmtNum(r.Overstocked) : '—'}
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: 13 }}>
                    {r.StockValue != null ? fmtMoney(r.StockValue) : '—'}
                  </td>
                  <td style={{ fontSize: 13 }}>{r.LeadTimeDays != null ? `${Number(r.LeadTimeDays).toFixed(1)} days` : '—'}</td>
                  <td>
                    <span className={`badge ${r.NeedsReorder ? 'badge-red' : 'badge-green'}`}>
                      {r.NeedsReorder ? 'Needs Reorder' : 'OK'}
                    </span>
                    {overstockedQty > 0 && (
                      <span className="badge badge-yellow" style={{ marginLeft: 6 }}>Overstocked</span>
                    )}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {r.AcknowledgedAt ? (
                      <div>
                        <div style={{ color: '#059669', fontWeight: 500 }}>{r.AcknowledgedByName || 'Acknowledged'}</div>
                        <div style={{ color: '#9ca3af' }}>{fmtDate(r.AcknowledgedAt)}</div>
                        {r.AcknowledgedMonthsCoverage != null && (
                          <div style={{ color: '#6b7280', marginTop: 2 }}>
                            Ordered {fmtNum(r.AcknowledgedRequiredQty)} → ~{fmtNum(r.AcknowledgedMonthsCoverage)} mo supply
                          </div>
                        )}
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
              );})}
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
              <h2 style={{ margin: 0, fontSize: 17 }}>Acknowledge Reorder Alert</h2>
              <button onClick={closeAcknowledge} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#6b7280' }}>×</button>
            </div>
            <p style={{ fontSize: 13, color: '#374151', marginBottom: 4 }}>
              <strong>{ackTarget.ItemName}</strong>
            </p>
            <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 4 }}>
              Required Qty: <strong>{fmtNum(ackTarget.RequiredQty)}</strong> · Lead Time: {ackTarget.LeadTimeDays != null ? `${Number(ackTarget.LeadTimeDays).toFixed(1)} days` : '—'}
            </p>
            <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
              Avg Monthly Consumption: <strong>{fmtNum(ackTarget.AvgMonthlyConsumption)}</strong> · Covers: <strong>{fmtMonths(ackTarget)}</strong>
            </p>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Notes (optional)</label>
              <textarea
                className="form-control"
                rows={3}
                value={ackNotes}
                onChange={e => setAckNotes(e.target.value)}
                placeholder="e.g. Order raised in Busy ERP as PO-1234"
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
              <strong>{batchTarget.ItemName}</strong>
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
                {batchRecon.length > 0 && (
                  <div style={{ fontSize: 12, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '6px 10px', marginBottom: 12 }}>
                    Busy's batch records don't add up to this item's stock in{' '}
                    {batchRecon.map((c) => `${c.store} (batches ${fmtNum(c.batchTotal)} vs stock ${fmtNum(c.stock)})`).join(', ')}
                    {' '}— usually opening batches carried into this year. The stock figure is right; correct the batches in Busy.
                  </div>
                )}

                <div style={{ overflow: 'auto', maxHeight: '50vh' }}>
                  <table className="data-table" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
                    <thead>
                      <tr>
                        <th style={stickyThStyle}>Factory</th>
                        <th style={stickyThStyle}>Batch No</th>
                        <th style={stickyThStyle}>Batch Date</th>
                        <th style={stickyThStyle}>Qty</th>
                        <th style={stickyThStyle}>Amount</th>
                        <th style={stickyThStyle}>Aging (days)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchRows.map((b, i) => (
                        <tr key={`${b.BatchNo}-${i}`}>
                          <td style={{ fontSize: 13 }}>{b.Factory}</td>
                          <td>{b.BatchNo}</td>
                          <td>{fmtDate(b.BatchDate)}</td>
                          <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{fmtNum(b.Qty)}</td>
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

// Sticky table-header cell: stays pinned to the top of the scrolling
// container while the body scrolls underneath it.
const stickyThStyle = {
  position: 'sticky',
  top: 0,
  background: '#fff',
  zIndex: 2,
  boxShadow: 'inset 0 -1px 0 #e5e7eb', // keeps the header/body divider visible while stuck
};

// First-column header cell: sticky both to the top (like every other header
// cell) AND to the left edge, so it stays pinned in both directions —
// needs a higher z-index since it overlaps the regular sticky header row too.
const stickyFirstColThStyle = {
  ...stickyThStyle,
  left: 0,
  zIndex: 3,
};

// First-column body cell: sticky to the left edge only, so it stays visible
// while the table scrolls horizontally. Needs an explicit background since
// sticky cells don't get one automatically, and would otherwise let the
// scrolling columns behind it show through.
const stickyFirstColTdStyle = {
  position: 'sticky',
  left: 0,
  background: '#fff',
  zIndex: 1,
  boxShadow: 'inset -1px 0 0 #e5e7eb', // subtle divider so it reads as "frozen"
};