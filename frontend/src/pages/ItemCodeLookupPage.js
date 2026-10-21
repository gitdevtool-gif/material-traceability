import React, { useEffect, useState } from 'react';
import api from '../services/api';

// Splits one pasted row into [name, code, category] regardless of whether
// it was copied from Excel (tab-separated) or pasted as CSV (comma-separated).
function splitRow(line) {
  const cells = line.includes('\t') ? line.split('\t') : line.split(',');
  return cells.map((c) => c.trim());
}

export default function ItemCodeLookupPage() {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');

  // Single add/edit form
  const [editId, setEditId]     = useState(null);
  const [itemCode, setItemCode] = useState('');
  const [itemName, setItemName] = useState('');
  const [category, setCategory] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving]     = useState(false);

  // Bulk paste
  const [bulkOpen, setBulkOpen]   = useState(false);
  const [bulkText, setBulkText]   = useState('');
  const [bulkBusy, setBulkBusy]   = useState(false);
  const [bulkResult, setBulkResult] = useState(null);

  const load = () => {
    setLoading(true);
    api.get('/procurement/item-code-lookup')
      .then((res) => setRows(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const resetForm = () => {
    setEditId(null);
    setItemCode('');
    setItemName('');
    setCategory('');
    setError('');
    setSuccess('');
  };

  const openNew = () => { resetForm(); setFormOpen(true); };

  const openEdit = (row) => {
    setEditId(row.ItemCodeLookupId);
    setItemCode(row.ItemCode);
    setItemName(row.ItemName);
    setCategory(row.Category || '');
    setError('');
    setSuccess('');
    setFormOpen(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!itemCode.trim() || !itemName.trim()) {
      return setError('Item code and item name are required');
    }
    setSaving(true);
    setError('');
    try {
      if (editId) {
        await api.put(`/procurement/item-code-lookup/${editId}`, { itemCode, itemName, category });
      } else {
        await api.post('/procurement/item-code-lookup', { itemCode, itemName, category });
      }
      setSuccess(editId ? 'Mapping updated' : 'Mapping added');
      setFormOpen(false);
      resetForm();
      load();
    } catch (e) {
      setError(e.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this mapping?')) return;
    try {
      await api.delete(`/procurement/item-code-lookup/${id}`);
      setRows((r) => r.filter((x) => x.ItemCodeLookupId !== id));
    } catch (e) {
      alert(e.response?.data?.error || 'Delete failed');
    }
  };

  const handleBulkImport = async () => {
    const lines = bulkText.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;

    // Tolerate an optional header row (e.g. "Ingredient Name  Code  Category").
    const firstCells = splitRow(lines[0]).map((c) => c.toLowerCase());
    const startIdx = (firstCells.includes('code') || firstCells.includes('ingredient name')) ? 1 : 0;

    const parsedRows = [];
    for (let i = startIdx; i < lines.length; i++) {
      const cells = splitRow(lines[i]);
      if (cells.length < 2) continue;
      // Matches the Excel column order from the source book: Name, Code, Category.
      const [name, code, cat] = cells;
      if (!name || !code) continue;
      parsedRows.push({ itemName: name, itemCode: code, category: cat || null });
    }

    if (parsedRows.length === 0) {
      return setError('Could not find any valid rows to import — expected "Name, Code, Category" per line');
    }

    setBulkBusy(true);
    setError('');
    setBulkResult(null);
    try {
      const res = await api.post('/procurement/item-code-lookup/bulk', { rows: parsedRows });
      setBulkResult(res.data);
      setBulkText('');
      load();
    } catch (e) {
      setError(e.response?.data?.error || 'Bulk import failed');
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Item Code Lookup</h1>
          <p className="page-subtitle">
            Some Busy stock items only show a product code (e.g. "ING-0141") instead of a real name.
            This table resolves the code to the real name for Central Stores, Procurement and the supplier.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-secondary" onClick={() => setBulkOpen((v) => !v)}>
            {bulkOpen ? 'Close Bulk Import' : 'Bulk Import from Excel'}
          </button>
          <button className="btn btn-primary" onClick={openNew}>+ Add Mapping</button>
        </div>
      </div>

      {error   && <div className="alert alert-error"   style={{ marginBottom: 16 }}>{error}</div>}
      {success && <div className="alert alert-success" style={{ marginBottom: 16 }}>{success}</div>}

      {bulkOpen && (
        <div className="card" style={{ marginBottom: 24, border: '2px solid #1a73e8' }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>Bulk Import</h3>
          <p style={{ fontSize: 12, color: '#6b7280', marginTop: 0, marginBottom: 12 }}>
            In Excel, select the Name / Code / Category columns (in that order), copy, and paste below.
            Existing codes get updated; new codes get added. A header row is fine and will be skipped automatically.
          </p>
          <textarea
            className="form-input"
            style={{ width: '100%', minHeight: 180, fontFamily: 'monospace', fontSize: 12 }}
            placeholder={'Aglu Pectin Powder HS-R\tING-0001\tINGREDIENTS\nAmmonium chloride\tING-0002\tINGREDIENTS'}
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center' }}>
            <button className="btn btn-primary" onClick={handleBulkImport} disabled={bulkBusy || !bulkText.trim()}>
              {bulkBusy ? 'Importing…' : 'Import Pasted Rows'}
            </button>
            {bulkResult && (
              <span style={{ fontSize: 13, color: '#059669' }}>
                Imported {bulkResult.total} row{bulkResult.total !== 1 ? 's' : ''}
                ({bulkResult.inserted} new, {bulkResult.updated} updated)
              </span>
            )}
          </div>
        </div>
      )}

      {formOpen && (
        <div className="card" style={{ marginBottom: 24, border: '2px solid #1a73e8' }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 14 }}>{editId ? 'Edit Mapping' : 'New Mapping'}</h3>
          <form onSubmit={handleSave}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <div className="form-group" style={{ minWidth: 160 }}>
                <label className="form-label">Item Code *</label>
                <input className="form-input" value={itemCode}
                  onChange={(e) => setItemCode(e.target.value)}
                  placeholder="e.g. ING-0001" />
              </div>
              <div className="form-group" style={{ flex: 2, minWidth: 220 }}>
                <label className="form-label">Item Name *</label>
                <input className="form-input" value={itemName}
                  onChange={(e) => setItemName(e.target.value)}
                  placeholder="e.g. Aglu Pectin Powder HS-R" />
              </div>
              <div className="form-group" style={{ flex: 1, minWidth: 160 }}>
                <label className="form-label">Category</label>
                <input className="form-input" value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="e.g. INGREDIENTS" />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Saving…' : editId ? 'Update' : 'Add Mapping'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => { setFormOpen(false); resetForm(); }}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>
          No mappings yet. Paste your Excel list via Bulk Import, or add one manually.
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Item Name</th>
                <th>Category</th>
                <th>Added By</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.ItemCodeLookupId}>
                  <td><code style={{ background: '#f3f4f6', padding: '2px 6px', borderRadius: 4, fontSize: 12 }}>{row.ItemCode}</code></td>
                  <td>{row.ItemName}</td>
                  <td style={{ color: '#6b7280' }}>{row.Category || '—'}</td>
                  <td style={{ fontSize: 12, color: '#6b7280' }}>{row.CreatedByName || '—'}</td>
                  <td>
                    <button className="btn btn-secondary" style={{ padding: '3px 10px', fontSize: 12, marginRight: 6 }}
                      onClick={() => openEdit(row)}>
                      Edit
                    </button>
                    <button
                      style={{ padding: '3px 10px', fontSize: 12, border: '1px solid #fca5a5', background: '#fff', color: '#dc2626', borderRadius: 6, cursor: 'pointer' }}
                      onClick={() => handleDelete(row.ItemCodeLookupId)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
