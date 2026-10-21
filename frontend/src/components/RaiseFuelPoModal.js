import React, { useCallback, useEffect, useState } from 'react';
import Select from 'react-select';
import api from '../services/api';
import BusyLoginLink from './BusyLoginLink';

/**
 * Raise a Transport fuel requisition as a Busy PO directly — no RFQ
 * (2026-10-19). Procurement picks the fuel station; the PO goes to the
 * vehicle's Busy store, VAT-inclusive at 8%, exactly like the fuel POs Busy
 * users raise by hand. See busy-po.service.js buildFuelPurchaseOrder.
 */
const fmtMoney = (n) => `KES ${Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function RaiseFuelPoModal({ requisition, onClose, onRaised }) {
  const [preview, setPreview]   = useState(null);
  const [loading, setLoading]   = useState(true);
  const [supplier, setSupplier] = useState(null); // react-select option
  const [searchOptions, setSearchOptions] = useState([]);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  const loadPreview = useCallback((supplierId) => {
    setLoading(true);
    setError('');
    api.get('/procurement/busy-lpo/fuel-preview', { params: { requisitionId: requisition.RequisitionId, supplierId } })
      .then((r) => setPreview(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not check this PO against Busy'))
      .finally(() => setLoading(false));
  }, [requisition.RequisitionId]);

  useEffect(() => { loadPreview(undefined); }, [loadPreview]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const suggested = (preview?.suppliers || []).map((s) => ({
    value: s.SupplierId, label: `${s.SupplierName} — ${s.busyFuelPos} fuel PO(s) in Busy this year`,
  }));

  const searchSuppliers = (text) => {
    if (!text || text.trim().length < 2) return;
    api.get('/suppliers', { params: { search: text.trim(), active: 'true' } })
      .then((r) => {
        const list = Array.isArray(r.data) ? r.data : r.data?.data || [];
        setSearchOptions(list.map((s) => ({ value: s.SupplierId, label: s.SupplierName })));
      })
      .catch(() => {});
  };

  const chooseSupplier = (opt) => {
    setSupplier(opt);
    loadPreview(opt ? opt.value : undefined);
  };

  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      const r = await api.post('/procurement/busy-lpo/fuel-push', {
        requisitionId: requisition.RequisitionId, supplierId: supplier.value,
      });
      onRaised(r.data.lpo, r.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Busy did not save the PO');
    } finally {
      setSaving(false);
    }
  };

  const problems = preview?.problems || [];
  const ready = preview?.enabled && supplier && problems.length === 0 && !loading;
  const options = [
    { label: 'Used for fuel in Busy', options: suggested },
    { label: 'Search results', options: searchOptions.filter((o) => !suggested.some((s) => s.value === o.value)) },
  ];

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div style={{
        background: '#fff', borderRadius: 10, padding: 24, width: 680, maxWidth: '100%',
        maxHeight: '92vh', overflow: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
      }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 17 }}>⛽ Raise fuel PO in Busy</h2>
        <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>
          {requisition.BusyOrdNo} · Vehicle <strong>{requisition.Vehicle || '—'}</strong>
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
        {loading && !preview && <div style={{ fontSize: 13, color: '#6b7280' }}>Checking against Busy…</div>}

        {preview?.enabled && (
          <div className="form-group" style={{ marginBottom: 12 }}>
            <label className="form-label">Fuel station (Busy supplier) *</label>
            <Select
              options={options}
              value={supplier}
              onChange={chooseSupplier}
              onInputChange={(text, meta) => { if (meta.action === 'input-change') searchSuppliers(text); }}
              placeholder="Choose or type to search…"
              isDisabled={saving}
              isClearable
            />
          </div>
        )}

        {preview && supplier && problems.length > 0 && (
          <div className="alert alert-error" style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>This PO can't be raised from here yet:</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          </div>
        )}
        {preview && !preview.enabled && (
          <div className="alert alert-error" style={{ marginBottom: 12 }}>{problems[0]}</div>
        )}

        {preview?.enabled && preview.lines && (
          <>
            <table className="data-table" style={{ fontSize: 12, marginBottom: 10 }}>
              <thead>
                <tr>
                  <th>Busy item</th><th>Store</th><th style={{ textAlign: 'right' }}>Litres asked</th>
                  <th style={{ textAlign: 'right' }}>PO qty</th><th style={{ textAlign: 'right' }}>Price</th><th style={{ textAlign: 'right' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {preview.lines.map((l) => (
                  <tr key={l.srNo}>
                    <td>{l.itemName}</td>
                    <td>{l.store || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{l.litres > 0 ? Number(l.litres).toLocaleString() : 'not sure'}</td>
                    <td style={{ textAlign: 'right' }}>{Number(l.qty).toLocaleString()} {l.unitName || ''}</td>
                    <td style={{ textAlign: 'right' }}>{fmtMoney(l.price)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtMoney(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.litresOpen && (
              <div style={{ fontSize: 12, color: '#92400e', marginBottom: 8 }}>
                Litres not known yet — the PO line is 1 unit at the price per litre, like fuel POs entered in Busy.
                The actual amount comes from the fuel station's bill.
              </div>
            )}
            <div style={{ fontSize: 13, marginBottom: 6 }}>
              {preview.taxType}: prices include VAT ({fmtMoney(preview.vat)} at {preview.taxRate}%).
              {preview.roundOff !== 0 && <> Round-off {fmtMoney(preview.roundOff)}.</>}
              {' '}Total in Busy: <strong>{fmtMoney(preview.total)}</strong>
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>
              Supplier in Busy: {preview.party?.Name || '—'} · Date {preview.date} · Narration “{preview.narration}”.
              Busy assigns the PO number; it is saved as pending approval in Busy.
            </div>
            {preview.busyUser
              ? <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>Added by in Busy: <strong>{preview.busyUser}</strong></div>
              : <BusyLoginLink onLinked={() => loadPreview(supplier ? supplier.value : undefined)} />}
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
