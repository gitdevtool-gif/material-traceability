import React, { useCallback, useEffect, useState } from 'react';
import api from '../services/api';

/**
 * Accounts — GRN payments (2026-11-11). Which GRNs a Director has approved for
 * payment, and where each stands in Busy: billed (purchase bill raised on the
 * GRN) and paid (payment made against that bill). Bills and payments are still
 * made in Busy; this page says which GRNs may be paid and what is outstanding.
 * "Not approved" lists GRNs still with the Director or queried — don't pay
 * them; any already billed in Busy are listed first.
 */
const money = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const day = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const VIEWS = [
  { key: 'ready', label: 'Approved — to bill', help: 'Approved by a Director, not yet billed in Busy.' },
  { key: 'billed', label: 'Billed — to pay', help: 'Approved and billed in Busy, not fully paid against the bill.' },
  { key: 'paid', label: 'Paid', help: 'Approved, billed and paid against the bill in Busy.' },
  { key: 'notApproved', label: 'Not approved — hold', help: 'Waiting for the Director, or queried back to Stores. Do not pay these yet.' },
];

function toCsv(rows) {
  const head = ['GRN', 'Date', 'Supplier', 'Amount', 'Status', 'Approved by', 'Approved on', 'PO', 'Ticket', 'Bill', 'Supplier invoice', 'Bill amount', 'Paid', 'Balance', 'Checks'];
  const lines = rows.map((x) => [
    x.grnNo, day(x.date), x.party, x.amount, x.status, x.approvedBy || '', x.approvedAt ? day(x.approvedAt) : '', x.poNos.join(' '), x.ticketNo || '',
    x.bills.map((b) => b.billNo).join(' '), x.bills.map((b) => b.supplierInvoiceNo || '').join(' '),
    x.bills.reduce((s, b) => s + b.amount, 0), x.bills.reduce((s, b) => s + b.paid, 0), x.bills.reduce((s, b) => s + b.balance, 0),
    x.warnings.map((w) => w.text).join('; '),
  ]);
  return [head, ...lines].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

export default function AccountsPaymentsPage() {
  const [view, setView] = useState('ready');
  const [filter, setFilter] = useState({ search: '', from: '', to: '' });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback((v = view) => {
    setLoading(true); setError('');
    const q = { view: v };
    Object.entries(filter).forEach(([k, val]) => { if (val) q[k] = val; });
    api.get('/grn-approvals/accounts', { params: q })
      .then((r) => setData(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load'))
      .finally(() => setLoading(false));
  }, [view, filter]);
  useEffect(() => { load(view); }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  const download = () => {
    const blob = new Blob([toCsv(data.data)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `grn-payments-${view}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const current = VIEWS.find((v) => v.key === view);

  return (
    <div>
      <div className="page-header">
        <h1>GRN Payments</h1>
        <p style={{ color: '#6b7280', margin: 0 }}>
          Pay only GRNs a Director has approved. Bills and payments are made in Busy — this shows where each approved GRN stands there.
        </p>
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="card">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {VIEWS.map((v) => (
            <button key={v.key} className={`btn ${view === v.key ? 'btn-primary' : 'btn-outline'}`} style={{ fontSize: 13 }} onClick={() => setView(v.key)}>
              {v.label}{data?.counts ? ` (${data.counts[v.key]})` : ''}
            </button>
          ))}
        </div>
        <p style={{ fontSize: 13, color: '#6b7280', marginTop: 0 }}>{current.help}</p>
        <form onSubmit={(e) => { e.preventDefault(); load(view); }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Search</label>
            <input type="search" value={filter.search} onChange={(e) => setFilter({ ...filter, search: e.target.value })} placeholder="GRN no., supplier, entry" style={{ minWidth: 220 }} />
          </div>
          <div className="form-group" style={{ margin: 0 }}><label>From</label><input type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} /></div>
          <div className="form-group" style={{ margin: 0 }}><label>To</label><input type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} /></div>
          <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Loading…' : 'Search'}</button>
          {data?.data?.length > 0 && <button type="button" className="btn btn-outline" onClick={download}>⬇ Export CSV</button>}
          {data && (
            <span style={{ marginLeft: 'auto', fontSize: 13 }}>
              {data.data.length} GRN{data.data.length === 1 ? '' : 's'} · KES {money(data.totals.amount)}
              {view === 'billed' && <> · outstanding KES {money(data.totals.balance)}</>}
            </span>
          )}
        </form>

        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ fontSize: 13 }}>
            <thead>
              <tr>
                <th>GRN</th><th>Supplier</th><th style={{ textAlign: 'right' }}>GRN amount</th><th>Director</th><th>PO / ticket</th>
                <th>Busy bill</th><th style={{ textAlign: 'right' }}>Billed</th><th style={{ textAlign: 'right' }}>Paid</th><th style={{ textAlign: 'right' }}>Balance</th><th>Checks</th><th />
              </tr>
            </thead>
            <tbody>
              {(data?.data || []).map((x) => {
                const billed = x.bills.reduce((s, b) => s + b.amount, 0);
                const paid = x.bills.reduce((s, b) => s + b.paid, 0);
                const balance = x.bills.reduce((s, b) => s + b.balance, 0);
                const notes = x.warnings.filter((w) => w.level !== 'info');
                return (
                  <tr key={x.vchCode} style={view === 'notApproved' && x.billed !== 'Not billed' ? { background: '#fef2f2' } : undefined}>
                    <td style={{ whiteSpace: 'nowrap' }}><strong>{x.grnNo}</strong><div style={{ fontSize: 11, color: '#6b7280' }}>{day(x.date)}</div></td>
                    <td>{x.party}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{money(x.amount)}</td>
                    <td style={{ fontSize: 12 }}>
                      {x.status === 'Approved'
                        ? <><span className="badge badge-green">Approved</span><div>{x.approvedBy} · {day(x.approvedAt)}</div></>
                        : <><span className={`badge ${x.status === 'Queried' ? 'badge-orange' : 'badge-yellow'}`}>{x.status}</span>{x.queryReason && <div style={{ color: '#9a3412' }}>{x.queryReason}</div>}</>}
                    </td>
                    <td style={{ fontSize: 12 }}>{x.poNos.join(', ') || '—'}{x.ticketNo ? <div>Ticket {x.ticketNo}</div> : null}</td>
                    <td style={{ fontSize: 12 }}>
                      {x.bills.length ? x.bills.map((b) => <div key={b.billNo}>{b.billNo}{b.supplierInvoiceNo ? ` · inv ${b.supplierInvoiceNo}` : ''} · {day(b.date)}</div>) : <span className="badge badge-gray">{x.billed}</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>{x.bills.length ? money(billed) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{x.bills.length ? money(paid) : '—'}</td>
                    <td style={{ textAlign: 'right', fontWeight: balance > 0.5 ? 600 : undefined }}>{x.bills.length ? money(balance) : '—'}</td>
                    <td style={{ fontSize: 11, maxWidth: 220 }}>
                      {notes.map((w, i) => <div key={i} style={{ color: w.level === 'high' ? '#991b1b' : '#92400e' }}>{w.text}</div>)}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {x.entryId && <a className="btn btn-outline" style={{ padding: '4px 8px', fontSize: 12 }} href={`/grn-print/${x.entryId}`} target="_blank" rel="noreferrer">🖨 GRN</a>}
                    </td>
                  </tr>
                );
              })}
              {data && data.data.length === 0 && <tr><td colSpan={11} className="text-center text-muted">Nothing here</td></tr>}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 12, color: '#6b7280', marginTop: 10 }}>
          "Paid" counts payments made against the bill in Busy. A payment posted on account (not against the bill) does not show here — check the supplier's ledger in Busy.
        </p>
      </div>
    </div>
  );
}
