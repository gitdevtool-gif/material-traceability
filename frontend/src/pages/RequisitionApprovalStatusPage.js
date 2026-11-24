import React, { useEffect, useState, useCallback } from 'react';
import api from '../services/api';
import { PreferredSupplierNote } from '../components/PreferredSupplier';
import { useAuth } from '../context/AuthContext';

/**
 * Read-only follow-up view for whoever raises the Busy Purchase Indent
 * (FactoryReceiving clerks) — they have no other way to check whether the
 * Ops Manager has approved, rejected, or held the requisition that indent
 * turned into. Backed by GET /procurement/requisition-approval/status,
 * which (unlike the Ops Manager's own /pending working queue) returns
 * requisitions in ANY status, so "did mine go through?" has an answer
 * even after it's already been decided.
 */
const fmtDate = (v) => (v ? new Date(v).toLocaleDateString('en-KE') : '—');
const fmtDT = (v) => (v ? new Date(v).toLocaleString('en-KE') : '—');

const UNRESOLVED_STATUSES = [
  'PendingCentralStoresApproval', 'RejectedByCentralStores',
  'PendingOpsApproval', 'OnHold', 'RejectedByOps',
];

// Workshop requisitions are approved by the Workshop HOD, the rest by the Ops Manager.
const approverOf = (row) => (String(row?.MatCenter || '').trim().toLowerCase() === 'workshop' ? 'Workshop HOD' : 'Ops Manager');

function statusInfo(row) {
  if (row.Status === 'PendingCentralStoresApproval') {
    return { label: 'Awaiting Central Stores Review', color: 'badge-gray' };
  }
  if (row.Status === 'RejectedByCentralStores') {
    return { label: 'Rejected by Central Stores', color: 'badge-red' };
  }
  if (row.Status === 'PendingOpsApproval') {
    return { label: approverOf(row) === 'Workshop HOD' ? 'Awaiting Workshop HOD' : 'Awaiting Ops Review', color: 'badge-gray' };
  }
  if (row.Status === 'OnHold') {
    return { label: 'On Hold', color: 'badge-yellow' };
  }
  if (row.Status === 'RejectedByOps') {
    return { label: 'Rejected', color: 'badge-red' };
  }
  if (row.Status === 'Cancelled') {
    return { label: 'Cancelled', color: 'badge-gray' };
  }
  // Anything past the statuses above (Pending, RFQSent, QuotesReceived,
  // EvaluationPending, Approved, Reconciled) means both gates it needed
  // to clear (Central Stores, and the Ops Manager for factory Mat
  // Centres) have been cleared, one way or another.
  return row.OpsApprovedAt
    ? { label: 'Approved', color: 'badge-green' }
    : { label: 'Approved (no review required)', color: 'badge-green' };
}

/**
 * Rejected items of a PARTLY-approved requisition (2026-10-26): the approved
 * items have gone on to Procurement, so the clerk resubmits the rejected
 * ones — they go into a new follow-up requisition that returns to whoever
 * rejected them. Each item can be resubmitted once.
 */
function ResubmitRejectedItems({ detail, canResubmit, onDone }) {
  const rejected = detail.rejectedForResubmit || [];
  const done = detail.resubmittedItems || [];
  const [picked, setPicked] = useState({});   // key -> { on, qty }
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    setPicked(Object.fromEntries(rejected.map((r) => [`${r.source}:${r.decisionId}`, { on: true, qty: String(r.qty) }])));
    setNote(''); setError(''); setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.RequisitionId]);

  if (!rejected.length && !done.length && !detail.resubmittedFrom) return null;
  const chosen = rejected.filter((r) => picked[`${r.source}:${r.decisionId}`]?.on);

  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await api.post(`/procurement/requisition-approval/${detail.RequisitionId}/resubmit-rejected-items`, {
        note,
        items: chosen.map((r) => ({ source: r.source, decisionId: r.decisionId, qty: picked[`${r.source}:${r.decisionId}`].qty })),
      });
      setResult(res.data);
      onDone && onDone();
    } catch (e) {
      setError(e.response?.data?.error || 'Could not resubmit the items');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginTop: 16 }}>
      {detail.resubmittedFrom && (
        <p style={{ fontSize: 13, margin: '0 0 10px', color: '#1e40af' }}>
          ↩ This requisition resubmits items rejected on <strong>{detail.resubmittedFrom.BusyOrdNo}</strong>.
        </p>
      )}

      {result && (
        <div className="alert alert-success" style={{ marginBottom: 10 }}>
          {result.items} item(s) resubmitted as <strong>{result.busyOrdNo}</strong> — now with the {result.approver} for review.
        </div>
      )}

      {rejected.length > 0 && !result && (
        <div style={{ border: '1px solid #fca5a5', background: '#fef2f2', borderRadius: 8, padding: 12 }}>
          <h4 style={{ margin: '0 0 4px' }}>Rejected items — resubmit</h4>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: '#6b7280' }}>
            The approved items have gone on to Procurement. Tick the rejected items that are still needed: they go into a
            new requisition back to whoever rejected them.
          </p>
          <table className="data-table" style={{ fontSize: 12, background: '#fff' }}>
            <thead><tr><th /><th>Item</th><th>Rejected by</th><th>Reason</th><th style={{ textAlign: 'right' }}>Qty to resubmit</th></tr></thead>
            <tbody>
              {rejected.map((r) => {
                const k = `${r.source}:${r.decisionId}`;
                const p = picked[k] || { on: false, qty: String(r.qty) };
                return (
                  <tr key={k}>
                    <td><input type="checkbox" disabled={!canResubmit} checked={p.on} onChange={(e) => setPicked({ ...picked, [k]: { ...p, on: e.target.checked } })} /></td>
                    <td>{r.itemName}</td>
                    <td>{r.stage}{r.rejectedBy && r.rejectedBy !== r.stage ? <div style={{ color: '#6b7280' }}>{r.rejectedBy}</div> : null}</td>
                    <td style={{ color: '#991b1b' }}>{r.reason || '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <input type="number" min="0" step="any" value={p.qty} disabled={!canResubmit || !p.on}
                        onChange={(e) => setPicked({ ...picked, [k]: { ...p, qty: e.target.value } })}
                        style={{ width: 100, textAlign: 'right' }} /> {r.unit || ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {canResubmit ? (
            <>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, margin: '10px 0 4px' }}>
                Why are these still needed? (required — the approver sees this)
              </label>
              <textarea className="form-input" rows={2} value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Stock has since fallen below the reorder level; production run for KOL order next week" />
              {error && <div className="alert alert-error" style={{ marginTop: 8 }}>{error}</div>}
              <button className="btn btn-primary" style={{ marginTop: 8 }} disabled={saving || !chosen.length || note.trim().length < 3} onClick={submit}>
                {saving ? 'Resubmitting…' : `↩ Resubmit ${chosen.length} item${chosen.length === 1 ? '' : 's'}`}
              </button>
            </>
          ) : (
            <p style={{ fontSize: 12, color: '#6b7280', margin: '8px 0 0' }}>The clerk who raised it (or Admin) can resubmit these.</p>
          )}
        </div>
      )}

      {done.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: '#374151' }}>
          <strong>Already resubmitted:</strong>{' '}
          {done.map((d) => `${d.itemName} → ${d.resubmittedInNo}`).join(' · ')}
        </div>
      )}
    </div>
  );
}

export default function RequisitionApprovalStatusPage() {
  const { user } = useAuth();
  const canResubmit = ['FactoryReceiving', 'FactoryQA', 'Admin'].includes(user?.role);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const LIMIT = 25;

  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [resubmitNote, setResubmitNote] = useState('');
  const [resubmitting, setResubmitting] = useState(false);
  const [resubmitDone, setResubmitDone] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    const params = { page, limit: LIMIT };
    if (search)   params.search   = search;
    if (status)   params.status   = status;
    if (dateFrom) params.dateFrom = dateFrom;
    if (dateTo)   params.dateTo   = dateTo;
    api.get('/procurement/requisition-approval/status', { params })
      .then((r) => { setRows(r.data.data); setTotal(r.data.total); })
      .catch(() => setError('Failed to load requisitions'))
      .finally(() => setLoading(false));
  }, [page, search, status, dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  const openDetail = async (row) => {
    setSelected(row);
    setDetail(null);
    setDetailLoading(true);
    setResubmitNote('');
    setResubmitDone(false);
    try {
      const res = await api.get(`/procurement/requisition-approval/${row.RequisitionId}`);
      setDetail(res.data);
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  };
  const closeDetail = () => { setSelected(null); setDetail(null); };

  const handleResubmit = async (endpointSuffix) => {
    if (!selected) return;
    setResubmitting(true);
    setError('');
    try {
      await api.patch(`/procurement/requisition-approval/${selected.RequisitionId}/${endpointSuffix}`, {
        note: resubmitNote,
      });
      setResubmitDone(true);
      load();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to resubmit');
    } finally {
      setResubmitting(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Requisition Approval Status</h1>
          <p className="page-subtitle">
            Look up any Busy Purchase Indent by its Ord No to see whether the Ops Manager has
            approved, rejected, or held it.
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <input className="form-input" placeholder="Search Busy Ord No…"
          value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          style={{ width: 220 }} />
        <select className="form-input" style={{ width: 200 }}
          value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>
          <option value="PendingCentralStoresApproval">Awaiting Central Stores Review</option>
          <option value="RejectedByCentralStores">Rejected by Central Stores</option>
          <option value="PendingOpsApproval">Awaiting Ops Review</option>
          <option value="OnHold">On Hold</option>
          <option value="RejectedByOps">Rejected</option>
          <option value="Pending">Approved — Pending RFQ</option>
          <option value="RFQSent">Approved — RFQ Sent</option>
          <option value="Reconciled">Approved — Reconciled</option>
          <option value="Cancelled">Cancelled</option>
        </select>
        <input type="date" className="form-input" value={dateFrom}
          onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} style={{ width: 150 }} />
        <input type="date" className="form-input" value={dateTo}
          onChange={(e) => { setDateTo(e.target.value); setPage(1); }} style={{ width: 150 }} />
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Busy Ord No</th>
              <th>Date</th>
              <th>Warehouse / Mat Centre</th>
              <th>Items</th>
              <th>Status</th>
              <th>Detail</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 32, color: '#6b7280' }}>Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 32, color: '#6b7280' }}>No requisitions found</td></tr>
            )}
            {!loading && rows.map((r) => {
              const info = statusInfo(r);
              return (
                <tr key={r.RequisitionId}>
                  <td><strong>{r.BusyOrdNo}</strong></td>
                  <td>{fmtDate(r.BusyDate)}</td>
                  <td>{r.MatCenter || r.Warehouse || '—'}</td>
                  <td style={{ textAlign: 'center' }}>{r.ItemCount}</td>
                  <td><span className={`badge ${info.color}`}>{info.label}</span></td>
                  <td style={{ fontSize: 12, color: '#6b7280', maxWidth: 240 }}>
                    {r.Status === 'RejectedByCentralStores' && r.CentralStoresRejectionReason}
                    {r.Status === 'RejectedByOps' && r.OpsRejectionReason}
                    {r.Status === 'OnHold' && r.HoldReason}
                    {r.RejectedItemCount > 0 && r.Status !== 'RejectedByOps' && (
                      <span>{r.RejectedItemCount} item(s) rejected by Ops, rest approved</span>
                    )}
                    {r.CentralStoresRejectedItemCount > 0 && r.Status !== 'RejectedByCentralStores' && (
                      <span>{r.CentralStoresRejectedItemCount} item(s) rejected by Central Stores, rest approved</span>
                    )}
                    {r.OpsApprovedByName && ` — ${r.OpsApprovedByName}`}
                    {r.CentralStoresApprovedByName && ` — ${r.CentralStoresApprovedByName}`}
                  </td>
                  <td>
                    <button className="btn btn-secondary" style={{ padding: '4px 12px', fontSize: 12 }}
                      onClick={() => openDetail(r)}>
                      View
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 16, alignItems: 'center' }}>
          <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Prev</button>
          <span style={{ fontSize: 13, color: '#6b7280' }}>Page {page} of {totalPages}</span>
          <button className="btn btn-secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next →</button>
        </div>
      )}

      {selected && (
        <div
          onClick={closeDetail}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.55)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            padding: '5vh 16px', zIndex: 1000, overflowY: 'auto',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 12, width: '100%', maxWidth: 800,
              maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            }}
          >
            <div style={{
              position: 'sticky', top: 0, background: '#fff', zIndex: 1,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '18px 24px', borderBottom: '1px solid #e5e7eb', borderRadius: '12px 12px 0 0',
            }}>
              <h3 style={{ margin: 0 }}>{selected.BusyOrdNo}</h3>
              <button onClick={closeDetail} aria-label="Close"
                style={{ background: 'none', border: 'none', fontSize: 22, lineHeight: 1, cursor: 'pointer', color: '#6b7280', padding: 4 }}>
                ✕
              </button>
            </div>

            <div style={{ padding: 24 }}>
              {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}
              {detailLoading && <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Loading…</div>}

              {!detailLoading && detail && (
                <>
                  <div style={{ padding: 12, background: '#f9fafb', borderRadius: 6, marginBottom: 16 }}>
                    <strong>Warehouse:</strong> {detail.Warehouse || '—'} &nbsp;·&nbsp;
                    <strong>Mat Centre:</strong> {detail.MatCenter || '—'} &nbsp;·&nbsp;
                    <strong>Date:</strong> {fmtDate(detail.BusyDate)}
                  </div>

                  <div style={{
                    padding: 12, borderRadius: 6, marginBottom: 16,
                    background: ['RejectedByOps', 'RejectedByCentralStores'].includes(detail.Status) ? '#fef2f2'
                      : detail.Status === 'OnHold' ? '#fffbeb'
                      : ['PendingOpsApproval', 'PendingCentralStoresApproval'].includes(detail.Status) ? '#f9fafb'
                      : '#f0fdf4',
                    border: `1px solid ${['RejectedByOps', 'RejectedByCentralStores'].includes(detail.Status) ? '#fca5a5'
                      : detail.Status === 'OnHold' ? '#fde68a'
                      : ['PendingOpsApproval', 'PendingCentralStoresApproval'].includes(detail.Status) ? '#e5e7eb'
                      : '#86efac'}`,
                  }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>
                      <span className={`badge ${statusInfo(detail).color}`}>{statusInfo(detail).label}</span>
                    </div>
                    {detail.Status === 'PendingCentralStoresApproval' && (
                      <p style={{ margin: 0, fontSize: 13 }}>Still waiting on Central Stores — check back later.</p>
                    )}
                    {detail.Status === 'RejectedByCentralStores' && (
                      <>
                        <p style={{ margin: 0, fontSize: 13 }}>
                          Rejected{detail.CentralStoresApprovedByName ? ` by ${detail.CentralStoresApprovedByName}` : ''}{detail.CentralStoresApprovedAt ? ` on ${fmtDT(detail.CentralStoresApprovedAt)}` : ''}.
                          {detail.CentralStoresRejectionReason && <><br />Reason: {detail.CentralStoresRejectionReason}</>}
                        </p>
                        {canResubmit && (
                          resubmitDone ? (
                            <p style={{ margin: '10px 0 0', fontSize: 13, color: '#166534', fontWeight: 600 }}>
                              ✓ Resubmitted — back with Central Stores for a fresh review.
                            </p>
                          ) : (
                            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #fca5a5' }}>
                              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                                Once you've addressed the reason above, resubmit for another look:
                              </label>
                              <textarea className="form-input" rows={2} value={resubmitNote}
                                onChange={(e) => setResubmitNote(e.target.value)}
                                placeholder="Optional — what did you do about it? e.g. Confirmed we don't already stock this"
                                style={{ marginBottom: 8 }} />
                              <button className="btn btn-primary" style={{ padding: '6px 14px', fontSize: 13 }}
                                disabled={resubmitting} onClick={() => handleResubmit('central-stores-resubmit')}>
                                {resubmitting ? 'Resubmitting…' : '↩ Resubmit to Central Stores'}
                              </button>
                            </div>
                          )
                        )}
                      </>
                    )}
                    {detail.Status === 'PendingOpsApproval' && (
                      <p style={{ margin: 0, fontSize: 13 }}>Cleared Central Stores — still waiting on the {approverOf(detail)}. Check back later.</p>
                    )}
                    {detail.Status === 'OnHold' && (
                      <p style={{ margin: 0, fontSize: 13 }}>
                        Held{detail.HoldByName ? ` by ${detail.HoldByName}` : ''}{detail.HoldAt ? ` on ${fmtDT(detail.HoldAt)}` : ''}.
                        {detail.HoldReason && <><br />Reason: {detail.HoldReason}</>}
                      </p>
                    )}
                    {detail.Status === 'RejectedByOps' && (
                      <>
                        <p style={{ margin: 0, fontSize: 13 }}>
                          Rejected{detail.OpsApprovedByName ? ` by ${detail.OpsApprovedByName}` : ''}{detail.OpsApprovedAt ? ` on ${fmtDT(detail.OpsApprovedAt)}` : ''}.
                          {detail.OpsRejectionReason && <><br />Reason: {detail.OpsRejectionReason}</>}
                        </p>
                        {canResubmit && (
                          resubmitDone ? (
                            <p style={{ margin: '10px 0 0', fontSize: 13, color: '#166534', fontWeight: 600 }}>
                              ✓ Resubmitted — back with the {approverOf(detail)} for a fresh review.
                            </p>
                          ) : (
                            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #fca5a5' }}>
                              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                                Once you've addressed the reason above, resubmit for another look:
                              </label>
                              <textarea className="form-input" rows={2} value={resubmitNote}
                                onChange={(e) => setResubmitNote(e.target.value)}
                                placeholder="Optional — what did you do about it? e.g. Rechecked stock, confirmed still needed"
                                style={{ marginBottom: 8 }} />
                              <button className="btn btn-primary" style={{ padding: '6px 14px', fontSize: 13 }}
                                disabled={resubmitting} onClick={() => handleResubmit('resubmit')}>
                                {resubmitting ? 'Resubmitting…' : `↩ Resubmit to ${approverOf(detail)}`}
                              </button>
                            </div>
                          )
                        )}
                      </>
                    )}
                    {!UNRESOLVED_STATUSES.includes(detail.Status) && (
                      <p style={{ margin: 0, fontSize: 13 }}>
                        {detail.OpsApprovedAt
                          ? <>Approved{detail.OpsApprovedByName ? ` by ${detail.OpsApprovedByName}` : ''} on {fmtDT(detail.OpsApprovedAt)}.</>
                          : <>This Mat Centre doesn't require Ops Manager review — it passed straight through to Procurement.</>}
                        {' '}Now at status <strong>{detail.Status}</strong> in the Procurement pipeline.
                      </p>
                    )}
                    {detail.CentralStoresNotes && <p style={{ margin: '8px 0 0', fontSize: 13 }}><strong>Central Stores notes:</strong> {detail.CentralStoresNotes}</p>}
                    {detail.OpsNotes && <p style={{ margin: '8px 0 0', fontSize: 13 }}><strong>{approverOf(detail)} notes:</strong> {detail.OpsNotes}</p>}
                  </div>

                  {detail.centralStoresDecisions && detail.centralStoresDecisions.length > 0 && (
                    <>
                      <h4 style={{ margin: '0 0 8px' }}>Central Stores Decisions</h4>
                      <table className="data-table" style={{ marginBottom: 16 }}>
                        <thead>
                          <tr><th>Item</th><th>Requested Qty</th><th>Decision</th><th>Approved Qty</th><th>Reason</th></tr>
                        </thead>
                        <tbody>
                          {detail.centralStoresDecisions.map((d, i) => (
                            <tr key={i}>
                              <td>{d.ItemName}</td>
                              <td style={{ textAlign: 'center' }}>{Number(d.RequestedQty).toLocaleString()}</td>
                              <td>
                                <span className={`badge ${d.Decision === 'Rejected' ? 'badge-red' : 'badge-green'}`}>{d.Decision}</span>
                              </td>
                              <td>{d.ApprovedQty != null ? Number(d.ApprovedQty).toLocaleString() : '—'}</td>
                              <td style={{ fontSize: 12, color: '#6b7280' }}>{d.RejectionReason || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}

                  <h4 style={{ margin: '0 0 8px' }}>Items{detail.items && detail.items.length === 0 ? ' (none survived Central Stores review — see above)' : ''}</h4>
                  <table className="data-table">
                    <thead>
                      <tr><th>Item</th><th>Qty</th><th>Decision</th><th>Approved Qty</th><th>Rejection Reason</th></tr>
                    </thead>
                    <tbody>
                      {(detail.items || []).map((it) => (
                        <tr key={it.RequisitionItemId}>
                          <td>{it.ItemName}<PreferredSupplierNote item={it} /></td>
                          <td style={{ textAlign: 'center' }}>{Number(it.Qty).toLocaleString()}</td>
                          <td>
                            {it.ItemDecision
                              ? <span className={`badge ${it.ItemDecision === 'Rejected' ? 'badge-red' : 'badge-green'}`}>{it.ItemDecision}</span>
                              : <span style={{ color: '#9ca3af' }}>—</span>}
                          </td>
                          <td>{it.ItemApprovedQty != null ? Number(it.ItemApprovedQty).toLocaleString() : '—'}</td>
                          <td style={{ fontSize: 12, color: '#6b7280' }}>{it.ItemRejectionReason || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <ResubmitRejectedItems
                    detail={detail}
                    canResubmit={['FactoryReceiving', 'FactoryQA', 'StoreReceiving', 'Admin'].includes(user?.role)}
                    onDone={() => { load(); openDetail(selected); }}
                  />
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
