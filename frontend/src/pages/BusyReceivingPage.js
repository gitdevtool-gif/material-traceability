import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';

/**
 * Receiving ↔ Busy (2026-10-17)
 *
 * One page that lines this system's gate → weighbridge → QA pipeline up with
 * Busy's PO → GRN → bill → payment chain (routes/busy-receiving.routes.js):
 *   POs not delivered          approved Busy POs not fully received (or on a truck at the gate now)
 *   Busy GRNs without gate entry  goods received in Busy that never came through the gate here
 *   Open gate entries          link each to the Busy GRN it became, or close it
 *   Supplier clean-up          merge gate-typed suppliers into their Busy account
 *   Accounts                   GRNs not billed / bills not paid, with PO + GRN behind each
 * Everything is read from Busy live; nothing here writes to Busy.
 */
const money = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }));
const qty = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 }));
const date = (d) => (d ? new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');
const isoDaysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

const TABS = [
  { key: 'po',       label: 'POs not delivered',            roles: null },
  { key: 'bypass',   label: 'Busy GRNs without gate entry',  roles: null },
  { key: 'entries',  label: 'Open gate entries',            roles: null },
  { key: 'suppliers',label: 'Supplier clean-up',            roles: ['Admin', 'Procurement'] },
  { key: 'accounts', label: 'Accounts',                     roles: ['Admin', 'Director', 'Procurement'] },
];

const stateColor = { 'Not received': '#b91c1c', 'Partly received': '#b45309', 'At the gate': '#1d4ed8' };
const confColor = { High: '#059669', Medium: '#b45309', Low: '#6b7280' };

function useLoader(fn, deps) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setLoading(true);
    setError('');
    return fn()
      .then((r) => setData(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load from Busy'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { load(); }, [load]);
  return { data, loading, error, reload: load, setData };
}

const Status = ({ loading, error }) => (
  <>
    {loading && <div style={{ padding: 20, color: '#6b7280' }}>Reading Busy…</div>}
    {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
  </>
);

// ── POs not delivered ────────────────────────────────────────────────────────
function PoTracker() {
  const { data, loading, error } = useLoader(() => api.get('/busy-receiving/po-tracker'), []);
  const [state, setState] = useState('');
  const [minAge, setMinAge] = useState('14');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(null);

  const rows = useMemo(() => (data || [])
    .filter((p) => !state || p.state === state)
    .filter((p) => p.ageDays >= (parseInt(minAge, 10) || 0))
    .filter((p) => !search || `${p.poNo} ${p.party} ${p.lines.map((l) => l.itemName).join(' ')}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => b.ageDays - a.ageDays), [data, state, minAge, search]);
  const totals = rows.reduce((t, p) => ({ n: t.n + 1, v: t.v + p.pendingValue }), { n: 0, v: 0 });

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <select className="form-input" style={{ width: 180 }} value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">All states</option><option>Not received</option><option>Partly received</option><option>At the gate</option>
        </select>
        <select className="form-input" style={{ width: 170 }} value={minAge} onChange={(e) => setMinAge(e.target.value)}>
          <option value="0">Any age</option><option value="7">7+ days old</option><option value="14">14+ days old</option>
          <option value="30">30+ days old</option><option value="60">60+ days old</option>
        </select>
        <input className="form-input" style={{ flex: 1, minWidth: 200 }} placeholder="Search PO, supplier, item" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <Status loading={loading} error={error} />
      {data && (
        <>
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            <strong>{totals.n}</strong> PO{totals.n !== 1 ? 's' : ''} · KES <strong>{money(totals.v)}</strong> still to be delivered
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ fontSize: 13 }}>
              <thead><tr><th>PO</th><th>Raised</th><th style={{ textAlign: 'right' }}>Age</th><th>Supplier</th><th>Items pending</th><th style={{ textAlign: 'right' }}>Pending value</th><th>State</th></tr></thead>
              <tbody>
                {rows.slice(0, 500).map((p) => (
                  <React.Fragment key={p.poVchCode}>
                    <tr onClick={() => setOpen(open === p.poVchCode ? null : p.poVchCode)} style={{ cursor: 'pointer' }}>
                      <td><strong>{p.poNo}</strong></td>
                      <td>{date(p.poDate)}</td>
                      <td style={{ textAlign: 'right' }}>{p.ageDays}d</td>
                      <td>{p.party}</td>
                      <td>{p.lines.length === 1 ? p.lines[0].itemName : `${p.lines.length} items`}</td>
                      <td style={{ textAlign: 'right' }}>{money(p.pendingValue)}</td>
                      <td style={{ color: stateColor[p.state], fontWeight: 600 }}>{p.state}</td>
                    </tr>
                    {open === p.poVchCode && (
                      <tr><td colSpan={7} style={{ background: '#f9fafb' }}>
                        <table className="data-table" style={{ fontSize: 12, margin: 0 }}>
                          <thead><tr><th>Item</th><th>Store</th><th style={{ textAlign: 'right' }}>Ordered</th><th style={{ textAlign: 'right' }}>Received</th><th style={{ textAlign: 'right' }}>Pending</th><th>Unit</th><th>At the gate</th></tr></thead>
                          <tbody>
                            {p.lines.map((l) => (
                              <tr key={l.refCode}>
                                <td>{l.itemName}</td><td>{l.store || '—'}</td>
                                <td style={{ textAlign: 'right' }}>{qty(l.ordered)}</td><td style={{ textAlign: 'right' }}>{qty(l.received)}</td>
                                <td style={{ textAlign: 'right' }}>{qty(l.pending)}</td><td>{l.unitName}</td>
                                <td>{l.atGate ? `${qty(l.atGate.qty)} · ${l.atGate.entryNos}` : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td></tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 500 && <div style={{ fontSize: 12, color: '#6b7280' }}>Showing the oldest 500 — narrow the filters.</div>}
        </>
      )}
    </div>
  );
}

// ── Busy GRNs without a gate entry ───────────────────────────────────────────
function Bypass() {
  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to, setTo] = useState(isoDaysAgo(0));
  const { data, loading, error } = useLoader(() => api.get('/busy-receiving/grns-without-entry', { params: { from, to } }), [from, to]);
  const byParty = useMemo(() => {
    const m = {};
    for (const g of data || []) m[g.party] = (m[g.party] || 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [data]);
  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        From <input type="date" className="form-input" style={{ width: 160 }} value={from} onChange={(e) => setFrom(e.target.value)} />
        to <input type="date" className="form-input" style={{ width: 160 }} value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
        Goods received (GRN'd) in Busy that have no gate entry in this system — they bypassed the gate, weighbridge and QA here,
        or the gate entry hasn't been linked yet (see Open gate entries).
      </div>
      <Status loading={loading} error={error} />
      {data && (
        <>
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            <strong>{data.length}</strong> Busy GRN{data.length !== 1 ? 's' : ''} without a gate entry
            {byParty.length > 0 && <span style={{ color: '#6b7280' }}> · most: {byParty.map(([p, n]) => `${p} (${n})`).join(', ')}</span>}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ fontSize: 13 }}>
              <thead><tr><th>Busy GRN</th><th>Date</th><th>Supplier</th><th>Items</th><th>Vehicle</th><th>PO</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
              <tbody>
                {data.map((g) => (
                  <tr key={g.vchCode}>
                    <td>{g.grnNo}</td><td>{date(g.date)}</td><td>{g.party}</td>
                    <td>{g.lines.map((l) => `${l.itemName} ${qty(l.qty)} ${l.unitName || ''}`).join('; ')}</td>
                    <td>{g.vehicle || '—'}</td><td>{g.poNos.join(', ') || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{money(g.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ── Open gate entries → link to Busy GRN ─────────────────────────────────────
function OpenEntries({ role }) {
  const { data, loading, error, reload } = useLoader(() => api.get('/busy-receiving/open-entries'), []);
  const [filter, setFilter] = useState('');
  const [busyAction, setBusyAction] = useState(null);
  const [msg, setMsg] = useState('');
  const [actionError, setActionError] = useState('');
  const [cancelFor, setCancelFor] = useState(null);
  const [cancelReason, setCancelReason] = useState('');
  const canLink = ['Admin', 'Supervisor', 'StoreReceiving'].includes(role);
  const canBulk = ['Admin', 'Supervisor'].includes(role);

  const entries = useMemo(() => (data?.entries || []).filter((e) => {
    const top = e.suggestions[0];
    if (filter === 'nosupplier') return !e.busySupplier;
    if (filter === 'none') return e.busySupplier && !top;
    if (filter) return top?.confidence === filter;
    return true;
  }), [data, filter]);
  const counts = useMemo(() => {
    const c = { High: 0, Medium: 0, Low: 0, none: 0, nosupplier: 0 };
    for (const e of data?.entries || []) {
      if (!e.busySupplier) c.nosupplier++;
      else if (!e.suggestions[0]) c.none++;
      else c[e.suggestions[0].confidence]++;
    }
    return c;
  }, [data]);

  const act = async (key, fn, okMsg) => {
    setBusyAction(key);
    setActionError('');
    setMsg('');
    try {
      const r = await fn();
      setMsg(okMsg(r.data));
      await reload();
    } catch (e) {
      setActionError(e.response?.data?.error || 'Action failed');
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
        Deliveries logged at the gate here that never got a GRN in this system. Most were received in Busy by hand — link each to its
        Busy GRN (matched on weighbridge ticket, vehicle, item and date), or close it with a reason.
      </div>
      {data && !data.migrationApplied && (
        <div className="alert alert-error" style={{ marginBottom: 12 }}>
          Linking needs the database update <code>add-busy-receiving-link.sql</code> — ask the administrator to run it. Suggestions below are read-only until then.
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {[['', `All (${data?.entries?.length || 0})`], ['High', `High (${counts.High})`], ['Medium', `Medium (${counts.Medium})`], ['Low', `Low (${counts.Low})`],
          ['none', `No Busy GRN found (${counts.none})`], ['nosupplier', `Supplier not a Busy account (${counts.nosupplier})`]].map(([k, l]) => (
          <button key={k || 'all'} type="button" className={`btn btn-sm ${filter === k ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setFilter(k)}>{l}</button>
        ))}
        {canBulk && counts.High > 0 && data?.migrationApplied && (
          <button type="button" className="btn btn-success btn-sm" disabled={!!busyAction}
            onClick={() => act('bulk', () => api.post('/busy-receiving/entries/link-high-confidence'),
              (d) => `Linked ${d.linked.length} entr${d.linked.length === 1 ? 'y' : 'ies'}${d.failed.length ? ` · ${d.failed.length} could not be linked` : ''}.`)}>
            {busyAction === 'bulk' ? 'Linking…' : `Link all ${counts.High} high-confidence`}
          </button>
        )}
      </div>
      {msg && <div className="alert alert-success" style={{ marginBottom: 12 }}>{msg}</div>}
      {actionError && <div className="alert alert-error" style={{ marginBottom: 12 }}>{actionError}</div>}
      <Status loading={loading} error={error} />
      {entries.slice(0, 300).map((e) => (
        <div key={e.entryId} className="card" style={{ padding: 12, marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
            <div>
              <strong>{e.entryNo}</strong> · {date(e.deliveryDate)} · {e.supplierName}
              {!e.busySupplier && <span style={{ color: '#b91c1c' }}> (not a Busy account — merge it in Supplier clean-up)</span>}
              <div style={{ color: '#6b7280', fontSize: 12 }}>
                {e.status} · {e.vehicle}{e.ticketNo ? ` · ticket ${e.ticketNo}` : ''}{e.netWeight ? ` · net ${qty(e.netWeight)} kg` : ''}
                {e.items.length > 0 && ` · ${e.items.map((i) => i.name).join(', ')}`}
              </div>
            </div>
            {canLink && data?.migrationApplied && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setCancelFor(cancelFor === e.entryId ? null : e.entryId); setCancelReason(''); }}>
                Close without GRN
              </button>
            )}
          </div>
          {cancelFor === e.entryId && (
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <input className="form-input" placeholder="Reason, e.g. duplicate entry / goods turned away at gate" value={cancelReason} onChange={(ev) => setCancelReason(ev.target.value)} />
              <button type="button" className="btn btn-danger btn-sm" disabled={!!busyAction || cancelReason.trim().length < 5}
                onClick={() => act(`c${e.entryId}`, () => api.post(`/busy-receiving/entries/${e.entryId}/cancel`, { reason: cancelReason }), (d) => `${d.entryNo} closed.`)}>
                Close entry
              </button>
            </div>
          )}
          {e.suggestions.length > 0 && (
            <table className="data-table" style={{ fontSize: 12, marginTop: 8 }}>
              <tbody>
                {e.suggestions.slice(0, 3).map((s) => (
                  <tr key={s.grnVchCode}>
                    <td style={{ color: confColor[s.confidence], fontWeight: 600, width: 70 }}>{s.confidence}</td>
                    <td><strong>{s.grnNo}</strong> · {date(s.date)}<div style={{ color: '#6b7280' }}>{s.reasons.join(' · ')}</div></td>
                    <td>{s.lines.map((l) => `${l.itemName} ${qty(l.qty)} ${l.unitName || ''}`).join('; ')}</td>
                    <td>{s.vehicle || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{money(s.amount)}</td>
                    <td>
                      {canLink && data?.migrationApplied && (
                        <button type="button" className={`btn btn-sm ${s.alreadyLinkedTo?.length ? 'btn-secondary' : 'btn-primary'}`} disabled={!!busyAction}
                          title={s.alreadyLinkedTo?.length ? `Busy put several trucks on this GRN — it is already linked to ${s.alreadyLinkedTo.join(', ')}` : ''}
                          onClick={() => act(`l${e.entryId}`, () => api.post(`/busy-receiving/entries/${e.entryId}/link-grn`,
                            { grnVchCode: s.grnVchCode, allowShared: !!s.alreadyLinkedTo?.length }),
                            (d) => `${d.entryNo} linked to Busy GRN ${d.grnNo}${d.sharedWith?.length ? ` (shared with ${d.sharedWith.join(', ')})` : ''}.`)}>
                          {s.alreadyLinkedTo?.length ? 'Link as same GRN' : 'Link'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {e.busySupplier && e.suggestions.length === 0 && (
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>No unlinked Busy GRN for this supplier within 10 days of the gate.</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Supplier clean-up ────────────────────────────────────────────────────────
function SupplierCleanup() {
  const { data, loading, error, reload } = useLoader(() => api.get('/busy-receiving/supplier-cleanup'), []);
  const [choice, setChoice] = useState({});
  const [saving, setSaving] = useState(null);
  const [msg, setMsg] = useState('');
  const [actionError, setActionError] = useState('');

  const merge = async (s) => {
    const to = choice[s.supplierId] ?? s.candidates[0]?.supplierId;
    if (!to) return;
    setSaving(s.supplierId);
    setMsg('');
    setActionError('');
    try {
      const r = await api.post('/busy-receiving/supplier-cleanup/merge', { fromSupplierId: s.supplierId, toSupplierId: to });
      setMsg(`"${r.data.merged}" merged into Busy supplier "${r.data.into}".`);
      await reload();
    } catch (e) {
      setActionError(e.response?.data?.error || 'Merge failed');
    } finally {
      setSaving(null);
    }
  };

  return (
    <div>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
        Suppliers typed in at the gate (codes like NCF-0867) instead of picking the Busy account. Merging moves their gate entries,
        quotations and awards onto the Busy supplier so they can be matched to Busy POs and GRNs. Check the name before merging —
        if the supplier isn't in Busy at all, create it in Busy first, then refresh suppliers.
      </div>
      {msg && <div className="alert alert-success" style={{ marginBottom: 12 }}>{msg}</div>}
      {actionError && <div className="alert alert-error" style={{ marginBottom: 12 }}>{actionError}</div>}
      <Status loading={loading} error={error} />
      {data && (
        <table className="data-table" style={{ fontSize: 13 }}>
          <thead><tr><th>Gate-typed supplier</th><th style={{ textAlign: 'right' }}>Entries</th><th>Last delivery</th><th>Busy supplier</th><th /></tr></thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.supplierId}>
                <td>{s.supplierName}<div style={{ fontSize: 11, color: '#6b7280' }}>{s.supplierCode}{s.lastMaterial ? ` · ${s.lastMaterial}` : ''}</div></td>
                <td style={{ textAlign: 'right' }}>{s.entries}</td>
                <td>{date(s.lastDelivery)}</td>
                <td>
                  {s.candidates.length === 0 ? <span style={{ color: '#b91c1c' }}>No similar Busy supplier — create it in Busy</span> : (
                    <select className="form-input" value={choice[s.supplierId] ?? s.candidates[0].supplierId}
                      onChange={(e) => setChoice({ ...choice, [s.supplierId]: parseInt(e.target.value, 10) })}>
                      {s.candidates.map((c) => (
                        <option key={c.supplierId} value={c.supplierId}>{c.supplierName} ({c.supplierCode}) · {Math.round(c.similarity * 100)}% match</option>
                      ))}
                    </select>
                  )}
                </td>
                <td>
                  {s.candidates.length > 0 && (
                    <button type="button" className="btn btn-primary btn-sm" disabled={saving !== null} onClick={() => merge(s)}>
                      {saving === s.supplierId ? 'Merging…' : 'Merge'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Accounts ─────────────────────────────────────────────────────────────────
function Accounts() {
  const [view, setView] = useState('bills');
  const [since, setSince] = useState(isoDaysAgo(90));
  const url = view === 'bills' ? '/busy-receiving/accounts/unpaid-bills' : '/busy-receiving/accounts/unbilled-grns';
  const { data, loading, error } = useLoader(() => api.get(url, { params: { since } }), [url, since]);
  const total = (data || []).reduce((s, r) => s + (view === 'bills' ? r.balance : r.amount), 0);

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <button type="button" className={`btn btn-sm ${view === 'bills' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setView('bills')}>Bills not fully paid</button>
        <button type="button" className={`btn btn-sm ${view === 'grns' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setView('grns')}>GRNs not yet billed</button>
        <span style={{ marginLeft: 12 }}>since</span>
        <input type="date" className="form-input" style={{ width: 160 }} value={since} onChange={(e) => setSince(e.target.value)} />
      </div>
      <Status loading={loading} error={error} />
      {data && view === 'bills' && (
        <>
          <div style={{ fontSize: 13, marginBottom: 8 }}><strong>{data.length}</strong> bills · KES <strong>{money(total)}</strong> outstanding</div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ fontSize: 13 }}>
              <thead><tr><th>Bill</th><th>Supplier</th><th>Supplier invoice</th><th>PO</th><th>GRN(s) · gate entry</th><th style={{ textAlign: 'right' }}>Bill</th><th style={{ textAlign: 'right' }}>Paid</th><th style={{ textAlign: 'right' }}>Balance</th><th style={{ textAlign: 'right' }}>Bill vs GRN</th></tr></thead>
              <tbody>
                {[...data].sort((a, b) => new Date(a.date) - new Date(b.date)).map((b) => (
                  <tr key={b.vchCode}>
                    <td>{b.billNo}<div style={{ fontSize: 11, color: '#6b7280' }}>{date(b.date)}</div></td>
                    <td>{b.party}</td>
                    <td>{b.supplierInvoiceNo || '—'}</td>
                    <td>{b.poNos.join(', ') || '—'}</td>
                    <td>{b.grns.length === 0 ? <span style={{ color: '#6b7280' }}>billed on PO, no GRN</span>
                      : b.grns.map((g) => <div key={g.vchCode}>{g.grnNo}{g.gateEntry ? ` · ${g.gateEntry.entryNo}${g.gateEntry.qaStatus ? ` (QA ${g.gateEntry.qaStatus})` : ''}` : ''}</div>)}</td>
                    <td style={{ textAlign: 'right' }}>{money(b.amount)}</td>
                    <td style={{ textAlign: 'right' }}>{money(b.paid)}</td>
                    <td style={{ textAlign: 'right' }}><strong>{money(b.balance)}</strong></td>
                    <td style={{ textAlign: 'right', color: b.billVsGrnDiff && Math.abs(b.billVsGrnDiff) > 1 ? '#b45309' : '#6b7280' }}>
                      {b.billVsGrnDiff === null ? '—' : money(b.billVsGrnDiff)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
            “Bill vs GRN” is the bill amount minus the GRN value(s) it was raised on — VAT treatment or a price change shows here.
          </div>
        </>
      )}
      {data && view === 'grns' && (
        <>
          <div style={{ fontSize: 13, marginBottom: 8 }}><strong>{data.length}</strong> GRNs · KES <strong>{money(total)}</strong> received, waiting for the supplier's bill</div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ fontSize: 13 }}>
              <thead><tr><th>Busy GRN</th><th>Date</th><th>Supplier</th><th>Items</th><th>PO</th><th>Gate entry</th><th>Billed</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
              <tbody>
                {[...data].sort((a, b) => new Date(a.date) - new Date(b.date)).map((g) => (
                  <tr key={g.vchCode}>
                    <td>{g.grnNo}</td><td>{date(g.date)}</td><td>{g.party}</td>
                    <td>{g.lines.map((l) => `${l.itemName} ${qty(l.qty)} ${l.unitName || ''}`).join('; ')}</td>
                    <td>{g.poNos.join(', ') || '—'}</td>
                    <td>{g.gateEntry ? `${g.gateEntry.entryNo}${g.gateEntry.qaStatus ? ` · QA ${g.gateEntry.qaStatus}` : ''}` : '—'}</td>
                    <td>{g.billed}</td>
                    <td style={{ textAlign: 'right' }}>{money(g.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export default function BusyReceivingPage() {
  const { user } = useAuth();
  const role = user?.role;
  const tabs = TABS.filter((t) => !t.roles || t.roles.includes(role));
  const [tab, setTab] = useState(() => {
    try { return localStorage.getItem('ncf:busyReceivingTab') || 'po'; } catch { return 'po'; }
  });
  const active = tabs.find((t) => t.key === tab) ? tab : tabs[0]?.key;
  const choose = (k) => { setTab(k); try { localStorage.setItem('ncf:busyReceivingTab', k); } catch { /* storage unavailable */ } };

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Receiving ↔ Busy</h1>
          <p className="page-subtitle">Busy POs, GRNs, bills and payments lined up with gate entries here. Read live from Busy.</p>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16, borderBottom: '1px solid #e5e7eb', paddingBottom: 8 }}>
        {tabs.map((t) => (
          <button key={t.key} type="button" className={`btn btn-sm ${active === t.key ? 'btn-primary' : 'btn-secondary'}`} onClick={() => choose(t.key)}>{t.label}</button>
        ))}
      </div>
      {active === 'po' && <PoTracker />}
      {active === 'bypass' && <Bypass />}
      {active === 'entries' && <OpenEntries role={role} />}
      {active === 'suppliers' && <SupplierCleanup />}
      {active === 'accounts' && <Accounts />}
    </div>
  );
}
