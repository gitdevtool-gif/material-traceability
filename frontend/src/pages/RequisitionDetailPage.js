import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../services/api';
import StockPicture from '../components/StockPicture';
import { useAuth } from '../context/AuthContext';

const STATUS_COLOR = {
  Pending: 'badge-yellow', RFQSent: 'badge-blue', QuotesReceived: 'badge-purple',
  EvaluationPending: 'badge-orange', Approved: 'badge-green', Reconciled: 'badge-teal',
  Cancelled: 'badge-red',
};

export default function RequisitionDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isProcurement = ['Admin', 'Procurement'].includes(user?.role);

  const [req, setReq]                     = useState(null);
  const [matchingSuppliers, setSuppliers] = useState([]);
  // One entry per DISTINCT RFQ this requisition's items have been sent
  // in — a requisition can now be split across several RFQs over time
  // (see selectedItemIds / "Issue RFQ" section below), so this is no
  // longer a single flat dispatch list off one RFQId.
  const [rfqBatches, setRfqBatches]       = useState([]); // [{ RFQId, RFQNumber, IssuedAt, DeadlineAt, dispatches }]
  const [loading, setLoading]             = useState(true);

  // RFQ form state
  const [rfqOpen, setRfqOpen]             = useState(false);
  const [deadlineAt, setDeadlineAt]       = useState('');
  const [rfqNotes, setRfqNotes]           = useState('');
  const [selectedSuppliers, setSelected]  = useState([]);
  const [channels, setChannels]           = useState({});
  const [selectedItemIds, setSelectedItemIds] = useState([]); // which AVAILABLE items go in this RFQ
  const [submitting, setSubmitting]       = useState(false);
  const [error, setError]                 = useState('');

  // Add a supplier to an ALREADY-ISSUED RFQ batch — either a normal
  // dispatch (email/whatsapp/phone) or "Feed Quote Directly" (skip the
  // wait, go straight to capturing a quote for them). One panel open at a
  // time, keyed by which batch's RFQId it belongs to.
  const [addSupplierRfqId, setAddSupplierRfqId]         = useState(null);
  const [addSupplierId, setAddSupplierId]               = useState('');
  const [addSupplierChannel, setAddSupplierChannel]     = useState('email');
  const [addSupplierItemIds, setAddSupplierItemIds]     = useState([]);
  const [addSupplierSubmitting, setAddSupplierSubmitting] = useState(false);
  const [addSupplierError, setAddSupplierError]         = useState('');

  const loadRfqBatches = async (items) => {
    const rfqIds = [...new Set((items || []).map((it) => it.RFQId).filter(Boolean))];
    if (rfqIds.length === 0) {
      setRfqBatches([]);
      return;
    }
    const results = await Promise.all(
      rfqIds.map((rid) => api.get(`/procurement/rfq/${rid}`).then((r) => r.data).catch(() => null))
    );
    setRfqBatches(results.filter(Boolean).sort((a, b) => b.RFQId - a.RFQId));
  };

  useEffect(() => {
    const loadAll = async () => {
      setLoading(true);
      try {
        const [reqRes, suppRes] = await Promise.all([
          api.get(`/procurement/requisitions/${id}`),
          api.get(`/procurement/requisitions/${id}/matching-suppliers`),
        ]);
        setReq(reqRes.data);
        setSuppliers(suppRes.data);
        setSelectedItemIds((reqRes.data.items || []).filter((it) => !it.RFQId).map((it) => it.RequisitionItemId));
        await loadRfqBatches(reqRes.data.items);
      } catch (e) {
        setError(e.response?.data?.error || 'Failed to load');
      } finally {
        setLoading(false);
      }
    };
    loadAll();
  }, [id]);

  const [recategorizing, setRecategorizing] = useState(false);
  const [photoUploading, setPhotoUploading] = useState({}); // { [itemId]: bool }
  const [photoError, setPhotoError]         = useState({}); // { [itemId]: string }

  const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

  const handleItemPhotoSelect = async (itemId, file) => {
    if (!file) return;
    if (file.size > MAX_PHOTO_BYTES) {
      setPhotoError((p) => ({ ...p, [itemId]: 'Photo must be under 5MB' }));
      return;
    }
    setPhotoUploading((p) => ({ ...p, [itemId]: true }));
    setPhotoError((p) => ({ ...p, [itemId]: '' }));
    try {
      const formData = new FormData();
      formData.append('photo', file);
      // Do NOT set Content-Type manually — axios/browser needs to add the
      // multipart boundary itself, which an explicit header would clobber.
      const res = await api.post(`/procurement/requisitions/${id}/items/${itemId}/photo`, formData);
      setReq((r) => ({
        ...r,
        items: r.items.map((it) =>
          it.RequisitionItemId === itemId ? { ...it, ReferencePhotoUrl: res.data.photoUrl } : it
        ),
      }));
    } catch (e) {
      setPhotoError((p) => ({ ...p, [itemId]: e.response?.data?.error || 'Upload failed' }));
    } finally {
      setPhotoUploading((p) => ({ ...p, [itemId]: false }));
    }
  };

  const handleItemPhotoRemove = async (itemId) => {
    try {
      await api.delete(`/procurement/requisitions/${id}/items/${itemId}/photo`);
      setReq((r) => ({
        ...r,
        items: r.items.map((it) =>
          it.RequisitionItemId === itemId ? { ...it, ReferencePhotoUrl: null } : it
        ),
      }));
    } catch (e) {
      setPhotoError((p) => ({ ...p, [itemId]: e.response?.data?.error || 'Failed to remove photo' }));
    }
  };

  const handleRecategorize = async () => {
    setRecategorizing(true);
    try {
      const res = await api.post(`/procurement/requisitions/${id}/recategorize`);
      const reqRes = await api.get(`/procurement/requisitions/${id}`);
      setReq(reqRes.data);
      alert(`Categories refreshed: ${res.data.updated} of ${res.data.total} item(s) matched.`);
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to refresh categories');
    } finally {
      setRecategorizing(false);
    }
  };

  const toggleSupplier = (sid) => {
    setSelected((prev) =>
      prev.includes(sid) ? prev.filter((s) => s !== sid) : [...prev, sid]
    );
    setChannels((prev) => ({ ...prev, [sid]: prev[sid] || 'email' }));
  };

  const toggleItemSelected = (itemId) => {
    setSelectedItemIds((prev) =>
      prev.includes(itemId) ? prev.filter((i) => i !== itemId) : [...prev, itemId]
    );
  };

  const handleDispatch = async () => {
    if (!deadlineAt) return setError('Please set a quote deadline');
    if (selectedSuppliers.length === 0) return setError('Select at least one supplier');
    if (selectedItemIds.length === 0) return setError('Select at least one item to include in this RFQ');
    setSubmitting(true);
    setError('');
    try {
      await api.post('/procurement/rfq', {
        itemIds: selectedItemIds,
        deadlineAt,
        notes: rfqNotes,
        supplierIds: selectedSuppliers,
        channels,
      });
      const reqRes = await api.get(`/procurement/requisitions/${id}`);
      setReq(reqRes.data);
      setSelectedItemIds((reqRes.data.items || []).filter((it) => !it.RFQId).map((it) => it.RequisitionItemId));
      await loadRfqBatches(reqRes.data.items);
      setRfqOpen(false);
      setSelected([]);
      setChannels({});
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to dispatch RFQ');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResend = async (rfqId, dispatchId) => {
    try {
      await api.post(`/procurement/rfq/${rfqId}/resend`, { dispatchId });
      alert('Email re-sent successfully');
    } catch (e) {
      alert(e.response?.data?.error || 'Resend failed');
    }
  };

  // Edit the requested Qty and/or ItemName of an item already sent out
  // on an RFQ (e.g. a typo/wrong item was picked, or the qty was wrong),
  // then (separately, via the existing per-dispatch Resend button) notify
  // suppliers of the correction. Keyed by RequisitionItemId so only one
  // row is in edit mode at a time.
  const [editingQtyItemId, setEditingQtyItemId] = useState(null);
  const [editQtyValue, setEditQtyValue]         = useState('');
  const [editNameValue, setEditNameValue]       = useState('');
  const [editQtySaving, setEditQtySaving]       = useState(false);

  const openEditQty = (item) => {
    setEditingQtyItemId(item.RequisitionItemId);
    setEditQtyValue(String(item.Qty));
    setEditNameValue(item.ItemName);
  };

  const cancelEditQty = () => {
    setEditingQtyItemId(null);
    setEditQtyValue('');
    setEditNameValue('');
  };

  const saveEditQty = async (rfqId, itemId) => {
    const qty = parseFloat(editQtyValue);
    if (!Number.isFinite(qty) || qty <= 0) {
      return alert('Enter a valid positive quantity');
    }
    const itemName = editNameValue.trim();
    if (!itemName) {
      return alert('Item name cannot be blank');
    }
    setEditQtySaving(true);
    try {
      const res = await api.patch(`/procurement/rfq/${rfqId}/items/${itemId}`, { qty, itemName });
      const affected = res.data.affectedQuotations || [];
      setReq((prev) => ({
        ...prev,
        items: (prev.items || []).map((it) =>
          it.RequisitionItemId === itemId ? { ...it, Qty: qty, ItemName: itemName } : it
        ),
      }));
      cancelEditQty();
      if (affected.length > 0) {
        const names = affected.map((a) => a.SupplierName).join(', ');
        alert(
          `Item updated. ${affected.length} supplier${affected.length !== 1 ? 's' : ''} already quoted this item at the old details `
          + `(${names}) — their existing quote is still valid and visible to the Director, but consider using Resend below `
          + `to ask them to confirm pricing against the correction.`
        );
      }
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to update item');
    } finally {
      setEditQtySaving(false);
    }
  };

  // Same inline edit, but for an item NOT yet sent on any RFQ — goes
  // through the requisition endpoint (no suppliers to notify yet).
  const saveEditPendingItem = async (itemId) => {
    const qty = parseFloat(editQtyValue);
    if (!Number.isFinite(qty) || qty <= 0) {
      return alert('Enter a valid positive quantity');
    }
    const itemName = editNameValue.trim();
    if (!itemName) {
      return alert('Item name cannot be blank');
    }
    setEditQtySaving(true);
    try {
      const res = await api.patch(`/procurement/requisitions/${id}/items/${itemId}`, { qty, itemName });
      setReq((prev) => ({
        ...prev,
        items: (prev.items || []).map((it) =>
          it.RequisitionItemId === itemId ? { ...it, ...res.data } : it
        ),
      }));
      cancelEditQty();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to update item');
    } finally {
      setEditQtySaving(false);
    }
  };

  const openAddSupplier = (rfqId) => {
    const batchItemIds = (req.items || [])
      .filter((it) => it.RFQId === rfqId)
      .map((it) => it.RequisitionItemId);
    setAddSupplierRfqId(rfqId);
    setAddSupplierId('');
    setAddSupplierChannel('email');
    setAddSupplierItemIds(batchItemIds);
    setAddSupplierError('');
  };

  const closeAddSupplier = () => setAddSupplierRfqId(null);

  const toggleAddSupplierItem = (itemId) => {
    setAddSupplierItemIds((prev) =>
      prev.includes(itemId) ? prev.filter((i) => i !== itemId) : [...prev, itemId]
    );
  };

  const handleAddSupplier = async (directQuote) => {
    if (!addSupplierId) return setAddSupplierError('Select a supplier');
    if (addSupplierItemIds.length === 0) return setAddSupplierError('Select at least one item');
    setAddSupplierSubmitting(true);
    setAddSupplierError('');
    try {
      const batchItemIds = (req.items || [])
        .filter((it) => it.RFQId === addSupplierRfqId)
        .map((it) => it.RequisitionItemId);
      const res = await api.post(`/procurement/rfq/${addSupplierRfqId}/dispatch`, {
        supplierId: addSupplierId,
        channel: directQuote ? 'phone' : addSupplierChannel,
        itemIds: addSupplierItemIds.length < batchItemIds.length ? addSupplierItemIds : undefined,
      });
      if (directQuote) {
        navigate(`/procurement/quotations?rfqId=${addSupplierRfqId}&dispatchId=${res.data.dispatch.RFQDispatchId}`);
        return;
      }
      await loadRfqBatches(req.items);
      closeAddSupplier();
    } catch (e) {
      setAddSupplierError(e.response?.data?.error || 'Failed to add supplier');
    } finally {
      setAddSupplierSubmitting(false);
    }
  };

  if (loading) return <div className="page-container" style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading…</div>;
  if (!req) return <div className="page-container" style={{ padding: 40 }}>Requisition not found</div>;

  const availableItems = (req.items || []).filter((it) => !it.RFQId);
  const hasAvailableItems = availableItems.length > 0;
  const canEditPending = isProcurement && hasAvailableItems
    && !['Cancelled', 'Reconciled'].includes(req.Status);

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1a73e8', fontSize: 14, marginBottom: 4 }}
            onClick={() => navigate('/procurement/requisitions')}>
            ← Back to Requisitions
          </button>
          <h1 className="page-title">{req.BusyOrdNo}</h1>
          <p className="page-subtitle">
            {req.BusyDate ? new Date(req.BusyDate).toLocaleDateString('en-KE') : ''} &nbsp;·&nbsp;
            {req.MatCenter || req.Warehouse || 'No centre'}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className={`badge ${STATUS_COLOR[req.Status] || 'badge-gray'}`} style={{ fontSize: 14 }}>
            {req.Status}
          </span>
          {req.Status !== 'Cancelled' && req.Status !== 'Reconciled' && (
            <button className="btn btn-secondary btn-sm"
              onClick={async () => {
                if (window.confirm('Cancel this requisition?')) {
                  await api.patch(`/procurement/requisitions/${id}/cancel`);
                  setReq((r) => ({ ...r, Status: 'Cancelled' }));
                }
              }}>
              Cancel
            </button>
          )}
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

      {/* Whole picture before the RFQ goes out (2026-10-17) */}
      <StockPicture
        title="Stock picture before dispatching to suppliers (live from Busy)"
        items={(req.items || []).map((it) => ({ name: it.ItemCode || it.ItemName, requestedQty: it.Qty }))}
      />
      <div style={{ margin: '-4px 0 16px', fontSize: 13 }}>
        <a href={`/procurement/trace/${req.RequisitionId}`} onClick={(e) => { e.preventDefault(); navigate(`/procurement/trace/${req.RequisitionId}`); }}>
          Trace this requisition end to end →
        </a>
      </div>

      {/* Items */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Items from Busy PurIndents</h3>
          {isProcurement && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleRecategorize}
              disabled={recategorizing}
              title="Re-apply current category mappings to all items"
            >
              {recategorizing ? 'Refreshing…' : '↺ Refresh Categories'}
            </button>
          )}
        </div>
        <table className="data-table">
          <thead>
            <tr>
              {rfqOpen && <th style={{ width: 32 }}></th>}
              <th>Item Name</th>
              <th>Qty</th>
              <th>Category</th>
              <th>Preferred Brand / Quality</th>
              <th>Indicative Price</th>
              <th>Indicative Amt</th>
              <th>RFQ Status</th>
              {isProcurement && <th>Reference Photo</th>}
              {canEditPending && <th></th>}
            </tr>
          </thead>
          <tbody>
            {(req.items || []).map((item) => {
              const isLinked = !!item.RFQId;
              const isEditing = !isLinked && editingQtyItemId === item.RequisitionItemId;
              return (
                <tr key={item.RequisitionItemId} style={isLinked && rfqOpen ? { opacity: 0.5 } : undefined}>
                  {rfqOpen && (
                    <td>
                      <input type="checkbox"
                        checked={selectedItemIds.includes(item.RequisitionItemId)}
                        disabled={isLinked}
                        onChange={() => toggleItemSelected(item.RequisitionItemId)}
                        title={isLinked ? `Already in ${item.RFQNumber}` : 'Include in this RFQ'} />
                    </td>
                  )}
                  <td>
                    {isEditing ? (
                      <input type="text" className="form-input"
                        style={{ minWidth: 220, padding: '2px 8px' }}
                        value={editNameValue}
                        onChange={(e) => setEditNameValue(e.target.value)} />
                    ) : (
                      item.ItemName
                    )}
                  </td>
                  <td>
                    {isEditing ? (
                      <input type="number" min="0.01" step="0.01" className="form-input"
                        style={{ width: 100, padding: '2px 8px' }}
                        value={editQtyValue}
                        onChange={(e) => setEditQtyValue(e.target.value)}
                        autoFocus />
                    ) : (
                      `${Number(item.Qty).toLocaleString()}${item.Unit ? ` ${item.Unit}` : ''}`
                    )}
                  </td>
                  <td>
                    {item.Category
                      ? <span className="badge badge-blue" style={{ fontSize: 11 }}>{item.Category}</span>
                      : <span style={{ color: '#f59e0b', fontSize: 12 }}>⚠ No category mapped</span>
                    }
                  </td>
                  <td style={{ fontSize: 12.5 }}>
                    {[item.PreferredBrand, item.PreferredQuality].filter(Boolean).join(' · ') || <span style={{ color: '#9ca3af' }}>—</span>}
                  </td>
                  <td>{item.BusyPrice ? `KES ${Number(item.BusyPrice).toLocaleString()}` : '—'}</td>
                  <td>{item.BusyAmt  ? `KES ${Number(item.BusyAmt).toLocaleString()}`  : '—'}</td>
                  <td>
                    {isLinked
                      ? <span className="badge badge-blue" style={{ fontSize: 11 }}>{item.RFQNumber}</span>
                      : <span className="badge badge-gray" style={{ fontSize: 11 }}>Not yet sent</span>}
                  </td>
                  {isProcurement && (
                    <td>
                      <ItemPhotoCell
                        photoUrl={item.ReferencePhotoUrl}
                        uploading={!!photoUploading[item.RequisitionItemId]}
                        error={photoError[item.RequisitionItemId]}
                        onSelect={(file) => handleItemPhotoSelect(item.RequisitionItemId, file)}
                        onRemove={() => handleItemPhotoRemove(item.RequisitionItemId)}
                      />
                    </td>
                  )}
                  {canEditPending && (
                    <td>
                      {isLinked ? null : isEditing ? (
                        <>
                          <button className="btn btn-primary" style={{ padding: '3px 10px', fontSize: 12, marginRight: 6 }}
                            disabled={editQtySaving}
                            onClick={() => saveEditPendingItem(item.RequisitionItemId)}>
                            {editQtySaving ? 'Saving…' : 'Save'}
                          </button>
                          <button className="btn btn-secondary" style={{ padding: '3px 10px', fontSize: 12 }}
                            disabled={editQtySaving}
                            onClick={cancelEditQty}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button className="btn btn-secondary" style={{ padding: '3px 10px', fontSize: 12 }}
                          title="Correct the item or quantity before sending it to suppliers"
                          onClick={() => openEditQty(item)}>
                          Edit
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Issue a new RFQ — for whichever items aren't yet committed to one.
          A requisition can have some items already sent (see badges in
          the Items table above) while these remain, e.g. after a partial
          "Feed Quote" or an earlier RFQ that didn't cover everything. */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Request for Quotation</h3>
          {!rfqOpen && (
            <div style={{ fontSize: 13, color: '#6b7280' }}>
              {hasAvailableItems
                ? `${availableItems.length} item${availableItems.length !== 1 ? 's' : ''} not yet sent`
                : 'Every item is already in an RFQ'}
            </div>
          )}
        </div>

        {hasAvailableItems && isProcurement && !rfqOpen && (
          <div>
            {availableItems.some((i) => !i.Category) && (
              <div className="alert alert-warning" style={{ marginBottom: 14 }}>
                Some items have no category mapping — matching suppliers may be incomplete.
                <a href="/admin/item-categories" style={{ marginLeft: 8, color: '#1a73e8' }}>
                  Manage mappings →
                </a>
              </div>
            )}
            <button className="btn btn-primary" onClick={() => setRfqOpen(true)}>
              Issue RFQ & Dispatch to Suppliers
            </button>
          </div>
        )}

        {rfqOpen && (
          <div style={{ maxWidth: 640 }}>
            <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
              Check/uncheck items in the table above to choose exactly what goes in this RFQ —
              {' '}{selectedItemIds.length} of {availableItems.length} available item{availableItems.length !== 1 ? 's' : ''} selected.
              Anything left unchecked stays available for a separate RFQ later.
            </p>
            <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
              <div className="form-group" style={{ flex: 1, minWidth: 180 }}>
                <label className="form-label">Quote Deadline *</label>
                <input type="datetime-local" className="form-input" value={deadlineAt}
                  onChange={(e) => setDeadlineAt(e.target.value)} />
              </div>
              <div className="form-group" style={{ flex: 2, minWidth: 240 }}>
                <label className="form-label">Notes to suppliers</label>
                <input className="form-input" value={rfqNotes}
                  onChange={(e) => setRfqNotes(e.target.value)}
                  placeholder="e.g. Delivery to main store required" />
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                Matching Suppliers ({matchingSuppliers.length})
              </div>
              {matchingSuppliers.length === 0 && (
                <p style={{ color: '#f59e0b', fontSize: 13 }}>
                  No suppliers matched by category. Add categories to suppliers first.
                </p>
              )}
              {matchingSuppliers.map((s) => (
                <div key={s.SupplierId}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '8px 12px', border: '1px solid #e5e7eb',
                    borderRadius: 6, marginBottom: 6,
                    background: selectedSuppliers.includes(s.SupplierId) ? '#e8f0fe' : '#fff',
                  }}>
                  <input type="checkbox" checked={selectedSuppliers.includes(s.SupplierId)}
                    onChange={() => toggleSupplier(s.SupplierId)} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{s.SupplierName}</div>
                    <div style={{ fontSize: 11, color: '#6b7280' }}>
                      {s.SupplierCategories} &nbsp;·&nbsp; {s.Email || 'No email'} &nbsp;·&nbsp; {s.Phone || s.WhatsApp || ''}
                    </div>
                  </div>
                  {selectedSuppliers.includes(s.SupplierId) && (
                    <select className="form-input" style={{ width: 120, padding: '4px 8px', fontSize: 12 }}
                      value={channels[s.SupplierId] || 'email'}
                      onChange={(e) => setChannels((prev) => ({ ...prev, [s.SupplierId]: e.target.value }))}>
                      <option value="email">Email</option>
                      <option value="whatsapp">WhatsApp</option>
                      <option value="phone">Phone</option>
                    </select>
                  )}
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={handleDispatch} disabled={submitting}>
                {submitting ? 'Dispatching…' : `Dispatch RFQ (${selectedItemIds.length} item${selectedItemIds.length !== 1 ? 's' : ''}) to ${selectedSuppliers.length} supplier(s)`}
              </button>
              <button className="btn btn-secondary" onClick={() => {
                setRfqOpen(false); setError('');
                setSelectedItemIds(availableItems.map((it) => it.RequisitionItemId));
              }}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Past/active RFQ batches — a requisition can now span more than
          one, each with its own dispatch log and evaluation. */}
      {rfqBatches.map((batch) => {
        const batchItems = (req.items || []).filter((it) => it.RFQId === batch.RFQId);
        const dispatchedSupplierIds = new Set((batch.dispatches || []).map((d) => d.SupplierId));
        const addableSuppliers = matchingSuppliers.filter((s) => !dispatchedSupplierIds.has(s.SupplierId));
        const addPanelOpen = addSupplierRfqId === batch.RFQId;

        return (
          <div key={batch.RFQId} className="card" style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>RFQ — {batch.RFQNumber}</h3>
              <div style={{ fontSize: 13, color: '#6b7280' }}>
                Issued {batch.IssuedAt ? new Date(batch.IssuedAt).toLocaleDateString('en-KE') : '—'}
                {batch.DeadlineAt && ` · Deadline ${new Date(batch.DeadlineAt).toLocaleDateString('en-KE')}`}
              </div>
            </div>

            {/* Requested items on this RFQ — Procurement can correct the
                qty here (e.g. the original ask was wrong) before award.
                Existing quotes that already priced an edited item are
                automatically withdrawn server-side; use Resend below on
                the affected suppliers to collect fresh pricing. */}
            <table className="data-table" style={{ marginBottom: 14 }}>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Qty Requested</th>
                  <th>Preferred Brand / Quality</th>
                  {isProcurement && <th></th>}
                </tr>
              </thead>
              <tbody>
                {batchItems.map((item) => (
                  <tr key={item.RequisitionItemId}>
                    <td>
                      {editingQtyItemId === item.RequisitionItemId ? (
                        <input type="text" className="form-input"
                          style={{ minWidth: 220, padding: '2px 8px' }}
                          value={editNameValue}
                          onChange={(e) => setEditNameValue(e.target.value)} />
                      ) : (
                        item.ItemName
                      )}
                    </td>
                    <td>
                      {editingQtyItemId === item.RequisitionItemId ? (
                        <input type="number" min="0.01" step="0.01" className="form-input"
                          style={{ width: 100, padding: '2px 8px' }}
                          value={editQtyValue}
                          onChange={(e) => setEditQtyValue(e.target.value)}
                          autoFocus />
                      ) : (
                        `${Number(item.Qty).toLocaleString()}${item.Unit ? ` ${item.Unit}` : ''}`
                      )}
                    </td>
                    <td style={{ fontSize: 12.5 }}>
                      {[item.PreferredBrand, item.PreferredQuality].filter(Boolean).join(' · ') || <span style={{ color: '#9ca3af' }}>—</span>}
                    </td>
                    {isProcurement && (
                      <td>
                        {editingQtyItemId === item.RequisitionItemId ? (
                          <>
                            <button className="btn btn-primary" style={{ padding: '3px 10px', fontSize: 12, marginRight: 6 }}
                              disabled={editQtySaving}
                              onClick={() => saveEditQty(batch.RFQId, item.RequisitionItemId)}>
                              {editQtySaving ? 'Saving…' : 'Save'}
                            </button>
                            <button className="btn btn-secondary" style={{ padding: '3px 10px', fontSize: 12 }}
                              disabled={editQtySaving}
                              onClick={cancelEditQty}>
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button className="btn btn-secondary" style={{ padding: '3px 10px', fontSize: 12 }}
                            onClick={() => openEditQty(item)}>
                            Edit
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>

            <table className="data-table" style={{ marginBottom: 14 }}>
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th>Channel</th>
                  <th>Sent At</th>
                  <th>Token Expires</th>
                  <th>Quote Received</th>
                  <th>Amount</th>
                  {isProcurement && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {(batch.dispatches || []).map((d) => (
                  <tr key={d.RFQDispatchId}>
                    <td>{d.SupplierName}</td>
                    <td><span className="badge badge-gray">{d.Channel}</span></td>
                    <td>{d.SentAt ? new Date(d.SentAt).toLocaleString('en-KE') : '—'}</td>
                    <td>{d.TokenExpiresAt ? new Date(d.TokenExpiresAt).toLocaleDateString('en-KE') : '—'}</td>
                    <td>{d.QuotationId ? <span className="badge badge-green">Yes</span> : <span style={{ color: '#9ca3af' }}>Pending</span>}</td>
                    <td>{d.TotalAmount ? `KES ${Number(d.TotalAmount).toLocaleString()}` : '—'}</td>
                    {isProcurement && (
                      <td>
                        {d.Channel === 'email' && d.Email && (
                          <button className="btn btn-secondary" style={{ padding: '3px 10px', fontSize: 12 }}
                            onClick={() => handleResend(batch.RFQId, d.RFQDispatchId)}>
                            Resend
                          </button>
                        )}
                        {!d.QuotationId ? (
                          <button className="btn btn-secondary" style={{ padding: '3px 10px', fontSize: 12, marginLeft: 4 }}
                            onClick={() => navigate(`/procurement/quotations?rfqId=${batch.RFQId}&dispatchId=${d.RFQDispatchId}`)}>
                            Enter Quote
                          </button>
                        ) : (
                          <button className="btn btn-secondary" style={{ padding: '3px 10px', fontSize: 12, marginLeft: 4 }}
                            title="Amend the price if the supplier negotiates a discount"
                            onClick={() => navigate(`/procurement/quotations?rfqId=${batch.RFQId}&dispatchId=${d.RFQDispatchId}&quotationId=${d.QuotationId}`)}>
                            Edit Quote
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ display: 'flex', gap: 12, marginBottom: isProcurement ? 14 : 0 }}>
              <button className="btn btn-primary btn-sm"
                onClick={() => navigate(`/director/evaluation?rfqId=${batch.RFQId}`)}>
                View Quotation Comparison →
              </button>
            </div>

            {isProcurement && (
              <div style={{ paddingTop: 14, borderTop: '1px solid #e5e7eb' }}>
                {!addPanelOpen && (
                  <button className="btn btn-secondary btn-sm" onClick={() => openAddSupplier(batch.RFQId)}>
                    + Add Supplier to this RFQ
                  </button>
                )}

                {addPanelOpen && (
                  <div style={{ maxWidth: 640 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
                      Add a supplier to {batch.RFQNumber}
                    </div>
                    {addSupplierError && (
                      <div className="alert alert-error" style={{ marginBottom: 10 }}>{addSupplierError}</div>
                    )}

                    <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
                      <div className="form-group" style={{ flex: 1, minWidth: 220 }}>
                        <label className="form-label">Supplier</label>
                        <select className="form-input" value={addSupplierId}
                          onChange={(e) => setAddSupplierId(e.target.value)}>
                          <option value="">
                            {addableSuppliers.length === 0 ? 'No more matching suppliers' : 'Select a supplier…'}
                          </option>
                          {addableSuppliers.map((s) => (
                            <option key={s.SupplierId} value={s.SupplierId}>{s.SupplierName}</option>
                          ))}
                        </select>
                      </div>
                      <div className="form-group" style={{ width: 140 }}>
                        <label className="form-label">Channel</label>
                        <select className="form-input" value={addSupplierChannel}
                          onChange={(e) => setAddSupplierChannel(e.target.value)}>
                          <option value="email">Email</option>
                          <option value="whatsapp">WhatsApp</option>
                          <option value="phone">Phone</option>
                        </select>
                      </div>
                    </div>

                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>
                        Items to ask this supplier about ({addSupplierItemIds.length}/{batchItems.length})
                      </div>
                      <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 6 }}>
                        {batchItems.map((item) => (
                          <label key={item.RequisitionItemId}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8,
                              padding: '6px 10px', fontSize: 12.5, cursor: 'pointer',
                              borderBottom: '1px solid #f3f4f6',
                            }}>
                            <input type="checkbox"
                              checked={addSupplierItemIds.includes(item.RequisitionItemId)}
                              onChange={() => toggleAddSupplierItem(item.RequisitionItemId)} />
                            <span>
                              {item.ItemName}
                              <span style={{ color: '#9ca3af', marginLeft: 6 }}>
                                (Qty {Number(item.Qty).toLocaleString()}{item.Unit ? ` ${item.Unit}` : ''})
                              </span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-primary btn-sm" disabled={addSupplierSubmitting}
                        onClick={() => handleAddSupplier(false)}>
                        {addSupplierSubmitting ? 'Sending…' : 'Dispatch to Supplier'}
                      </button>
                      <button className="btn btn-secondary btn-sm" disabled={addSupplierSubmitting}
                        onClick={() => handleAddSupplier(true)}
                        title="Skip dispatch — go straight to entering a quote you already have from this supplier">
                        {addSupplierSubmitting ? 'Working…' : 'Feed Quote Directly →'}
                      </button>
                      <button className="btn btn-secondary btn-sm" disabled={addSupplierSubmitting} onClick={closeAddSupplier}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Reference photo cell for the Items table — procurement can attach a
// photo (sample, packaging, spec sheet) so suppliers know exactly what's
// being requested. Shown as a thumbnail once uploaded; upload/remove
// controls stay visible so it can be swapped at any time.
function ItemPhotoCell({ photoUrl, uploading, error, onSelect, onRemove }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
      {photoUrl && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <a href={photoUrl} target="_blank" rel="noopener noreferrer">
            <img src={photoUrl} alt="Item reference" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 4, border: '1px solid #e5e7eb' }} />
          </a>
          <button type="button" className="btn btn-secondary" style={{ padding: '2px 6px', fontSize: 11 }} onClick={onRemove}>
            Remove
          </button>
        </div>
      )}
      {!photoUrl && (
        <label style={{ fontSize: 12, color: '#1a73e8', cursor: 'pointer' }}>
          {uploading ? 'Uploading…' : '+ Attach photo'}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            style={{ display: 'none' }}
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              onSelect(file);
              e.target.value = '';
            }}
          />
        </label>
      )}
      {error && <div style={{ fontSize: 11, color: '#dc2626' }}>{error}</div>}
    </div>
  );
}
