import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import RaiseFuelPoModal from '../components/RaiseFuelPoModal';

const STATUS_COLOR = {
  Pending:            'badge-yellow',
  RFQSent:            'badge-blue',
  QuotesReceived:     'badge-purple',
  EvaluationPending:  'badge-orange',
  Approved:           'badge-green',
  Reconciled:         'badge-teal',
  Cancelled:          'badge-red',
};

const STATUSES = ['Pending','RFQSent','QuotesReceived','EvaluationPending','Approved','Reconciled','Cancelled'];

export default function RequisitionsPage() {
  const navigate = useNavigate();
  const [rows, setRows]       = useState([]);
  const [stats, setStats]     = useState({});
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [page, setPage]       = useState(1);
  const [total, setTotal]     = useState(0);
  const [search, setSearch]   = useState('');
  const [status, setStatus]   = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo]     = useState('');
  const LIMIT = 25;

  // Multi-select for bundling several requisitions into one combined RFQ.
  // Only requisitions with at least one item not yet linked to an RFQ
  // (AvailableItemCount > 0) are selectable — per-item RFQ linkage
  // (2026-08-25) means a requisition can still have unsent items left
  // even after an earlier RFQ went out for some of them.
  const [selectedIds, setSelectedIds] = useState([]);

  // "Feed Quote Directly" — for a requisition Procurement already has a
  // price for (phoned in, WhatsApp, an old email), skips the normal
  // dispatch-and-wait cycle: pick the supplier here, then hand off to the
  // existing Capture Quotation form to key in the known price. See
  // quickRfqRow state below for the picker modal.
  const [quickRfqRow, setQuickRfqRow]         = useState(null); // the row being quoted, or null
  const [quickRfqSuppliers, setQuickRfqSuppliers] = useState([]);
  const [quickRfqLoading, setQuickRfqLoading] = useState(false);
  const [quickRfqSearch, setQuickRfqSearch]   = useState('');
  const [quickRfqSearchResults, setQuickRfqSearchResults] = useState(null); // null = not searched yet
  const [quickRfqSearching, setQuickRfqSearching] = useState(false);
  const [quickRfqSubmitting, setQuickRfqSubmitting] = useState(false);
  const [quickRfqError, setQuickRfqError]     = useState('');

  // Transport fuel orders (2026-10-19) are raised in Busy straight from here — no RFQ.
  const [fuelRow, setFuelRow] = useState(null);
  const [fuelMsg, setFuelMsg] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    const params = { page, limit: LIMIT };
    if (search)   params.search   = search;
    if (status)   params.status   = status;
    if (dateFrom) params.dateFrom = dateFrom;
    if (dateTo)   params.dateTo   = dateTo;
    Promise.all([
      api.get('/procurement/requisitions', { params }),
      api.get('/procurement/requisitions/stats'),
    ])
      .then(([dataRes, statsRes]) => {
        setRows(dataRes.data.data);
        setTotal(dataRes.data.total);
        setStats(statsRes.data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page, search, status, dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  // Selections don't carry meaning across pages/filters — the set of rows
  // visible changes, so clear selection whenever the page or filters change.
  useEffect(() => { setSelectedIds([]); }, [page, search, status, dateFrom, dateTo]);

  const handleSync = () => {
    setSyncing(true);
    setSyncMsg('');
    api.post('/procurement/requisitions/sync')
      .then((r) => {
        setSyncMsg(`Sync complete — ${r.data.synced} new requisition(s) ingested.`);
        load();
      })
      .catch((e) => setSyncMsg(e.response?.data?.error || 'Sync failed'))
      .finally(() => setSyncing(false));
  };

  const toggleSelect = (row) => {
    if (!row.AvailableItemCount || row.OrderType === 'Fuel') return; // not selectable — every item already sent, or fuel (no RFQ)
    setSelectedIds((prev) =>
      prev.includes(row.RequisitionId)
        ? prev.filter((i) => i !== row.RequisitionId)
        : [...prev, row.RequisitionId]
    );
  };

  const selectableRows = rows.filter((r) => !!r.AvailableItemCount && r.OrderType !== 'Fuel');
  const allSelectableSelected = selectableRows.length > 0 && selectableRows.every((r) => selectedIds.includes(r.RequisitionId));

  const toggleSelectAll = () => {
    if (allSelectableSelected) {
      setSelectedIds((prev) => prev.filter((id) => !selectableRows.some((r) => r.RequisitionId === id)));
    } else {
      setSelectedIds((prev) => [...new Set([...prev, ...selectableRows.map((r) => r.RequisitionId)])]);
    }
  };

  const handleCreateCombinedRFQ = () => {
    if (selectedIds.length === 0) return;
    navigate(`/procurement/requisitions/bundle?ids=${selectedIds.join(',')}`);
  };

  const openQuickRfq = (row) => {
    setQuickRfqRow(row);
    setQuickRfqError('');
    setQuickRfqSearch('');
    setQuickRfqSearchResults(null);
    setQuickRfqLoading(true);
    api.get(`/procurement/requisitions/${row.RequisitionId}/matching-suppliers`)
      .then((r) => setQuickRfqSuppliers(r.data))
      .catch(() => setQuickRfqSuppliers([]))
      .finally(() => setQuickRfqLoading(false));
  };

  const closeQuickRfq = () => {
    setQuickRfqRow(null);
    setQuickRfqSuppliers([]);
    setQuickRfqError('');
  };

  const searchAllSuppliers = (e) => {
    e.preventDefault();
    if (!quickRfqSearch.trim()) return;
    setQuickRfqSearching(true);
    api.get('/suppliers', { params: { search: quickRfqSearch.trim(), active: 'true' } })
      .then((r) => setQuickRfqSearchResults(Array.isArray(r.data) ? r.data : r.data?.data || []))
      .catch(() => setQuickRfqSearchResults([]))
      .finally(() => setQuickRfqSearching(false));
  };

  const chooseQuickRfqSupplier = async (supplierId) => {
    if (!quickRfqRow) return;
    setQuickRfqSubmitting(true);
    setQuickRfqError('');
    try {
      const res = await api.post(`/procurement/requisitions/${quickRfqRow.RequisitionId}/quick-rfq`, { supplierId });
      navigate(`/procurement/quotations?rfqId=${res.data.rfqId}&dispatchId=${res.data.dispatchId}`);
    } catch (e) {
      setQuickRfqError(e.response?.data?.error || 'Failed to create RFQ');
    } finally {
      setQuickRfqSubmitting(false);
    }
  };

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Requisitions</h1>
          <p className="page-subtitle">Approved indents synced from Busy ERP</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {selectedIds.length > 0 && (
            <button className="btn btn-primary" onClick={handleCreateCombinedRFQ}>
              Create Combined RFQ ({selectedIds.length} selected)
            </button>
          )}
          <button className="btn btn-primary" onClick={handleSync} disabled={syncing}>
            {syncing ? 'Syncing…' : '↺ Sync from Busy'}
          </button>
        </div>
      </div>

      {syncMsg && (
        <div className={`alert ${syncMsg.includes('failed') || syncMsg.includes('Failed') ? 'alert-error' : 'alert-success'}`}
          style={{ marginBottom: 16 }}>
          {syncMsg}
        </div>
      )}

      {fuelMsg && (
        <div className="alert alert-success" style={{ marginBottom: 16 }}>{fuelMsg}</div>
      )}

      {/* Stats bar */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => { setStatus(status === s ? '' : s); setPage(1); }}
            style={{
              padding: '8px 14px', borderRadius: 20,
              border: `2px solid ${status === s ? '#1a73e8' : '#e5e7eb'}`,
              background: status === s ? '#e8f0fe' : '#fff',
              cursor: 'pointer', fontSize: 13, fontWeight: 600,
              color: status === s ? '#1a73e8' : '#374151',
            }}>
            {s} <span style={{ fontWeight: 400, color: '#6b7280' }}>({stats[s] || 0})</span>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          className="form-input"
          placeholder="Search ordno / warehouse…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          style={{ width: 220 }}
        />
        <input type="date" className="form-input" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} style={{ width: 150 }} />
        <input type="date" className="form-input" value={dateTo}   onChange={(e) => { setDateTo(e.target.value);   setPage(1); }} style={{ width: 150 }} />
        {(search || dateFrom || dateTo) && (
          <button className="btn btn-secondary" onClick={() => { setSearch(''); setDateFrom(''); setDateTo(''); setPage(1); }}>
            Clear
          </button>
        )}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: 36 }}>
                <input
                  type="checkbox"
                  checked={allSelectableSelected}
                  onChange={toggleSelectAll}
                  disabled={selectableRows.length === 0}
                  title="Select all requisitions not yet part of an RFQ"
                />
              </th>
              <th>Busy Ord No</th>
              <th>Date</th>
              <th>Warehouse</th>
              <th>Mat Centre</th>
              <th>Items</th>
              <th>Quotes</th>
              <th>RFQ No</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={10} style={{ textAlign: 'center', padding: 32, color: '#6b7280' }}>Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={10} style={{ textAlign: 'center', padding: 32, color: '#6b7280' }}>No requisitions found</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.RequisitionId} style={{ background: selectedIds.includes(r.RequisitionId) ? '#e8f0fe' : undefined }}>
                <td>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(r.RequisitionId)}
                    onChange={() => toggleSelect(r)}
                    disabled={!r.AvailableItemCount || r.OrderType === 'Fuel'}
                    title={r.OrderType === 'Fuel' ? 'Fuel order — raised in Busy directly, no RFQ'
                      : r.AvailableItemCount ? 'Select for combined RFQ' : 'Every item already part of an RFQ'}
                  />
                </td>
                <td><strong>{r.BusyOrdNo}</strong></td>
                <td>{r.BusyDate ? new Date(r.BusyDate).toLocaleDateString('en-KE') : '—'}</td>
                <td>{r.Warehouse || '—'}</td>
                <td>
                  {r.MatCenter || '—'}
                  {r.OrderType === 'Fuel' && <span className="badge badge-orange" style={{ marginLeft: 6 }}>⛽ Fuel</span>}
                  {r.Vehicle && r.Vehicle !== r.MatCenter && <div style={{ fontSize: 11, color: '#6b7280' }}>Vehicle {r.Vehicle}</div>}
                </td>
                <td style={{ textAlign: 'center' }}>{r.ItemCount}</td>
                <td style={{ textAlign: 'center' }}>{r.QuotationCount ?? '—'}</td>
                <td>{r.RFQNumber || <span style={{ color: '#9ca3af' }}>—</span>}</td>
                <td><span className={`badge ${STATUS_COLOR[r.Status] || 'badge-gray'}`}>{r.Status}</span></td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="btn btn-secondary"
                    style={{ padding: '4px 12px', fontSize: 12 }}
                    onClick={() => navigate(`/procurement/requisitions/${r.RequisitionId}`)}>
                    View
                  </button>
                  {r.OrderType === 'Fuel' && r.Status === 'Pending' && (
                    <button
                      className="btn btn-primary"
                      style={{ padding: '4px 12px', fontSize: 12 }}
                      title="Fuel order — raise the PO in Busy directly, no RFQ."
                      onClick={() => { setFuelMsg(''); setFuelRow(r); }}>
                      ⛽ Raise PO in Busy
                    </button>
                  )}
                  {r.OrderType !== 'Fuel' && !!r.AvailableItemCount && r.Status !== 'Cancelled' && (
                    <button
                      className="btn btn-secondary"
                      style={{ padding: '4px 12px', fontSize: 12 }}
                      title="Already have a supplier's price for this? Skip the dispatch and enter it directly."
                      onClick={() => openQuickRfq(r)}>
                      💬 Feed Quote
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
          <button className="btn btn-secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>‹ Prev</button>
          <span style={{ padding: '8px 12px', fontSize: 13, color: '#6b7280' }}>
            Page {page} of {totalPages} &nbsp;({total} total)
          </span>
          <button className="btn btn-secondary" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>Next ›</button>
        </div>
      )}

      {/* "Feed Quote Directly" supplier picker — creates the RFQ +
          dispatch (no email sent) then hands off to the existing Capture
          Quotation form to key in the price Procurement already has. */}
      {quickRfqRow && (
        <div
          onClick={closeQuickRfq}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.55)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            padding: '5vh 16px', zIndex: 1000, overflowY: 'auto',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 12, width: '100%', maxWidth: 520,
              maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            }}
          >
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '18px 24px', borderBottom: '1px solid #e5e7eb',
            }}>
              <div>
                <h3 style={{ margin: 0 }}>Feed Quote Directly</h3>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>{quickRfqRow.BusyOrdNo}</p>
              </div>
              <button onClick={closeQuickRfq} aria-label="Close"
                style={{ background: 'none', border: 'none', fontSize: 22, lineHeight: 1, cursor: 'pointer', color: '#6b7280', padding: 4 }}>
                ✕
              </button>
            </div>

            <div style={{ padding: 24 }}>
              <p style={{ fontSize: 13, color: '#374151', margin: '0 0 16px' }}>
                Pick the supplier you already have a price from. This creates the RFQ without
                emailing anyone, then takes you straight to entering their price.
              </p>

              {quickRfqError && <div className="alert alert-error" style={{ marginBottom: 16 }}>{quickRfqError}</div>}

              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: '#374151' }}>
                Suggested suppliers (match this requisition's item categories)
              </div>
              {quickRfqLoading ? (
                <p style={{ fontSize: 13, color: '#6b7280' }}>Loading…</p>
              ) : quickRfqSuppliers.length === 0 ? (
                <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>
                  No category-matched suppliers found — search for one below.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
                  {quickRfqSuppliers.map((s) => (
                    <button
                      key={s.SupplierId}
                      disabled={quickRfqSubmitting}
                      onClick={() => chooseQuickRfqSupplier(s.SupplierId)}
                      style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                        padding: '10px 14px', border: '1px solid #e5e7eb', borderRadius: 6,
                        background: '#fff', cursor: quickRfqSubmitting ? 'default' : 'pointer', textAlign: 'left', width: '100%',
                      }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{s.SupplierName}</div>
                        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{s.SupplierCategories || '—'}</div>
                      </div>
                      <div style={{ fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>{s.Phone || s.Email || '—'}</div>
                    </button>
                  ))}
                </div>
              )}

              <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: '#374151' }}>
                  Or search all suppliers
                </div>
                <form onSubmit={searchAllSuppliers} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <input className="form-input" style={{ flex: 1 }} value={quickRfqSearch}
                    onChange={(e) => setQuickRfqSearch(e.target.value)}
                    placeholder="Supplier name or code…" />
                  <button type="submit" className="btn btn-secondary" disabled={quickRfqSearching || !quickRfqSearch.trim()}>
                    {quickRfqSearching ? 'Searching…' : 'Search'}
                  </button>
                </form>
                {quickRfqSearchResults && (
                  quickRfqSearchResults.length === 0 ? (
                    <p style={{ fontSize: 13, color: '#6b7280' }}>No active suppliers match "{quickRfqSearch}".</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {quickRfqSearchResults.map((s) => (
                        <button
                          key={s.SupplierId}
                          disabled={quickRfqSubmitting}
                          onClick={() => chooseQuickRfqSupplier(s.SupplierId)}
                          style={{
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                            padding: '10px 14px', border: '1px solid #e5e7eb', borderRadius: 6,
                            background: '#fff', cursor: quickRfqSubmitting ? 'default' : 'pointer', textAlign: 'left', width: '100%',
                          }}>
                          <div style={{ fontWeight: 600, fontSize: 14 }}>{s.SupplierName}</div>
                          <div style={{ fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>{s.Phone || s.Email || '—'}</div>
                        </button>
                      ))}
                    </div>
                  )
                )}
              </div>

              {quickRfqSubmitting && (
                <p style={{ fontSize: 13, color: '#6b7280', marginTop: 16 }}>Creating RFQ…</p>
              )}
            </div>
          </div>
        </div>
      )}

      {fuelRow && (
        <RaiseFuelPoModal
          requisition={fuelRow}
          onClose={() => setFuelRow(null)}
          onRaised={(lpo, result) => {
            setFuelRow(null);
            setFuelMsg(`Busy PO ${lpo.ordno} raised for ${fuelRow.BusyOrdNo} (${fuelRow.Vehicle}).`
              + [result.approvalWarning, result.totalWarning, result.userWarning].filter(Boolean).map((w) => ` ${w}`).join(''));
            load();
          }}
        />
      )}
    </div>
  );
}