import React, { useEffect, useState } from 'react';
import api from '../services/api';

/**
 * Purchase price history for one item (2026-10-23) — Busy's Purchase
 * Analysis: every GRN / purchase in the last N months with supplier, qty and
 * price per unit, plus average / lowest / highest / latest and a per-supplier
 * breakdown. Read live through POST /api/stock/purchase-history.
 *
 * props: itemName (Busy item name), data (optional, already loaded for 3 months)
 */
const num = (n, dp = 2) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-KE', { maximumFractionDigits: dp }));
const day = (d) => (d ? new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');

export function PriceSummaryCell({ h }) {
  if (!h || !h.summary) return <span style={{ color: '#9ca3af' }}>not bought</span>;
  const s = h.summary;
  if (s.mixedUnits) return <span style={{ color: '#b45309' }} title="Bought in different units on different vouchers">mixed units</span>;
  return (
    <span title={`${s.purchases} purchase(s) from ${s.suppliers} supplier(s); latest ${num(s.lastRate)} on ${day(s.lastDate)}`}>
      <strong>{num(s.avgRate)}</strong>
      {s.changePct != null && Math.abs(s.changePct) >= 1 && (
        <span style={{ marginLeft: 4, color: s.changePct > 0 ? '#b91c1c' : '#047857', fontSize: 11 }}>
          {s.changePct > 0 ? '▲' : '▼'}{Math.abs(Math.round(s.changePct))}%
        </span>
      )}
      <div style={{ fontSize: 11, color: '#6b7280' }}>{num(s.minRate)} – {num(s.maxRate)}</div>
    </span>
  );
}

export default function PriceHistory({ itemName, data, buyQty }) {
  const [months, setMonths] = useState(3);
  const [h, setH] = useState(data && months === 3 ? data : null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [all, setAll] = useState(false);

  useEffect(() => {
    if (data && months === 3) { setH(data); return; }
    if (!itemName) return;
    setLoading(true);
    setError('');
    api.post('/stock/purchase-history', { itemNames: [itemName], months })
      .then((r) => setH(r.data.items[0] || null))
      .catch((e) => setError(e.response?.data?.error || 'Could not read purchases from Busy'))
      .finally(() => setLoading(false));
  }, [itemName, months, data]);

  const s = h?.summary;
  const unit = h?.unitName ? ` / ${h.unitName}` : '';
  return (
    <div style={{ fontSize: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <strong style={{ fontSize: 13 }}>Purchase prices</strong>
        <select value={months} onChange={(e) => setMonths(Number(e.target.value))} style={{ fontSize: 12, padding: '1px 4px' }}>
          {[3, 6, 12].map((m) => <option key={m} value={m}>last {m} months</option>)}
        </select>
        <span style={{ color: '#6b7280' }}>from Busy GRNs &amp; purchase bills · price per unit as on the voucher</span>
      </div>
      {error && <div style={{ color: '#b91c1c' }}>{error}</div>}
      {loading && <div style={{ color: '#6b7280' }}>Reading Busy…</div>}
      {!loading && h && !s && <div style={{ color: '#6b7280' }}>Not bought in the last {months} months.</div>}
      {!loading && s && (
        <>
          {s.mixedUnits && (
            <div style={{ color: '#b45309', marginBottom: 6 }}>
              Bought in different units on different vouchers (e.g. a whole fill as “1 unit” vs per litre) — compare individual purchases, not the average.
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            {[
              ['Average', s.mixedUnits ? '—' : `${num(s.avgRate)}${unit}`],
              ['Lowest', `${num(s.minRate)}${unit}`],
              ['Highest', `${num(s.maxRate)}${unit}`],
              ['Latest', `${num(s.lastRate)}${unit}`, `${day(s.lastDate)} · ${s.lastSupplier}`],
              ['Trend', s.changePct == null || s.mixedUnits ? '—' : `${s.changePct > 0 ? '▲ +' : s.changePct < 0 ? '▼ ' : ''}${num(s.changePct, 1)}%`, 'latest vs oldest in the period'],
              ['Bought', `${num(s.qty)}${h.unitName ? ` ${h.unitName}` : ''}`, `${s.purchases} purchase(s) · KES ${num(s.amount, 0)}`],
            ].map(([label, value, sub]) => (
              <div key={label} style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 8px', background: '#fff', minWidth: 92 }}>
                <div style={{ color: '#6b7280', fontSize: 11 }}>{label}</div>
                <div style={{ fontWeight: 600, color: label === 'Trend' && s.changePct ? (s.changePct > 0 ? '#b91c1c' : '#047857') : undefined }}>{value}</div>
                {sub && <div style={{ color: '#6b7280', fontSize: 10 }}>{sub}</div>}
              </div>
            ))}
          </div>

          {Number(buyQty) > 0 && !s.mixedUnits && (
            <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '6px 10px', marginBottom: 8 }}>
              Buying <strong>{num(buyQty)}{h.unitName ? ` ${h.unitName}` : ''}</strong> costs about{' '}
              <strong>KES {num(Number(buyQty) * s.lastRate, 0)}</strong> at the latest price ({num(s.lastRate)}),{' '}
              KES {num(Number(buyQty) * s.avgRate, 0)} at the {months}-month average ({num(s.avgRate)}),{' '}
              KES {num(Number(buyQty) * s.minRate, 0)} at the lowest ({num(s.minRate)}).
            </div>
          )}

          {h.bySupplier.length > 1 && (
            <table className="data-table" style={{ fontSize: 12, marginBottom: 8, background: '#fff' }}>
              <thead><tr><th>Supplier</th><th style={{ textAlign: 'right' }}>Purchases</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Avg price</th><th style={{ textAlign: 'right' }}>Lowest – highest</th><th>Last</th></tr></thead>
              <tbody>
                {h.bySupplier.map((x) => (
                  <tr key={x.supplier}>
                    <td>{x.supplier}</td>
                    <td style={{ textAlign: 'right' }}>{x.purchases}</td>
                    <td style={{ textAlign: 'right' }}>{num(x.qty)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{num(x.avgRate)}</td>
                    <td style={{ textAlign: 'right' }}>{num(x.minRate)} – {num(x.maxRate)}</td>
                    <td>{num(x.lastRate)} · {day(x.lastDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <table className="data-table" style={{ fontSize: 12, background: '#fff' }}>
            <thead><tr><th>Date</th><th>Voucher</th><th>Supplier</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Price{unit}</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
            <tbody>
              {(all ? h.lines : h.lines.slice(0, 8)).map((l) => (
                <tr key={`${l.voucher}-${l.date}-${l.qty}-${l.rate}`}>
                  <td>{day(l.date)}</td>
                  <td>{l.kind} {l.voucher}</td>
                  <td>{l.supplier}</td>
                  <td style={{ textAlign: 'right' }}>{num(l.qty)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{num(l.rate)}</td>
                  <td style={{ textAlign: 'right' }}>{num(l.amount, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {h.lines.length > 8 && (
            <button type="button" className="btn btn-sm btn-outline" style={{ marginTop: 6 }} onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : `Show all ${h.lines.length} purchases`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
