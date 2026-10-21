import React, { useEffect, useState } from 'react';
import api from '../services/api';

const MATCH_TYPE_LABELS = {
  exact:       'Exact match',
  contains:    'Contains',
  starts_with: 'Starts with',
};

export default function ItemCategoryMapPage() {
  const [rows, setRows]         = useState([]);
  const [loading, setLoading]   = useState(false);
  const [categories, setCats]   = useState([]);

  // Form state
  const [editId, setEditId]         = useState(null);  // null = new row
  const [itemPattern, setPattern]   = useState('');
  const [matchType, setMatchType]   = useState('contains');
  const [category, setCategory]     = useState('');
  const [sortOrder, setSortOrder]   = useState(50);
  const [formOpen, setFormOpen]     = useState(false);
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState('');
  const [success, setSuccess]       = useState('');

  const load = () => {
    setLoading(true);
    Promise.all([
      api.get('/procurement/item-categories'),
      api.get('/procurement/item-categories/categories'),
    ])
      .then(([mapRes, catRes]) => {
        setRows(mapRes.data);
        setCats(catRes.data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const resetForm = () => {
    setEditId(null);
    setPattern('');
    setMatchType('contains');
    setCategory('');
    setSortOrder(50);
    setError('');
    setSuccess('');
  };

  const openNew = () => {
    resetForm();
    setFormOpen(true);
  };

  const openEdit = (row) => {
    setEditId(row.ItemCategoryMapId);
    setPattern(row.ItemPattern);
    setMatchType(row.MatchType);
    setCategory(row.Category);
    setSortOrder(row.SortOrder);
    setError('');
    setSuccess('');
    setFormOpen(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!itemPattern.trim() || !category.trim()) {
      return setError('Item pattern and category are required');
    }
    setSaving(true);
    setError('');
    try {
      if (editId) {
        await api.put(`/procurement/item-categories/${editId}`, {
          itemPattern, matchType, category, sortOrder,
        });
      } else {
        await api.post('/procurement/item-categories', {
          itemPattern, matchType, category, sortOrder,
        });
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
      await api.delete(`/procurement/item-categories/${id}`);
      setRows((r) => r.filter((x) => x.ItemCategoryMapId !== id));
    } catch (e) {
      alert(e.response?.data?.error || 'Delete failed');
    }
  };

  // Group rows by category for display
  const grouped = rows.reduce((acc, r) => {
    if (!acc[r.Category]) acc[r.Category] = [];
    acc[r.Category].push(r);
    return acc;
  }, {});

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Item Category Mapping</h1>
          <p className="page-subtitle">
            Maps Busy PurIndents item names → supply categories for supplier matching.
            The sync job uses these rules to auto-classify requisition items.
          </p>
        </div>
        <button className="btn btn-primary" onClick={openNew}>+ Add Mapping</button>
      </div>

      {error   && <div className="alert alert-error"   style={{ marginBottom: 16 }}>{error}</div>}
      {success && <div className="alert alert-success" style={{ marginBottom: 16 }}>{success}</div>}

      {/* How it works callout */}
      <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: '#1e40af' }}>
        <strong>How matching works:</strong> When a PurIndents row is synced, the item name is tested
        against these patterns in priority order: <em>Exact → Starts with → Contains</em>.
        The first match wins. Lower SortOrder = higher priority within the same match type.
      </div>

      {/* Add/Edit form */}
      {formOpen && (
        <div className="card" style={{ marginBottom: 24, border: '2px solid #1a73e8' }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 14 }}>
            {editId ? 'Edit Mapping' : 'New Mapping'}
          </h3>
          <form onSubmit={handleSave}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <div className="form-group" style={{ flex: 2, minWidth: 200 }}>
                <label className="form-label">Item Pattern *</label>
                <input className="form-input" value={itemPattern}
                  onChange={(e) => setPattern(e.target.value)}
                  placeholder="e.g. Sugar, Tin Plate, HDPE" />
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                  The pattern to match against the itemName from Busy
                </div>
              </div>

              <div className="form-group" style={{ minWidth: 160 }}>
                <label className="form-label">Match Type *</label>
                <select className="form-input" value={matchType} onChange={(e) => setMatchType(e.target.value)}>
                  <option value="contains">Contains</option>
                  <option value="starts_with">Starts with</option>
                  <option value="exact">Exact match</option>
                </select>
              </div>

              <div className="form-group" style={{ flex: 1, minWidth: 160 }}>
                <label className="form-label">Category *</label>
                <input className="form-input" list="cat-list" value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="e.g. Raw Materials" />
                <datalist id="cat-list">
                  {categories.map((c) => <option key={c} value={c} />)}
                </datalist>
              </div>

              <div className="form-group" style={{ width: 100 }}>
                <label className="form-label">Sort Order</label>
                <input type="number" className="form-input" value={sortOrder}
                  min="1" max="999" onChange={(e) => setSortOrder(parseInt(e.target.value, 10) || 50)} />
              </div>
            </div>

            {/* Preview */}
            {itemPattern && (
              <div style={{ background: '#f9fafb', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#374151', marginBottom: 12 }}>
                <strong>Preview rule:</strong> itemName{' '}
                {matchType === 'exact'       ? `= "${itemPattern}"` : ''}
                {matchType === 'contains'    ? `contains "${itemPattern}"` : ''}
                {matchType === 'starts_with' ? `starts with "${itemPattern}"` : ''}
                {' '}→ <strong>{category || '(category)'}</strong>
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Saving…' : editId ? 'Update' : 'Add Mapping'}
              </button>
              <button type="button" className="btn btn-secondary"
                onClick={() => { setFormOpen(false); resetForm(); }}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Table grouped by category */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>
          No mappings yet. Add your first mapping to enable auto-classification.
        </div>
      ) : (
        Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([cat, items]) => (
          <div key={cat} className="card" style={{ marginBottom: 16, padding: 0, overflow: 'hidden' }}>
            <div style={{
              background: '#f3f4f6', padding: '8px 16px', fontWeight: 700,
              fontSize: 13, color: '#374151', borderBottom: '1px solid #e5e7eb',
            }}>
              {cat}
              <span style={{ fontWeight: 400, color: '#6b7280', marginLeft: 8 }}>
                ({items.length} pattern{items.length !== 1 ? 's' : ''})
              </span>
            </div>
            <table className="data-table" style={{ margin: 0 }}>
              <thead>
                <tr>
                  <th>Pattern</th>
                  <th>Match Type</th>
                  <th>Sort Order</th>
                  <th>Added By</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.ItemCategoryMapId}>
                    <td><code style={{ background: '#f3f4f6', padding: '2px 6px', borderRadius: 4, fontSize: 12 }}>{row.ItemPattern}</code></td>
                    <td>
                      <span className={`badge ${
                        row.MatchType === 'exact'       ? 'badge-green' :
                        row.MatchType === 'starts_with' ? 'badge-blue'  : 'badge-gray'
                      }`} style={{ fontSize: 11 }}>
                        {MATCH_TYPE_LABELS[row.MatchType]}
                      </span>
                    </td>
                    <td style={{ textAlign: 'center', color: '#6b7280' }}>{row.SortOrder}</td>
                    <td style={{ fontSize: 12, color: '#6b7280' }}>{row.CreatedByName || '—'}</td>
                    <td>
                      <button className="btn btn-secondary"
                        style={{ padding: '3px 10px', fontSize: 12, marginRight: 6 }}
                        onClick={() => openEdit(row)}>
                        Edit
                      </button>
                      <button
                        style={{ padding: '3px 10px', fontSize: 12, border: '1px solid #fca5a5', background: '#fff', color: '#dc2626', borderRadius: 6, cursor: 'pointer' }}
                        onClick={() => handleDelete(row.ItemCategoryMapId)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}

      {/* Supplier category summary */}
      {categories.length > 0 && (
        <div style={{ marginTop: 24, fontSize: 13, color: '#6b7280' }}>
          <strong>Active categories in use:</strong>{' '}
          {categories.map((c) => (
            <span key={c} style={{
              display: 'inline-block', background: '#dbeafe', color: '#1e40af',
              borderRadius: 10, padding: '2px 10px', fontSize: 12, marginRight: 6, marginBottom: 4,
            }}>
              {c}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
