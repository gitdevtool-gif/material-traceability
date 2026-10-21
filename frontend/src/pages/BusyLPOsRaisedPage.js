import React, { useEffect, useState, useCallback } from 'react';
import api from '../services/api';

/**
 * LPOs Raised in Busy (2026-10-15) — every award linked to a Busy Purchase
 * Order, whether marked raised from the Awarded Suppliers page, matched on
 * the LPO Reconciliation page, or auto-matched by the sync. Each row shows
 * our side (RFQ, requisitions, quoted amount) next to the LPO's live state
 * in Busy (approval, VAT-inclusive total, prints, item lines).
 */
const fmtMoney = (n) =>
  n === null || n === undefined
    ? '—'
    : Number(n).toLocaleString(undefined, { style: 'currency', currency: 'KES', maximumFractionDigits: 2 });
const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

const SOURCE_BADGE = {
  'Marked raised': 'badge-green',
  'Auto-matched': 'badge-blue',
  'Manual reconciliation': 'badge-gray',
};

export default function BusyLPOsRaisedPage() {
  const [rows, setRows]         = useState([]);
  const [busyError, setBusyError] = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [search, setSearch]     = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo]     = useState('');
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    const params = {};
    if (search.trim()) params.search = search.trim();
    if (dateFrom) params.dateFrom = dateFrom;
    if (dateTo) params.dateTo = dateTo;
    api.get('/procurement/busy-lpo/raised', { params })
      .then((r) => { setRows(r.data.data || []); setBusyError(r.data.busyError); })
      .catch((e) => setError(e.response?.data?.error || 'Failed to load LPOs'))
      .finally(() => setLoading(false));
  }, [search, dateFrom, dateTo]);

  useEffect(() => {
    const t = setTimeout(load, 300); // debounce typing in the search box
    return () => clearTimeout(t);
  }, [load]);

  const pendingCount = rows.filter((r) => r.busy && r.busy.approvalStatus !== 1).length;
  const totalExVat = rows.reduce((s, r) => s + Number(r.busy ? r.busy.totalAmt : r.TotalActualAmt || 0), 0);

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">LPOs Raised in Busy</h1>
          <p className="page-subtitle">
            Awarded quotations and the Busy LPO raised for each, with the LPO&apos;s live status in Busy.
          </p>
        </div>
        <button className="btn btn-secondary" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}
      {busyError && <div className="alert alert-info" style={{ marginBottom: 16 }}>{busyError}</div>}

      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="form-input" placeholder="Search LPO no / supplier / RFQ / requisition…"
          value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 300, maxWidth: '100%' }} />
        <input type="date" className="form-input" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ width: 150 }} title="Busy LPO date from" />
        <input type="date" className="form-input" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ width: 150 }} title="Busy LPO date to" />
        <div style={{ fontSize: 13, color: '#6b7280', marginLeft: 'auto' }}>
          {rows.length} LPO{rows.length !== 1 ? 's' : ''} · {fmtMoney(totalExVat)} excl. VAT
          {pendingCount > 0 && <> · <span style={{ color: '#b45309' }}>{pendingCount} pending approval in Busy</span></>}
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Busy LPO No</th>
              <th>LPO Date</th>
              <th>Supplier</th>
              <th>RFQ / Requisition</th>
              <th style={{ textAlign: 'right' }}>Quoted</th>
              <th style={{ textAlign: 'right' }}>Busy excl. VAT</th>
              <th style={{ textAlign: 'right' }}>Busy incl. VAT</th>
              <th>Busy Status</th>
              <th>Linked</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr><td colSpan={9} style={{ textAlign: 'center', padding: 32, color: '#6b7280' }}>Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={9} style={{ textAlign: 'center', padding: 32, color: '#6b7280' }}>No LPOs found</td></tr>
            )}
            {rows.map((r) => {
              const b = r.busy;
              const isOpen = expanded === r.LPOReconciliationId;
              const actual = b ? b.totalAmt : r.TotalActualAmt;
              const variance = r.TotalQuotedAmt != null && actual != null ? Number(actual) - Number(r.TotalQuotedAmt) : null;
              return (
                <React.Fragment key={r.LPOReconciliationId}>
                  <tr onClick={() => setExpanded(isOpen ? null : r.LPOReconciliationId)} style={{ cursor: 'pointer' }}>
                    <td><strong>{r.BusyPurOrdNo}</strong> <span style={{ color: '#9ca3af', fontSize: 11 }}>{isOpen ? '▲' : '▼'}</span></td>
                    <td>{fmtDate(b ? b.date : r.BusyDate)}</td>
                    <td>{(b && b.supplier) || r.BusySupplier || r.AwardedSupplierName || '—'}</td>
                    <td style={{ fontSize: 12 }}>
                      <div>{r.RFQNumber || '—'}</div>
                      <div style={{ color: '#6b7280' }}>{r.RequisitionOrdNo || ''}</div>
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{fmtMoney(r.TotalQuotedAmt)}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>
                      {fmtMoney(actual)}
                      {variance !== null && Math.abs(variance) >= 0.01 && (
                        <div style={{ fontSize: 11, color: variance > 0 ? '#dc2626' : '#059669' }}>
                          {variance > 0 ? '+' : ''}{fmtMoney(variance)} vs quote
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{b ? fmtMoney(b.grandTotal) : '—'}</td>
                    <td style={{ fontSize: 12 }}>
                      {b ? (
                        <>
                          <span className={`badge ${b.approvalStatus === 1 ? 'badge-green' : 'badge-yellow'}`}>{b.approvalLabel}</span>
                          <div style={{ color: '#6b7280', marginTop: 3 }}>
                            {b.printCount > 0 ? `Printed ${b.printCount}× · last by ${b.lastPrintedBy || '—'}` : 'Not printed'}
                          </div>
                        </>
                      ) : (
                        <span className="badge badge-red" title="This LPO number no longer exists in Busy — it may have been deleted or renumbered">
                          Not found in Busy
                        </span>
                      )}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      <span className={`badge ${SOURCE_BADGE[r.Source] || 'badge-gray'}`}>{r.Source}</span>
                      <div style={{ color: '#6b7280', marginTop: 3 }}>
                        {r.MarkedByName || 'System'} · {fmtDate(r.ReconciledAt)}
                      </div>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={9} style={{ background: '#f9fafb', padding: '12px 20px' }}>
                        {b && b.items.length > 0 ? (
                          <table className="data-table" style={{ fontSize: 12, background: '#fff', marginBottom: 8 }}>
                            <thead>
                              <tr><th>Item (Busy)</th><th>Mat Centre</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Price</th><th style={{ textAlign: 'right' }}>Amount</th></tr>
                            </thead>
                            <tbody>
                              {b.items.map((it) => (
                                <tr key={it.SrNo}>
                                  <td>{it.itemName}</td>
                                  <td>{it.MatCenter || '—'}</td>
                                  <td style={{ textAlign: 'right' }}>{Number(it.Qty).toLocaleString()}</td>
                                  <td style={{ textAlign: 'right' }}>{fmtMoney(it.Price)}</td>
                                  <td style={{ textAlign: 'right' }}>{fmtMoney(it.Amt)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : (
                          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>No item lines available from Busy.</div>
                        )}
                        {r.Notes && <div style={{ fontSize: 12, color: '#374151' }}><strong>Notes:</strong> {r.Notes}</div>}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
