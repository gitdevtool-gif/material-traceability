import React, { useEffect, useState } from 'react';
import api from '../services/api';

/**
 * "Mark LPO Raised in Busy" for one awarded supplier (Awarded Suppliers
 * page). Procurement picks the Busy Purchase Order they just raised —
 * either from this supplier's recent unlinked Busy LPOs, or by typing the
 * number (full "Pur-2194---2026-27" or just "2194"). The server re-reads
 * the LPO from Busy before saving, so the amounts recorded always come
 * from Busy itself.
 */
const fmtMoney = (n) =>
  n === null || n === undefined
    ? '—'
    : Number(n).toLocaleString(undefined, { style: 'currency', currency: 'KES', maximumFractionDigits: 2 });
const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

export default function MarkLpoRaisedModal({ award, onClose, onMarked }) {
  const [candidates, setCandidates] = useState([]);
  const [matchedBy, setMatchedBy]   = useState('');
  const [loadingCands, setLoadingCands] = useState(true);
  const [manualNo, setManualNo]     = useState('');
  const [lookingUp, setLookingUp]   = useState(false);
  const [lookupResults, setLookupResults] = useState(null);
  const [selected, setSelected]     = useState(null);
  const [notes, setNotes]           = useState('');
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState('');
  const [mismatch, setMismatch]     = useState('');

  useEffect(() => {
    setLoadingCands(true);
    api.get('/procurement/busy-lpo/candidates', {
      params: { supplierId: award.SupplierId, since: award.ApprovedAt },
    })
      .then((r) => { setCandidates(r.data.lpos || []); setMatchedBy(r.data.matchedBy); })
      .catch((e) => setError(e.response?.data?.error || 'Could not load LPOs from Busy'))
      .finally(() => setLoadingCands(false));
  }, [award.SupplierId, award.ApprovedAt]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const awardedNames = new Set(award.lineItems.map((li) => norm(li.ItemName)));
  const matchCount = (lpo) => lpo.items.filter((it) => awardedNames.has(norm(it.itemName))).length;

  const select = (lpo) => { setSelected(lpo); setMismatch(''); setError(''); };

  const lookup = async () => {
    const q = manualNo.trim();
    if (!q) return;
    setLookingUp(true);
    setError('');
    setLookupResults(null);
    try {
      const r = await api.get('/procurement/busy-lpo/lookup', { params: { ordno: q } });
      setLookupResults(r.data);
      if (r.data.length === 1 && !r.data[0].linkedTo) select(r.data[0]);
      if (r.data.length === 0) setError(`No LPO "${q}" found in Busy. Make sure it has been saved in Busy.`);
    } catch (e) {
      setError(e.response?.data?.error || 'Lookup failed');
    } finally {
      setLookingUp(false);
    }
  };

  const submit = async (confirmSupplierMismatch = false) => {
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      await api.post('/procurement/busy-lpo/mark-raised', {
        busyOrdNo: selected.ordno,
        rfqId: award.RFQId,
        quoteEvaluationId: award.QuoteEvaluationId,
        supplierId: award.SupplierId,
        awardType: award.awardType,
        notes: notes || null,
        confirmSupplierMismatch,
      });
      onMarked(selected);
    } catch (e) {
      if (e.response?.data?.code === 'SUPPLIER_MISMATCH') setMismatch(e.response.data.error);
      else setError(e.response?.data?.error || 'Failed to mark LPO as raised');
    } finally {
      setSaving(false);
    }
  };

  const renderLpoRow = (lpo) => {
    const isSel = selected?.ordno === lpo.ordno;
    const matched = matchCount(lpo);
    const disabled = !!lpo.linkedTo;
    return (
      <label key={lpo.ordno} style={{
        display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px',
        border: `1px solid ${isSel ? '#1a73e8' : '#e5e7eb'}`, borderRadius: 6,
        background: isSel ? '#eff6ff' : disabled ? '#f9fafb' : '#fff',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
      }}>
        <input type="radio" name="busyLpo" checked={isSel} disabled={disabled}
          onChange={() => select(lpo)} style={{ marginTop: 3 }} />
        <div style={{ flex: 1, fontSize: 13 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <strong>{lpo.ordno}</strong>
            <strong>{fmtMoney(lpo.totalAmt)}</strong>
          </div>
          <div style={{ color: '#6b7280', fontSize: 12, marginTop: 2 }}>
            {fmtDate(lpo.date)} · {lpo.supplier} · {lpo.items.length} item{lpo.items.length !== 1 ? 's' : ''}
            {' · '}
            <span style={{ color: lpo.approvalStatus === 1 ? '#059669' : '#b45309' }}>{lpo.approvalLabel}</span>
            {' · '}
            <span style={{ color: matched === awardedNames.size ? '#059669' : '#6b7280' }}>
              {matched}/{awardedNames.size} awarded item{awardedNames.size !== 1 ? 's' : ''} match
            </span>
          </div>
          {disabled && (
            <div style={{ color: '#b91c1c', fontSize: 12, marginTop: 2 }}>
              Already linked to {lpo.linkedTo.rfqNumber || 'another record'}
            </div>
          )}
        </div>
      </label>
    );
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div style={{
        background: '#fff', borderRadius: 10, padding: 24, width: 640, maxWidth: '100%',
        maxHeight: '92vh', overflow: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
      }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 17 }}>Mark LPO Raised in Busy</h2>
        <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>
          {award.RFQNumber} · <strong>{award.SupplierName}</strong> · awarded {fmtMoney(award.TotalAmount)}
          {award.awardType === 'split' && ' (split award — this supplier\'s share only)'}
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
          1. Pick the LPO you raised in Busy
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
          {matchedBy === 'name'
            ? 'This supplier has no Busy code on file, so these are matched by supplier name.'
            : `Unlinked Busy LPOs for this supplier since ${fmtDate(award.ApprovedAt)}.`}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
          {loadingCands && <div style={{ fontSize: 13, color: '#6b7280' }}>Checking Busy…</div>}
          {!loadingCands && candidates.length === 0 && (
            <div style={{ fontSize: 13, color: '#6b7280' }}>
              No unlinked Busy LPOs found for this supplier yet — enter the number below.
            </div>
          )}
          {candidates.map(renderLpoRow)}
        </div>

        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>…or enter the Busy LPO number</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input className="form-input" value={manualNo} placeholder="e.g. Pur-2194---2026-27 or 2194"
            onChange={(e) => setManualNo(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') lookup(); }} />
          <button className="btn btn-secondary" onClick={lookup} disabled={lookingUp || !manualNo.trim()}>
            {lookingUp ? 'Finding…' : 'Find in Busy'}
          </button>
        </div>
        {lookupResults && lookupResults.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
            {lookupResults.map(renderLpoRow)}
          </div>
        )}

        {selected && (
          <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: 12, margin: '14px 0' }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>2. Check it against the award</div>
            <table className="data-table" style={{ fontSize: 12, marginBottom: 8 }}>
              <thead>
                <tr><th>Busy item</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Price</th><th style={{ textAlign: 'right' }}>Amount</th><th /></tr>
              </thead>
              <tbody>
                {selected.items.map((it) => (
                  <tr key={it.SrNo}>
                    <td>{it.itemName}</td>
                    <td style={{ textAlign: 'right' }}>{Number(it.Qty).toLocaleString()}</td>
                    <td style={{ textAlign: 'right' }}>{fmtMoney(it.Price)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtMoney(it.Amt)}</td>
                    <td title={awardedNames.has(norm(it.itemName)) ? 'Matches an awarded item' : 'Not in this award'}>
                      {awardedNames.has(norm(it.itemName)) ? '✓' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13 }}>
              <div>Busy (excl. VAT): <strong>{fmtMoney(selected.totalAmt)}</strong></div>
              <div>Busy (incl. VAT): {fmtMoney(selected.grandTotal)}</div>
              <div>Awarded: {fmtMoney(award.TotalAmount)}</div>
              <div style={{ color: Number(selected.totalAmt) - Number(award.TotalAmount) > 0 ? '#dc2626' : '#059669' }}>
                Difference: {fmtMoney(Number(selected.totalAmt) - Number(award.TotalAmount || 0))}
              </div>
            </div>
          </div>
        )}

        {mismatch && (
          <div className="alert alert-error" style={{ marginBottom: 12 }}>
            {mismatch}
            <div style={{ marginTop: 8 }}>
              <button className="btn btn-danger btn-sm" onClick={() => submit(true)} disabled={saving}>
                Link anyway
              </button>
            </div>
          </div>
        )}

        <div className="form-group">
          <label className="form-label">Notes (optional)</label>
          <textarea className="form-input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Price negotiated down from quoted amount" />
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-primary" onClick={() => submit(false)} disabled={!selected || saving}>
            {saving ? 'Saving…' : selected ? `Mark raised as ${selected.ordno}` : 'Select an LPO first'}
          </button>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
