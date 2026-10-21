import React, { useState, useEffect, useCallback } from 'react';
import api from '../services/api';

const ROLES = [
  { value: 'Admin', label: 'Admin', desc: 'Full system access' },
  { value: 'GateSecurity', label: 'Gate Security', desc: 'Gate entry management' },
  { value: 'Weighbridge', label: 'Weighbridge', desc: 'Weighbridge operations' },
  { value: 'QAInspector', label: 'QA Inspector', desc: 'Quality inspections' },
  { value: 'QAManager', label: 'QA Manager', desc: 'QA decisions & reports' },
  { value: 'StoreReceiving', label: 'Store Receiving', desc: 'Central stores GRN' },
  { value: 'FactoryReceiving', label: 'Factory Receiving', desc: 'Factory GRN' },
  { value: 'Supervisor', label: 'Supervisor', desc: 'Oversight & approvals' },
  { value: 'ProductionClerk', label: 'Production Clerk', desc: 'Production records' },
  { value: 'Auditor', label: 'Auditor', desc: 'Traceability & reports' },
  { value: 'OpsManager', label: 'Ops Manager', desc: 'Operational approval before receiving' },
  { value: 'FactoryQA', label: 'Factory QA', desc: 'QA inspection, QA decision & factory GRN' },
  { value: 'Director', label: 'Director', desc: 'Approve supplier quotations & reorder oversight' },
  { value: 'Procurement', label: 'Procurement', desc: 'Requisitions, quotations, suppliers & reorder management' },
  { value: 'ProductionManager', label: 'Production Manager', desc: 'Reorder levels, FG reorder, production planning & aging analysis' },
  { value: 'Viewer', label: 'System Viewer', desc: 'Read-only access to all pages — cannot make any changes' },
];

const DEPARTMENTS = [
  'IT', 'Security', 'Logistics', 'Central Stores', 'Production',
  'Operations', 'Finance', 'Quality Assurance', 'Administration',
];

const emptyForm = {
  username: '', password: '', fullName: '', email: '',
  role: 'GateSecurity', department: '', assignedMatCenter: '', busyUserName: '', isActive: true,
};

export default function UserManagementPage() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmPermanentDelete, setConfirmPermanentDelete] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get('/auth/users');
      setUsers(res.data);
    } catch (err) {
      setError('Failed to load users');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const [busyUsers, setBusyUsers] = useState([]);
  useEffect(() => {
    api.get('/auth/busy-users').then((r) => setBusyUsers(r.data)).catch(() => setBusyUsers([]));
  }, []);

  // Busy's Material Centres — a clerk's Mat Centre must be one of these or the LPO push fails.
  const [busyStores, setBusyStores] = useState([]);
  useEffect(() => {
    api.get('/procurement/requisitions-create/mat-centers').then((r) => setBusyStores(r.data)).catch(() => setBusyStores([]));
  }, []);

  useEffect(() => {
    if (successMsg) {
      const t = setTimeout(() => setSuccessMsg(''), 3000);
      return () => clearTimeout(t);
    }
  }, [successMsg]);

  const openAdd = () => {
    setEditingUser(null);
    setForm(emptyForm);
    setError('');
    setModalOpen(true);
  };

  const openEdit = (user) => {
    setEditingUser(user);
    setForm({
      username: user.Username,
      password: '',
      fullName: user.FullName,
      email: user.Email || '',
      role: user.Role,
      department: user.Department || '',
      assignedMatCenter: user.AssignedMatCenter || '',
      busyUserName: user.BusyUserName || '',
      isActive: user.IsActive,
    });
    setError('');
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingUser(null);
    setForm(emptyForm);
    setError('');
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setForm(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      if (editingUser) {
        await api.put(`/auth/users/${editingUser.UserId}`, form);
        setSuccessMsg('User updated successfully');
      } else {
        if (!form.password) {
          setError('Password is required for new users');
          setSaving(false);
          return;
        }
        await api.post('/auth/users', form);
        setSuccessMsg('User created successfully');
      }
      closeModal();
      fetchUsers();
    } catch (err) {
      setError(err.response?.data?.error || 'Operation failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDeactivate = async (userId) => {
    try {
      await api.delete(`/auth/users/${userId}`);
      setSuccessMsg('User deactivated successfully');
      setConfirmDelete(null);
      fetchUsers();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to deactivate user');
      setConfirmDelete(null);
    }
  };

  const handlePermanentDelete = async (userId) => {
    try {
      await api.delete(`/auth/users/${userId}/permanent`);
      setSuccessMsg('User permanently deleted');
      setConfirmPermanentDelete(null);
      fetchUsers();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete user');
      setConfirmPermanentDelete(null);
    }
  };

  const filtered = users.filter(u => {
    if (!searchTerm) return true;
    const s = searchTerm.toLowerCase();
    return u.Username.toLowerCase().includes(s)
      || u.FullName.toLowerCase().includes(s)
      || (u.Email && u.Email.toLowerCase().includes(s))
      || u.Role.toLowerCase().includes(s);
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginated = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  // Reset to page 1 when search changes
  useEffect(() => { setCurrentPage(1); }, [searchTerm, pageSize]);

  const activeCount = users.filter(u => u.IsActive).length;
  const roleGroups = users.reduce((acc, u) => {
    acc[u.Role] = (acc[u.Role] || 0) + 1;
    return acc;
  }, {});

  return (
    <div style={{ padding: '24px 32px' }}>
      <div className="page-header">
        <h1>User Management</h1>
        <button className="btn btn-primary" onClick={openAdd}>+ Add User</button>
      </div>

      {successMsg && (
        <div style={{
          background: '#d1fae5', color: '#065f46', padding: '10px 16px',
          borderRadius: 'var(--radius)', marginBottom: 16, fontSize: 14, fontWeight: 500,
          border: '1px solid #a7f3d0'
        }}>
          {successMsg}
        </div>
      )}
      {error && !modalOpen && (
        <div style={{
          background: '#fee2e2', color: '#991b1b', padding: '10px 16px',
          borderRadius: 'var(--radius)', marginBottom: 16, fontSize: 14, fontWeight: 500,
          border: '1px solid #fecaca'
        }}>
          {error}
        </div>
      )}

      {/* Stats */}
      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-value">{users.length}</div>
          <div className="stat-label">Total Users</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: 'var(--success)' }}>{activeCount}</div>
          <div className="stat-label">Active Users</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: 'var(--danger)' }}>{users.length - activeCount}</div>
          <div className="stat-label">Inactive Users</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: 'var(--warning)' }}>{Object.keys(roleGroups).length}</div>
          <div className="stat-label">Roles in Use</div>
        </div>
      </div>

      {/* Search */}
      <div className="card" style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search users by name, username, email, or role..."
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          style={{
            width: '100%', padding: '8px 12px', border: '1px solid var(--gray-300)',
            borderRadius: 'var(--radius)', fontSize: 14,
          }}
        />
      </div>

      {/* Users table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="table-wrapper">
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--gray-500)' }}>Loading users...</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Full Name</th>
                  <th>Username</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Department</th>
                  <th>Mat Centre</th>
                  <th>Busy User</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {paginated.length === 0 ? (
                  <tr><td colSpan="9" style={{ textAlign: 'center', padding: 32, color: 'var(--gray-500)' }}>No users found</td></tr>
                ) : paginated.map(u => (
                  <tr key={u.UserId} style={{ opacity: u.IsActive ? 1 : 0.5 }}>
                    <td style={{ fontWeight: 600 }}>{u.FullName}</td>
                    <td>{u.Username}</td>
                    <td>{u.Email || '—'}</td>
                    <td>
                      <span className={`badge ${u.Role === 'Admin' ? 'badge-red' : 'badge-blue'}`}>
                        {ROLES.find(r => r.value === u.Role)?.label || u.Role}
                      </span>
                    </td>
                    <td>{u.Department || '—'}</td>
                    <td>{u.AssignedMatCenter || '—'}</td>
                    <td>
                      {u.BusyUserName || '—'}
                      {u.BusyUserName && (u.BusyUserVerifiedAt
                        ? <span title="Verified with the user's Busy password" style={{ color: '#059669', marginLeft: 4 }}>✓</span>
                        : <span title="Not verified yet — the user must confirm it with their Busy password before raising POs" style={{ color: '#d97706', marginLeft: 4, fontSize: 11 }}>(unverified)</span>)}
                    </td>
                    <td>
                      <span className={`badge ${u.IsActive ? 'badge-green' : 'badge-gray'}`}>
                        {u.IsActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn btn-outline" style={{ marginRight: 6, padding: '4px 12px', fontSize: 13 }} onClick={() => openEdit(u)}>
                        Edit
                      </button>
                      {u.IsActive && (
                        <button className="btn btn-outline" style={{ marginRight: 6, padding: '4px 12px', fontSize: 13, color: 'var(--warning)', borderColor: 'var(--warning)' }} onClick={() => setConfirmDelete(u)}>
                          Deactivate
                        </button>
                      )}
                      <button className="btn btn-danger" style={{ padding: '4px 12px', fontSize: 13 }} onClick={() => setConfirmPermanentDelete(u)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {filtered.length > 0 && (
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '12px 16px', borderTop: '1px solid var(--gray-200)', fontSize: 13,
            flexWrap: 'wrap', gap: 12,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--gray-500)' }}>
              <span>Show</span>
              <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))}
                style={{ padding: '4px 8px', border: '1px solid var(--gray-300)', borderRadius: 'var(--radius)', fontSize: 13 }}>
                {[5, 10, 20, 50].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              <span>of {filtered.length} users</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button className="btn btn-outline" style={{ padding: '4px 10px', fontSize: 13 }}
                disabled={safePage <= 1} onClick={() => setCurrentPage(1)}>«</button>
              <button className="btn btn-outline" style={{ padding: '4px 10px', fontSize: 13 }}
                disabled={safePage <= 1} onClick={() => setCurrentPage(p => p - 1)}>‹</button>
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter(p => p === 1 || p === totalPages || Math.abs(p - safePage) <= 1)
                .reduce((acc, p, i, arr) => {
                  if (i > 0 && p - arr[i - 1] > 1) acc.push('...');
                  acc.push(p);
                  return acc;
                }, [])
                .map((p, i) => typeof p === 'string'
                  ? <span key={`e${i}`} style={{ padding: '4px 6px', color: 'var(--gray-400)' }}>{p}</span>
                  : <button key={p} className="btn" onClick={() => setCurrentPage(p)}
                      style={{
                        padding: '4px 10px', fontSize: 13, minWidth: 32,
                        background: p === safePage ? 'var(--primary)' : '#fff',
                        color: p === safePage ? '#fff' : 'var(--gray-700)',
                        border: `1px solid ${p === safePage ? 'var(--primary)' : 'var(--gray-300)'}`,
                      }}>{p}</button>
                )}
              <button className="btn btn-outline" style={{ padding: '4px 10px', fontSize: 13 }}
                disabled={safePage >= totalPages} onClick={() => setCurrentPage(p => p + 1)}>›</button>
              <button className="btn btn-outline" style={{ padding: '4px 10px', fontSize: 13 }}
                disabled={safePage >= totalPages} onClick={() => setCurrentPage(totalPages)}>»</button>
            </div>
          </div>
        )}
      </div>

      {/* Deactivate confirmation modal */}
      {confirmDelete && (
        <div style={overlayStyle} onClick={() => setConfirmDelete(null)}>
          <div style={{ ...modalStyle, maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Confirm Deactivate</h2>
            <p style={{ color: 'var(--gray-700)', marginBottom: 20 }}>
              Are you sure you want to deactivate <strong>{confirmDelete.FullName}</strong> ({confirmDelete.Username})?
              They will no longer be able to log in.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-outline" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={() => handleDeactivate(confirmDelete.UserId)}>Deactivate</button>
            </div>
          </div>
        </div>
      )}

      {/* Permanent delete confirmation modal */}
      {confirmPermanentDelete && (
        <div style={overlayStyle} onClick={() => setConfirmPermanentDelete(null)}>
          <div style={{ ...modalStyle, maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: 18, marginBottom: 12, color: 'var(--danger)' }}>⚠ Permanently Delete User</h2>
            <p style={{ color: 'var(--gray-700)', marginBottom: 8 }}>
              Are you sure you want to <strong>permanently delete</strong> <strong>{confirmPermanentDelete.FullName}</strong> ({confirmPermanentDelete.Username})?
            </p>
            <p style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 20 }}>
              This action cannot be undone. If the user has associated records, deletion will fail — use Deactivate instead.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-outline" onClick={() => setConfirmPermanentDelete(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={() => handlePermanentDelete(confirmPermanentDelete.UserId)}>Delete Permanently</button>
            </div>
          </div>
        </div>
      )}

      {/* Add / Edit modal */}
      {modalOpen && (
        <div style={overlayStyle} onClick={closeModal}>
          <div style={modalStyle} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 18, margin: 0 }}>{editingUser ? 'Edit User' : 'Add New User'}</h2>
              <button onClick={closeModal} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--gray-500)' }}>&times;</button>
            </div>

            {error && modalOpen && (
              <div style={{
                background: '#fee2e2', color: '#991b1b', padding: '8px 12px',
                borderRadius: 'var(--radius)', marginBottom: 16, fontSize: 13,
                border: '1px solid #fecaca'
              }}>
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit}>
              <div className="form-row">
                <div className="form-group">
                  <label>Full Name *</label>
                  <input name="fullName" value={form.fullName} onChange={handleChange} required />
                </div>
                <div className="form-group">
                  <label>Username *</label>
                  <input name="username" value={form.username} onChange={handleChange} required />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Email</label>
                  <input name="email" type="email" value={form.email} onChange={handleChange} />
                </div>
                <div className="form-group">
                  <label>{editingUser ? 'New Password (leave blank to keep)' : 'Password *'}</label>
                  <input name="password" type="password" value={form.password} onChange={handleChange}
                    required={!editingUser} autoComplete="new-password" />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Role *</label>
                  <select name="role" value={form.role} onChange={handleChange} required>
                    {ROLES.map(r => (
                      <option key={r.value} value={r.value}>{r.label} — {r.desc}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Department</label>
                  <select name="department" value={form.department} onChange={handleChange}>
                    <option value="">— Select —</option>
                    {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
              </div>

              {form.role === 'FactoryReceiving' && (
                <div className="form-row">
                  <div className="form-group">
                    <label>Assigned Mat Centre *</label>
                    <select name="assignedMatCenter" value={form.assignedMatCenter} onChange={handleChange}>
                      <option value="">— Select Busy Material Centre —</option>
                      {form.assignedMatCenter
                        && !busyStores.some((s) => s.toUpperCase() === form.assignedMatCenter.trim().toUpperCase())
                        && <option value={form.assignedMatCenter}>{form.assignedMatCenter} (not in Busy — change it)</option>}
                      {busyStores.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <p style={{ fontSize: 12, color: 'var(--gray-500)', margin: '4px 0 0' }}>
                      Locks this clerk to raising requisitions for exactly this Mat Centre. The list is
                      Busy's own Material Centres, so the LPO raised in Busy always gets a valid store.
                    </p>
                  </div>
                </div>
              )}

              {['Procurement', 'Admin'].includes(form.role) && (
                <div className="form-row">
                  <div className="form-group">
                    <label>Busy user</label>
                    <select name="busyUserName" value={form.busyUserName} onChange={handleChange}>
                      <option value="">— Not linked —</option>
                      {busyUsers.map(b => <option key={b} value={b}>{b}</option>)}
                    </select>
                    <p style={{ fontSize: 12, color: 'var(--gray-500)', margin: '4px 0 0' }}>
                      To raise POs in Busy the user must verify this login once with their own Busy password
                      (asked for in the Raise PO dialog). Changing it here clears the verification.
                      {editingUser?.BusyUserVerifiedAt && editingUser.BusyUserName === form.busyUserName
                        && <> Verified {new Date(editingUser.BusyUserVerifiedAt).toLocaleDateString('en-KE')}.</>}
                    </p>
                  </div>
                </div>
              )}

              {editingUser && (
                <div className="form-group" style={{ marginTop: 4 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input type="checkbox" name="isActive" checked={form.isActive} onChange={handleChange}
                      style={{ width: 'auto' }} />
                    Active account
                  </label>
                </div>
              )}

              {/* Role permissions reference */}
              <div style={{
                background: 'var(--gray-50)', borderRadius: 'var(--radius)',
                padding: '12px 16px', marginBottom: 16, fontSize: 12, color: 'var(--gray-500)', lineHeight: 1.8,
              }}>
                <strong style={{ color: 'var(--gray-700)' }}>Role Access:</strong><br />
                Gate Security → Gate Entry &nbsp;|&nbsp;
                Weighbridge → Weighbridge &nbsp;|&nbsp;
                QA Inspector / Manager → QA Inspection &nbsp;|&nbsp;
                Factory QA → QA Inspection + Decision + Factory GRN &nbsp;|&nbsp;
                Store / Factory Receiving → GRN &nbsp;|&nbsp;
                Supervisor → Oversight &nbsp;|&nbsp;
                Director → Quote Evaluation &amp; Reorder Oversight &nbsp;|&nbsp;
                Procurement → Requisitions, Quotations &amp; Suppliers &nbsp;|&nbsp;
                Admin → Full Access
              </div>

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-outline" onClick={closeModal}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Saving...' : editingUser ? 'Update User' : 'Create User'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000,
};

const modalStyle = {
  background: '#fff', borderRadius: 12, padding: '24px 28px',
  width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto',
  boxShadow: '0 20px 60px rgba(0,0,0,.2)',
};