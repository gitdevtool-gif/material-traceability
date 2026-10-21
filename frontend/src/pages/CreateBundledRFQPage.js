import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../services/api';
import StockPicture from '../components/StockPicture';

/**
 * Combined-RFQ dispatch page.
 * Reached from RequisitionsPage after selecting several requisitions
 * (any factory/warehouse) via checkboxes — bundles them into one RFQ,
 * per migration 016 / Requisitions.RFQId. Mirrors the dispatch section
 * of RequisitionDetailPage, but across N requisitions instead of one.
 *
 * Per-supplier item assignment (2026-08-18): each selected supplier
 * defaults to seeing every item across the bundled requisitions — same
 * as before this feature existed. Expanding "Customize items" for a
 * supplier reveals a checklist (all checked by default) so procurement
 * can narrow what that specific supplier is asked to quote on, e.g.
 * when only some suppliers stock some of the items. Only suppliers
 * whose selection ends up SMALLER than the full item set are sent as
 * `supplierItems` in the dispatch request — an untouched supplier still
 * means "no restriction" on the backend (dbo.RFQDispatchItems stays
 * empty for them), which is what keeps this backward compatible.
 */
export default function CreateBundledRFQPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const ids = [...new Set(
    (searchParams.get('ids') || '').split(',').map((v) => parseInt(v, 10)).filter((n) => !isNaN(n))
  )];

  const [requisitions, setRequisitions]   = useState([]);
  const [matchingSuppliers, setSuppliers] = useState([]);
  const [loading, setLoading]             = useState(true);
  const [loadError, setLoadError]         = useState('');

  const [deadlineAt, setDeadlineAt]       = useState('');
  const [notes, setNotes]                 = useState('');
  const [selectedSuppliers, setSelected]  = useState([]);
  const [channels, setChannels]           = useState({});
  const [submitting, setSubmitting]       = useState(false);
  const [error, setError]                 = useState('');

  // Per-supplier item customization. supplierItemSelections[sid] is only
  // populated once procurement actually opens/edits that supplier's item
  // picker — until then, "no entry" implicitly means "all items", which
  // is exactly how it's treated both here and on the backend.
  const [supplierItemSelections, setSupplierItemSelections] = useState({}); // { [sid]: number[] of RequisitionItemId }
  const [expandedItems, setExpandedItems] = useState({}); // { [sid]: boolean }

  const [photoUploading, setPhotoUploading] = useState({}); // { [itemId]: bool }
  const [photoError, setPhotoError]         = useState({}); // { [itemId]: string }

  const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

  const handleItemPhotoSelect = async (requisitionId, itemId, file) => {
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
      const res = await api.post(`/procurement/requisitions/${requisitionId}/items/${itemId}/photo`, formData);
      setRequisitions((prev) => prev.map((r) => (
        r.RequisitionId !== requisitionId ? r : {
          ...r,
          items: (r.items || []).map((it) =>
            it.RequisitionItemId === itemId ? { ...it, ReferencePhotoUrl: res.data.photoUrl } : it
          ),
        }
      )));
    } catch (e) {
      setPhotoError((p) => ({ ...p, [itemId]: e.response?.data?.error || 'Upload failed' }));
    } finally {
      setPhotoUploading((p) => ({ ...p, [itemId]: false }));
    }
  };

  const handleItemPhotoRemove = async (requisitionId, itemId) => {
    try {
      await api.delete(`/procurement/requisitions/${requisitionId}/items/${itemId}/photo`);
      setRequisitions((prev) => prev.map((r) => (
        r.RequisitionId !== requisitionId ? r : {
          ...r,
          items: (r.items || []).map((it) =>
            it.RequisitionItemId === itemId ? { ...it, ReferencePhotoUrl: null } : it
          ),
        }
      )));
    } catch (e) {
      setPhotoError((p) => ({ ...p, [itemId]: e.response?.data?.error || 'Failed to remove photo' }));
    }
  };

  useEffect(() => {
    if (ids.length === 0) {
      setLoadError('No requisitions selected. Go back and select at least one.');
      setLoading(false);
      return;
    }
    const loadAll = async () => {
      setLoading(true);
      setLoadError('');
      try {
        const [reqResults, suppRes] = await Promise.all([
          Promise.all(ids.map((id) => api.get(`/procurement/requisitions/${id}`))),
          api.get('/procurement/requisitions/matching-suppliers', { params: { ids: ids.join(',') } }),
        ]);
        setRequisitions(reqResults.map((r) => r.data));
        setSuppliers(suppRes.data);
      } catch (e) {
        setLoadError(e.response?.data?.error || 'Failed to load selected requisitions');
      } finally {
        setLoading(false);
      }
    };
    loadAll();
  }, [searchParams]);

  const toggleSupplier = (sid) => {
    const isRemoving = selectedSuppliers.includes(sid);
    setSelected((prev) =>
      isRemoving ? prev.filter((s) => s !== sid) : [...prev, sid]
    );
    setChannels((prev) => ({ ...prev, [sid]: prev[sid] || 'email' }));
    if (isRemoving) {
      // Drop any item customization + collapse state when the supplier
      // is deselected entirely, so re-adding them later starts fresh.
      setSupplierItemSelections((prev) => {
        const next = { ...prev };
        delete next[sid];
        return next;
      });
      setExpandedItems((prev) => ({ ...prev, [sid]: false }));
    }
  };

  // Only items not yet committed to an earlier RFQ are eligible here —
  // per-item RFQ linkage (2026-08-25) lets a requisition split across
  // several RFQs, so anything already sent stays off this bundle.
  const allItemsRaw = requisitions.flatMap((r) => (r.items || []).map((i) => ({ ...i, BusyOrdNo: r.BusyOrdNo })));
  const allItems = allItemsRaw.filter((i) => !i.RFQId);
  const alreadySentCount = allItemsRaw.length - allItems.length;
  const allItemIds = allItems.map((i) => i.RequisitionItemId);
  const anyMissingCategory = allItems.some((i) => !i.Category);

  // Current selection for a supplier — defaults to every item until
  // procurement customizes it.
  const itemsForSupplier = (sid) => supplierItemSelections[sid] || allItemIds;

  const toggleItemForSupplier = (sid, itemId) => {
    setSupplierItemSelections((prev) => {
      const current = new Set(prev[sid] || allItemIds);
      if (current.has(itemId)) current.delete(itemId);
      else current.add(itemId);
      return { ...prev, [sid]: [...current] };
    });
  };

  const selectAllItemsForSupplier = (sid) =>
    setSupplierItemSelections((prev) => ({ ...prev, [sid]: [...allItemIds] }));

  const selectNoItemsForSupplier = (sid) =>
    setSupplierItemSelections((prev) => ({ ...prev, [sid]: [] }));

  const toggleExpanded = (sid) =>
    setExpandedItems((prev) => ({ ...prev, [sid]: !prev[sid] }));

  const handleDispatch = async () => {
    if (!deadlineAt) return setError('Please set a quote deadline');
    if (selectedSuppliers.length === 0) return setError('Select at least one supplier');

    // Build the per-supplier restriction payload — only suppliers whose
    // selection is smaller than the full item set get sent, so anyone
    // procurement didn't touch stays fully unrestricted on the backend.
    const supplierItems = {};
    for (const sid of selectedSuppliers) {
      const sel = itemsForSupplier(sid);
      if (sel.length === 0) {
        const supplierName = matchingSuppliers.find((s) => s.SupplierId === sid)?.SupplierName || `Supplier #${sid}`;
        return setError(`${supplierName} has no items selected — either assign at least one item or remove them from this RFQ.`);
      }
      if (sel.length < allItemIds.length) {
        supplierItems[sid] = sel;
      }
    }

    setSubmitting(true);
    setError('');
    try {
      const res = await api.post('/procurement/rfq', {
        requisitionIds: ids,
        deadlineAt,
        notes,
        supplierIds: selectedSuppliers,
        channels,
        supplierItems,
      });
      navigate(`/procurement/requisitions/${ids[0]}`, {
        state: { justCreatedRfqId: res.data?.rfq?.RFQId },
      });
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to dispatch combined RFQ');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="page-container" style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading…</div>;
  }
  if (loadError) {
    return (
      <div className="page-container">
        <div className="alert alert-error">{loadError}</div>
        <button className="btn btn-secondary" style={{ marginTop: 16 }} onClick={() => navigate('/procurement/requisitions')}>
          ← Back to Requisitions
        </button>
      </div>
    );
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1a73e8', fontSize: 14, marginBottom: 4 }}
            onClick={() => navigate('/procurement/requisitions')}>
            ← Back to Requisitions
          </button>
          <h1 className="page-title">Create Combined RFQ</h1>
          <p className="page-subtitle">
            Bundling {requisitions.length} requisition{requisitions.length !== 1 ? 's' : ''}: {requisitions.map((r) => r.BusyOrdNo).join(', ')}
          </p>
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

      {/* Requisitions being bundled */}
      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 15 }}>Requisitions in this RFQ</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>Busy Ord No</th>
              <th>Date</th>
              <th>Warehouse</th>
              <th>Mat Centre</th>
              <th>Items</th>
            </tr>
          </thead>
          <tbody>
            {requisitions.map((r) => (
              <tr key={r.RequisitionId}>
                <td><strong>{r.BusyOrdNo}</strong></td>
                <td>{r.BusyDate ? new Date(r.BusyDate).toLocaleDateString('en-KE') : '—'}</td>
                <td>{r.Warehouse || '—'}</td>
                <td>{r.MatCenter || '—'}</td>
                <td style={{ textAlign: 'center' }}>
                  {(r.items || []).filter((i) => !i.RFQId).length}
                  {(r.items || []).some((i) => i.RFQId) && (
                    <span style={{ color: '#9ca3af', fontSize: 11 }}> / {(r.items || []).length} total</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Whole picture before the RFQ goes out (2026-10-17) */}
      <StockPicture
        title="Stock picture before dispatching to suppliers (live from Busy)"
        items={allItems.map((it) => ({ name: it.ItemCode || it.ItemName, requestedQty: it.Qty }))}
      />

      {/* Combined items */}
      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 15 }}>All Items ({allItems.length})</h3>
        {alreadySentCount > 0 && (
          <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
            {alreadySentCount} item{alreadySentCount !== 1 ? 's are' : ' is'} already part of an earlier RFQ and
            {alreadySentCount !== 1 ? " aren't" : " isn't"} included here.
          </p>
        )}
        <table className="data-table">
          <thead>
            <tr>
              <th>Busy Ord No</th>
              <th>Item Name</th>
              <th>Qty</th>
              <th>Category</th>
              <th>Reference Photo</th>
            </tr>
          </thead>
          <tbody>
            {allItems.map((item) => (
              <tr key={item.RequisitionItemId}>
                <td style={{ fontSize: 12, color: '#6b7280' }}>{item.BusyOrdNo}</td>
                <td>{item.ItemName}</td>
                <td>{Number(item.Qty).toLocaleString()}</td>
                <td>
                  {item.Category
                    ? <span className="badge badge-blue" style={{ fontSize: 11 }}>{item.Category}</span>
                    : <span style={{ color: '#f59e0b', fontSize: 12 }}>⚠ No category mapped</span>
                  }
                </td>
                <td>
                  <ItemPhotoCell
                    photoUrl={item.ReferencePhotoUrl}
                    uploading={!!photoUploading[item.RequisitionItemId]}
                    error={photoError[item.RequisitionItemId]}
                    onSelect={(file) => handleItemPhotoSelect(item.RequisitionId, item.RequisitionItemId, file)}
                    onRemove={() => handleItemPhotoRemove(item.RequisitionId, item.RequisitionItemId)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Dispatch form */}
      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 15 }}>Request for Quotation</h3>

        {anyMissingCategory && (
          <div className="alert alert-warning" style={{ marginBottom: 14 }}>
            Some items have no category mapping — matching suppliers may be incomplete.
            <a href="/admin/item-categories" style={{ marginLeft: 8, color: '#1a73e8' }}>
              Manage mappings →
            </a>
          </div>
        )}

        <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
          <div className="form-group" style={{ flex: 1, minWidth: 180 }}>
            <label className="form-label">Quote Deadline *</label>
            <input type="datetime-local" className="form-input" value={deadlineAt}
              onChange={(e) => setDeadlineAt(e.target.value)} />
          </div>
          <div className="form-group" style={{ flex: 2, minWidth: 240 }}>
            <label className="form-label">Notes to suppliers</label>
            <input className="form-input" value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Delivery to main store required" />
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
            Matching Suppliers ({matchingSuppliers.length})
          </div>
          {matchingSuppliers.length === 0 && (
            <p style={{ color: '#f59e0b', fontSize: 13 }}>
              No suppliers matched by category across these requisitions. Add categories to suppliers first.
            </p>
          )}
          {matchingSuppliers.map((s) => {
            const isSelected = selectedSuppliers.includes(s.SupplierId);
            const selectedItemIds = itemsForSupplier(s.SupplierId);
            const isRestricted = isSelected && selectedItemIds.length < allItemIds.length;
            const isExpanded = !!expandedItems[s.SupplierId];

            return (
              <div key={s.SupplierId}
                style={{
                  border: '1px solid #e5e7eb', borderRadius: 6, marginBottom: 6,
                  background: isSelected ? '#e8f0fe' : '#fff', overflow: 'hidden',
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px' }}>
                  <input type="checkbox" checked={isSelected}
                    onChange={() => toggleSupplier(s.SupplierId)} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{s.SupplierName}</div>
                    <div style={{ fontSize: 11, color: '#6b7280' }}>
                      {s.SupplierCategories} &nbsp;·&nbsp; {s.Email || 'No email'} &nbsp;·&nbsp; {s.Phone || s.WhatsApp || ''}
                    </div>
                  </div>
                  {isSelected && (
                    <>
                      <button type="button" className="btn btn-secondary btn-sm"
                        onClick={() => toggleExpanded(s.SupplierId)}>
                        {isRestricted
                          ? `Items: ${selectedItemIds.length}/${allItemIds.length}`
                          : 'All items'} {isExpanded ? '▲' : '▼'}
                      </button>
                      <select className="form-input" style={{ width: 120, padding: '4px 8px', fontSize: 12 }}
                        value={channels[s.SupplierId] || 'email'}
                        onChange={(e) => setChannels((prev) => ({ ...prev, [s.SupplierId]: e.target.value }))}>
                        <option value="email">Email</option>
                        <option value="whatsapp">WhatsApp</option>
                        <option value="phone">Phone</option>
                      </select>
                    </>
                  )}
                </div>

                {isSelected && isExpanded && (
                  <div style={{ background: '#fff', borderTop: '1px solid #e5e7eb', padding: '10px 14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 12, color: '#6b7280' }}>
                        Only checked items will be visible to <strong>{s.SupplierName}</strong> on their quote link.
                      </span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button type="button" className="btn btn-secondary btn-sm"
                          onClick={() => selectAllItemsForSupplier(s.SupplierId)}>Select all</button>
                        <button type="button" className="btn btn-secondary btn-sm"
                          onClick={() => selectNoItemsForSupplier(s.SupplierId)}>Clear</button>
                      </div>
                    </div>
                    <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 6 }}>
                      {allItems.map((item) => (
                        <label key={item.RequisitionItemId}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '6px 10px', fontSize: 12.5, cursor: 'pointer',
                            borderBottom: '1px solid #f3f4f6',
                          }}>
                          <input
                            type="checkbox"
                            checked={selectedItemIds.includes(item.RequisitionItemId)}
                            onChange={() => toggleItemForSupplier(s.SupplierId, item.RequisitionItemId)}
                          />
                          <span style={{ flex: 1 }}>
                            {item.ItemName}
                            <span style={{ color: '#9ca3af', marginLeft: 6 }}>
                              ({item.BusyOrdNo} · Qty {Number(item.Qty).toLocaleString()})
                            </span>
                          </span>
                          {item.Category && (
                            <span className="badge badge-blue" style={{ fontSize: 10 }}>{item.Category}</span>
                          )}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {allItems.length === 0 ? (
          <div className="alert alert-warning">
            Every item on the selected requisition(s) is already part of an earlier RFQ — nothing left to bundle here.
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-primary" onClick={handleDispatch} disabled={submitting}>
              {submitting ? 'Dispatching…' : `Dispatch Combined RFQ to ${selectedSuppliers.length} supplier(s)`}
            </button>
            <button className="btn btn-secondary" onClick={() => navigate('/procurement/requisitions')}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Reference photo cell shared with RequisitionDetailPage's Items table —
// procurement can attach a photo (sample, packaging, spec sheet) per item
// so suppliers know exactly what's being requested.
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
