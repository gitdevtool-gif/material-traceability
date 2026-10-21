import React, { useEffect, useState } from 'react';
import api from '../services/api';

/**
 * Link the signed-in user's own Busy login (2026-10-19). Busy checks the
 * user name + password itself; only the user name is kept, never the
 * password. Raising a PO in Busy needs this so Busy records the real person,
 * not "Supervisor".
 */
export default function BusyLoginLink({ onLinked }) {
  const [busyUserName, setBusyUserName] = useState('');
  const [busyPassword, setBusyPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/auth/me/busy-link')
      .then((r) => { if (r.data.busyUserName) setBusyUserName(r.data.busyUserName); })
      .catch(() => {});
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const r = await api.post('/auth/me/busy-link', { busyUserName, busyPassword });
      setBusyPassword('');
      onLinked(r.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not check your Busy login');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ border: '1px solid #fcd34d', background: '#fffbeb', borderRadius: 8, padding: 12, marginBottom: 16 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>Link your Busy login</div>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
        Enter the user name and password you use in Busy, once. Busy checks them; your password is not stored.
        POs you raise from here will then show you as “added by” in Busy.
      </div>
      {error && <div className="alert alert-error" style={{ marginBottom: 8, fontSize: 12 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 160px' }}>
          <label className="form-label">Busy user name</label>
          <input className="form-input" value={busyUserName} autoComplete="off"
            onChange={(e) => setBusyUserName(e.target.value)} />
        </div>
        <div style={{ flex: '1 1 160px' }}>
          <label className="form-label">Busy password</label>
          <input className="form-input" type="password" value={busyPassword} autoComplete="new-password"
            onChange={(e) => setBusyPassword(e.target.value)} />
        </div>
        <button type="submit" className="btn btn-primary" disabled={saving || !busyUserName || !busyPassword}>
          {saving ? 'Checking with Busy…' : 'Verify & link'}
        </button>
      </div>
    </form>
  );
}
