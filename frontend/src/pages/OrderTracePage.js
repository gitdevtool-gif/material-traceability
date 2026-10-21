import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../services/api';

/**
 * Order trace (2026-10-17) — one requisition followed end to end:
 * requisition → Central Stores → Ops → RFQ → quotes → award → Busy PO →
 * gate / QA → Busy GRN → bill → payment, with a reconciliation of
 * quantities and values at every step (routes/trace.routes.js).
 */
const num = (n, dp = 2) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: dp }));
const date = (d) => (d ? new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: '2-digit' }) : '');

const STATE = {
  done:     { icon: '✓', color: '#065f46', bg: '#d1fae5' },
  partial:  { icon: '◐', color: '#92400e', bg: '#fef3c7' },
  pending:  { icon: '…', color: '#1d4ed8', bg: '#dbeafe' },
  held:     { icon: '⏸', color: '#92400e', bg: '#fef3c7' },
  rejected: { icon: '✕', color: '#991b1b', bg: '#fee2e2' },
  skipped:  { icon: '!', color: '#991b1b', bg: '#fee2e2' },
  na:       { icon: '–', color: '#9ca3af', bg: '#f3f4f6' },
};

function Stages({ stages }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {stages.map((s) => {
        const st = STATE[s.state] || STATE.na;
        return (
          <div key={s.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, opacity: s.state === 'na' ? 0.55 : 1 }}>
            <span style={{ width: 22, height: 22, borderRadius: 11, background: st.bg, color: st.color, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flexShrink: 0 }}>
              {st.icon}
            </span>
            <div style={{ minWidth: 170, fontWeight: 600 }}>{s.label}</div>
            <div style={{ color: '#374151' }}>
              {s.info || (s.state === 'pending' ? 'waiting' : s.state === 'na' ? 'not applicable' : '')}
              {(s.at || s.by) && <span style={{ color: '#6b7280' }}> · {date(s.at)}{s.by ? ` · ${s.by}` : ''}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Reconciliation({ r }) {
  const cells = [
    ['Requested', r.requestedQty], ['Central Stores', r.centralStoresQty], ['Ops approved', r.opsApprovedQty],
    ['Awarded', r.awardedQty != null ? `${num(r.awardedQty)} @ ${num(r.awardedPrice)}` : null],
    ['Busy PO', r.poQty != null ? `${num(r.poQty)} @ ${num(r.poPrice)}` : null],
    ['Received', r.receivedQty], ['Still pending', r.pendingQty],
    ['Billed (KES)', r.billedAmount], ['Paid (KES)', r.paidAmount],
  ];
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {cells.map(([k, v]) => (
          <div key={k} style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 8px', fontSize: 12, minWidth: 92 }}>
            <div style={{ color: '#6b7280' }}>{k}</div>
            <div style={{ fontWeight: 600 }}>{typeof v === 'number' ? num(v) : v ?? '—'}</div>
          </div>
        ))}
      </div>
      {r.flags.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: '#b45309' }}>{r.flags.map((f) => <div key={f}>⚠ {f}</div>)}</div>
      )}
    </div>
  );
}

export default function OrderTracePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  const [trace, setTrace] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) { setTrace(null); return; }
    setLoading(true);
    setError('');
    api.get(`/trace/requisition/${id}`)
      .then((r) => setTrace(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load the trace'))
      .finally(() => setLoading(false));
  }, [id]);

  const search = (e) => {
    e.preventDefault();
    if (q.trim().length < 3) return;
    api.get('/trace/find', { params: { q: q.trim() } }).then((r) => setFound(r.data)).catch(() => setFound([]));
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Order Trace</h1>
          <p className="page-subtitle">Requisition → approvals → RFQ → award → Busy PO → gate & QA → GRN → bill → payment.</p>
        </div>
      </div>

      <form onSubmit={search} style={{ display: 'flex', gap: 8, marginBottom: 12, maxWidth: 560 }}>
        <input className="form-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Requisition no., RFQ no., Busy PO no. or item" />
        <button className="btn btn-primary" type="submit">Find</button>
      </form>
      {found && (
        <div className="card" style={{ marginBottom: 16, padding: 10 }}>
          {found.length === 0 ? <div style={{ fontSize: 13, color: '#6b7280' }}>Nothing found.</div> : (
            <table className="data-table" style={{ fontSize: 13 }}>
              <tbody>
                {found.map((f) => (
                  <tr key={`${f.RequisitionId}-${f.RFQNumber}-${f.BusyPurOrdNo}`} style={{ cursor: 'pointer' }}
                    onClick={() => { setFound(null); navigate(`/procurement/trace/${f.RequisitionId}`); }}>
                    <td><strong>{f.BusyOrdNo}</strong></td><td>{date(f.BusyDate)}</td><td>{f.MatCenter}</td>
                    <td>{f.RFQNumber || '—'}</td><td>{f.BusyPurOrdNo || '—'}</td><td>{f.Status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {loading && <div style={{ padding: 20, color: '#6b7280' }}>Tracing through this system and Busy…</div>}
      {error && <div className="alert alert-error">{error}</div>}
      {trace && (
        <>
          <div className="card" style={{ marginBottom: 12, padding: 12, fontSize: 13 }}>
            <strong style={{ fontSize: 15 }}>{trace.requisition.number}</strong> · {date(trace.requisition.date)} · {trace.requisition.store}
            {trace.requisition.raisedBy && ` · raised by ${trace.requisition.raisedBy}`} · status <strong>{trace.requisition.status}</strong>
          </div>
          {trace.items.map((it) => (
            <div key={it.requisitionItemId} className="card" style={{ marginBottom: 12, padding: 14 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>
                {it.itemName}{it.unit ? <span style={{ fontWeight: 400, color: '#6b7280' }}> · {it.unit}</span> : null}
                {!it.busyItemCode && <span style={{ fontWeight: 400, fontSize: 12, color: '#b45309' }}> · not a Busy item name</span>}
              </div>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 420px' }}><Stages stages={it.stages} /></div>
                <div style={{ flex: '1 1 360px' }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Reconciliation</div>
                  <Reconciliation r={it.reconciliation} />
                  {it.receipts.length > 0 && (
                    <table className="data-table" style={{ fontSize: 12, marginTop: 10 }}>
                      <thead><tr><th>Received</th><th>Qty</th><th>Gate entry / QA</th><th>Bill</th><th>Paid</th></tr></thead>
                      <tbody>
                        {it.receipts.map((r) => (
                          <tr key={`${r.voucher}-${r.date}`}>
                            <td>{r.voucher}<div style={{ color: '#6b7280' }}>{date(r.date)}{r.vehicle ? ` · ${r.vehicle}` : ''}</div></td>
                            <td>{num(r.qty)}</td>
                            <td>{r.gateEntries.length ? r.gateEntries.map((e) => <div key={e.entryNo}>{e.entryNo}{e.qa ? ` · QA ${e.qa}` : ''}{e.netWeight ? ` · ${num(e.netWeight)} kg` : ''}</div>)
                              : <span style={{ color: '#991b1b' }}>no gate entry</span>}</td>
                            <td>{r.bills.length ? r.bills.map((b) => <div key={b.vchCode}>{b.billNo}{b.supplierInvoiceNo ? ` · inv ${b.supplierInvoiceNo}` : ''}</div>) : r.billed}</td>
                            <td>{r.paid || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {it.atGate.length > 0 && (
                    <div style={{ fontSize: 12, marginTop: 6 }}>On a truck at the gate now: {it.atGate.map((e) => `${e.entryNo} (${e.status})`).join(', ')}</div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
