import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Select from 'react-select';
import AsyncSelect from 'react-select/async';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';

/**
 * Gate entry — stage 1 of a delivery (reworked 2026-10-21).
 *
 * The gate records WHO came (the supplier's Busy account, vehicle, driver)
 * and WHAT is on the truck (Busy items) — no quantities and no PO. The
 * weighbridge (stage 2) records the ticket, the weight and the Busy PO line
 * of each item. Items the supplier has on order in Busy are offered as
 * one-click buttons; anything else is searched in Busy's item list.
 */
const GATE_STAGE = ['GateReceived', 'WeighbridgePending'];

const blankForm = () => ({
  supplierId: '', deliveryDate: new Date().toISOString().slice(0, 10),
  deliveryTime: new Date().toTimeString().slice(0, 5),
  vehicleRegNo: '', driverName: '', driverIdNo: '', driverPhone: '', notes: '',
});

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
  const [entryStatus, setEntryStatus] = useState('');
  const [items, setItems] = useState([]);             // Busy items: { item: {itemCode,itemName,unitName}, description }
  const [legacyItems, setLegacyItems] = useState([]); // old entries' non-Busy items (edit mode only)
  const [lockedItems, setLockedItems] = useState([]); // already weighed — shown, not editable
  const [onOrder, setOnOrder] = useState([]);         // distinct items on the supplier's open Busy POs
  const [onOrderNote, setOnOrderNote] = useState('');

  const itemsLocked = isEdit && entryStatus && !GATE_STAGE.includes(entryStatus);

  const selectStyles = {
    control: (base) => ({ ...base, minHeight: 38 }),
    menu: (base) => ({ ...base, zIndex: 10 }),
  };

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

  // Load existing entry for edit mode
  useEffect(() => {
    if (!isEdit) return;
    setLoadingEntry(true);
    api.get(`/entries/${entryNo}`)
      .then((r) => {
        const e = r.data;
        setEntryStatus(e.Status);
        setForm({
          supplierId: String(e.SupplierId),
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
        if (GATE_STAGE.includes(e.Status)) {
          setItems(busyItems);
          setLegacyItems(legacy);
        } else {
          setLockedItems((e.items || []).map((it) => ({ name: it.MaterialName, po: it.BusyPONo })));
        }
      })
      .catch(() => setError('Failed to load entry'))
      .finally(() => setLoadingEntry(false));
  }, [entryNo, isEdit]);

  // What this supplier has on order in Busy — one-click material buttons.
  useEffect(() => {
    if (!form.supplierId || itemsLocked) { setOnOrder([]); setOnOrderNote(''); return; }
    api.get('/busy-receiving/open-po-lines', { params: { supplierId: form.supplierId } })
      .then((r) => {
        const byCode = new Map();
        for (const l of r.data.lines || []) {
          if (!byCode.has(l.itemCode)) byCode.set(l.itemCode, { itemCode: l.itemCode, itemName: l.itemName, unitName: l.unitName });
        }
        setOnOrder([...byCode.values()]);
        setOnOrderNote(r.data.message || (byCode.size ? '' : 'Nothing on order from this supplier in Busy — search the material below.'));
      })
      .catch(() => { setOnOrder([]); setOnOrderNote(''); });
  }, [form.supplierId, itemsLocked]);

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
  const selectedSupplier = supplierOptions.find((o) => o.value === parseInt(form.supplierId, 10)) || null;

  const hasItem = (code) => items.some((x) => x.item.itemCode === code);
  const addItem = (item) => {
    if (!item || hasItem(item.itemCode)) return;
    setItems((cur) => [...cur, { item, description: '' }]);
  };
  const setItemRemark = (i) => (e) => setItems(items.map((x, idx) => (idx === i ? { ...x, description: e.target.value } : x)));
  const removeItem = (i) => setItems(items.filter((_, idx) => idx !== i));

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

  const itemCount = itemsLocked ? lockedItems.length : items.length + legacyItems.length;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!form.supplierId) { setError('Pick the supplier'); return; }
    if (itemCount === 0) { setError('Add the materials that are on the truck'); return; }

    setSaving(true);
    try {
      const payload = {
        ...form,
        supplierId: parseInt(form.supplierId, 10),
        items: itemsLocked ? [] : [
          ...items.map((x) => ({
            busyItemCode: x.item.itemCode,
            // also sent as a plain name so the server's pre-migration path still works
            erpProductName: x.item.itemName,
            quantity: null,
            description: x.description,
          })),
          ...legacyItems.map((x) => ({ materialId: x.materialId, quantity: x.quantity, description: x.description })),
        ],
      };
      if (isEdit) {
        const res = await api.put(`/entries/${entryNo}`, payload);
        alert(res.data.message || `Entry ${entryNo} updated`);
        navigate('/entries');
      } else {
        const res = await api.post('/entries', payload);
        alert(`Entry created: ${res.data.EntryNo}\nNext: weighbridge (ticket, weight and PO).`);
        // Ready for the next truck; keep the date.
        setForm({ ...blankForm(), deliveryDate: form.deliveryDate });
        setItems([]);
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
          Record who came and what is on the truck. The weighbridge records the ticket, the weight and the PO.
        </div>

        <h3 style={{ marginBottom: 16 }}>Delivery Details</h3>

        <div className="form-row">
          <div className="form-group" style={{ minWidth: 280 }}>
            <label>Supplier (Busy account) *</label>
            <Select
              options={supplierOptions}
              value={selectedSupplier}
              onChange={(opt) => setForm({ ...form, supplierId: opt ? String(opt.value) : '' })}
              placeholder="Search supplier..."
              noOptionsMessage={() => 'Not in Busy — ask Procurement/Accounts to create the supplier in Busy, then Refresh'}
              isClearable
              isSearchable
              autoFocus={!isEdit}
              styles={selectStyles}
            />
            <button type="button" className="btn btn-outline" style={{ marginTop: 6, fontSize: 12, padding: '2px 8px' }}
              onClick={refreshSuppliersFromBusy} disabled={syncing}>
              {syncing ? 'Refreshing…' : '↻ Refresh suppliers from Busy'}
            </button>
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
            <label>Vehicle Registration No *</label>
            <input value={form.vehicleRegNo} onChange={set('vehicleRegNo')} onBlur={lookupDriver}
              placeholder="e.g. KDA 123B" style={{ textTransform: 'uppercase' }} required />
          </div>
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

        <h3 style={{ margin: '20px 0 8px' }}>Materials on the truck *</h3>

        {itemsLocked ? (
          <div style={{ fontSize: 13, marginBottom: 12 }}>
            <div style={{ color: '#6b7280', marginBottom: 6 }}>
              Already weighed — the materials can no longer be changed here.
            </div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {lockedItems.map((x, i) => <li key={i}>{x.name}{x.po ? ` — ${x.po}` : ''}</li>)}
            </ul>
          </div>
        ) : (
          <>
            {form.supplierId && onOrder.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>On order from this supplier in Busy — click to add:</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {onOrder.map((it) => (
                    <button key={it.itemCode} type="button"
                      className={hasItem(it.itemCode) ? 'btn btn-primary' : 'btn btn-outline'}
                      style={{ fontSize: 12, padding: '4px 10px' }}
                      onClick={() => (hasItem(it.itemCode)
                        ? setItems(items.filter((x) => x.item.itemCode !== it.itemCode))
                        : addItem(it))}>
                      {hasItem(it.itemCode) ? '✓ ' : '+ '}{it.itemName}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {onOrderNote && <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>{onOrderNote}</div>}

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

            {(items.length > 0 || legacyItems.length > 0) && (
              <table className="data-table" style={{ fontSize: 13, marginBottom: 12 }}>
                <thead>
                  <tr><th>Material</th><th>Unit</th><th>Remarks (optional)</th><th /></tr>
                </thead>
                <tbody>
                  {items.map((x, i) => (
                    <tr key={x.item.itemCode}>
                      <td style={{ fontWeight: 500 }}>{x.item.itemName}</td>
                      <td>{x.item.unitName || '—'}</td>
                      <td><input value={x.description} onChange={setItemRemark(i)} placeholder="e.g. 40 bags, damaged crates" /></td>
                      <td><button type="button" className="btn btn-danger" style={{ padding: '2px 8px' }} onClick={() => removeItem(i)}>✕</button></td>
                    </tr>
                  ))}
                  {legacyItems.map((x) => (
                    <tr key={`legacy-${x.materialId}`}>
                      <td>{x.name}</td>
                      <td colSpan={3} style={{ color: '#6b7280' }}>Recorded before the Busy link — kept as it is</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Update Entry' : 'Create Gate Entry'}
          </button>
          {!isEdit && <span style={{ fontSize: 12, color: '#6b7280' }}>{itemCount} material(s)</span>}
          {isEdit && <button type="button" className="btn btn-outline" onClick={() => navigate('/entries')}>Cancel</button>}
        </div>
      </form>
      )}
    </div>
  );
}
