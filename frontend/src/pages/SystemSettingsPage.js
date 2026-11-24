import React, { useEffect, useState } from 'react';
import api from '../services/api';

// System Settings (2026-10-27) — settings Admin changes here instead of a
// code change (backend: settings.service.js). First: the Raise Order units.

function UnitsSetting({ setting, onSaved }) {
  const [units, setUnits]   = useState(setting.value);
  const [newUnit, setNewUnit] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');
  const [success, setSuccess] = useState('');

  const dirty = JSON.stringify(units) !== JSON.stringify(setting.value);

  const add = (e) => {
    e.preventDefault();
    const u = newUnit.trim().replace(/\s+/g, ' ');
    if (!u) return;
    if (units.some((x) => x.toLowerCase() === u.toLowerCase())) { setError(`"${u}" is already in the list`); return; }
    setUnits([...units, u]);
    setNewUnit('');
    setError('');
    setSuccess('');
  };

  const remove = (u) => { setUnits(units.filter((x) => x !== u)); setSuccess(''); };

  const move = (i, d) => {
    const next = [...units];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setUnits(next);
    setSuccess('');
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await api.put(`/settings/${setting.key}`, { value: units });
      setUnits(res.data.value);
      setSuccess('Saved — the Raise Order page shows the new list straight away');
      onSaved();
    } catch (e) {
      setError(e.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>Units of measure</h3>
      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
        The units a clerk can pick for each item on Raise Order. Removing a unit does not change orders
        already raised with it. Litres stays — fuel orders use it.
        {setting.updatedAt && ` Last changed ${new Date(setting.updatedAt).toLocaleString()}${setting.updatedBy ? ` by ${setting.updatedBy}` : ''}.`}
      </p>

      {error   && <div className="alert alert-error"   style={{ marginBottom: 12 }}>{error}</div>}
      {success && <div className="alert alert-success" style={{ marginBottom: 12 }}>{success}</div>}

      <table className="data-table" style={{ maxWidth: 480 }}>
        <thead><tr><th style={{ width: 40 }}>#</th><th>Unit</th><th style={{ width: 150 }}></th></tr></thead>
        <tbody>
          {units.map((u, i) => (
            <tr key={u}>
              <td>{i + 1}</td>
              <td>{u}</td>
              <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                <button className="btn btn-sm btn-secondary" disabled={i === 0} onClick={() => move(i, -1)} title="Move up">↑</button>{' '}
                <button className="btn btn-sm btn-secondary" disabled={i === units.length - 1} onClick={() => move(i, 1)} title="Move down">↓</button>{' '}
                <button className="btn btn-sm btn-danger" disabled={u.toLowerCase() === 'litres'} onClick={() => remove(u)}>Remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form onSubmit={add} style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="form-input" style={{ maxWidth: 220 }} maxLength={20} placeholder="New unit, e.g. Bags"
          value={newUnit} onChange={(e) => setNewUnit(e.target.value)} />
        <button type="submit" className="btn btn-secondary" disabled={!newUnit.trim()}>+ Add</button>
        <div style={{ flex: 1 }} />
        {dirty && <button type="button" className="btn btn-secondary" onClick={() => { setUnits(setting.value); setError(''); }}>Undo changes</button>}
        <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </form>
    </div>
  );
}

// Direct-supply items (2026-11-24): Busy item names bought from standing
// suppliers at their standing price — "Raise direct POs", no RFQ.
function DirectItemsSetting({ setting, onSaved }) {
  const [items, setItems] = useState(setting.value);
  const [newItem, setNewItem] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const dirty = JSON.stringify(items) !== JSON.stringify(setting.value);

  const add = (e) => {
    e.preventDefault();
    const n = newItem.trim().replace(/\s+/g, ' ');
    if (!n) return;
    if (items.some((x) => x.toLowerCase() === n.toLowerCase())) { setError(`"${n}" is already in the list`); return; }
    setItems([...items, n]);
    setNewItem('');
    setError('');
    setSuccess('');
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await api.put(`/settings/${setting.key}`, { value: items });
      setItems(res.data.value);
      setSuccess('Saved — Requisitions and the Direct Supply page use the new list within a minute');
      onSaved();
    } catch (e) {
      setError(e.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>Direct-supply items (no RFQ)</h3>
      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
        Items bought from standing suppliers at their standing price (each supplier's last Busy PO for the item) —
        Procurement raises the POs straight from the requisition with "Raise direct POs", and production plans the
        daily deliveries. Use the exact Busy item name. Removing an item sends it back to the normal RFQ path.
        {setting.updatedAt && ` Last changed ${new Date(setting.updatedAt).toLocaleString()}${setting.updatedBy ? ` by ${setting.updatedBy}` : ''}.`}
      </p>
      {error   && <div className="alert alert-error"   style={{ marginBottom: 12 }}>{error}</div>}
      {success && <div className="alert alert-success" style={{ marginBottom: 12 }}>{success}</div>}
      <table className="data-table" style={{ maxWidth: 480 }}>
        <thead><tr><th>Busy item</th><th style={{ width: 90 }}></th></tr></thead>
        <tbody>
          {items.length === 0 && <tr><td colSpan={2} style={{ color: '#6b7280' }}>None — every item goes through an RFQ.</td></tr>}
          {items.map((n) => (
            <tr key={n}>
              <td>{n}</td>
              <td style={{ textAlign: 'right' }}>
                <button className="btn btn-sm btn-danger" onClick={() => { setItems(items.filter((x) => x !== n)); setSuccess(''); }}>Remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={add} style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="form-input" style={{ maxWidth: 280 }} maxLength={40} placeholder="Busy item name, e.g. SAW DUST IN TONNES"
          value={newItem} onChange={(e) => setNewItem(e.target.value)} />
        <button type="submit" className="btn btn-secondary" disabled={!newItem.trim()}>+ Add</button>
        <div style={{ flex: 1 }} />
        {dirty && <button type="button" className="btn btn-secondary" onClick={() => { setItems(setting.value); setError(''); }}>Undo changes</button>}
        <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
      </form>
    </div>
  );
}

export default function SystemSettingsPage() {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');

  const load = () => {
    api.get('/settings')
      .then((res) => setSettings(res.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load the settings'));
  };

  useEffect(() => { load(); }, []);

  const units = settings?.find((s) => s.key === 'requisition.units');
  const directItems = settings?.find((s) => s.key === 'directSupply.items');

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">System Settings</h1>
          <p className="page-subtitle">Settings you can change here without a system update.</p>
        </div>
      </div>
      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}
      {!settings && !error && <div className="text-muted">Loading…</div>}
      {units && <UnitsSetting key={units.updatedAt || 'default'} setting={units} onSaved={load} />}
      {directItems && <DirectItemsSetting key={directItems.updatedAt || 'default'} setting={directItems} onSaved={load} />}
    </div>
  );
}
