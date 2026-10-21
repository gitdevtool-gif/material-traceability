import React, { useEffect, useMemo, useState } from 'react';
import api from '../services/api';

/**
 * The "whole picture" for the items on a requisition / RFQ / award
 * (2026-10-17): live stock (Central Stores + company), what's already on
 * order in Busy, monthly consumption, lead time, reorder level, status,
 * suggested order and last purchase — read live from Busy through
 * /api/stock/picture. Used at every decision point: Central Stores review,
 * Ops approval, Procurement before dispatching the RFQ, the Director's
 * award and raising the PO in Busy.
 *
 * props.items: [{ name, requestedQty?, unit? }]  (name = Busy item name)
 */
const num = (n, dp = 2) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: dp }));
const date = (d) => (d ? new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');
const monthLabel = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-KE', { month: 'short' });

const STATUS_STYLE = {
  'Out of stock':       { color: '#991b1b', background: '#fee2e2' },
  Critical:             { color: '#991b1b', background: '#fee2e2' },
  Reorder:              { color: '#92400e', background: '#fef3c7' },
  OK:                   { color: '#065f46', background: '#d1fae5' },
  'No consumption':     { color: '#374151', background: '#f3f4f6' },
  'Service (no stock)': { color: '#374151', background: '#f3f4f6' },
};

/** One short sentence that helps the reader decide. */
function hint(p, requestedQty) {
  if (p.nonStock) return null;
  const req = Number(requestedQty) || 0;
  if (req > 0 && p.centralStores >= req) return `Central Stores already holds ${num(p.centralStores)} — enough to issue instead of buying.`;
  if (p.onOrder > 0 && req > 0 && p.onOrder >= req) return `${num(p.onOrder)} already on open Busy PO(s) — check before ordering again.`;
  if (p.onOrder > 0) return `${num(p.onOrder)} already on order (${p.openPos.filter((o) => o.approved).map((o) => o.poNo).join(', ')}).`;
  if (req > 0 && p.suggestedOrderQty != null && req > p.suggestedOrderQty * 1.5 && p.status === 'OK') {
    return `Stock is OK with ${num(p.monthsOfCover)} month(s) of cover — requested qty is above the suggested ${num(p.suggestedOrderQty)}.`;
  }
  if (p.status === 'Out of stock' || p.status === 'Critical') return 'Below safety stock — urgent.';
  return null;
}

function Bars({ months }) {
  const max = Math.max(1, ...months.map((m) => m.qty));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 54 }}>
      {months.map((m) => (
        <div key={m.month} style={{ textAlign: 'center', fontSize: 10, color: '#6b7280' }} title={`${m.month}: ${num(m.qty)}`}>
          <div style={{ width: 22, height: Math.max(2, (m.qty / max) * 36), background: '#93c5fd', borderRadius: 2, margin: '0 auto' }} />
          {monthLabel(m.month)}
        </div>
      ))}
    </div>
  );
}

function Detail({ p }) {
  const [batches, setBatches] = useState(null);
  const [loading, setLoading] = useState(false);
  const loadBatches = () => {
    setLoading(true);
    api.get('/stock/batches', { params: { itemCode: p.itemCode } })
      .then((r) => setBatches(r.data))
      .catch(() => setBatches({ batches: [], reconciliation: [], error: true }))
      .finally(() => setLoading(false));
  };
  return (
    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 12, padding: '6px 4px' }}>
      <div style={{ minWidth: 200 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Stock by store</div>
        {p.stores.length === 0 ? <div style={{ color: '#6b7280' }}>No stock anywhere</div> : p.stores.slice(0, 10).map((s) => (
          <div key={s.storeCode} style={{ color: s.excluded ? '#9ca3af' : undefined }}>
            {s.store}: <strong>{num(s.qty)}</strong>{s.excluded ? ' (consumed, not counted)' : ''}
          </div>
        ))}
      </div>
      {p.consumption && (
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Monthly consumption · this month so far {num(p.consumption.monthToDate)}</div>
          <Bars months={p.consumption.months} />
        </div>
      )}
      <div style={{ minWidth: 220 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Open Busy POs</div>
        {p.openPos.length === 0 ? <div style={{ color: '#6b7280' }}>None</div> : p.openPos.map((o) => (
          <div key={`${o.poNo}-${o.pending}`}>{o.poNo} · {o.party} · {num(o.pending)} pending{o.approved ? '' : ' (awaiting approval)'}</div>
        ))}
        <div style={{ marginTop: 6, color: '#6b7280' }}>
          Levels: min {num(p.minLevel)} · reorder {num(p.reorderLevel)} · max {num(p.maxLevel)} · EOQ {num(p.eoq)}
        </div>
      </div>
      <div style={{ minWidth: 240 }}>
        {!batches ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={loadBatches} disabled={loading}>
            {loading ? 'Loading…' : 'Show batches'}
          </button>
        ) : (
          <>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Batches (remaining)</div>
            {batches.batches.filter((b) => b.qty > 0).slice(0, 12).map((b) => (
              <div key={`${b.store}-${b.batchNo}`}>{b.store} · {b.batchNo} · <strong>{num(b.qty)}</strong> · {b.ageDays}d</div>
            ))}
            {batches.reconciliation.length > 0 && (
              <div style={{ color: '#b45309', marginTop: 4 }}>
                Busy's batches don't add up to stock in: {batches.reconciliation.map((c) => `${c.store} (${num(c.batchTotal)} vs ${num(c.stock)})`).join(', ')}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function StockPicture({ items, title = 'Stock picture (live from Busy)', compact = false }) {
  const names = useMemo(() => [...new Set((items || []).map((i) => String(i.name || '').trim()).filter(Boolean))], [items]);
  const key = names.join('|');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);

  useEffect(() => {
    if (!names.length) { setData({ items: [], notFound: [] }); return; }
    setData(null);
    setError('');
    api.post('/stock/picture', { itemNames: names })
      .then((r) => setData(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not read stock from Busy'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const reqByName = useMemo(() => {
    const m = {};
    for (const i of items || []) m[String(i.name || '').trim().toUpperCase()] = i;
    return m;
  }, [items]);

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: compact ? 8 : 12, margin: '10px 0', background: '#fcfcfd' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{title}</div>
        {data?.asOf && <div style={{ fontSize: 11, color: '#6b7280' }}>Lead time defaults to {data.defaultLeadWeeks} weeks where none is set</div>}
      </div>
      {error && <div style={{ color: 'var(--danger, #b91c1c)', fontSize: 13 }}>{error}</div>}
      {!data && !error && <div style={{ fontSize: 13, color: '#6b7280' }}>Reading Busy…</div>}
      {data && (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ fontSize: 12, margin: 0 }}>
            <thead>
              <tr>
                <th>Item</th><th style={{ textAlign: 'right' }}>Requested</th>
                <th style={{ textAlign: 'right' }}>Central Stores</th><th style={{ textAlign: 'right' }}>All stores</th>
                <th style={{ textAlign: 'right' }}>On order</th><th style={{ textAlign: 'right' }}>Use / month</th>
                <th style={{ textAlign: 'right' }}>Cover</th><th style={{ textAlign: 'right' }}>Lead</th>
                <th style={{ textAlign: 'right' }}>Reorder level</th><th>Status</th>
                <th style={{ textAlign: 'right' }}>Suggested order</th><th>Last bought</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => {
                const reqItem = reqByName[p.itemName.toUpperCase()];
                const h = hint(p, reqItem?.requestedQty);
                return (
                  <React.Fragment key={p.itemCode}>
                    <tr onClick={() => setOpen(open === p.itemCode ? null : p.itemCode)} style={{ cursor: 'pointer' }}>
                      <td>
                        <strong>{p.itemName}</strong>
                        <div style={{ fontSize: 11, color: '#6b7280' }}>{p.group} · {p.unitName}</div>
                        {h && <div style={{ fontSize: 11, color: '#1d4ed8' }}>{h}</div>}
                      </td>
                      <td style={{ textAlign: 'right' }}>{reqItem?.requestedQty != null ? num(reqItem.requestedQty) : '—'}</td>
                      <td style={{ textAlign: 'right' }}><strong>{num(p.centralStores)}</strong></td>
                      <td style={{ textAlign: 'right' }}>{num(p.liveStock)}</td>
                      <td style={{ textAlign: 'right' }}>{p.onOrder ? num(p.onOrder) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{p.consumption ? num(p.consumption.avgMonthly) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{p.monthsOfCover != null ? `${num(p.monthsOfCover, 1)} mo` : '—'}</td>
                      <td style={{ textAlign: 'right' }} title={p.leadDefaulted ? 'Default — no lead time set for this item group' : ''}>
                        {p.leadWeeks}w{p.leadDefaulted ? '*' : ''}
                      </td>
                      <td style={{ textAlign: 'right' }}>{num(p.reorderLevel)}</td>
                      <td><span style={{ ...(STATUS_STYLE[p.status] || {}), padding: '1px 6px', borderRadius: 4, whiteSpace: 'nowrap' }}>{p.status}</span></td>
                      <td style={{ textAlign: 'right' }}>{p.suggestedOrderQty != null ? num(p.suggestedOrderQty) : '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {p.lastPurchase ? <>{num(p.lastPurchase.price)} · {date(p.lastPurchase.date)}<div style={{ fontSize: 11, color: '#6b7280' }}>{p.lastPurchase.supplier}</div></> : '—'}
                      </td>
                    </tr>
                    {open === p.itemCode && <tr><td colSpan={12} style={{ background: '#f9fafb' }}><Detail p={p} /></td></tr>}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          {data.notFound.length > 0 && (
            <div style={{ fontSize: 12, color: '#b45309', marginTop: 6 }}>
              Not a Busy item, so no stock data: {data.notFound.join(', ')}
            </div>
          )}
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
            Click an item for stock by store, monthly consumption, open POs and batches. Use / month = average of the last 3 full months.
          </div>
        </div>
      )}
    </div>
  );
}
