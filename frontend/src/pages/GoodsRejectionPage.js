import React, { useEffect, useState } from 'react';
import api from '../services/api';

export default function GoodsRejectionPage() {
  const [entries, setEntries] = useState([]);
  const [rejections, setRejections] = useState([]);
  const [selected, setSelected] = useState(null);
  const [entryDetail, setEntryDetail] = useState(null);
  const [form, setForm] = useState({ rejectionReason: '', notes: '' });
  const [rejItems, setRejItems] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [tab, setTab] = useState('create'); // create | list

  const loadData = () => {
    api.get('/entries?status=QARejected').then(r => setEntries(r.data.data)).catch(() => {});
    api.get('/rejections').then(r => setRejections(r.data.data)).catch(() => {});
  };
  useEffect(() => { loadData(); }, []);

  const handleSelect = async (entry) => {
    setSelected(entry); setError(''); setSuccess('');
    setForm({ rejectionReason: '', notes: '' });
    try {
      const res = await api.get(`/entries/${entry.EntryNo}`);
      setEntryDetail(res.data);
      setRejItems((res.data.items || []).map(it => ({
        materialId: it.MaterialId, materialName: `${it.MaterialCode} — ${it.MaterialName}`,
        rejectedQty: it.Quantity, uom: it.UOM, rejectionReason: '', remarks: '',
      })));
    } catch { setError('Failed to load entry details'); }
  };

  const setRejItem = (i, field) => (e) => {
    const updated = [...rejItems]; updated[i] = { ...updated[i], [field]: e.target.value }; setRejItems(updated);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.rejectionReason) { setError('Rejection reason is required'); return; }
    setSaving(true); setError('');
    try {
      const res = await api.post('/rejections', {
        entryNo: selected.EntryNo, rejectionReason: form.rejectionReason, notes: form.notes,
        items: rejItems.map(it => ({
          materialId: it.materialId, rejectedQty: parseFloat(it.rejectedQty), uom: it.uom,
          rejectionReason: it.rejectionReason, remarks: it.remarks,
        })),
      });
      setSuccess(`Goods Rejection Note ${res.data.RejectionNo} created for ${selected.EntryNo}`);
      setSelected(null); setEntryDetail(null); loadData();
    } catch (err) { setError(err.response?.data?.error || 'Failed to create rejection note'); }
    finally { setSaving(false); }
  };

  return (
    <div>
      <div className="page-header">
        <h1>Goods Rejection</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className={`btn ${tab === 'create' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setTab('create')}>Create Rejection</button>
          <button className={`btn ${tab === 'list' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setTab('list')}>Rejection List</button>
        </div>
      </div>
      {success && <div className="card" style={{ color: 'var(--success)' }}>{success}</div>}
      {error && <div className="card" style={{ color: 'var(--danger)' }}>{error}</div>}

      {tab === 'create' && (
        <>
          <div className="card">
            <h3 style={{ marginBottom: 12 }}>QA Rejected Entries ({entries.length})</h3>
            <table className="data-table">
              <thead><tr><th>Entry No</th><th>Supplier</th><th>Consignment</th><th>Vehicle</th><th>Net Wt</th><th></th></tr></thead>
              <tbody>
                {entries.map(e => (
                  <tr key={e.EntryId}>
                    <td><strong>{e.EntryNo}</strong></td><td>{e.SupplierName}</td><td>{e.ConsignmentNo}</td>
                    <td>{e.VehicleRegNo}</td><td>{e.NetWeight} kg</td>
                    <td><button className="btn btn-primary" style={{ padding: '4px 12px', fontSize: 13 }} onClick={() => handleSelect(e)}>Reject</button></td>
                  </tr>
                ))}
                {entries.length === 0 && <tr><td colSpan="6" className="text-center text-muted">No QA-rejected entries</td></tr>}
              </tbody>
            </table>
          </div>

          {selected && entryDetail && (
            <form className="card" onSubmit={handleSubmit}>
              <h3 style={{ marginBottom: 16 }}>Create Goods Rejection Note — {selected.EntryNo}</h3>
              <div style={{ padding: 12, background: 'var(--gray-50)', borderRadius: 'var(--radius)', marginBottom: 16 }}>
                <strong>Supplier:</strong> {entryDetail.SupplierName} | <strong>Consignment:</strong> {entryDetail.ConsignmentNo} | <strong>Vehicle:</strong> {entryDetail.VehicleRegNo}
              </div>
              <div className="form-group">
                <label>Rejection Reason *</label>
                <textarea rows="3" value={form.rejectionReason} onChange={e => setForm({ ...form, rejectionReason: e.target.value })} required placeholder="Describe why goods are being rejected..." />
              </div>
              <h4 style={{ margin: '16px 0 8px' }}>Rejected Items</h4>
              <table className="data-table">
                <thead><tr><th>Material</th><th>Rejected Qty</th><th>UOM</th><th>Reason</th><th>Remarks</th></tr></thead>
                <tbody>
                  {rejItems.map((it, i) => (
                    <tr key={i}>
                      <td>{it.materialName}</td>
                      <td><input type="number" step="0.01" value={it.rejectedQty} onChange={setRejItem(i, 'rejectedQty')} style={{ width: 90 }} /></td>
                      <td>{it.uom}</td>
                      <td><input value={it.rejectionReason} onChange={setRejItem(i, 'rejectionReason')} placeholder="Specific reason" /></td>
                      <td><input value={it.remarks} onChange={setRejItem(i, 'remarks')} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="form-group" style={{ marginTop: 12 }}>
                <label>Notes</label>
                <textarea rows="2" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="submit" className="btn btn-danger" disabled={saving}>{saving ? 'Creating…' : 'Create Rejection Note'}</button>
                <button type="button" className="btn btn-outline" onClick={() => { setSelected(null); setEntryDetail(null); }}>Cancel</button>
              </div>
            </form>
          )}
        </>
      )}

      {tab === 'list' && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Goods Rejection Notes</h3>
          <table className="data-table">
            <thead><tr><th>Rejection No</th><th>Entry No</th><th>Supplier</th><th>Date</th><th>Reason</th><th>Rejected By</th></tr></thead>
            <tbody>
              {rejections.map(r => (
                <tr key={r.RejectionId}>
                  <td><strong>{r.RejectionNo}</strong></td><td>{r.EntryNo}</td><td>{r.SupplierName}</td>
                  <td>{new Date(r.RejectionDate).toLocaleDateString()}</td>
                  <td>{r.RejectionReason?.substring(0, 80)}{r.RejectionReason?.length > 80 ? '…' : ''}</td>
                  <td>{r.RejectedByName}</td>
                </tr>
              ))}
              {rejections.length === 0 && <tr><td colSpan="6" className="text-center text-muted">No rejection notes</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
