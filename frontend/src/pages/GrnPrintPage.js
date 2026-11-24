import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../services/api';

/**
 * Printable GRN (2026-10-21) — the document Stores take to Accounts for
 * payment. Amounts, quantities, batches and the GRN number are Busy's own
 * (read back from the Busy GRN); the gate, weighbridge and QA trail come
 * from this system, so Accounts see the whole delivery on one page.
 * Works for any delivery linked to a Busy GRN, whether it was received here
 * or in Busy.
 */
const money = (n) => Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 }));
const day = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const dayTime = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

const cell = { border: '1px solid #444', padding: '4px 6px', fontSize: 11, verticalAlign: 'top' };
const head = { ...cell, background: '#eee', fontWeight: 700, textAlign: 'left' };
const label = { color: '#555', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.3 };

function Field({ name, children }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={label}>{name}</div>
      <div style={{ fontSize: 12, fontWeight: 600 }}>{children || '—'}</div>
    </div>
  );
}

/**
 * Not printed: when QA rejected part of a delivery but the GRN this system
 * saved in Busy is still at the full PO price (Njr-2275 / Njr-2284, before
 * 2026-10-29), Stores apply the rejection % to it in Busy — the way they put
 * it in the GRN line's Disc % by hand. Only shown to roles that receive.
 */
function RejectionPanel({ entryId, onApplied }) {
  const [info, setInfo] = useState(null);
  const [pct, setPct] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = (p) => api.get(`/busy-grn/${entryId}/rejection`, { params: p === undefined || p === '' ? {} : { pct: p } })
    .then((r) => { setInfo(r.data); if (p === undefined) setPct(String(r.data.rejectionPct ?? '')); })
    .catch(() => setInfo(null));                                  // not a receiving role / no GRN → no panel
  useEffect(() => { load(); }, [entryId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!info || !(info.qaRejectionPct > 0) || !info.lines?.length) return null;
  // only while a line is still at the full PO price
  const atFullPrice = info.lines.some((l) => l.currentPrice >= l.listPrice - 0.005);
  if (!atFullPrice && !msg) return null;

  const apply = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post(`/busy-grn/${entryId}/rejection`, { rejectionPct: pct, reason });
      setMsg({ ok: true, text: `Saved in Busy: ${r.data.grnNo} at ${r.data.rejectionPct}% rejection — total ${money(r.data.oldTotal)} → ${money(r.data.total)}.`, warnings: r.data.warnings });
      onApplied();
    } catch (e) {
      setMsg({ ok: false, text: e.response?.data?.error || 'Busy did not save the change' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="no-print" style={{ width: '190mm', margin: '0 auto 12px', background: '#fffbeb', border: '1px solid #f59e0b', borderRadius: 6, padding: 12, fontFamily: 'sans-serif', fontSize: 13 }}>
      {msg?.ok ? (
        <>
          <div style={{ color: '#065f46', fontWeight: 600 }}>{msg.text}</div>
          {msg.warnings?.map((w) => <div key={w} style={{ color: '#b91c1c' }}>{w}</div>)}
        </>
      ) : (
        <>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            QA rejected {info.qaRejectionPct}% of this delivery, but {info.grnNo} is at the full PO price in Busy.
          </div>
          <div style={{ marginBottom: 8 }}>
            {info.lines.map((l) => (
              <div key={l.srNo}>{l.itemName}: {qty(l.qty)} {l.unitName} @ {money(l.currentPrice)} → <strong>{money(l.price)}</strong> (PO price {money(l.listPrice)} less {l.discountPct}%)</div>
            ))}
            <div>GRN total {money(info.currentTotal)} → <strong>{money(info.total)}</strong></div>
          </div>
          {info.problems?.length > 0 ? (
            <div style={{ color: '#b91c1c' }}>{info.problems.join(' ')}</div>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <label>Rejection %{' '}
                <input type="number" min="0" max="99.99" step="0.01" value={pct} style={{ width: 80 }}
                  onChange={(e) => { setPct(e.target.value); load(e.target.value); }} />
              </label>
              <input placeholder="Reason (e.g. QA rejects not deducted)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
              <button onClick={apply} disabled={busy || reason.trim().length < 3 || !info.enabled} style={{ padding: '6px 14px', cursor: 'pointer' }}>
                {busy ? 'Saving in Busy…' : 'Apply in Busy'}
              </button>
            </div>
          )}
          {msg && !msg.ok && <div style={{ color: '#b91c1c', marginTop: 6 }}>{msg.text}</div>}
        </>
      )}
    </div>
  );
}

export default function GrnPrintPage() {
  const { entryId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const loadPrint = () => api.get(`/busy-grn/${entryId}/print`)
    .then((r) => setData(r.data))
    .catch((e) => setError(e.response?.data?.error || 'Could not load the GRN'));
  useEffect(() => { loadPrint(); }, [entryId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (data) document.title = `GRN ${data.grn.grnNo}`;
  }, [data]);

  if (error) return <div style={{ padding: 32, fontFamily: 'sans-serif', color: '#b91c1c' }}>{error}</div>;
  if (!data) return <div style={{ padding: 32, fontFamily: 'sans-serif' }}>Loading GRN…</div>;

  const { entry, grn, qa, weighings, billing } = data;
  const net = weighings.reduce((s, w) => s + Number(w.FinalNetWeight ?? w.NetWeight ?? 0), 0);

  return (
    <div style={{ background: '#f3f4f6', minHeight: '100vh', padding: '16px 0' }}>
      <style>{`
        @page { size: A4; margin: 12mm; }
        @media print {
          body { background: #fff !important; }
          .no-print { display: none !important; }
          .sheet { box-shadow: none !important; margin: 0 !important; width: auto !important; padding: 0 !important; }
        }
      `}</style>

      <div className="no-print" style={{ textAlign: 'center', marginBottom: 12, fontFamily: 'sans-serif' }}>
        <button onClick={() => window.print()} style={{ padding: '8px 20px', fontSize: 14, cursor: 'pointer' }}>🖨 Print</button>
      </div>
      <RejectionPanel entryId={entryId} onApplied={loadPrint} />

      <div className="sheet" style={{ background: '#fff', width: '190mm', margin: '0 auto', padding: '12mm', boxShadow: '0 2px 12px rgba(0,0,0,0.15)', fontFamily: 'Arial, sans-serif', color: '#111' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid #111', paddingBottom: 6, marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800 }}>NJORO CANNING FACTORY (K) LIMITED</div>
            <div style={{ fontSize: 14, fontWeight: 700, marginTop: 2 }}>GOODS RECEIVED NOTE</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 16, fontWeight: 800 }}>{grn.grnNo}</div>
            <div style={{ fontSize: 12 }}>Date: {day(grn.date)}</div>
            {!grn.approved && <div style={{ fontSize: 11, color: '#b91c1c', fontWeight: 700 }}>NOT YET APPROVED IN BUSY</div>}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
          <div>
            <Field name="Supplier">{grn.party}</Field>
            <Field name="Purchase order(s)">{grn.poNos.join(', ') || entry.PurchaseOrderNo || 'Not on a PO'}</Field>
            <Field name="Delivery note / narration">{grn.narration}</Field>
          </div>
          <div>
            <Field name="Gate entry">{entry.EntryNo}</Field>
            <Field name="Arrived">{day(entry.DeliveryDate)} {String(entry.DeliveryTime || '').slice(11, 16)}</Field>
            <Field name="Vehicle / driver">{entry.VehicleRegNo}{entry.DriverName ? ` · ${entry.DriverName}` : ''}</Field>
          </div>
          <div>
            <Field name="Weighbridge ticket">{grn.ticketNo || weighings[0]?.TicketNo}</Field>
            <Field name="Net weight">{net ? `${qty(net)} kg` : null}</Field>
            <Field name="QA">{qa ? `${qa.OverallStatus}${qa.InspectionNo ? ` (${qa.InspectionNo})` : ''}` : (entry.Destination === 'CentralStore' ? 'Central Stores — no QA' : null)}</Field>
          </div>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }}>
          <thead>
            <tr>
              <th style={head}>#</th><th style={head}>Item</th><th style={head}>Batch</th><th style={head}>Store</th>
              <th style={{ ...head, textAlign: 'right' }}>Qty</th><th style={head}>Unit</th>
              <th style={{ ...head, textAlign: 'right' }}>Price</th><th style={{ ...head, textAlign: 'right' }}>Amount (KES)</th>
            </tr>
          </thead>
          <tbody>
            {grn.lines.map((l) => (
              <tr key={l.srNo}>
                <td style={cell}>{l.srNo}</td>
                <td style={cell}>{l.itemName}</td>
                <td style={{ ...cell, fontFamily: 'monospace', fontSize: 10 }}>{l.batchNo || '—'}</td>
                <td style={cell}>{l.store}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{qty(l.qty)}</td>
                <td style={cell}>{l.unitName}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{money(l.price)}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{money(l.amount)}</td>
              </tr>
            ))}
            <tr>
              <td style={{ ...cell, textAlign: 'right' }} colSpan={7}>Items</td>
              <td style={{ ...cell, textAlign: 'right' }}>{money(grn.linesTotal)}</td>
            </tr>
            {grn.taxAndRounding !== 0 && (
              <tr>
                <td style={{ ...cell, textAlign: 'right' }} colSpan={7}>{grn.taxType || 'VAT'} &amp; rounding</td>
                <td style={{ ...cell, textAlign: 'right' }}>{money(grn.taxAndRounding)}</td>
              </tr>
            )}
            <tr>
              <td style={{ ...cell, textAlign: 'right', fontWeight: 800 }} colSpan={7}>GRN TOTAL{grn.taxType ? ` (${grn.taxType})` : ''}</td>
              <td style={{ ...cell, textAlign: 'right', fontWeight: 800 }}>{money(grn.amount)}</td>
            </tr>
          </tbody>
        </table>

        {weighings.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }}>
            <thead>
              <tr>
                <th style={head}>Weighbridge</th><th style={{ ...head, textAlign: 'right' }}>1st (kg)</th><th style={{ ...head, textAlign: 'right' }}>2nd (kg)</th>
                <th style={{ ...head, textAlign: 'right' }}>Net (kg)</th><th style={{ ...head, textAlign: 'right' }}>Bags (kg)</th><th style={{ ...head, textAlign: 'right' }}>Final net (kg)</th><th style={head}>Operator</th>
              </tr>
            </thead>
            <tbody>
              {weighings.map((w, i) => (
                <tr key={i}>
                  <td style={cell}>{w.MaterialName || 'All items (weighed together)'} · ticket {w.TicketNo || '—'}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>{qty(w.FirstWeight)}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>{qty(w.SecondWeight)}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>{qty(w.NetWeight)}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>{w.BagWeight ? qty(w.BagWeight) : '—'}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>{qty(w.FinalNetWeight ?? w.NetWeight)}</td>
                  <td style={cell}>{w.OperatorName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {qa && (
          <div style={{ fontSize: 11, marginBottom: 8 }}>
            <strong>QA:</strong> {qa.OverallStatus}
            {qa.AcceptedQty != null && <> · accepted {qty(qa.AcceptedQty)}</>}
            {qa.RejectedQty > 0 && <> · rejected {qty(qa.RejectedQty)}
              {qa.AcceptedQty != null && ` (${(100 * qa.RejectedQty / (Number(qa.AcceptedQty) + Number(qa.RejectedQty))).toFixed(2)}% — taken off the price, not the quantity)`}</>}
            {qa.InspectorName && <> · inspector {qa.InspectorName}</>}
            {qa.ApprovedByName && <> · approved by {qa.ApprovedByName}</>}
            {qa.OverallRemarks && <> · {qa.OverallRemarks}</>}
          </div>
        )}

        <div style={{ fontSize: 11, marginBottom: 14, padding: 6, border: '1px dashed #888' }}>
          <strong>For Accounts:</strong> Busy shows this GRN as <strong>{billing?.billed || 'Not billed'}</strong>
          {billing?.paid && <> · <strong>{billing.paid}</strong></>}
          {billing?.bills?.length > 0 && <> · bill(s): {billing.bills.map((b) => `${b.billNo}${b.supplierInvoiceNo ? ` (inv. ${b.supplierInvoiceNo})` : ''} ${b.state}`).join(', ')}</>}
          {' '}— check this before paying so the same delivery is never paid twice.
        </div>

        {/* Director approval for payment (2026-11-11) — replaces the signed paper copy */}
        {data.approval && (
          <div style={{
            fontSize: 12, marginBottom: 14, padding: 8,
            border: `2px solid ${data.approval.Status === 'Approved' ? '#065f46' : '#b45309'}`,
            color: data.approval.Status === 'Approved' ? '#065f46' : '#92400e',
          }}>
            {data.approval.Status === 'Approved' ? (
              <><strong>APPROVED FOR PAYMENT</strong> by {data.approval.ApprovedBy} (Director) on {dayTime(data.approval.ApprovedAt)}
                {' '}— KES {money(data.approval.ApprovedAmount)}</>
            ) : data.approval.Status === 'Queried' ? (
              <><strong>NOT APPROVED — QUERIED</strong> by the Director: {data.approval.QueryReason}. Do not pay.</>
            ) : (
              <><strong>NOT YET APPROVED</strong> by a Director{data.approval.ChangedAfterApproval ? ' (changed in Busy after an earlier approval)' : ''}. Do not pay.</>
            )}
            {/* Flagged checks with the GRN Reviewer's reason (2026-11-23) */}
            {data.approval.checks?.length > 0 && (
              <div style={{ marginTop: 6, color: '#111827' }}>
                <strong>Checks and reasons:</strong>
                <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
                  {data.approval.checks.map((c, i) => (
                    <li key={i}>{c.text} — {c.reason ? <>Reason: {c.reason}{c.reasonBy ? ` (${c.reasonBy})` : ''}</> : <em>no reason given</em>}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 18 }}>
          {[
            ['Received by (Stores)', grn.addedBy || entry.ReceivedBy || entry.LinkedBy],
            ['Checked by (QA / Supervisor)', qa?.ApprovedByName || qa?.InspectorName],
            ['Gate / weighbridge', [entry.GateBy, weighings[0]?.OperatorName].filter(Boolean).join(' / ')],
            [data.approval?.Status === 'Approved' ? 'Director (approved on the system)' : 'Accounts', data.approval?.Status === 'Approved' ? data.approval.ApprovedBy : ''],
          ].map(([who, name]) => (
            <div key={who}>
              <div style={{ borderBottom: '1px solid #111', height: 34 }} />
              <div style={{ fontSize: 10, marginTop: 3 }}>{who}</div>
              <div style={{ fontSize: 10, color: '#555' }}>{name || 'Name / sign / date'}</div>
            </div>
          ))}
        </div>

        <div style={{ fontSize: 9, color: '#666', marginTop: 14, display: 'flex', justifyContent: 'space-between' }}>
          <span>Amounts and quantities as held in Busy ({grn.grnNo}). Added in Busy by {grn.addedBy || '—'}.</span>
          <span>Printed {dayTime(data.printedAt)}{data.printedBy ? ` by ${data.printedBy}` : ''}</span>
        </div>
      </div>
    </div>
  );
}
