import React, { useCallback, useEffect, useState } from 'react';
import api from '../services/api';
import StockPicture from './StockPicture';
import BusyLoginLink from './BusyLoginLink';

/**
 * "Raise PO in Busy" for one awarded supplier (Awarded Suppliers page).
 * Shows exactly what will be saved in Busy — every supplier, item, store
 * and tax type already checked against Busy by the server — then saves it
 * through Busy's own API so Busy assigns the PO number. The award is
 * linked to that PO the same way "Mark LPO Raised" does.
 */
const fmtMoney = (n) =>
  n === null || n === undefined
    ? '—'
    : Number(n).toLocaleString(undefined, { style: 'currency', currency: 'KES', maximumFractionDigits: 2 });

export default function RaisePoInBusyModal({ award, onClose, onRaised }) {
  const [preview, setPreview]   = useState(null);
  const [loading, setLoading]   = useState(true);
  const [taxType, setTaxType]   = useState('');
  const [store, setStore]       = useState('');
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  const baseParams = {
    rfqId: award.RFQId,
    quoteEvaluationId: award.QuoteEvaluationId,
    supplierId: award.SupplierId,
    awardType: award.awardType,
  };

  const loadPreview = useCallback((overrides = {}) => {
    setLoading(true);
    setError('');
    api.get('/procurement/busy-lpo/push-preview', {
      params: { ...baseParams, taxType: overrides.taxType || undefined, storeOverride: overrides.store || undefined },
    })
      .then((r) => {
        setPreview(r.data);
        if (r.data.taxType) setTaxType(r.data.taxType);
      })
      .catch((e) => setError(e.response?.data?.error || 'Could not check this PO against Busy'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [award.RFQId, award.QuoteEvaluationId, award.SupplierId, award.awardType]);

  useEffect(() => { loadPreview(); }, [loadPreview]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const changeTaxType = (t) => { setTaxType(t); loadPreview({ taxType: t, store }); };
  const changeStore = (s) => { setStore(s); loadPreview({ taxType, store: s }); };

  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      const r = await api.post('/procurement/busy-lpo/push', {
        ...baseParams, taxType, storeOverride: store || undefined,
      });
      onRaised(r.data.lpo, r.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Busy did not save the PO');
    } finally {
      setSaving(false);
    }
  };

  const problems = preview?.problems || [];
  const ready = preview?.enabled && problems.length === 0 && !loading;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div style={{
        background: '#fff', borderRadius: 10, padding: 24, width: 680, maxWidth: '100%',
        maxHeight: '92vh', overflow: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
      }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 17 }}>Raise PO in Busy</h2>
        <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>
          {award.RFQNumber} · <strong>{award.SupplierName}</strong>
          {award.awardType === 'split' && ' (split award — this supplier\'s share only)'}
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
        {loading && !preview && <div style={{ fontSize: 13, color: '#6b7280' }}>Checking against Busy…</div>}

        {preview && problems.length > 0 && (
          <div className="alert alert-error" style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>This PO can't be raised from here yet:</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          </div>
        )}

        {preview?.enabled && preview.lines && (
          <>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
              <div className="form-group" style={{ margin: 0, minWidth: 220 }}>
                <label className="form-label">Busy tax type</label>
                <select className="form-input" value={taxType} disabled={loading || saving}
                  onChange={(e) => changeTaxType(e.target.value)}>
                  {(preview.taxTypes || []).map((t) => (
                    <option key={t} value={t}>{t}{t === preview.suggestedTaxType ? ' (suggested)' : ''}</option>
                  ))}
                </select>
              </div>
              {preview.needsStore && (
                <div className="form-group" style={{ margin: 0, minWidth: 220 }}>
                  <label className="form-label">Busy store for items without one</label>
                  <select className="form-input" value={store} disabled={loading || saving}
                    onChange={(e) => changeStore(e.target.value)}>
                    <option value="">— choose a store —</option>
                    {(preview.stores || []).map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              )}
            </div>

            <table className="data-table" style={{ fontSize: 12, marginBottom: 10 }}>
              <thead>
                <tr>
                  <th>Busy item</th><th>Store</th><th style={{ textAlign: 'right' }}>Qty</th>
                  <th>Unit</th><th style={{ textAlign: 'right' }}>Price</th><th style={{ textAlign: 'right' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {preview.lines.map((l) => (
                  <tr key={l.srNo}>
                    <td>{l.itemName}</td>
                    <td title={l.requisitionStore && l.requisitionStore !== l.store ? `Requisition store: ${l.requisitionStore}` : ''}>
                      {l.store || '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>{Number(l.qty).toLocaleString()}</td>
                    <td>{l.unitName || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{fmtMoney(l.price)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtMoney(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <StockPicture
              compact
              title="Stock picture for these items right now (Busy)"
              items={preview.lines.map((l) => ({ name: l.itemName, requestedQty: l.qty }))}
            />
            <div style={{ fontSize: 13, marginBottom: 6 }}>
              {preview.taxInclusive
                ? <>Prices include VAT ({fmtMoney(preview.vat)} at {preview.taxRate}%).</>
                : <>Subtotal {fmtMoney(preview.subtotal)} + VAT {preview.taxRate}% {fmtMoney(preview.vat)}.</>}
              {preview.roundOff !== 0 && <> Round-off {fmtMoney(preview.roundOff)}.</>}
              {' '}Total in Busy: <strong>{fmtMoney(preview.total)}</strong>
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>
              Supplier in Busy: {preview.party?.Name || '—'} · Date {preview.date} · Narration “{preview.narration}”.
              Busy assigns the PO number; it is saved as pending approval for the Director in Busy.
            </div>
            {preview.busyUser
              ? <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>Added by in Busy: <strong>{preview.busyUser}</strong></div>
              : <BusyLoginLink onLinked={() => loadPreview({ taxType, store })} />}
          </>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-primary" onClick={submit} disabled={!ready || saving}>
            {saving ? 'Saving in Busy…' : 'Raise PO in Busy'}
          </button>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
