import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Select from 'react-select';
import CreatableSelect from 'react-select/creatable';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';

/**
 * In-system purchase indent creation (2026-09-15) — replaces raising the
 * indent in Busy ERP. A FactoryReceiving clerk is locked to exactly one
 * Mat Centre (Users.AssignedMatCenter, set by Admin) — never picked here,
 * always read from the server. Items are a company-wide dropdown (see
 * requisition-item-catalog.service.js). Submitting sends the requisition
 * to Central Stores for review — see CentralStoresApprovalPage.js.
 *
 * Admin has overall access (2026-09-15) — unlike a clerk, Admin isn't
 * locked to one Mat Centre. They get a Mat Centre picker (every value
 * Busy tracks stock against) and can raise a requisition for any of them.
 *
 * Central Stores can also raise here for themselves (2026-09-21) — locked
 * server-side to the fixed "CENTRAL STORES" Mat Centre, same "never
 * client-supplied" pattern as a clerk's AssignedMatCenter. Since Central
 * Stores IS the reviewer for every other role's requisition, their own
 * skip that review step entirely and land straight on Procurement's
 * queue (or the Ops Manager gate, in principle, though CENTRAL STORES
 * never triggers that) — see requisition-create.routes.js.
 */
const blankRow = () => ({
  itemOption: null,
  qty: '',
  unit: '',
  supplierOption: null,
  preferredBrand: '',
  preferredQuality: '',
});

// Transport fuel line (2026-10-19): litres may be 0 (not known yet), unit price required.
const blankFuelRow = () => ({ itemName: '', litres: '', unitPrice: '', supplierOption: null });

export default function CreateRequisitionPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';

  const [matCenter, setMatCenter]     = useState('');
  const [matCenterOptions, setMatCenterOptions] = useState([]);
  const [itemOptions, setItemOptions] = useState([]);
  const [supplierOptions, setSupplierOptions] = useState([]);
  const [unitOptions, setUnitOptions] = useState([]);
  const [rows, setRows]               = useState([blankRow()]);
  const [loading, setLoading]         = useState(true);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [loadError, setLoadError]     = useState('');
  const [submitting, setSubmitting]   = useState(false);
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState(null); // { busyOrdNo } once created

  // Transport only (2026-10-19): orders are raised per vehicle (Busy cost
  // centre), and fuel orders go straight to Procurement.
  const [isTransport, setIsTransport] = useState(false);
  const [fuelItems, setFuelItems]     = useState([]);
  const [vehicles, setVehicles]       = useState([]);
  const [vehicle, setVehicle]         = useState('');
  const [orderType, setOrderType]     = useState('fuel'); // 'fuel' | 'other'
  const [fuelRows, setFuelRows]       = useState([blankFuelRow()]);

  // fatal=true blocks the whole page (used at initial mount, when there's
  // nothing else useful to show yet); fatal=false shows an inline banner
  // instead (used when Admin picks a different Mat Centre later — a
  // failure there shouldn't wipe out the picker they're using to fix it).
  const loadItemsFor = useCallback(async (mc, fatal) => {
    setItemsLoading(true);
    setError('');
    if (fatal) setLoadError('');
    try {
      const res = await api.get('/procurement/requisitions-create/item-options', { params: { matCenter: mc } });
      setMatCenter(res.data.matCenter);
      setItemOptions((res.data.items || []).map((it) => ({
        value: it.Name,
        label: it.currentstock != null
          ? `${it.Name} — current stock: ${Number(it.currentstock).toLocaleString()}`
          : `${it.Name} — current stock: unknown`,
        currentstock: it.currentstock,
      })));
      setRows([blankRow()]);
      setIsTransport(!!res.data.isTransport);
      setFuelItems(res.data.fuelItems || []);
      setFuelRows([blankFuelRow()]);
      setVehicle('');
      if (res.data.isTransport) {
        const vRes = await api.get('/procurement/requisitions-create/vehicles');
        setVehicles(vRes.data || []);
      }
    } catch (e) {
      const message = e.response?.data?.error || 'Failed to load item list';
      if (fatal) setLoadError(message); else setError(message);
    } finally {
      setItemsLoading(false);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setLoadError('');
      try {
        const [suppliersRes, unitsRes] = await Promise.all([
          api.get('/procurement/requisitions-create/suppliers'),
          api.get('/procurement/requisitions-create/units'),
        ]);
        setSupplierOptions((suppliersRes.data || []).map((s) => ({
          value: s.SupplierId,
          label: s.SupplierName,
        })));
        setUnitOptions(unitsRes.data || []);

        if (isAdmin) {
          const mcRes = await api.get('/procurement/requisitions-create/mat-centers');
          setMatCenterOptions(mcRes.data || []);
          // Nothing to default to — Admin picks one explicitly.
        } else {
          await loadItemsFor(undefined, true);
        }
      } catch (e) {
        setLoadError(e.response?.data?.error || 'Failed to load item list');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [isAdmin, loadItemsFor]);

  const updateRow = (i, patch) =>
    setRows((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      return next;
    });

  const addRow = () => setRows((prev) => [...prev, blankRow()]);
  const removeRow = (i) => setRows((prev) => prev.filter((_, idx) => idx !== i));

  const handleCreateSupplier = (i, inputValue) => {
    const value = inputValue.trim();
    if (!value) return;
    // Not added to the Suppliers master here — just a suggestion for
    // Procurement to see. A real new supplier is added by Procurement/
    // Admin on the Suppliers page, same as everywhere else in this system.
    updateRow(i, { supplierOption: { value: `__new__${value}`, label: value, isNew: true } });
  };

  const updateFuelRow = (i, patch) =>
    setFuelRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const submitFuel = async () => {
    if (!vehicle) { setError('Choose the vehicle the fuel is for'); return; }
    const filled = fuelRows.filter((r) => r.itemName);
    if (filled.length === 0) { setError('Choose Diesel or Petrol'); return; }
    if (filled.some((r) => r.litres !== '' && !(parseFloat(r.litres) >= 0))) {
      setError('Litres must be 0 or more (0 if you are not sure)'); return;
    }
    if (filled.some((r) => !(parseFloat(r.unitPrice) > 0))) {
      setError('Enter the unit price per litre'); return;
    }
    setSubmitting(true);
    try {
      const res = await api.post('/procurement/requisitions-create', {
        matCenter: isAdmin ? matCenter : undefined,
        vehicle,
        items: filled.map((r) => ({
          itemName: r.itemName,
          qty: r.litres === '' ? 0 : parseFloat(r.litres),
          unit: 'Litres',
          unitPrice: parseFloat(r.unitPrice),
          preferredSupplierId: r.supplierOption && !r.supplierOption.isNew ? r.supplierOption.value : undefined,
          preferredSupplierName: r.supplierOption && r.supplierOption.isNew ? r.supplierOption.label : undefined,
        })),
      });
      setSuccess({ busyOrdNo: res.data.busyOrdNo, status: res.data.status, orderType: res.data.orderType });
      setFuelRows([blankFuelRow()]);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to submit fuel order');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (isAdmin && !matCenter) {
      setError('Select a Mat Centre first');
      return;
    }
    if (isTransport && orderType === 'fuel') {
      await submitFuel();
      return;
    }
    const validRows = rows.filter((r) => r.itemOption && parseFloat(r.qty) > 0);
    if (validRows.length === 0) {
      setError('Add at least one item with a quantity');
      return;
    }
    const invalidQty = rows.some((r) => r.itemOption && !(parseFloat(r.qty) > 0));
    if (invalidQty) {
      setError('Every item with a selection needs a quantity greater than 0');
      return;
    }
    const missingUnit = rows.some((r) => r.itemOption && !r.unit);
    if (missingUnit) {
      setError('Every item needs a unit of measure (Kgs, Pcs, Metres, Litres, Set, or Rim)');
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        matCenter: isAdmin ? matCenter : undefined,
        vehicle: isTransport && vehicle ? vehicle : undefined,
        items: validRows.map((r) => ({
          itemName: r.itemOption.value,
          qty: parseFloat(r.qty),
          unit: r.unit,
          preferredSupplierId: r.supplierOption && !r.supplierOption.isNew ? r.supplierOption.value : undefined,
          preferredSupplierName: r.supplierOption && r.supplierOption.isNew ? r.supplierOption.label : undefined,
          preferredBrand: r.preferredBrand || undefined,
          preferredQuality: r.preferredQuality || undefined,
        })),
      };
      const res = await api.post('/procurement/requisitions-create', payload);
      setSuccess({ busyOrdNo: res.data.busyOrdNo, status: res.data.status });
      setRows([blankRow()]);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to submit requisition');
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
      </div>
    );
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Raise Order</h1>
          <p className="page-subtitle">
            {isAdmin
              ? 'Pick any Mat Centre — items and current stock come from Busy live.'
              : <>Requesting for <strong>{matCenter}</strong> — items and current stock come from Busy live.</>}
          </p>
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

      {success && (
        <div className="alert alert-success" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>
            Requisition <strong>{success.busyOrdNo}</strong> submitted — {
              success.orderType === 'Fuel'                       ? "fuel order sent straight to Procurement to raise the PO in Busy."
              : success.status === 'PendingCentralStoresApproval' ? "it's now with Central Stores for review."
              : success.status === 'PendingOpsApproval'         ? "it's now with the Ops Manager for review."
              : "it's now visible to Procurement."
            }
          </span>
          <button className="btn btn-secondary btn-sm" onClick={() => navigate('/procurement/requisition-status')}>
            Track it →
          </button>
        </div>
      )}

      {isAdmin && (
        <div className="card" style={{ marginBottom: 20, maxWidth: 360 }}>
          <label className="form-label">Mat Centre *</label>
          <select className="form-input" value={matCenter}
            onChange={(e) => { const mc = e.target.value; setMatCenter(mc); if (mc) loadItemsFor(mc, false); else setItemOptions([]); }}>
            <option value="">— Select —</option>
            {matCenterOptions.map((mc) => <option key={mc} value={mc}>{mc}</option>)}
          </select>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        {isTransport && (
          <div className="card" style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div>
                <label className="form-label">Order type *</label>
                <div style={{ display: 'flex', gap: 16, paddingTop: 6 }}>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
                    <input type="radio" checked={orderType === 'fuel'} onChange={() => setOrderType('fuel')} /> ⛽ Fuel
                  </label>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
                    <input type="radio" checked={orderType === 'other'} onChange={() => setOrderType('other')} /> Other items
                  </label>
                </div>
              </div>
              <div style={{ flex: '0 1 320px' }}>
                <label className="form-label">Vehicle {orderType === 'fuel' ? '*' : '(optional)'}</label>
                <select className="form-input" value={vehicle} onChange={(e) => setVehicle(e.target.value)}>
                  <option value="">{orderType === 'fuel' ? '— Select vehicle —' : '— Transport store (no vehicle) —'}</option>
                  {vehicles.map((v) => (
                    <option key={v.name} value={v.name}>{v.name}{v.isStore ? '' : ' (posts to Transport store)'}</option>
                  ))}
                </select>
              </div>
            </div>
            {orderType === 'fuel' && (
              <p style={{ fontSize: 12, color: '#6b7280', margin: '10px 0 0' }}>
                Fuel orders go straight to Procurement, who raise the PO in Busy. Not sure of the litres? Leave it at 0 — the unit price is enough.
              </p>
            )}
          </div>
        )}

        {isTransport && orderType === 'fuel' ? (
          <div className="card" style={{ marginBottom: 20 }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 14 }}>Fuel</h3>
            {fuelRows.map((row, i) => (
              <div key={i} style={{
                display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap',
                padding: '12px 0', borderBottom: i < fuelRows.length - 1 ? '1px solid #e5e7eb' : 'none',
              }}>
                <div style={{ flex: '0 1 200px' }}>
                  <label className="form-label">Fuel *</label>
                  <select className="form-input" value={row.itemName} onChange={(e) => updateFuelRow(i, { itemName: e.target.value })}>
                    <option value="">— Select —</option>
                    {fuelItems.map((f) => <option key={f.itemName} value={f.itemName}>{f.label}</option>)}
                  </select>
                </div>
                <div style={{ flex: '0 1 130px' }}>
                  <label className="form-label">Litres</label>
                  <input type="number" className="form-input" min="0" step="0.01" placeholder="0 if not sure"
                    value={row.litres} onChange={(e) => updateFuelRow(i, { litres: e.target.value })} />
                </div>
                <div style={{ flex: '0 1 170px' }}>
                  <label className="form-label">Unit price (KES/L) *</label>
                  <input type="number" className="form-input" min="0" step="0.01"
                    value={row.unitPrice} onChange={(e) => updateFuelRow(i, { unitPrice: e.target.value })} />
                </div>
                <div style={{ flex: '1 1 220px' }}>
                  <label className="form-label">Fuel station (optional)</label>
                  <CreatableSelect
                    options={supplierOptions}
                    value={row.supplierOption}
                    onChange={(opt) => updateFuelRow(i, { supplierOption: opt })}
                    onCreateOption={(value) => updateFuelRow(i, { supplierOption: { value: `__new__${value}`, label: value, isNew: true } })}
                    formatCreateLabel={(value) => `Suggest: ${value}`}
                    placeholder="Search or suggest…"
                    isClearable
                    isSearchable
                  />
                </div>
                <div style={{ flex: '0 0 auto', paddingTop: 22 }}>
                  <button type="button" className="btn btn-danger" disabled={fuelRows.length === 1}
                    onClick={() => setFuelRows((prev) => prev.filter((_, idx) => idx !== i))}>✕</button>
                </div>
              </div>
            ))}
            <button type="button" className="btn btn-outline" style={{ marginTop: 12 }}
              onClick={() => setFuelRows((prev) => [...prev, blankFuelRow()])}>
              + Add Fuel Line
            </button>
          </div>
        ) : (
        <div className="card" style={{ marginBottom: 20, opacity: isAdmin && !matCenter ? 0.5 : 1 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 14 }}>
            Items {itemsLoading && <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 400 }}>(loading…)</span>}
          </h3>
          {isAdmin && !matCenter ? (
            <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>Select a Mat Centre above to see its items.</p>
          ) : rows.map((row, i) => (
            <div key={i} style={{
              display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap',
              padding: '12px 0', borderBottom: i < rows.length - 1 ? '1px solid #e5e7eb' : 'none',
            }}>
              <div style={{ flex: '2 1 280px' }}>
                <label className="form-label">Item *</label>
                <Select
                  options={itemOptions}
                  value={row.itemOption}
                  onChange={(opt) => updateRow(i, { itemOption: opt })}
                  placeholder="Search item…"
                  isClearable
                  isSearchable
                />
              </div>
              <div style={{ flex: '0 1 110px' }}>
                <label className="form-label">Qty *</label>
                <input type="number" className="form-input" min="0" step="0.01"
                  value={row.qty} onChange={(e) => updateRow(i, { qty: e.target.value })} />
              </div>
              <div style={{ flex: '0 1 130px' }}>
                <label className="form-label">Unit *</label>
                <select className="form-input" value={row.unit}
                  onChange={(e) => updateRow(i, { unit: e.target.value })}>
                  <option value="">— Select —</option>
                  {unitOptions.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
              <div style={{ flex: '1 1 220px' }}>
                <label className="form-label">Preferred Supplier (optional)</label>
                <CreatableSelect
                  options={supplierOptions}
                  value={row.supplierOption}
                  onChange={(opt) => updateRow(i, { supplierOption: opt })}
                  onCreateOption={(value) => handleCreateSupplier(i, value)}
                  formatCreateLabel={(value) => `Suggest: ${value}`}
                  placeholder="Search or suggest a supplier…"
                  isClearable
                  isSearchable
                />
              </div>
              <div style={{ flex: '1 1 160px' }}>
                <label className="form-label">Brand (optional)</label>
                <input className="form-input" value={row.preferredBrand}
                  onChange={(e) => updateRow(i, { preferredBrand: e.target.value })} placeholder="e.g. Dorman" />
              </div>
              <div style={{ flex: '1 1 160px' }}>
                <label className="form-label">Quality (optional)</label>
                <input className="form-input" value={row.preferredQuality}
                  onChange={(e) => updateRow(i, { preferredQuality: e.target.value })} placeholder="e.g. Grade A" />
              </div>
              <div style={{ flex: '0 0 auto', paddingTop: 22 }}>
                <button type="button" className="btn btn-danger" disabled={rows.length === 1}
                  onClick={() => removeRow(i)}>✕</button>
              </div>
            </div>
          ))}
          {(!isAdmin || matCenter) && (
            <button type="button" className="btn btn-outline" onClick={addRow} style={{ marginTop: 12 }}>
              + Add Item
            </button>
          )}
        </div>
        )}

        <button type="submit" className="btn btn-primary" disabled={submitting || (isAdmin && !matCenter)}>
          {submitting ? 'Submitting…' : isTransport && orderType === 'fuel' ? 'Submit Fuel Order' : 'Submit Requisition'}
        </button>
      </form>
    </div>
  );
}
