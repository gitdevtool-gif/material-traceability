import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../services/api';

/**
 * The inspector's copy of a QA decision (2026-11-11) — exactly what was
 * submitted: the delivery, the checks, every test result, the decision,
 * quantities, remarks and rejection reason. Read from the decision log, so it
 * does not change when the delivery moves on or the inspection is redone.
 * Outside the app layout so it prints as a clean A4 page.
 */
const qty = (n) => (n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 }));
const day = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const dayTime = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const yesNo = (b) => (b ? 'Yes' : 'No');

const cell = { border: '1px solid #444', padding: '4px 6px', fontSize: 11, verticalAlign: 'top' };
const head = { ...cell, background: '#eee', fontWeight: 700, textAlign: 'left' };
const label = { color: '#555', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.3 };
const DECISION_COLOR = { Accepted: '#065f46', Conditional: '#065f46', Rejected: '#b91c1c', Quarantine: '#92400e' };

function Field({ name, children }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={label}>{name}</div>
      <div style={{ fontSize: 12, fontWeight: 600 }}>{children || '—'}</div>
    </div>
  );
}

export default function QADecisionCopyPage() {
  const { logId } = useParams();
  const [rec, setRec] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/qa/my-log/${logId}`)
      .then((r) => setRec(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load this QA record'));
  }, [logId]);

  if (error) return <div style={{ padding: 24, fontFamily: 'sans-serif', color: '#b91c1c' }}>{error}</div>;
  if (!rec) return <div style={{ padding: 24, fontFamily: 'sans-serif' }}>Loading…</div>;

  const { inspection: ins, entry, tests, decision: d } = rec.snapshot;
  const statusNow = rec.InspectionDeleted
    ? 'This inspection was later deleted by Admin — this copy is what was submitted.'
    : rec.LaterLogId ? 'A later QA decision was made on this inspection — this copy is the earlier one.' : null;

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

      <div className="no-print" style={{ textAlign: 'center', marginBottom: 12, fontFamily: 'sans-serif', display: 'flex', gap: 8, justifyContent: 'center' }}>
        <button onClick={() => window.print()} style={{ padding: '8px 20px', fontSize: 14, cursor: 'pointer' }}>🖨 Print / Save as PDF</button>
        {rec.LaterLogId && (
          <a href={`/qa-copy/${rec.LaterLogId}`} style={{ padding: '8px 20px', fontSize: 14 }}>Open the later decision →</a>
        )}
      </div>

      <div className="sheet" style={{ width: '190mm', margin: '0 auto', background: '#fff', padding: '10mm', boxShadow: '0 1px 4px rgba(0,0,0,.15)', fontFamily: 'Arial, sans-serif', color: '#111' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid #111', paddingBottom: 6, marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>NJORO CANNING FACTORY (K) LIMITED</div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>QA Inspection — Decision Record</div>
          </div>
          <div style={{ textAlign: 'right', fontSize: 11 }}>
            <div><strong>{ins.inspectionNo}</strong></div>
            <div>Record #{rec.LogId}</div>
            <div>Submitted {dayTime(rec.SubmittedAt)}</div>
          </div>
        </div>

        {rec.Source === 'Backfill' && (
          <div style={{ fontSize: 10, color: '#555', marginBottom: 8 }}>
            Decided before decision records were kept (11 Nov 2026) — taken from the inspection as it stood on that date.
          </div>
        )}
        {statusNow && <div className="no-print" style={{ fontSize: 12, color: '#92400e', marginBottom: 8 }}>{statusNow}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 10 }}>
          <Field name="Gate entry">{entry.entryNo}</Field>
          <Field name="Supplier">{entry.supplierName}{entry.supplierCode ? ` (${entry.supplierCode})` : ''}</Field>
          <Field name="Factory">{entry.factory}</Field>
          <Field name="Delivery date">{day(entry.deliveryDate)}</Field>
          <Field name="Vehicle">{entry.vehicleRegNo}</Field>
          <Field name="Driver">{entry.driverName}</Field>
          <Field name="Weighbridge ticket">{(entry.ticketNos || []).join(', ')}</Field>
          <Field name="Net weight">{entry.netWeight != null ? `${qty(entry.netWeight)} kg` : '—'}</Field>
          <Field name="Consignment">{entry.consignmentNo}</Field>
          <Field name="PO">{entry.purchaseOrderNo}</Field>
          <Field name="Inspected by">{ins.inspectorName}</Field>
          <Field name="Inspection started">{dayTime(ins.inspectionDate)}</Field>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10 }}>
          <thead><tr><th style={head}>Material</th><th style={head}>Quantity</th><th style={head}>Weighed</th></tr></thead>
          <tbody>
            {(entry.items || []).map((i, k) => (
              <tr key={k}>
                <td style={cell}>{i.code ? `${i.code} — ` : ''}{i.name}</td>
                <td style={cell}>{i.quantity != null ? `${qty(i.quantity)} ${i.uom || ''}` : '—'}</td>
                <td style={cell}>{i.netKg != null ? `${qty(i.netKg)} kg` : '—'}</td>
              </tr>
            ))}
            {!(entry.items || []).length && <tr><td style={cell} colSpan={3}>No items recorded on the gate entry</td></tr>}
          </tbody>
        </table>

        <div style={{ fontSize: 12, marginBottom: 10 }}>
          <strong>Checks:</strong> COA provided: {yesNo(ins.coaProvided)}{ins.coaReference ? ` (${ins.coaReference})` : ''}
          {' · '}Samples taken: {yesNo(ins.samplesTaken)} · Physical check: {yesNo(ins.physicalCheckDone)} · Vehicle inspection: {yesNo(ins.vehicleInspectionDone)}
        </div>

        <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4 }}>Test results</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 12 }}>
          <thead>
            <tr>
              <th style={head}>Material</th><th style={head}>Test</th><th style={head}>Method</th><th style={head}>Expected / limit</th>
              <th style={head}>Actual</th><th style={head}>Result</th><th style={head}>Remarks</th>
            </tr>
          </thead>
          <tbody>
            {tests.map((t, k) => (
              <tr key={k}>
                <td style={cell}>{t.material}</td><td style={cell}>{t.test}</td><td style={cell}>{t.method || '—'}</td>
                <td style={cell}>{t.expected || '—'}</td><td style={cell}>{t.actual || '—'}</td>
                <td style={{ ...cell, fontWeight: 700, color: t.result === 'Fail' ? '#b91c1c' : t.result === 'Pass' ? '#065f46' : '#92400e' }}>{t.result}</td>
                <td style={cell}>{t.remarks || '—'}</td>
              </tr>
            ))}
            {tests.length === 0 && <tr><td style={cell} colSpan={7}>No test results were recorded</td></tr>}
          </tbody>
        </table>

        <div style={{ border: '2px solid #111', padding: 8, marginBottom: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            <Field name="Decision"><span style={{ color: DECISION_COLOR[d.decision] || '#111', fontSize: 14 }}>{d.decision}</span></Field>
            <Field name="Accepted qty">{qty(d.acceptedQty)}</Field>
            <Field name="Rejected qty">{qty(d.rejectedQty)}</Field>
            <Field name="Decided">{dayTime(d.decidedAt)}</Field>
          </div>
          <Field name="Decision remarks">{d.remarks}</Field>
          {d.decision === 'Rejected' && (
            <>
              <Field name="Rejection reason">{d.rejectionReason}</Field>
              {d.rejectionNotes && <Field name="Rejection notes">{d.rejectionNotes}</Field>}
              {rec.RejectionNos && <Field name="Rejection note">{rec.RejectionNos}</Field>}
            </>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, fontSize: 11, marginTop: 24 }}>
          <div><div style={{ borderTop: '1px solid #111', paddingTop: 3 }}>Submitted by: <strong>{d.decidedBy || rec.SubmittedByName}</strong></div></div>
          <div><div style={{ borderTop: '1px solid #111', paddingTop: 3 }}>Signature</div></div>
        </div>
        <div style={{ fontSize: 9, color: '#666', marginTop: 12 }}>
          Printed {dayTime(new Date())} · Delivery status now: {rec.EntryStatusNow || '—'}
        </div>
      </div>
    </div>
  );
}
