import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Select from 'react-select';
import AsyncSelect from 'react-select/async';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';

/**
 * Gate entry — stage 1 of a delivery (reworked 2026-10-21, several suppliers
 * per truck 2026-10-22).
 *
 * The gate records WHO came (vehicle, driver, and the Busy supplier account
 * of every supplier whose goods are on the truck) and WHAT is on the truck
 * (Busy items, each under its supplier) — never quantities and never a PO.
 * The weighbridge (stage 2) records the ticket, the weight and the Busy PO
 * line of each item. A truck carrying goods from several suppliers becomes
 * one entry per supplier, sharing the truck's consignment number.
 */
const GATE_STAGE = ['GateReceived', 'WeighbridgePending'];

const blankForm = () => ({
  deliveryDate: new Date().toISOString().slice(0, 10),
  deliveryTime: new Date().toTimeString().slice(0, 5),
  vehicleRegNo: '', driverName: '', driverIdNo: '', driverPhone: '', notes: '',
});
let groupSeq = 1;
const blankGroup = () => ({ key: groupSeq++, supplierId: '', items: [], legacyItems: [] });

const selectStyles = {
  control: (base) => ({ ...base, minHeight: 38 }),
  menu: (base) => ({ ...base, zIndex: 10 }),
};

/** One supplier on the truck and the materials they sent. */
function SupplierBlock({ index, group, supplierOptions, usedSupplierIds, canRemove, onChange, onRemove }) {
  const [onOrder, setOnOrder] = useState([]);   // distinct items on this supplier's open Busy POs
  const [onOrderNote, setOnOrderNote] = useState('');

  useEffect(() => {
    if (!group.supplierId) { setOnOrder([]); setOnOrderNote(''); return; }
    api.get('/busy-receiving/open-po-lines', { params: { supplierId: group.supplierId } })
      .then((r) => {
        const byCode = new Map();
        for (const l of r.data.lines || []) {
          if (!byCode.has(l.itemCode)) byCode.set(l.itemCode, { itemCode: l.itemCode, itemName: l.itemName, unitName: l.unitName });
        }
        setOnOrder([...byCode.values()]);
        setOnOrderNote(r.data.message || (byCode.size ? '' : 'Nothing on order from this supplier in Busy — search the material below.'));
      })
      .catch(() => { setOnOrder([]); setOnOrderNote(''); });
  }, [group.supplierId]);

  const items = group.items;
  const hasItem = (code) => items.some((x) => x.item.itemCode === code);
  const setItems = (next) => onChange({ ...group, items: next });
  const addItem = (item) => { if (item && !hasItem(item.itemCode)) setItems([...items, { item, description: '' }]); };
  const toggleItem = (item) => (hasItem(item.itemCode) ? setItems(items.filter((x) => x.item.itemCode !== item.itemCode)) : addItem(item));

  const searchBusyItems = (input) =>
    input.trim().length < 2
      ? Promise.resolve([])
      : api.get('/busy-receiving/items', { params: { search: input } })
        .then((r) => r.data.map((it) => ({
          value: it.itemCode,
          label: `${it.itemName}${it.alias ? ` (${it.alias})` : ''} · ${it.unitName || ''}`,
          item: it,
          isDisabled: hasItem(it.itemCode),
        })));

  const selected = supplierOptions.find((o) => o.value === parseInt(group.supplierId, 10)) || null;

  return (
    <div style={{ border: '1px solid var(--gray-200, #e5e7eb)', borderRadius: 8, padding: 14, marginBottom: 14, background: index % 2 ? '#fafafa' : '#fff' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 10 }}>
        <div className="form-group" style={{ minWidth: 320, flex: 1, margin: 0 }}>
          <label>Supplier {index + 1} (Busy account) *</label>
          <Select
            options={supplierOptions.map((o) => ({ ...o, isDisabled: usedSupplierIds.includes(o.value) && o.value !== selected?.value }))}
            value={selected}
            onChange={(opt) => onChange({ ...group, supplierId: opt ? String(opt.value) : '', items: [] })}
            placeholder="Search supplier..."
            noOptionsMessage={() => 'Not in Busy — ask Procurement/Accounts to create the supplier in Busy, then Refresh'}
            isClearable
            isSearchable
            autoFocus={index > 0}
            styles={selectStyles}
          />
        </div>
        {canRemove && (
          <button type="button" className="btn btn-outline" style={{ color: 'var(--danger)' }} onClick={onRemove}>Remove this supplier</button>
        )}
      </div>

      {group.supplierId && onOrder.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>On order from this supplier in Busy — click to add:</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {onOrder.map((it) => (
              <button key={it.itemCode} type="button"
                className={hasItem(it.itemCode) ? 'btn btn-primary' : 'btn btn-outline'}
                style={{ fontSize: 12, padding: '4px 10px' }}
                onClick={() => toggleItem(it)}>
                {hasItem(it.itemCode) ? '✓ ' : '+ '}{it.itemName}
              </button>
            ))}
          </div>
        </div>
      )}
      {onOrderNote && <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>{onOrderNote}</div>}

      {group.supplierId && (
        <div className="form-group" style={{ maxWidth: 520 }}>
          <label>{onOrder.length ? 'Something else? Search Busy items' : 'Search Busy items'}</label>
          <AsyncSelect
            cacheOptions
            loadOptions={searchBusyItems}
            value={null}
            onChange={(opt) => opt && addItem(opt.item)}
            placeholder="Type 2+ letters of the material..."
            noOptionsMessage={({ inputValue }) => (inputValue.trim().length < 2 ? 'Type 2+ letters' : 'No Busy item found')}
            styles={selectStyles}
          />
        </div>
      )}

      {(items.length > 0 || group.legacyItems.length > 0) && (
        <table className="data-table" style={{ fontSize: 13, marginBottom: 4 }}>
          <thead>
            <tr><th>Material</th><th>Unit</th><th>Remarks (optional)</th><th /></tr>
          </thead>
          <tbody>
            {items.map((x, i) => (
              <tr key={x.item.itemCode}>
                <td style={{ fontWeight: 500 }}>{x.item.itemName}</td>
                <td>{x.item.unitName || '—'}</td>
                <td>
                  <input value={x.description} placeholder="e.g. condition of goods, delivery note no."
                    onChange={(e) => setItems(items.map((y, k) => (k === i ? { ...y, description: e.target.value } : y)))} />
                </td>
                <td><button type="button" className="btn btn-danger" style={{ padding: '2px 8px' }}
                  onClick={() => setItems(items.filter((_, k) => k !== i))}>✕</button></td>
              </tr>
            ))}
            {group.legacyItems.map((x) => (
              <tr key={`legacy-${x.materialId}`}>
                <td>{x.name}</td>
                <td colSpan={3} style={{ color: '#6b7280' }}>Recorded before the Busy link — kept as it is</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ fontSize: 11, color: '#6b7280' }}>No quantities here — the weighbridge records the weight.</div>
    </div>
  );
}

export default function GateEntryPage() {
  const navigate = useNavigate();
  const { entryNo } = useParams();
  const { user } = useAuth();
  const isEdit = Boolean(entryNo);
  const [suppliers, setSuppliers] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingEntry, setLoadingEntry] = useState(false);
  const [error, setError] = useState('');
  const [driverHint, setDriverHint] = useState('');

  const [form, setForm] = useState(blankForm);
  const [groups, setGroups] = useState(() => [blankGroup()]); // one per supplier on the truck
  const [entryStatus, setEntryStatus] = useState('');
  const [lockedItems, setLockedItems] = useState([]); // already weighed — shown, not editable

  const itemsLocked = isEdit && entryStatus && !GATE_STAGE.includes(entryStatus);

  // Admins editing old entries may need a gate-created supplier; the gate only ever sees Busy suppliers.
  const loadSuppliers = useCallback(() => {
    const busyOnly = !(isEdit && user?.role === 'Admin');
    return api.get(`/suppliers?active=true${busyOnly ? '&busyOnly=true' : ''}`).then((r) => setSuppliers(r.data));
  }, [isEdit, user?.role]);

  useEffect(() => { loadSuppliers(); }, [loadSuppliers]);

  const refreshSuppliersFromBusy = async () => {
    setSyncing(true);
    setError('');
    try {
      await api.post('/suppliers/sync');
      await loadSuppliers();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not refresh suppliers from Busy');
    } finally {
      setSyncing(false);
    }
  };

  // Load existing entry for edit mode (one entry = one supplier)
  useEffect(() => {
    if (!isEdit) return;
    setLoadingEntry(true);
    api.get(`/entries/${entryNo}`)
      .then((r) => {
        const e = r.data;
        setEntryStatus(e.Status);
        setForm({
          consignmentNo: e.ConsignmentNo || '',
          deliveryDate: e.DeliveryDate ? e.DeliveryDate.slice(0, 10) : '',
          deliveryTime: e.DeliveryTime ? e.DeliveryTime.slice(11, 16) || e.DeliveryTime.slice(0, 5) : '',
          vehicleRegNo: e.VehicleRegNo || '',
          driverName: e.DriverName || '',
          driverIdNo: e.DriverIdNo || '',
          driverPhone: e.DriverPhone || '',
          notes: e.Notes || '',
        });
        const busyItems = [];
        const legacy = [];
        for (const it of e.items || []) {
          if (it.BusyItemCode) {
            busyItems.push({ item: { itemCode: it.BusyItemCode, itemName: it.MaterialName, unitName: it.UOM }, description: it.Description || '' });
          } else {
            legacy.push({ materialId: it.MaterialId, name: it.MaterialName, quantity: it.Quantity ?? null, description: it.Description || '' });
          }
        }
        const g = { ...blankGroup(), supplierId: String(e.SupplierId) };
        if (GATE_STAGE.includes(e.Status)) {
          g.items = busyItems;
          g.legacyItems = legacy;
        } else {
          setLockedItems((e.items || []).map((it) => ({ name: it.MaterialName, po: it.BusyPONo })));
        }
        setGroups([g]);
      })
      .catch(() => setError('Failed to load entry'))
      .finally(() => setLoadingEntry(false));
  }, [entryNo, isEdit]);

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  // Same truck, same driver, most of the time: offer the last driver seen with this plate.
  const lookupDriver = () => {
    const reg = form.vehicleRegNo.trim().replace(/\s+/g, ' ').toUpperCase();
    if (reg !== form.vehicleRegNo) setForm((f) => ({ ...f, vehicleRegNo: reg }));
    if (isEdit || reg.length < 4 || form.driverName) return;
    api.get('/entries', { params: { search: reg, limit: 5 } })
      .then((r) => {
        const last = (r.data.data || []).find((x) => String(x.VehicleRegNo || '').toUpperCase() === reg && x.DriverName);
        if (!last) return;
        setForm((f) => (f.driverName ? f : {
          ...f, driverName: last.DriverName || '', driverIdNo: last.DriverIdNo || '', driverPhone: last.DriverPhone || '',
        }));
        setDriverHint(`Driver filled in from ${last.EntryNo} — change it if someone else is driving.`);
      })
      .catch(() => {});
  };

  const supplierOptions = useMemo(() =>
    suppliers.map((s) => ({ value: s.SupplierId, label: `${s.SupplierCode} — ${s.SupplierName}` })),
    [suppliers]
  );
  const usedSupplierIds = groups.map((g) => parseInt(g.supplierId, 10)).filter(Boolean);
  const updateGroup = (key) => (next) => setGroups((gs) => gs.map((g) => (g.key === key ? next : g)));
  const removeGroup = (key) => setGroups((gs) => gs.filter((g) => g.key !== key));
  const materialCount = groups.reduce((n, g) => n + g.items.length + g.legacyItems.length, 0);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (groups.some((g) => !g.supplierId)) { setError('Pick the supplier for every supplier block (or remove the empty one)'); return; }
    if (!itemsLocked) {
      const empty = groups.find((g) => g.items.length + g.legacyItems.length === 0);
      if (empty) {
        const name = supplierOptions.find((o) => o.value === parseInt(empty.supplierId, 10))?.label || 'a supplier';
        setError(`Add the materials on the truck for ${name}`);
        return;
      }
    }

    const itemsOf = (g) => [
      ...g.items.map((x) => ({
        busyItemCode: x.item.itemCode,
        // also sent as a plain name so the server's pre-migration path still works
        erpProductName: x.item.itemName,
        quantity: null, // the gate never records quantities — the weighbridge does
        description: x.description,
      })),
      ...g.legacyItems.map((x) => ({ materialId: x.materialId, quantity: x.quantity, description: x.description })),
    ];

    setSaving(true);
    try {
      if (isEdit) {
        const g = groups[0];
        const res = await api.put(`/entries/${entryNo}`, {
          ...form, supplierId: parseInt(g.supplierId, 10), items: itemsLocked ? [] : itemsOf(g),
        });
        alert(res.data.message || `Entry ${entryNo} updated`);
        navigate('/entries');
      } else {
        const res = await api.post('/entries', {
          ...form,
          suppliers: groups.map((g) => ({ supplierId: parseInt(g.supplierId, 10), items: itemsOf(g) })),
        });
        const made = res.data.entries || [res.data];
        alert(made.length > 1
          ? `Truck ${form.vehicleRegNo} recorded — ${made.length} entries (one per supplier, consignment ${res.data.consignmentNo}):\n`
            + made.map((m) => `${m.EntryNo} — ${m.supplierName || ''}`).join('\n')
            + '\nNext: weighbridge (ticket, weight and PO).'
          : `Entry created: ${made[0].EntryNo}\nNext: weighbridge (ticket, weight and PO).`);
        // Ready for the next truck; keep the date.
        setForm({ ...blankForm(), deliveryDate: form.deliveryDate });
        setGroups([blankGroup()]);
        setDriverHint('');
        window.scrollTo(0, 0);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save entry');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="page-header"><h1>{isEdit ? `Edit Entry: ${entryNo}` : 'New Gate Entry'}</h1></div>
      {error && <div className="card" style={{ color: 'var(--danger)' }}>{error}</div>}
      {loadingEntry ? <div className="card">Loading entry…</div> : (
      <form className="card" onSubmit={handleSubmit}>
        <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
          Record the truck and what is on it, per supplier. No quantities — the weighbridge records the ticket, the weight and the PO.
        </div>

        <h3 style={{ marginBottom: 16 }}>Truck</h3>
        <div className="form-row">
          <div className="form-group">
            <label>Vehicle Registration No *</label>
            <input value={form.vehicleRegNo} onChange={set('vehicleRegNo')} onBlur={lookupDriver}
              placeholder="e.g. KDA 123B" style={{ textTransform: 'uppercase' }} required autoFocus={!isEdit} />
          </div>
          <div className="form-group">
            <label>Delivery Date *</label>
            <input type="date" value={form.deliveryDate} onChange={set('deliveryDate')} required />
          </div>
          <div className="form-group">
            <label>Delivery Time *</label>
            <input type="time" value={form.deliveryTime} onChange={set('deliveryTime')} required />
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Driver Name</label>
            <input value={form.driverName} onChange={set('driverName')} />
          </div>
          <div className="form-group">
            <label>Driver ID No</label>
            <input value={form.driverIdNo} onChange={set('driverIdNo')} />
          </div>
          <div className="form-group">
            <label>Driver Phone No</label>
            <input value={form.driverPhone} onChange={set('driverPhone')} placeholder="e.g. 0712345678" />
          </div>
        </div>
        {driverHint && <div style={{ fontSize: 12, color: '#6b7280', margin: '-6px 0 10px' }}>{driverHint}</div>}

        <div className="form-group">
          <label>Notes (delivery note no., etc.)</label>
          <textarea rows="2" value={form.notes} onChange={set('notes')} />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '20px 0 8px', flexWrap: 'wrap', gap: 8 }}>
          <h3 style={{ margin: 0 }}>Suppliers and materials on the truck *</h3>
          <button type="button" className="btn btn-outline" style={{ fontSize: 12, padding: '2px 8px' }}
            onClick={refreshSuppliersFromBusy} disabled={syncing}>
            {syncing ? 'Refreshing…' : '↻ Refresh suppliers from Busy'}
          </button>
        </div>

        {itemsLocked ? (
          <div style={{ fontSize: 13, marginBottom: 12 }}>
            <div className="form-group" style={{ maxWidth: 420 }}>
              <label>Supplier</label>
              <Select options={supplierOptions} styles={selectStyles}
                value={supplierOptions.find((o) => o.value === parseInt(groups[0]?.supplierId, 10)) || null}
                onChange={(opt) => setGroups([{ ...groups[0], supplierId: opt ? String(opt.value) : '' }])} />
            </div>
            <div style={{ color: '#6b7280', marginBottom: 6 }}>Already weighed — the materials can no longer be changed here.</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {lockedItems.map((x, i) => <li key={i}>{x.name}{x.po ? ` — ${x.po}` : ''}</li>)}
            </ul>
          </div>
        ) : (
          <>
            {groups.map((g, i) => (
              <SupplierBlock
                key={g.key}
                index={i}
                group={g}
                supplierOptions={supplierOptions}
                usedSupplierIds={usedSupplierIds}
                canRemove={!isEdit && groups.length > 1}
                onChange={updateGroup(g.key)}
                onRemove={() => removeGroup(g.key)}
              />
            ))}
            {!isEdit && (
              <button type="button" className="btn btn-outline" style={{ marginBottom: 12 }}
                onClick={() => setGroups((gs) => [...gs, blankGroup()])}>
                + Add another supplier on this truck
              </button>
            )}
          </>
        )}

        <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Update Entry' : groups.length > 1 ? `Create ${groups.length} Gate Entries` : 'Create Gate Entry'}
          </button>
          {!isEdit && (
            <span style={{ fontSize: 12, color: '#6b7280' }}>
              {groups.length} supplier(s) · {materialCount} material(s)
            </span>
          )}
          {isEdit && <button type="button" className="btn btn-outline" onClick={() => navigate('/entries')}>Cancel</button>}
        </div>
      </form>
      )}
    </div>
  );
}
