import React, { useEffect, useState, useCallback } from 'react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';

const EMPTY_FORM = {
  supplierCode: '', supplierName: '', contactPerson: '',
  phone: '', whatsApp: '', email: '', address: '', isActive: true,
};

export default function SuppliersPage() {
  const { user } = useAuth();
  const canEdit = ['Admin', 'Procurement'].includes(user?.role);

  const [suppliers, setSuppliers]   = useState([]);
  const [loading, setLoading]       = useState(true);
  const [search, setSearch]         = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [error, setError]           = useState('');

  // Modal state
  const [modal, setModal]           = useState(null); // null | 'add' | 'edit'
  const [form, setForm]             = useState(EMPTY_FORM);
  const [saving, setSaving]         = useState(false);
  const [formError, setFormError]   = useState('');

  // Category management (per selected supplier)
  const [catSupplier, setCatSupplier]   = useState(null); // supplier object
  const [categories, setCategories]     = useState([]);
  const [catSelect, setCatSelect]       = useState([]); // array of selected categories to add
  const [catLoading, setCatLoading]     = useState(false);
  const [allCategoryOptions, setAllCategoryOptions] = useState([]);

  // Email management (per selected supplier) — standalone "Emails" modal
  const [emailSupplier, setEmailSupplier] = useState(null); // supplier object
  const [emails, setEmails]               = useState([]);
  const [emailLoading, setEmailLoading]   = useState(false);
  const [newEmail, setNewEmail]           = useState('');
  const [newEmailLabel, setNewEmailLabel] = useState('');
  const [emailAdding, setEmailAdding]     = useState(false);
  const [emailError, setEmailError]       = useState('');

  // Additional emails, inline in the Add/Edit modal itself. In Add mode
  // these are staged locally (no SupplierId exists yet) and flushed to the
  // API right after the new supplier is created. In Edit mode they're
  // loaded from / written to the API immediately, same endpoints as the
  // standalone Emails modal above.
  const [modalEmails, setModalEmails]           = useState([]); // {SupplierEmailId?, Email, Label, _tempId?}
  const [modalNewEmail, setModalNewEmail]       = useState('');
  const [modalNewEmailLabel, setModalNewEmailLabel] = useState('');
  const [modalEmailError, setModalEmailError]   = useState('');
  const [modalEmailBusy, setModalEmailBusy]     = useState(false);
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const loadSuppliers = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (search) params.search = search;
      if (!showInactive) params.active = 'true';
      const res = await api.get('/suppliers', { params });
      setSuppliers(res.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load suppliers');
    } finally {
      setLoading(false);
    }
  }, [search, showInactive]);

  useEffect(() => { loadSuppliers(); }, [loadSuppliers]);

  // Load distinct item categories (Busy-authoritative, via RequisitionItems)
  // for the supply-category dropdown.
  useEffect(() => {
    api.get('/procurement/requisitions/categories')
      .then(res => setAllCategoryOptions(Array.isArray(res.data) ? res.data : []))
      .catch(() => setAllCategoryOptions([]));
  }, []);

  // ── Auto-generate code on name input (only for new supplier) ──
  const handleNameChange = (val) => {
    setForm(f => ({ ...f, supplierName: val }));
  };

  const resetModalEmailFields = () => {
    setModalNewEmail('');
    setModalNewEmailLabel('');
    setModalEmailError('');
  };

  const openAdd = () => {
    setForm(EMPTY_FORM);
    setFormError('');
    setModalEmails([]);
    resetModalEmailFields();
    setModal('add');
  };

  const openEdit = async (s) => {
    setForm({
      supplierCode:  s.SupplierCode,
      supplierName:  s.SupplierName,
      contactPerson: s.ContactPerson || '',
      phone:         s.Phone || '',
      whatsApp:      s.WhatsApp || '',
      email:         s.Email || '',
      address:       s.Address || '',
      isActive:      s.IsActive,
    });
    setFormError('');
    setModalEmails([]);
    resetModalEmailFields();
    setModal({ type: 'edit', id: s.SupplierId });
    try {
      const res = await api.get(`/suppliers/${s.SupplierId}/emails`);
      setModalEmails(res.data);
    } catch (e) {
      setModalEmails([]);
    }
  };

  const closeModal = () => {
    setModal(null);
    setFormError('');
    setModalEmails([]);
    resetModalEmailFields();
  };

  // Add mode: no SupplierId yet, so just stage the entry locally.
  // Edit mode: SupplierId is already known, so hit the API immediately.
  const addModalEmail = async () => {
    const trimmed = modalNewEmail.trim();
    if (!trimmed) return setModalEmailError('Enter an email address');
    if (!EMAIL_RE.test(trimmed)) return setModalEmailError('Enter a valid email address');
    const label = modalNewEmailLabel.trim() || undefined;

    if (modal === 'add') {
      setModalEmails(prev => [...prev, { Email: trimmed, Label: label || null, _tempId: Date.now() }]);
      resetModalEmailFields();
      return;
    }

    setModalEmailBusy(true);
    setModalEmailError('');
    try {
      const res = await api.post(`/suppliers/${modal.id}/emails`, { email: trimmed, label });
      setModalEmails(prev => [...prev, res.data]);
      resetModalEmailFields();
      loadSuppliers(); // refresh AdditionalEmails count on the list
    } catch (e) {
      setModalEmailError(e.response?.data?.error || 'Failed to add email');
    } finally {
      setModalEmailBusy(false);
    }
  };

  const removeModalEmail = async (item) => {
    if (!item.SupplierEmailId) {
      // Locally staged (add mode) — nothing persisted yet, just drop it.
      setModalEmails(prev => prev.filter(x => x._tempId !== item._tempId));
      return;
    }
    if (!window.confirm(`Remove "${item.Email}" from this supplier?`)) return;
    try {
      await api.delete(`/suppliers/${modal.id}/emails/${item.SupplierEmailId}`);
      setModalEmails(prev => prev.filter(x => x.SupplierEmailId !== item.SupplierEmailId));
      loadSuppliers();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to remove email');
    }
  };

  const handleSave = async () => {
    if (!form.supplierName.trim()) return setFormError('Supplier name is required');
    if (modal === 'add' && !form.supplierCode.trim()) return setFormError('Supplier code is required');
    setSaving(true);
    setFormError('');
    try {
      if (modal === 'add') {
        const res = await api.post('/suppliers', form);
        const newSupplierId = res.data?.SupplierId;
        if (newSupplierId && modalEmails.length > 0) {
          for (const item of modalEmails) {
            await api.post(`/suppliers/${newSupplierId}/emails`, { email: item.Email, label: item.Label || undefined });
          }
        }
      } else {
        await api.put(`/suppliers/${modal.id}`, form);
      }
      closeModal();
      loadSuppliers();
    } catch (e) {
      setFormError(e.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // ── Category management ──
  const openCategories = async (s) => {
    setCatSupplier(s);
    setCatSelect([]);
    setCatLoading(true);
    try {
      const res = await api.get(`/suppliers/${s.SupplierId}/categories`);
      setCategories(res.data);
    } catch (e) {
      setCategories([]);
    } finally {
      setCatLoading(false);
    }
  };

  const closeCatModal = () => { setCatSupplier(null); setCategories([]); };

  const toggleCatSelect = (cat) => {
    setCatSelect(prev =>
      prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]
    );
  };

  // Adds every category currently checked in the picker — a supplier can
  // supply many categories, so this isn't limited to one at a time.
  const addSelectedCategories = async () => {
    if (catSelect.length === 0) return;
    try {
      for (const cat of catSelect) {
        await api.post(`/suppliers/${catSupplier.SupplierId}/categories`, { category: cat });
      }
      setCatSelect([]);
      const res = await api.get(`/suppliers/${catSupplier.SupplierId}/categories`);
      setCategories(res.data);
      // Refresh list to show updated categories column
      loadSuppliers();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to add categories');
    }
  };

  const removeCategory = async (cat) => {
    if (!window.confirm(`Remove category "${cat}" from this supplier?`)) return;
    try {
      await api.delete(`/suppliers/${catSupplier.SupplierId}/categories/${encodeURIComponent(cat)}`);
      setCategories(c => c.filter(x => x.Category !== cat));
      loadSuppliers();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to remove category');
    }
  };

  // Categories not yet assigned to this supplier — the dropdown only
  // offers ones that would actually add something new.
  const availableCategoryOptions = allCategoryOptions.filter(
    c => !categories.some(existing => existing.Category === c)
  );

  // ── Email management ──
  // A supplier can have unlimited secondary email recipients on top of
  // the single Busy-ERP-owned primary Email (e.g. accounts person, second
  // contact). These are purely local and never touched by the ERP sync.
  const openEmails = async (s) => {
    setEmailSupplier(s);
    setNewEmail('');
    setNewEmailLabel('');
    setEmailError('');
    setEmailLoading(true);
    try {
      const res = await api.get(`/suppliers/${s.SupplierId}/emails`);
      setEmails(res.data);
    } catch (e) {
      setEmails([]);
    } finally {
      setEmailLoading(false);
    }
  };

  const closeEmailModal = () => {
    setEmailSupplier(null);
    setEmails([]);
    setNewEmail('');
    setNewEmailLabel('');
    setEmailError('');
  };

  const addEmail = async () => {
    const trimmed = newEmail.trim();
    if (!trimmed) return setEmailError('Enter an email address');
    setEmailAdding(true);
    setEmailError('');
    try {
      const res = await api.post(`/suppliers/${emailSupplier.SupplierId}/emails`, {
        email: trimmed,
        label: newEmailLabel.trim() || undefined,
      });
      setEmails(prev => [...prev, res.data]);
      setNewEmail('');
      setNewEmailLabel('');
      loadSuppliers(); // refresh AdditionalEmails on the list
    } catch (e) {
      setEmailError(e.response?.data?.error || 'Failed to add email');
    } finally {
      setEmailAdding(false);
    }
  };

  const removeEmail = async (e) => {
    if (!window.confirm(`Remove "${e.Email}" from this supplier?`)) return;
    try {
      await api.delete(`/suppliers/${emailSupplier.SupplierId}/emails/${e.SupplierEmailId}`);
      setEmails(prev => prev.filter(x => x.SupplierEmailId !== e.SupplierEmailId));
      loadSuppliers();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to remove email');
    }
  };

  const f = (key) => (e) => setForm(prev => ({ ...prev, [key]: e.target.value }));

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Suppliers</h1>
          <p className="page-subtitle">Manage supplier master data and supply categories</p>
        </div>
        {canEdit && (
          <button className="btn btn-primary" onClick={openAdd}>+ Add Supplier</button>
        )}
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

      {/* Filters */}
      <div className="card" style={{ marginBottom: 20, padding: '12px 16px' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="form-control"
            style={{ maxWidth: 280 }}
            placeholder="Search name or code…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: '#374151', cursor: 'pointer' }}>
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
          <span style={{ marginLeft: 'auto', fontSize: 13, color: '#6b7280' }}>
            {suppliers.length} supplier{suppliers.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading…</div>
        ) : suppliers.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>
            No suppliers found.{canEdit && <> Click <strong>+ Add Supplier</strong> to create one.</>}
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Contact</th>
                <th>Phone / WhatsApp</th>
                <th>Email</th>
                <th>Supply Categories</th>
                <th>Status</th>
                {canEdit && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {suppliers.map(s => {
                const extraCount = s.AdditionalEmails
                  ? s.AdditionalEmails.split(', ').filter(Boolean).length
                  : 0;
                return (
                <tr key={s.SupplierId} style={{ opacity: s.IsActive ? 1 : 0.55 }}>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{s.SupplierCode}</td>
                  <td style={{ fontWeight: 500 }}>{s.SupplierName}</td>
                  <td>{s.ContactPerson || <span style={{ color: '#9ca3af' }}>—</span>}</td>
                  <td>
                    {s.Phone && <div style={{ fontSize: 13 }}>📞 {s.Phone}</div>}
                    {s.WhatsApp && <div style={{ fontSize: 13 }}>💬 {s.WhatsApp}</div>}
                    {!s.Phone && !s.WhatsApp && <span style={{ color: '#9ca3af' }}>—</span>}
                  </td>
                  <td style={{ fontSize: 13 }}>
                    {s.Email || <span style={{ color: '#9ca3af' }}>—</span>}
                    {extraCount > 0 && (
                      <span
                        className="badge badge-gray"
                        title={s.AdditionalEmails}
                        style={{ fontSize: 11, marginLeft: 6 }}
                      >
                        +{extraCount}
                      </span>
                    )}
                  </td>
                  <td>
                    {s.Categories
                      ? s.Categories.split(', ').map(c => (
                          <span key={c} className="badge badge-blue" style={{ fontSize: 11, marginRight: 4, marginBottom: 2 }}>{c}</span>
                        ))
                      : <span style={{ color: '#9ca3af', fontSize: 12 }}>None</span>
                    }
                  </td>
                  <td>
                    <span className={`badge ${s.IsActive ? 'badge-green' : 'badge-gray'}`}>
                      {s.IsActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  {canEdit && (
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => openEdit(s)}>Edit</button>
                        <button className="btn btn-secondary btn-sm" onClick={() => openCategories(s)}>Categories</button>
                        <button className="btn btn-secondary btn-sm" onClick={() => openEmails(s)}>Emails</button>
                      </div>
                    </td>
                  )}
                </tr>
              );})}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Add / Edit Modal ── */}
      {modal && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>{modal === 'add' ? 'Add Supplier' : 'Edit Supplier'}</h2>
              <button onClick={closeModal} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#6b7280' }}>×</button>
            </div>

            {formError && <div className="alert alert-error" style={{ marginBottom: 14 }}>{formError}</div>}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 16px' }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Supplier Code *</label>
                <input className="form-control" value={form.supplierCode} onChange={f('supplierCode')}
                  placeholder="e.g. NCF-0001" disabled={modal !== 'add'} />
                {modal === 'add' && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>Use format NCF-XXXX</div>}
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Supplier Name *</label>
                <input className="form-control" value={form.supplierName} onChange={e => handleNameChange(e.target.value)} placeholder="Full business name" />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Contact Person</label>
                <input className="form-control" value={form.contactPerson} onChange={f('contactPerson')} placeholder="Name" />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Phone</label>
                <input className="form-control" value={form.phone} onChange={f('phone')} placeholder="+254 7XX XXX XXX" />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">WhatsApp</label>
                <input className="form-control" value={form.whatsApp} onChange={f('whatsApp')} placeholder="+254 7XX XXX XXX" />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Email</label>
                <input className="form-control" type="email" value={form.email} onChange={f('email')} placeholder="supplier@example.com" />
                {modal !== 'add' && (
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                    Primary email, synced from Busy ERP.
                  </div>
                )}
              </div>
              <div className="form-group" style={{ gridColumn: '1 / -1', margin: 0 }}>
                <label className="form-label">Address</label>
                <textarea className="form-control" rows={2} value={form.address} onChange={f('address')} placeholder="Physical / postal address" />
              </div>
              {modal !== 'add' && (
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Status</label>
                  <select className="form-control" value={form.isActive ? 'true' : 'false'}
                    onChange={e => setForm(prev => ({ ...prev, isActive: e.target.value === 'true' }))}>
                    <option value="true">Active</option>
                    <option value="false">Inactive</option>
                  </select>
                </div>
              )}
            </div>

            <div style={{ marginTop: 18 }}>
              <label className="form-label">Additional Email Recipients</label>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
                e.g. an accounts contact who should also receive RFQs and other supplier emails.
              </div>

              {modalEmailError && <div className="alert alert-error" style={{ marginBottom: 10 }}>{modalEmailError}</div>}

              {modalEmails.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                  {modalEmails.map(item => (
                    <span key={item.SupplierEmailId || item._tempId} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '4px 10px', fontSize: 13,
                    }}>
                      {item.Email}{item.Label ? ` (${item.Label})` : ''}
                      <button onClick={() => removeModalEmail(item)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontWeight: 700, fontSize: 14, lineHeight: 1 }}>×</button>
                    </span>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="form-control"
                  type="email"
                  placeholder="second.person@example.com"
                  value={modalNewEmail}
                  onChange={e => setModalNewEmail(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addModalEmail()}
                  style={{ flex: 2 }}
                />
                <input
                  className="form-control"
                  placeholder="Label (optional)"
                  value={modalNewEmailLabel}
                  onChange={e => setModalNewEmailLabel(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addModalEmail()}
                  style={{ flex: 1 }}
                />
                <button className="btn btn-secondary" onClick={addModalEmail} disabled={modalEmailBusy || !modalNewEmail.trim()}>
                  {modalEmailBusy ? 'Adding…' : 'Add'}
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24 }}>
              <button className="btn btn-secondary" onClick={closeModal} disabled={saving}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : (modal === 'add' ? 'Create Supplier' : 'Save Changes')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Categories Modal ── */}
      {catSupplier && (
        <div style={overlayStyle}>
          <div style={{ ...modalStyle, maxWidth: 480 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 17 }}>Supply Categories</h2>
                <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>{catSupplier.SupplierName}</div>
              </div>
              <button onClick={closeCatModal} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#6b7280' }}>×</button>
            </div>

            <p style={{ fontSize: 13, color: '#374151', marginBottom: 14 }}>
              Categories link this supplier to requisition items so they appear as suggested suppliers when creating an RFQ.
              Options come from item categories currently in use, sourced from Busy ERP.
            </p>

            {/* Existing categories */}
            {catLoading ? (
              <div style={{ color: '#6b7280', fontSize: 14, padding: '12px 0' }}>Loading…</div>
            ) : categories.length === 0 ? (
              <div style={{ color: '#9ca3af', fontSize: 13, padding: '8px 0' }}>No categories assigned yet.</div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
                {categories.map(c => (
                  <span key={c.Category} style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
                    background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '4px 10px', fontSize: 13 }}>
                    {c.Category}
                    <button onClick={() => removeCategory(c.Category)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontWeight: 700, fontSize: 14, lineHeight: 1 }}>×</button>
                  </span>
                ))}
              </div>
            )}

            {/* Add categories — checklist of distinct requisition item categories,
                a supplier can be tagged with as many as apply */}
            {allCategoryOptions.length === 0 ? (
              <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 6 }}>
                No item categories found yet — sync requisitions from Busy ERP first.
              </div>
            ) : availableCategoryOptions.length === 0 ? (
              <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 6 }}>
                All available categories are already assigned to this supplier.
              </div>
            ) : (
              <>
                <div style={{
                  border: '1px solid #e5e7eb', borderRadius: 6, maxHeight: 200,
                  overflowY: 'auto', padding: '8px 10px', marginBottom: 10,
                }}>
                  {availableCategoryOptions.map(c => (
                    <label key={c} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '4px 0', fontSize: 13, cursor: 'pointer',
                    }}>
                      <input
                        type="checkbox"
                        checked={catSelect.includes(c)}
                        onChange={() => toggleCatSelect(c)}
                      />
                      {c}
                    </label>
                  ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: '#6b7280' }}>
                    {catSelect.length} selected
                  </span>
                  <button className="btn btn-primary" onClick={addSelectedCategories} disabled={catSelect.length === 0}>
                    Add {catSelect.length > 0 ? `(${catSelect.length})` : ''}
                  </button>
                </div>
              </>
            )}

            <div style={{ marginTop: 20, textAlign: 'right' }}>
              <button className="btn btn-secondary" onClick={closeCatModal}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Emails Modal ── */}
      {emailSupplier && (
        <div style={overlayStyle}>
          <div style={{ ...modalStyle, maxWidth: 480 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 17 }}>Email Recipients</h2>
                <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>{emailSupplier.SupplierName}</div>
              </div>
              <button onClick={closeEmailModal} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#6b7280' }}>×</button>
            </div>

            <p style={{ fontSize: 13, color: '#374151', marginBottom: 14 }}>
              Primary email (<strong>{emailSupplier.Email || '—'}</strong>) is synced from Busy ERP and edited via the supplier's
              Edit form. Add extra recipients here — e.g. an accounts contact — who should also receive RFQs and other supplier emails.
            </p>

            {emailError && <div className="alert alert-error" style={{ marginBottom: 12 }}>{emailError}</div>}

            {/* Existing extra emails */}
            {emailLoading ? (
              <div style={{ color: '#6b7280', fontSize: 14, padding: '12px 0' }}>Loading…</div>
            ) : emails.length === 0 ? (
              <div style={{ color: '#9ca3af', fontSize: 13, padding: '8px 0' }}>No additional recipients yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                {emails.map(e => (
                  <div key={e.SupplierEmailId} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: '8px 12px',
                  }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{e.Email}</div>
                      {e.Label && <div style={{ fontSize: 11, color: '#6b7280' }}>{e.Label}</div>}
                    </div>
                    <button onClick={() => removeEmail(e)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontWeight: 700, fontSize: 14, lineHeight: 1 }}>×</button>
                  </div>
                ))}
              </div>
            )}

            {/* Add new email */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <input
                className="form-control"
                type="email"
                placeholder="second.person@example.com"
                value={newEmail}
                onChange={e => setNewEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addEmail()}
                style={{ flex: 2 }}
              />
              <input
                className="form-control"
                placeholder="Label (optional)"
                value={newEmailLabel}
                onChange={e => setNewEmailLabel(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addEmail()}
                style={{ flex: 1 }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" onClick={addEmail} disabled={emailAdding || !newEmail.trim()}>
                {emailAdding ? 'Adding…' : 'Add Email'}
              </button>
            </div>

            <div style={{ marginTop: 20, textAlign: 'right' }}>
              <button className="btn btn-secondary" onClick={closeEmailModal}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 1000, padding: 16,
};
const modalStyle = {
  background: '#fff', borderRadius: 12, padding: 28,
  width: '100%', maxWidth: 640,
  maxHeight: '90vh', overflowY: 'auto',
  boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
};