import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';

/**
 * GRN Approval (2026-11-11) — a Director approves each Busy GRN before
 * Accounts pay it, instead of signing a paper copy with the weighbridge ticket
 * attached. Every GRN shows its trail (PO and price, gate entry, weighbridge,
 * QA) and the checks that need a closer look; flagged ones are listed first.
 * A Director can approve many at once, or query one back to Stores, who fix
 * it in Busy and resubmit it.
 */
const money = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const qty = (n) => (n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 }));
const day = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const dayTime = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const LEVEL = { high: { bg: '#fee2e2', fg: '#991b1b' }, warn: { bg: '#fef3c7', fg: '#92400e' }, info: { bg: '#f3f4f6', fg: '#4b5563' } };
const STATUS_BADGE = { Pending: 'badge-yellow', Queried: 'badge-orange', Approved: 'badge-green', Deleted: 'badge-gray' };
const BILL_BADGE = { 'Not billed': 'badge-gray', 'Partly billed': 'badge-yellow', Billed: 'badge-blue' };
// NeedsReason (2026-11-23): GRNs with a flagged check the GRN Reviewer has not yet explained
const TABS = ['Pending', 'NeedsReason', 'Queried', 'Approved', 'All'];
const TAB_LABEL = { NeedsReason: 'Awaiting reason' };
const REVIEWER_ROLES = ['GrnReviewer', 'Admin'];

/** One check, with the GRN Reviewer's reason under it (or "awaiting reason"). */
function Check({ w, small }) {
  const fs = small ? 11 : 12;
  return (
    <div>
      <span style={{ background: LEVEL[w.level].bg, color: LEVEL[w.level].fg, borderRadius: 4, padding: '1px 6px', fontSize: fs, display: 'inline-block' }}>{w.text}</span>
      {w.reason && (
        <div style={{ fontSize: fs, color: '#065f46', marginTop: 2, paddingLeft: 6, borderLeft: '2px solid #10b981' }}>
          <strong>Reason:</strong> {w.reason.reason}
          <span style={{ color: '#6b7280' }}> — {w.reason.by || 'GRN Reviewer'}{w.reason.at ? `, ${dayTime(w.reason.at)}` : ''}</span>
        </div>
      )}
      {w.needsReason && <div style={{ fontSize: fs, color: '#991b1b', marginTop: 2, paddingLeft: 6, fontStyle: 'italic' }}>Awaiting the GRN Reviewer's reason</div>}
    </div>
  );
}

function Checks({ warnings, max }) {
  if (!warnings?.length) return <span style={{ color: '#065f46', fontSize: 12 }}>✓ No issues</span>;
  const shown = max ? warnings.slice(0, max) : warnings;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {shown.map((w, i) => <Check key={w.key || i} w={w} small />)}
      {max && warnings.length > max && <span style={{ fontSize: 11, color: '#6b7280' }}>+{warnings.length - max} more</span>}
    </div>
  );
}

/** The GRN Reviewer writes why each flagged check is so; saved together. */
function ReasonForm({ d, onSaved }) {
  const flagged = d.warnings.filter((w) => w.level !== 'info');
  const [text, setText] = useState(() => Object.fromEntries(flagged.map((w) => [w.key, w.reason?.reason || ''])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const changed = flagged.filter((w) => (text[w.key] || '').trim() && (text[w.key] || '').trim() !== (w.reason?.reason || ''));
  const save = async () => {
    setSaving(true); setError('');
    try {
      await api.post(`/grn-approvals/${d.vchCode}/reasons`, { items: changed.map((w) => ({ key: w.key, reason: text[w.key].trim() })) });
      onSaved();
    } catch (e) { setError(e.response?.data?.error || 'Could not save the reasons'); } finally { setSaving(false); }
  };
  if (!flagged.length) return null;
  return (
    <div style={{ border: '1px solid #fcd34d', background: '#fffbeb', borderRadius: 6, padding: 12, marginTop: 8 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Your reason for each check — the Director reads this before approving</div>
      {error && <div className="alert alert-error" style={{ marginBottom: 8 }}>{error}</div>}
      {flagged.map((w) => (
        <div key={w.key} style={{ marginBottom: 10 }}>
          <span style={{ background: LEVEL[w.level].bg, color: LEVEL[w.level].fg, borderRadius: 4, padding: '1px 6px', fontSize: 12 }}>{w.text}</span>
          <textarea rows={2} value={text[w.key] || ''} onChange={(e) => setText({ ...text, [w.key]: e.target.value })}
            placeholder="Why is there a difference? e.g. price agreed with the supplier on …, second truck on another ticket, QA rejection applied on the bill …"
            style={{ width: '100%', marginTop: 4 }} />
        </div>
      ))}
      <button className="btn btn-primary" disabled={saving || !changed.length || changed.some((w) => text[w.key].trim().length < 3)} onClick={save}>
        {saving ? 'Saving…' : `Save reason${changed.length === 1 ? '' : 's'}${changed.length ? ` (${changed.length})` : ''}`}
      </button>
    </div>
  );
}

function Detail({ vchCode, onClose, onDone, onChanged, isDirector, isStores, isReviewer }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(null); // 'query' | 'resubmit'
  const [text, setText] = useState('');
  const load = useCallback(() => {
    setError('');
    api.get(`/grn-approvals/${vchCode}`).then((r) => setD(r.data)).catch((e) => setError(e.response?.data?.error || 'Could not load the GRN'));
  }, [vchCode]);
  useEffect(() => { load(); }, [load]);

  const act = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); onDone(); } catch (e) { setError(e.response?.data?.error || e.message || 'Failed'); } finally { setBusy(false); }
  };
  const approve = (override = false) => act(async () => {
    const body = { items: [{ vchCode: d.vchCode, signature: d.signature }] };
    if (override) Object.assign(body, { override: true, note: text });
    const r = await api.post('/grn-approvals/approve', body);
    const res = r.data.results[0];
    if (!res?.ok) throw new Error(res?.error || 'Not approved');
  });
  const isOpen = d && ['Pending', 'Queried'].includes(d.status);
  const query = () => act(() => api.post(`/grn-approvals/${d.vchCode}/query`, { reason: text }));
  const resubmit = () => act(() => api.post(`/grn-approvals/${d.vchCode}/resubmit`, { note: text }));

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }} onClick={onClose}>
      <div style={{ background: '#fff', width: 'min(980px, 100%)', height: '100%', overflow: 'auto', padding: 20 }} onClick={(e) => e.stopPropagation()}>
        {!d ? <div>{error || 'Loading…'}</div> : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
              <div>
                <h2 style={{ margin: 0 }}>{d.grnNo} <span className={`badge ${STATUS_BADGE[d.status]}`} style={{ fontSize: 12, verticalAlign: 'middle' }}>{d.status}</span></h2>
                <div style={{ color: '#4b5563' }}>{d.party} · {day(d.date)} · <strong>KES {money(d.amount)}</strong></div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {d.entryId && <a className="btn btn-outline" href={`/grn-print/${d.entryId}`} target="_blank" rel="noreferrer">🖨 GRN print</a>}
                <button className="btn btn-outline" onClick={onClose}>Close</button>
              </div>
            </div>
            {error && <div className="alert alert-error" style={{ marginBottom: 10 }}>{error}</div>}
            {d.status === 'Queried' && (
              <div className="alert alert-warning" style={{ marginBottom: 10 }}>
                Queried by {d.queriedBy} on {dayTime(d.queriedAt)}: <strong>{d.queryReason}</strong>
              </div>
            )}
            {d.status === 'Approved' && (
              <div className="alert alert-success" style={{ marginBottom: 10 }}>
                Approved by {d.approvedBy} on {dayTime(d.approvedAt)} at KES {money(d.approvedAmount)}{d.approvalNote ? ` — ${d.approvalNote}` : ''}
              </div>
            )}
            {d.resubmittedAt && d.status === 'Pending' && (
              <div className="alert alert-info" style={{ marginBottom: 10 }}>
                Resubmitted by {d.resubmittedBy} on {dayTime(d.resubmittedAt)}: {d.resubmitNote}
              </div>
            )}

            <h4 style={{ margin: '12px 0 6px' }}>Checks</h4>
            {isOpen && d.awaitingReason > 0 && (
              <div className="alert alert-warning" style={{ marginBottom: 8 }}>
                {d.awaitingReason} check{d.awaitingReason === 1 ? '' : 's'} waiting for the GRN Reviewer's reason — the Director approves once every flagged check has one.
              </div>
            )}
            {isReviewer && isOpen ? (
              <>
                {d.warnings.filter((w) => w.level === 'info').length > 0 && <Checks warnings={d.warnings.filter((w) => w.level === 'info')} />}
                <ReasonForm key={d.warnings.map((w) => `${w.key}${w.reason?.at || ''}`).join('|')} d={d} onSaved={() => { load(); onChanged(); }} />
                {!d.warnings.length && <Checks warnings={[]} />}
              </>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {d.warnings.length ? d.warnings.map((w, i) => <Check key={w.key || i} w={w} />) : <Checks warnings={[]} />}
              </div>
            )}

            <h4 style={{ margin: '16px 0 6px' }}>GRN lines (Busy)</h4>
            <table className="data-table" style={{ fontSize: 13 }}>
              <thead><tr><th>Item</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Price</th><th style={{ textAlign: 'right' }}>PO price</th><th style={{ textAlign: 'right' }}>Amount</th><th>Store</th><th>PO</th></tr></thead>
              <tbody>
                {d.lines.map((l) => (
                  <tr key={l.srNo}>
                    <td>{l.itemName}</td>
                    <td style={{ textAlign: 'right' }}>{qty(l.qty)} {l.unitName || ''}</td>
                    <td style={{ textAlign: 'right', color: l.poPrice > 0 && l.price > l.poPrice * 1.005 ? '#b91c1c' : undefined }}>{money(l.price)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {l.poPrice != null ? money(l.poPrice) : '—'}
                      {l.poPrice != null && l.poPriceInclVat && <div style={{ fontSize: 10, color: '#6b7280' }}>incl. VAT, as the GRN</div>}
                    </td>
                    <td style={{ textAlign: 'right' }}>{money(l.amount)}</td>
                    <td>{l.store || '—'}</td>
                    <td style={{ fontSize: 12 }}>{l.refs.length ? l.refs.map((r) => `${r.refNo || r.poNo} (${day(r.poDate)}) ${qty(r.qty)}`).join(', ') : <span style={{ color: '#b45309' }}>no PO</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d.narration && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Narration: {d.narration}</div>}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 16 }}>
              <div className="card" style={{ margin: 0 }}>
                <strong>Gate entry</strong>
                {d.entry ? (
                  <div style={{ fontSize: 13, marginTop: 4 }}>
                    {d.entry.entryNo}<br />Vehicle {d.entry.vehicle || d.vehicle || '—'}{d.entry.driver ? ` · ${d.entry.driver}` : ''}<br />At the gate {dayTime(d.entry.gateAt)}
                  </div>
                ) : <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>Entered in Busy with no gate entry here{d.vehicle ? ` · vehicle ${d.vehicle}` : ''}</div>}
              </div>
              <div className="card" style={{ margin: 0 }}>
                <strong>Weighbridge</strong>
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  Ticket {d.ticketNo || d.entry?.ticketNo || '—'}<br />
                  Net {d.entry?.netKg != null ? `${qty(d.entry.netKg)} kg` : '—'}
                </div>
              </div>
              <div className="card" style={{ margin: 0 }}>
                <strong>QA</strong>
                {d.entry?.qa ? (
                  <div style={{ fontSize: 13, marginTop: 4 }}>
                    {d.entry.qa.inspectionNo} · <strong>{d.entry.qa.decision}</strong><br />
                    Accepted {qty(d.entry.qa.acceptedQty)} · Rejected {qty(d.entry.qa.rejectedQty)}{d.entry.qa.rejectionPct ? ` (${d.entry.qa.rejectionPct}%)` : ''}<br />
                    {d.entry.qa.by ? `by ${d.entry.qa.by} ` : ''}
                    {d.entry.qa.logId && <a href={`/qa-copy/${d.entry.qa.logId}`} target="_blank" rel="noreferrer">QA record</a>}
                  </div>
                ) : <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>No QA inspection here</div>}
              </div>
              <div className="card" style={{ margin: 0 }}>
                <strong>Accounts (Busy)</strong>
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  <span className={`badge ${BILL_BADGE[d.billed] || 'badge-gray'}`}>{d.billed || '—'}</span>{d.paid ? ` · ${d.paid}` : ''}
                  {d.bills.map((b) => (
                    <div key={b.billNo}>{b.billNo}{b.supplierInvoiceNo ? ` (inv ${b.supplierInvoiceNo})` : ''} · {money(b.amount)} · paid {money(b.paid)}</div>
                  ))}
                </div>
              </div>
            </div>

            <h4 style={{ margin: '16px 0 6px' }}>History</h4>
            <table className="data-table" style={{ fontSize: 12 }}>
              <tbody>
                {d.events.map((e, i) => (
                  <tr key={i}><td style={{ whiteSpace: 'nowrap' }}>{dayTime(e.At)}</td><td>{e.Action}</td><td>{e.UserName || 'System'}</td><td>{e.Notes || ''}</td></tr>
                ))}
              </tbody>
            </table>

            <div style={{ position: 'sticky', bottom: 0, background: '#fff', borderTop: '1px solid #e5e7eb', paddingTop: 12, marginTop: 16 }}>
              {mode ? (
                <div>
                  <label style={{ fontWeight: 600 }}>
                    {mode === 'query' ? 'What should Stores check or correct?'
                      : mode === 'override' ? `Why approve without the GRN Reviewer's reason on ${d.awaitingReason} check${d.awaitingReason === 1 ? '' : 's'}? (kept in the history)`
                        : 'What was checked or corrected?'}
                  </label>
                  <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} style={{ width: '100%', marginTop: 4 }} autoFocus />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button className={`btn ${mode === 'override' ? 'btn-success' : 'btn-primary'}`} disabled={busy || text.trim().length < 3}
                      onClick={mode === 'query' ? query : mode === 'override' ? () => approve(true) : resubmit}>
                      {busy ? 'Saving…' : mode === 'query' ? 'Send query to Stores' : mode === 'override' ? `✓ Approve without reasons — KES ${money(d.amount)}` : 'Resubmit to the Director'}
                    </button>
                    <button className="btn btn-outline" onClick={() => { setMode(null); setText(''); }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {isDirector && isOpen && !d.awaitingReason && (
                    <button className="btn btn-success" disabled={busy} onClick={() => approve(false)}>{busy ? 'Approving…' : `✓ Approve — KES ${money(d.amount)}`}</button>
                  )}
                  {isDirector && isOpen && d.awaitingReason > 0 && (
                    <>
                      <button className="btn btn-success" disabled title="Every flagged check needs the GRN Reviewer's reason first">✓ Approve — waiting for reasons</button>
                      <button className="btn btn-outline" disabled={busy} onClick={() => setMode('override')}>Approve without reasons…</button>
                    </>
                  )}
                  {isDirector && ['Pending', 'Approved'].includes(d.status) && (
                    <button className="btn btn-outline" disabled={busy} onClick={() => setMode('query')}>↩ Query back to Stores</button>
                  )}
                  {isStores && d.status === 'Queried' && (
                    <button className="btn btn-primary" disabled={busy} onClick={() => setMode('resubmit')}>Resubmit for approval</button>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function GrnApprovalsPage() {
  const { user } = useAuth();
  const isDirector = ['Director', 'Admin'].includes(user?.role);
  const isStores = ['StoreReceiving', 'FactoryReceiving', 'FactoryQA', 'Supervisor', 'Admin'].includes(user?.role);
  const isReviewer = REVIEWER_ROLES.includes(user?.role);
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState(params.get('status') || (user?.role === 'GrnReviewer' ? 'NeedsReason' : isDirector || !isStores ? 'Pending' : 'Queried'));
  const [filter, setFilter] = useState({ search: '', from: '', to: '', flagged: false });
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ data: [], total: 0 });
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [open, setOpen] = useState(params.get('grn') ? parseInt(params.get('grn'), 10) : null);
  const [approving, setApproving] = useState(false);
  const LIMIT = 50;

  const load = useCallback((p = page) => {
    setLoading(true); setError('');
    const q = { status, page: p, limit: LIMIT };
    if (filter.search) q.search = filter.search;
    if (filter.from) q.from = filter.from;
    if (filter.to) q.to = filter.to;
    if (filter.flagged) q.flagged = '1';
    Promise.all([api.get('/grn-approvals', { params: q }), api.get('/grn-approvals/summary')])
      .then(([r, s]) => { setData(r.data); setSummary(s.data); setSelected(new Set()); })
      .catch((e) => setError(e.response?.data?.error || 'Could not load GRNs'))
      .finally(() => setLoading(false));
  }, [status, filter, page]);
  useEffect(() => { load(page); }, [status, page]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeTab = (t) => { setStatus(t); setPage(1); setParams({ status: t }); };
  const toggle = (v) => setSelected((s) => { const n = new Set(s); if (n.has(v)) n.delete(v); else n.add(v); return n; });
  // A GRN still waiting for the GRN Reviewer's reasons is approved one at a time from its page (with an override note)
  const approvable = data.data.filter((x) => ['Pending', 'Queried'].includes(x.status) && !x.awaitingReason);
  const allOn = approvable.length > 0 && approvable.every((x) => selected.has(x.vchCode));
  const picked = data.data.filter((x) => selected.has(x.vchCode));
  const pickedTotal = picked.reduce((s, x) => s + x.amount, 0);

  const approveSelected = async () => {
    const flagged = picked.filter((x) => x.flagged);
    if (flagged.length && !window.confirm(`${flagged.length} of the ${picked.length} selected GRNs have flagged checks (${flagged.map((x) => x.grnNo).join(', ')}). Have you read the GRN Reviewer's reasons? Approve them?`)) return;
    setApproving(true); setMsg(null);
    try {
      const r = await api.post('/grn-approvals/approve', { items: picked.map((x) => ({ vchCode: x.vchCode, signature: x.signature })) });
      const failed = r.data.results.filter((x) => !x.ok);
      setMsg({ ok: !failed.length, text: `${r.data.approved} GRN${r.data.approved === 1 ? '' : 's'} approved.${failed.length ? ` Not approved: ${failed.map((f) => `${f.grnNo || f.vchCode} — ${f.error}`).join('; ')}` : ''}` });
      load(page);
    } catch (e) {
      setMsg({ ok: false, text: e.response?.data?.error || 'Approval failed' });
    } finally { setApproving(false); }
  };

  const count = (t) => (t === 'Pending' ? summary?.pending?.count : t === 'Queried' ? summary?.queried?.count : t === 'Approved' ? summary?.approved?.count : t === 'NeedsReason' ? summary?.needsReason?.count : null);

  return (
    <div>
      <div className="page-header">
        <h1>GRN Approval</h1>
        <p style={{ color: '#6b7280', margin: 0 }}>
          Every GRN is approved by a Director before Accounts pay it. Flagged checks carry the GRN Reviewer's reason; the Director approves once every flagged check has one. Flagged GRNs are listed first.
          {summary && <> Pending: <strong>{summary.pending.count}</strong> · KES {money(summary.pending.amount)}. From {day(summary.startDate)}.</>}
        </p>
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      {msg && <div className={`alert ${msg.ok ? 'alert-success' : 'alert-warning'}`}>{msg.text}</div>}

      <div className="card">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {TABS.map((t) => (
            <button key={t} className={`btn ${status === t ? 'btn-primary' : 'btn-outline'}`} onClick={() => changeTab(t)} style={{ fontSize: 13 }}>
              {TAB_LABEL[t] || t}{count(t) != null ? ` (${count(t)})` : ''}
            </button>
          ))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); setPage(1); load(1); }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Search</label>
            <input type="search" value={filter.search} onChange={(e) => setFilter({ ...filter, search: e.target.value })} placeholder="GRN no., supplier, entry" style={{ minWidth: 220 }} />
          </div>
          <div className="form-group" style={{ margin: 0 }}><label>From</label><input type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} /></div>
          <div className="form-group" style={{ margin: 0 }}><label>To</label><input type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} /></div>
          {['Pending', 'Queried'].includes(status) && (
            <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" checked={filter.flagged} onChange={(e) => setFilter({ ...filter, flagged: e.target.checked })} /> Flagged only
            </label>
          )}
          <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Loading…' : 'Search'}</button>
        </form>

        {isDirector && approvable.length > 0 && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: '8px 12px', marginBottom: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13 }}>{selected.size ? `${selected.size} selected · KES ${money(pickedTotal)}` : 'Tick GRNs to approve several at once'}</span>
            <button className="btn btn-success" disabled={!selected.size || approving} onClick={approveSelected}>
              {approving ? 'Approving…' : `✓ Approve selected${selected.size ? ` (${selected.size})` : ''}`}
            </button>
          </div>
        )}

        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ fontSize: 13 }}>
            <thead>
              <tr>
                {isDirector && <th><input type="checkbox" checked={allOn} disabled={!approvable.length}
                  onChange={(e) => setSelected(e.target.checked ? new Set(approvable.map((x) => x.vchCode)) : new Set())} /></th>}
                <th>GRN</th><th>Supplier</th><th>Items</th><th style={{ textAlign: 'right' }}>Amount</th><th>PO</th>
                <th>Ticket / weighed</th><th>QA</th><th>Checks</th><th>Status</th><th>Busy bill</th><th />
              </tr>
            </thead>
            <tbody>
              {data.data.map((x) => (
                <tr key={x.vchCode} style={x.flagged ? { background: '#fffbeb' } : undefined}>
                  {isDirector && <td>{['Pending', 'Queried'].includes(x.status) && (x.awaitingReason
                    ? <span title="Waiting for the GRN Reviewer's reason" style={{ fontSize: 14 }}>⏳</span>
                    : <input type="checkbox" checked={selected.has(x.vchCode)} onChange={() => toggle(x.vchCode)} />)}</td>}
                  <td style={{ whiteSpace: 'nowrap' }}><strong>{x.grnNo}</strong><div style={{ fontSize: 11, color: '#6b7280' }}>{day(x.date)}{x.entryNo ? ` · ${x.entryNo}` : ''}</div></td>
                  <td>{x.party}</td>
                  <td style={{ fontSize: 12, maxWidth: 260 }}>{x.items.slice(0, 3).join('; ')}{x.items.length > 3 ? ` +${x.items.length - 3}` : ''}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{money(x.amount)}</td>
                  <td style={{ fontSize: 12 }}>{x.poNos.length ? x.poNos.join(', ') : <span style={{ color: '#b45309' }}>none</span>}</td>
                  <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{x.ticketNo || '—'}{x.netKg != null ? <div>{qty(x.netKg)} kg</div> : null}</td>
                  <td style={{ fontSize: 12 }}>{x.qa ? <>{x.qa.decision}{x.qa.rejectionPct ? ` · ${x.qa.rejectionPct}%` : ''}</> : '—'}</td>
                  <td style={{ minWidth: 240, maxWidth: 360 }}><Checks warnings={x.warnings} max={3} /></td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[x.status]}`}>{x.status}</span>
                    {x.status === 'Approved' && <div style={{ fontSize: 11, color: '#6b7280' }}>{x.approvedBy}</div>}
                    {x.status === 'Queried' && <div style={{ fontSize: 11, color: '#9a3412', maxWidth: 160 }}>{x.queryReason}</div>}
                    {x.resubmittedAt && x.status === 'Pending' && <div style={{ fontSize: 11, color: '#1e40af' }}>resubmitted</div>}
                  </td>
                  <td><span className={`badge ${BILL_BADGE[x.billed] || 'badge-gray'}`}>{x.billed || '—'}</span></td>
                  <td><button className="btn btn-outline" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setOpen(x.vchCode)}>Open</button></td>
                </tr>
              ))}
              {!loading && data.data.length === 0 && (
                <tr><td colSpan={12} className="text-center text-muted">{status === 'Pending' ? 'Nothing waiting for approval' : status === 'NeedsReason' ? 'Every flagged check has a reason' : 'No GRNs'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {data.total > LIMIT && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', marginTop: 10, fontSize: 13 }}>
            <button className="btn btn-outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev</button>
            <span>Page {page} of {Math.ceil(data.total / LIMIT)}</span>
            <button className="btn btn-outline" disabled={page >= Math.ceil(data.total / LIMIT)} onClick={() => setPage(page + 1)}>Next ›</button>
          </div>
        )}
      </div>

      {open && (
        <Detail vchCode={open} isDirector={isDirector} isStores={isStores} isReviewer={isReviewer}
          onChanged={() => load(page)}
          onClose={() => { setOpen(null); if (params.get('grn')) setParams({ status }); }}
          onDone={() => { setOpen(null); load(page); }} />
      )}
    </div>
  );
}
