import React, { useEffect, useState } from 'react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';

const fmtDT = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
const fmtDate = (v) => (v ? new Date(v).toLocaleDateString() : '—');

export default function ReceivingPage() {
  const { user } = useAuth();
  const [entries, setEntries] = useState([]);
  const [selected, setSelected] = useState(null);
  const [entryDetail, setEntryDetail] = useState(null);
  const [form, setForm] = useState({ receivingDept: '', purchaseOrderNo: '', nonPOReason: '', notes: '' });
  const [grnItems, setGrnItems] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [erpSearch, setErpSearch] = useState('');
  const [erpResults, setErpResults] = useState([]);
  const [erpLoading, setErpLoading] = useState(false);
  const [selectedErpVchNo, setSelectedErpVchNo] = useState('');

  const loadPendingEntries = async () => {
    const statuses = ['OpsManagerApproved', 'CentralStoreReceived'];
    if (user?.role === 'FactoryQA') {
      // Factory QA can receive directly after QA acceptance for factory GRN flow.
      statuses.push('QAAccepted');
    }

    const results = await Promise.all(
      statuses.map((status) => api.get(`/entries?status=${status}`).then(r => r.data.data).catch(() => []))
    );

    // Deduplicate by EntryId when an entry may appear in overlapping status fetches.
    const unique = new Map();
    results.flat().forEach((entry) => {
      if (!unique.has(entry.EntryId)) unique.set(entry.EntryId, entry);
    });
    setEntries([...unique.values()]);
  };

  useEffect(() => {
    // Fetch entries ready for GRN by role-specific workflow stage.
    loadPendingEntries();
  }, [user?.role]);

  // Close modal on Escape key
  useEffect(() => {
    if (!selected) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected]);

  const closeModal = () => {
    setSelected(null);
    setEntryDetail(null);
    setError('');
  };

  const handleSelect = async (entry) => {
    setSelected(entry);
    setError('');
    setSuccess('');
    setForm({ receivingDept: '', purchaseOrderNo: '', nonPOReason: '', notes: '' });
    setSelectedErpVchNo('');
    setErpSearch('');
    setErpResults([]);
    try {
      const res = await api.get(`/entries/${entry.EntryNo}`);
      setEntryDetail(res.data);
      // Pre-populate PO fields from entry if already set
      if (res.data.PurchaseOrderNo) {
        setForm(f => ({ ...f, purchaseOrderNo: res.data.PurchaseOrderNo || '', nonPOReason: res.data.NonPOReason || '' }));
      }
      // Pre-populate GRN items from delivery entry items + QA inspection data
      const qa = res.data.qaInspection;
      const totalItemQty = (res.data.items || []).reduce((sum, it) => sum + (parseFloat(it.Quantity) || 0), 0);

      const items = (res.data.items || []).map((it) => {
        const itemQty = parseFloat(it.Quantity) || 0;
        const proportion = totalItemQty > 0 ? itemQty / totalItemQty : 1;

        // Use QA accepted/rejected quantities, proportioned per item
        const acceptedQty = qa && qa.AcceptedQty != null
          ? Math.round(qa.AcceptedQty * proportion * 100) / 100
          : itemQty;
        const rejectedQty = qa && qa.RejectedQty != null && qa.RejectedQty > 0
          ? Math.round(qa.RejectedQty * proportion * 100) / 100
          : 0;

        return {
          materialId: it.MaterialId,
          materialName: `${it.MaterialCode} — ${it.MaterialName}`,
          expectedQty: itemQty,
          receivedQty: itemQty,
          acceptedQty: acceptedQty,
          rejectedQty: rejectedQty,
          rejectionReason: '',
          uom: it.UOM,
          remarks: '',
        };
      });
      setGrnItems(items);

      // Auto-search ERP using first material name for GRV auto-match
      const firstMat = (res.data.items || [])[0];
      if (firstMat) {
        const matName = firstMat.MaterialName || '';
        setErpSearch(matName);
        setErpLoading(true);
        api.get('/erp/goods-received', { params: { search: matName, limit: 20 } })
          .then(r => {
            const results = r.data.data || [];
            setErpResults(results);
            // Auto-select if exactly one unique VchNo found
            const uniqueVchs = [...new Set(results.map(x => (x.VchNo || '').trim()))];
            if (uniqueVchs.length === 1) {
              setSelectedErpVchNo(uniqueVchs[0]);
              setErpResults([]);
            }
          })
          .catch(() => setErpResults([]))
          .finally(() => setErpLoading(false));
      }
    } catch {
      setError('Failed to load entry details');
    }
  };

  const setGrnItem = (i, field) => (e) => {
    const updated = [...grnItems];
    updated[i] = { ...updated[i], [field]: e.target.value };
    setGrnItems(updated);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (!form.receivingDept) { setError('Select receiving department'); return; }
    const erpVchNoToUse = selectedErpVchNo || erpSearch.trim();
    if (!erpVchNoToUse) { setError('Enter or search for an ERP GRV number'); return; }
    if (!form.purchaseOrderNo && !form.nonPOReason) { setError('Non-PO Reason is required when no PO Number is provided'); return; }
    setSaving(true);
    try {
      const payload = {
        entryNo: selected.EntryNo,
        receivingDept: form.receivingDept,
        purchaseOrderNo: form.purchaseOrderNo || null,
        nonPOReason: form.nonPOReason || null,
        notes: form.notes,
        erpVchNo: erpVchNoToUse,
        items: grnItems.map((it) => ({
          materialId: it.materialId,
          expectedQty: parseFloat(it.expectedQty),
          receivedQty: parseFloat(it.receivedQty),
          acceptedQty: parseFloat(it.acceptedQty),
          rejectedQty: parseFloat(it.rejectedQty) || 0,
          rejectionReason: it.rejectionReason,
          uom: it.uom,
          remarks: it.remarks,
        })),
      };
      const res = await api.post('/grn', payload);
      setSuccess(`GRN created: ${res.data.GRNNo} for entry ${selected.EntryNo}`);
      closeModal();
      // Refresh pending list
      await loadPendingEntries();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create GRN');
    } finally {
      setSaving(false);
    }
  };


  return (
    <div>
      <div className="page-header"><h1>Receiving — Generate GRN</h1></div>

      {success && <div className="card" style={{ color: 'var(--success)' }}>{success}</div>}
      {error && !selected && <div className="card" style={{ color: 'var(--danger)' }}>{error}</div>}

      {/* Pending entries */}
      <div className="card">
        <h3 style={{ marginBottom: 12 }}>Entries Awaiting GRN ({entries.length})</h3>
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr><th>Entry No</th><th>Supplier</th><th>Consignment</th><th>Vehicle</th><th>Delivery Date</th><th>Net Wt</th><th>Destination</th><th></th></tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.EntryId}>
                  <td><strong>{e.EntryNo}</strong></td>
                  <td>{e.SupplierName}</td>
                  <td>{e.ConsignmentNo}</td>
                  <td>{e.VehicleRegNo}</td>
                  <td style={{ fontSize: 12, whiteSpace: 'nowrap', color: 'var(--gray-600)' }}>
                    {fmtDate(e.DeliveryDate)}
                    {e.DeliveryTime && <><br /><span style={{ color: 'var(--gray-500)' }}>{String(e.DeliveryTime).slice(0, 5)}</span></>}
                  </td>
                  <td>{e.NetWeight} kg</td>
                  <td><span className={`badge ${e.Status === 'OpsManagerApproved' ? 'badge-green' : 'badge-blue'}`}>
                    {e.Status === 'OpsManagerApproved' ? 'Factory (Ops Approved)' : 'Central Store'}
                  </span></td>
                  <td>
                    <button className="btn btn-primary" style={{ padding: '4px 12px', fontSize: 13, whiteSpace: 'nowrap' }}
                      onClick={() => handleSelect(e)}>Receive</button>
                  </td>
                </tr>
              ))}
              {entries.length === 0 && (
                <tr><td colSpan="8" className="text-center text-muted">No entries pending receiving</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* GRN Form Modal */}
      {selected && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.55)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            padding: 'clamp(8px, 4vw, 40px) clamp(8px, 3vw, 16px)',
            overflowY: 'auto',
            zIndex: 1000,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}
        >
          {!entryDetail ? (
            <div className="card" style={{ width: '100%', maxWidth: 720, margin: 'clamp(24px, 15vh, 80px) auto' }}>
              Loading entry details…
            </div>
          ) : (
            <form
              className="card grn-modal-form"
              onSubmit={handleSubmit}
              style={{ width: '100%', maxWidth: 900, position: 'relative', maxHeight: '90vh', overflowY: 'auto', boxSizing: 'border-box' }}
            >
              <style>{`
                @media (max-width: 768px) {
                  .grn-modal-form {
                    max-height: 100vh !important;
                  }
                  .grn-modal-form h3 {
                    padding-right: 24px;
                  }
                  .grn-modal-form .grn-actions {
                    flex-direction: column;
                  }
                  .grn-modal-form .grn-actions button {
                    width: 100%;
                  }
                }
              `}</style>
              <button
                type="button"
                onClick={closeModal}
                aria-label="Close"
                style={{
                  position: 'absolute', top: 12, right: 12, background: 'none', border: 'none',
                  fontSize: 20, lineHeight: 1, cursor: 'pointer', color: 'var(--gray-500)',
                }}
              >✕</button>

              <h3 style={{ marginBottom: 16 }}>Create GRN for {selected.EntryNo}</h3>

              {error && <div style={{ color: 'var(--danger)', marginBottom: 12 }}>{error}</div>}

              <div style={{ padding: 12, background: 'var(--gray-50)', borderRadius: 'var(--radius)', marginBottom: 16 }}>
                <strong>Supplier:</strong> {entryDetail.SupplierName} |
                <strong> Consignment:</strong> {entryDetail.ConsignmentNo} |
                <strong> Vehicle:</strong> {entryDetail.VehicleRegNo} |
                <strong> Net Weight:</strong> {entryDetail.NetWeight} kg
                {entryDetail.weighbridge && (<><br /><strong>Weighbridge Net:</strong> {entryDetail.weighbridge.NetWeight} kg | <strong>Variance:</strong> {entryDetail.weighbridge.WeightVariance} kg</>)}
                {entryDetail.qaInspection && (
                  <><br />
                    <strong>QC Responsible:</strong> {entryDetail.qaInspection.ApprovedByName || entryDetail.qaInspection.InspectorName || '—'} |
                    <strong> QA Decision:</strong> <span style={{ color: entryDetail.qaInspection.OverallStatus === 'Accepted' ? '#16a34a' : entryDetail.qaInspection.OverallStatus === 'Rejected' ? '#dc2626' : '#d97706' }}>{entryDetail.qaInspection.OverallStatus}</span>
                    {entryDetail.qaInspection.AcceptedQty != null && <> | <strong>Accepted Qty:</strong> {entryDetail.qaInspection.AcceptedQty} kg</>}
                    {entryDetail.qaInspection.RejectedQty > 0 && <> | <strong>Rejected Qty:</strong> {entryDetail.qaInspection.RejectedQty} kg</>}
                  </>
                )}
              </div>

              <div className="form-row">
                <div className="form-group" style={{ flex: 2 }}>
                  <label>ERP GRV Number (Busy) *</label>
                  {erpLoading && <div style={{ fontSize: 13, color: 'var(--gray-500)', padding: '6px 0' }}>🔍 Searching ERP for matching GRV…</div>}
                  {selectedErpVchNo && (
                    <div style={{ padding: '8px 12px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 'var(--radius)', fontSize: 13 }}>
                      ✅ GRN No: <strong>{selectedErpVchNo}</strong>
                      <button type="button" style={{ marginLeft: 8, background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 13 }}
                        onClick={() => { setSelectedErpVchNo(''); setErpResults([]); }}>✕ Change</button>
                    </div>
                  )}
                  {!selectedErpVchNo && !erpLoading && (
                    <>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <input
                          value={erpSearch}
                          onChange={(e) => setErpSearch(e.target.value)}
                          placeholder="Search by GRV no, material name, supplier..."
                          style={{ flex: 1 }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              if (!erpSearch.trim()) return;
                              setErpLoading(true);
                              api.get('/erp/goods-received', { params: { search: erpSearch.trim(), limit: 20 } })
                                .then(r => setErpResults(r.data.data || []))
                                .catch(() => setErpResults([]))
                                .finally(() => setErpLoading(false));
                            }
                          }}
                        />
                        <button type="button" className="btn btn-outline" disabled={!erpSearch.trim()}
                          onClick={() => {
                            setErpLoading(true);
                            api.get('/erp/goods-received', { params: { search: erpSearch.trim(), limit: 20 } })
                              .then(r => setErpResults(r.data.data || []))
                              .catch(() => setErpResults([]))
                              .finally(() => setErpLoading(false));
                          }}>🔍 Search</button>
                      </div>
                      {erpResults.length > 0 && (
                        <div style={{ marginTop: 4, border: '1px solid var(--gray-300)', borderRadius: 'var(--radius)', maxHeight: 200, overflowY: 'auto', background: '#fff' }}>
                          <div style={{ padding: '4px 12px', fontSize: 11, color: 'var(--gray-500)', borderBottom: '1px solid var(--gray-200)' }}>
                            Click to select the matching GRV:
                          </div>
                          {erpResults.map((r, i) => {
                            const vch = (r.VchNo || '').trim();
                            return (
                              <div key={i} style={{ padding: '6px 12px', cursor: 'pointer', borderBottom: '1px solid var(--gray-100)', fontSize: 13 }}
                                onClick={() => { setSelectedErpVchNo(vch); setErpResults([]); }}
                                onMouseEnter={(e) => e.currentTarget.style.background = 'var(--gray-50)'}
                                onMouseLeave={(e) => e.currentTarget.style.background = '#fff'}>
                                <strong>{vch}</strong> — {r.Name} | Qty: {r.Qty} | {r['Mat Center'] || ''}
                                {r.Date ? ` | ${new Date(r.Date).toLocaleDateString()}` : ''}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {erpResults.length === 0 && !erpLoading && (
                        <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 12, color: 'var(--gray-500)' }}>
                            {erpSearch.trim() ? 'No ERP match found.' : 'Search by GRV no or material name above.'}
                          </span>
                          {erpSearch.trim() && (
                            <button type="button" className="btn btn-outline" style={{ fontSize: 12, padding: '2px 10px' }}
                              onClick={() => setSelectedErpVchNo(erpSearch.trim())}>
                              Use "{erpSearch.trim()}" as GRV No
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Receiving Department *</label>
                  <select value={form.receivingDept} onChange={(e) => setForm({ ...form, receivingDept: e.target.value })} required>
                    <option value="">-- Select --</option>
                    <option value="CentralStore">Central Store</option>
                    <option value="Factory">Factory</option>
                  </select>
                </div>
              </div>

              <h4 style={{ margin: '16px 0 8px' }}>Purchase Order</h4>
              <div className="form-row">
                <div className="form-group">
                  <label>PO Number</label>
                  <input value={form.purchaseOrderNo} onChange={(e) => setForm({ ...form, purchaseOrderNo: e.target.value })} placeholder="Leave blank for non-PO" />
                </div>
                <div className="form-group">
                  <label>Non-PO Reason {!form.purchaseOrderNo && '*'}</label>
                  <input
                    value={form.nonPOReason}
                    onChange={(e) => setForm({ ...form, nonPOReason: e.target.value })}
                    required={!form.purchaseOrderNo}
                    placeholder="Required if no PO"
                  />
                </div>
              </div>

              <h4 style={{ margin: '16px 0 8px' }}>Material Items</h4>
              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Material</th>
                      <th>Received Qty</th>
                      <th>Accepted Qty</th>
                      <th>Rejected Qty</th>
                      <th>Rejection Reason</th>
                      <th>UOM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grnItems.map((item, i) => (
                      <tr key={i}>
                        <td>{item.materialName}</td>
                        <td><input type="number" step="0.01" value={item.receivedQty} onChange={setGrnItem(i, 'receivedQty')} style={{ width: 90 }} /></td>
                        <td><input type="number" step="0.01" value={item.acceptedQty} onChange={setGrnItem(i, 'acceptedQty')} style={{ width: 90 }} /></td>
                        <td><input type="number" step="0.01" value={item.rejectedQty} onChange={setGrnItem(i, 'rejectedQty')} style={{ width: 90 }} /></td>
                        <td><input value={item.rejectionReason} onChange={setGrnItem(i, 'rejectionReason')} placeholder="If any" /></td>
                        <td>{item.uom}</td>
                      </tr>
                    ))}
                    {grnItems.length === 0 && (
                      <tr><td colSpan="6" className="text-center text-muted">No material items on this entry</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="form-group mt-4">
                <label>Notes</label>
                <textarea rows="2" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>

              <div className="grn-actions" style={{ display: 'flex', gap: 8 }}>
                <button type="submit" className="btn btn-success" disabled={saving}>
                  {saving ? 'Creating…' : 'Create GRN'}
                </button>
                <button type="button" className="btn btn-outline" onClick={closeModal}>Cancel</button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}