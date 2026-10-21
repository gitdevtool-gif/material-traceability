import React, { useEffect, useMemo, useState } from 'react';
import api from '../services/api';

/**
 * Weighbridge — stage 2 of a delivery (reworked 2026-10-21).
 *
 * The gate only records who came and what is on the truck. Here the
 * operator records the weighbridge ticket (one per truck), the weights, and
 * the supplier's Busy PO line each material is delivered against — or why
 * it is not on a PO. The PO line is what Stores later receive (GRN) against
 * in Busy.
 */
const fmtDT = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
const fmtDate = (v) => (v ? new Date(v).toLocaleDateString() : '—');
const fmtQty = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 }));
const fmtTime = (v) => {
  const s = String(v || '');
  return s.length > 10 ? s.slice(11, 16) : s.slice(0, 5);
};

function blankItemWeight(item) {
  return {
    entryItemId: item ? item.EntryItemId : null,
    materialName: item ? item.MaterialName : '',
    busyItemCode: item ? item.BusyItemCode : null,
    currentRefCode: item ? item.BusyPORefCode : null,
    uom: item ? item.UOM : 'kg',
    poRefCode: '',
    firstWeight: '',
    secondWeight: '',
    netWeight: '',
    deductBagWeight: false,
    bagWeight: '',
    finalNetWeight: '',
    remarks: '',
  };
}

const matches = (entry, q) => {
  if (!q) return true;
  const hay = [
    entry.EntryNo, entry.SupplierName, entry.SupplierCode, entry.VehicleRegNo, entry.DriverName,
    entry.ConsignmentNo, entry.Notes, fmtDate(entry.DeliveryDate),
    ...(entry.items || []).flatMap((i) => [i.MaterialName, i.BusyPONo]),
  ].join(' ').toLowerCase();
  // Every word must appear somewhere: "kda maize" finds KDA 123B carrying maize.
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w) || hay.replace(/\s+/g, '').includes(w));
};

export default function WeighbridgePage() {
  const [pending, setPending] = useState([]);
  const [loadingList, setLoadingList] = useState(false);
  const [search, setSearch] = useState('');
  const [locations, setLocations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [itemWeights, setItemWeights] = useState([]);
  const [entryForm, setEntryForm] = useState({ ticketNo: '', nonPOReason: '', destination: '', locationId: '', skipQA: false });
  const [poLines, setPoLines] = useState([]);
  const [poState, setPoState] = useState({ loading: false, busySupplier: true, message: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const loadPending = () => {
    setLoadingList(true);
    api.get('/weighbridge').then((r) => setPending(r.data)).catch(() => {}).finally(() => setLoadingList(false));
  };

  useEffect(() => {
    loadPending();
    api.get('/locations').then((r) => setLocations(r.data)).catch(() => {});
  }, []);

  const shown = useMemo(() => pending.filter((p) => matches(p, search.trim())), [pending, search]);

  const handleSelect = (entry) => {
    setSelected(entry);
    const itemList = entry.items || [];
    setItemWeights(itemList.length > 0 ? itemList.map((i) => blankItemWeight(i)) : [blankItemWeight(null)]);
    setEntryForm({ ticketNo: '', nonPOReason: '', destination: '', locationId: '', skipQA: false });
    setError('');
    setSuccess('');

    // The supplier's open Busy PO lines; pre-pick the obvious one per item.
    setPoLines([]);
    setPoState({ loading: true, busySupplier: true, message: '' });
    api.get('/busy-receiving/open-po-lines', { params: { supplierId: entry.SupplierId } })
      .then((r) => {
        const lines = r.data.lines || [];
        setPoLines(lines);
        setPoState({ loading: false, busySupplier: r.data.busySupplier !== false, message: r.data.message || '' });
        setItemWeights((rows) => rows.map((row) => {
          const forItem = lines.filter((l) => l.itemCode === row.busyItemCode);
          const current = forItem.find((l) => l.refCode === row.currentRefCode);
          const pick = current || (forItem.length === 1 ? forItem[0] : null);
          return pick ? { ...row, poRefCode: String(pick.refCode) } : row;
        }));
      })
      .catch((e) => setPoState({ loading: false, busySupplier: true, message: e.response?.data?.error || 'Could not load the supplier\'s POs from Busy' }));
  };

  const onSearchKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (shown.length === 1) handleSelect(shown[0]);
    }
    if (e.key === 'Escape') setSearch('');
  };

  const isMultiItem = selected && (selected.items || []).length > 1;

  const updateItemWeight = (idx, field, value) => {
    setItemWeights((prev) => {
      const updated = [...prev];
      const row = { ...updated[idx], [field]: value };

      // Recalculate netWeight
      const f = parseFloat(row.firstWeight);
      const s = parseFloat(row.secondWeight);
      row.netWeight =
        !isNaN(f) && !isNaN(s) && (f > 0 || s > 0)
          ? Math.abs(f - s).toFixed(2)
          : '';

      // Recalculate finalNetWeight
      if (row.deductBagWeight) {
        const bagW = parseFloat(row.bagWeight);
        const net = parseFloat(row.netWeight);
        if (!isNaN(bagW) && bagW > 0 && !isNaN(net)) {
          row.finalNetWeight = (net - bagW).toFixed(2);
        } else {
          row.finalNetWeight = row.netWeight;
        }
      } else {
        row.finalNetWeight = row.netWeight;
        row.bagWeight = '';
      }

      updated[idx] = row;
      return updated;
    });
  };

  const linesFor = (row) => poLines.filter((l) => l.itemCode === row.busyItemCode);
  // Busy items that go through without a PO line need a reason.
  const offPoItems = poState.busySupplier
    ? itemWeights.filter((r) => r.busyItemCode && !r.poRefCode)
    : [];

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!entryForm.ticketNo.trim()) { setError('Enter the weighbridge ticket number'); return; }
    for (const it of itemWeights) {
      if (!it.firstWeight || !it.secondWeight) {
        setError(isMultiItem ? `Enter weights for: ${it.materialName}` : 'Enter 1st and 2nd weight');
        return;
      }
      // Guard: bag weight must not exceed net weight
      if (it.deductBagWeight) {
        const bag = parseFloat(it.bagWeight) || 0;
        const net = parseFloat(it.netWeight) || 0;
        if (bag >= net) {
          setError(
            `Bag weight (${bag} kg) must be less than net weight (${net} kg)` +
            (isMultiItem ? ` for: ${it.materialName}` : '')
          );
          return;
        }
      }
    }
    if (offPoItems.length && !entryForm.nonPOReason.trim()) {
      setError(`Choose the PO for ${offPoItems.map((r) => r.materialName).join(', ')}, or give the reason it is not on a PO`);
      return;
    }

    setSaving(true);
    try {
      const res = await api.post('/weighbridge', {
        entryNo: selected.EntryNo,
        ticketNo: entryForm.ticketNo.trim(),
        nonPOReason: offPoItems.length ? entryForm.nonPOReason.trim() : null,
        destination: entryForm.destination,
        locationId: entryForm.locationId ? parseInt(entryForm.locationId, 10) : null,
        skipQA: entryForm.skipQA,
        items: itemWeights.map((it) => {
          const base = {
            entryItemId: it.entryItemId || null,
            busyPORefCode: it.poRefCode ? parseInt(it.poRefCode, 10) : null,
            firstWeight: parseFloat(it.firstWeight),
            secondWeight: parseFloat(it.secondWeight),
            netWeight: parseFloat(it.netWeight),
            remarks: it.remarks || null,
          };
          // Only send bag deduction fields when the user opted in
          if (it.deductBagWeight) {
            base.deductBagWeight = true;
            base.bagWeight = parseFloat(it.bagWeight) || 0;
            base.finalNetWeight = parseFloat(it.finalNetWeight) || base.netWeight;
          }
          return base;
        }),
      });

      const skipped = entryForm.skipQA ? ' (QA Skipped)' : '';
      const dest =
        res.data.destination === 'Factory'
          ? `QA Inspection → Factory${skipped}`
          : 'Central Stores';
      setSuccess(
        `Weighbridge recorded for ${selected.EntryNo} (ticket ${res.data.ticketNo}). ` +
        `Total net: ${res.data.totalNetWeight} kg. ` +
        `${res.data.poNos?.length ? `PO: ${res.data.poNos.join(', ')}. ` : 'Not on a PO. '}` +
        `Routed to: ${dest}`
      );
      setSelected(null);
      setSearch('');
      loadPending();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to record weighbridge');
    } finally {
      setSaving(false);
    }
  };

  // ── PO line picker for one material ───────────────────────────────────────
  const renderPoSelect = (row, idx, compact) => {
    if (!row.busyItemCode) {
      return <span style={{ fontSize: 12, color: '#6b7280' }}>Old entry item — no Busy link</span>;
    }
    if (poState.loading) return <span style={{ fontSize: 12, color: '#6b7280' }}>Checking Busy…</span>;
    if (!poState.busySupplier) return <span style={{ fontSize: 12, color: '#6b7280' }}>Supplier not in Busy</span>;
    const lines = linesFor(row);
    if (lines.length === 0) {
      return <span style={{ fontSize: 12, color: '#b45309' }}>No open PO for this item in Busy</span>;
    }
    return (
      <select
        value={row.poRefCode}
        onChange={(e) => updateItemWeight(idx, 'poRefCode', e.target.value)}
        style={compact ? { minWidth: 200 } : undefined}
      >
        <option value="">— Not on a PO —</option>
        {lines.map((l) => (
          <option key={l.refCode} value={l.refCode}>
            {l.poNo} · pending {fmtQty(l.pending)} {l.unitName || ''}
            {!l.approved ? ' · awaiting approval' : ''}
            {l.atGate ? ` · already on ${l.atGate.entryNos}` : ''}
          </option>
        ))}
      </select>
    );
  };

  // ── Single-item form ──────────────────────────────────────────────────────
  const renderSingleForm = () => {
    const row = itemWeights[0] || blankItemWeight(null);
    const idx = 0;
    return (
      <>
        {row.entryItemId && (
          <div className="form-row">
            <div className="form-group" style={{ minWidth: 280 }}>
              <label>Busy PO for {row.materialName}</label>
              {renderPoSelect(row, idx, false)}
            </div>
          </div>
        )}

        <div className="form-row">
          <div className="form-group">
            <label>1st Weight (kg) *</label>
            <input
              type="number" step="0.01" required value={row.firstWeight}
              onChange={(e) => updateItemWeight(idx, 'firstWeight', e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>2nd Weight (kg) *</label>
            <input
              type="number" step="0.01" required value={row.secondWeight}
              onChange={(e) => updateItemWeight(idx, 'secondWeight', e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>Net Weight (kg)</label>
            <input
              type="number" step="0.01" value={row.netWeight} readOnly
              style={{ background: '#f3f4f6', fontWeight: 600 }}
            />
          </div>
        </div>

        {/* Bag weight deduction — optional per entry */}
        <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox" id="deductBagWeight" checked={row.deductBagWeight}
            onChange={(e) => updateItemWeight(idx, 'deductBagWeight', e.target.checked)}
          />
          <label htmlFor="deductBagWeight" style={{ margin: 0 }}>
            Deduct bag weight from net weight?
          </label>
        </div>

        {row.deductBagWeight && (
          <div className="form-row">
            <div className="form-group">
              <label>Bag Weight to Deduct (kg)</label>
              <input
                type="number" step="0.01" value={row.bagWeight}
                onChange={(e) => updateItemWeight(idx, 'bagWeight', e.target.value)}
                placeholder="e.g. 0.50"
              />
            </div>
            <div className="form-group">
              <label>Final Net Weight (kg)</label>
              <input
                type="number" step="0.01" value={row.finalNetWeight} readOnly
                style={{ background: '#e8f5e9', fontWeight: 600, color: '#2e7d32' }}
              />
            </div>
          </div>
        )}

        <div className="form-group">
          <label>Remarks</label>
          <textarea
            rows="2" value={row.remarks}
            onChange={(e) => updateItemWeight(idx, 'remarks', e.target.value)}
          />
        </div>
      </>
    );
  };

  // ── Per-item table (multiple materials) ───────────────────────────────────
  const renderMultiTable = () => (
    <>
      <h4 style={{ marginBottom: 10 }}>Material Weights</h4>
      <div style={{ overflowX: 'auto', marginBottom: 20 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Material</th>
              <th>Busy PO</th>
              <th>1st Weight (kg)</th>
              <th>2nd Weight (kg)</th>
              <th>Net Weight (kg)</th>
              <th>Deduct Bags?</th>
              <th>Bag Weight (kg)</th>
              <th>Final Net Weight (kg)</th>
              <th>Remarks</th>
            </tr>
          </thead>
          <tbody>
            {itemWeights.map((row, idx) => (
              <tr key={row.entryItemId || idx}>
                <td style={{ whiteSpace: 'nowrap', fontWeight: 500 }}>{row.materialName}</td>
                <td>{renderPoSelect(row, idx, true)}</td>
                <td>
                  <input
                    type="number" step="0.01" required value={row.firstWeight}
                    onChange={(e) => updateItemWeight(idx, 'firstWeight', e.target.value)}
                    style={{ width: 100 }}
                  />
                </td>
                <td>
                  <input
                    type="number" step="0.01" required value={row.secondWeight}
                    onChange={(e) => updateItemWeight(idx, 'secondWeight', e.target.value)}
                    style={{ width: 100 }}
                  />
                </td>
                <td>
                  <input
                    type="number" step="0.01" value={row.netWeight} readOnly
                    style={{ width: 100, background: '#f3f4f6', fontWeight: 600 }}
                  />
                </td>
                <td style={{ textAlign: 'center' }}>
                  <input
                    type="checkbox" checked={row.deductBagWeight}
                    onChange={(e) => updateItemWeight(idx, 'deductBagWeight', e.target.checked)}
                  />
                </td>
                <td>
                  {row.deductBagWeight && (
                    <input
                      type="number" step="0.01" value={row.bagWeight}
                      onChange={(e) => updateItemWeight(idx, 'bagWeight', e.target.value)}
                      placeholder="e.g. 0.50" style={{ width: 100 }}
                    />
                  )}
                </td>
                <td>
                  <input
                    type="number" step="0.01"
                    value={row.finalNetWeight} readOnly
                    style={{
                      width: 100,
                      background: row.deductBagWeight ? '#e8f5e9' : '#f3f4f6',
                      fontWeight: 600,
                      color: row.deductBagWeight ? '#2e7d32' : 'inherit',
                    }}
                  />
                </td>
                <td>
                  <input
                    value={row.remarks}
                    onChange={(e) => updateItemWeight(idx, 'remarks', e.target.value)}
                    style={{ width: 120 }}
                  />
                </td>
              </tr>
            ))}
            {/* Totals row */}
            <tr style={{ background: 'var(--gray-50)', fontWeight: 600 }}>
              <td colSpan={4} style={{ textAlign: 'right', paddingRight: 8 }}>Totals:</td>
              <td>
                {itemWeights.reduce((sum, r) => sum + (parseFloat(r.netWeight) || 0), 0).toFixed(2)} kg
              </td>
              <td></td>
              <td>
                {itemWeights
                  .filter((r) => r.deductBagWeight)
                  .reduce((sum, r) => sum + (parseFloat(r.bagWeight) || 0), 0)
                  .toFixed(2)} kg
              </td>
              <td style={{ color: '#2e7d32' }}>
                {itemWeights.reduce((sum, r) => sum + (parseFloat(r.finalNetWeight) || 0), 0).toFixed(2)} kg
              </td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );

  return (
    <div className="page-container">
      <h2>Weighbridge</h2>

      {success && <div className="alert alert-success">{success}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      <div className="two-col-layout">
        {/* Pending entries list */}
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8 }}>
            <h3 style={{ margin: 0 }}>Waiting to be weighed</h3>
            <button type="button" className="btn btn-outline" style={{ padding: '2px 10px', fontSize: 12 }}
              onClick={loadPending} disabled={loadingList}>
              {loadingList ? 'Loading…' : '↻ Refresh'}
            </button>
          </div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder="Search vehicle, supplier, entry no, driver, material…"
            autoFocus
            style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--gray-300)', borderRadius: 'var(--radius)', marginBottom: 6 }}
          />
          <div style={{ fontSize: 12, color: 'var(--gray-500)', marginBottom: 8 }}>
            {search.trim()
              ? `${shown.length} of ${pending.length} match${shown.length === 1 ? ' — press Enter to weigh it' : ''}`
              : `${pending.length} truck(s) waiting`}
          </div>
          <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Entry No</th>
                  <th>Supplier</th>
                  <th>Vehicle</th>
                  <th>Arrived</th>
                  <th>Materials</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.EntryId} style={{ background: selected?.EntryId === p.EntryId ? '#eff6ff' : undefined }}>
                    <td>{p.EntryNo}</td>
                    <td>{p.SupplierName}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <strong>{p.VehicleRegNo}</strong>
                      {p.DriverName && <div style={{ fontSize: 11, color: 'var(--gray-500)' }}>{p.DriverName}</div>}
                    </td>
                    <td style={{ fontSize: 12, whiteSpace: 'nowrap', color: 'var(--gray-600)' }}>
                      {p.DeliveryDate ? fmtDate(p.DeliveryDate) : '—'}
                      {p.DeliveryTime ? <><br /><span style={{ color: 'var(--gray-500)' }}>{fmtTime(p.DeliveryTime)}</span></> : ''}
                      {p.GateEntryAt && <><br /><span style={{ fontSize: 11, color: 'var(--gray-400)' }}>Logged: {fmtDT(p.GateEntryAt)}</span></>}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {(p.items || []).length ? (p.items || []).map((i) => i.MaterialName).join(', ') : '—'}
                    </td>
                    <td>
                      <button
                        className="btn btn-primary"
                        style={{ padding: '4px 12px', fontSize: 13 }}
                        onClick={() => handleSelect(p)}
                      >
                        Weigh
                      </button>
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan="6" className="text-center text-muted">
                      {search.trim() ? 'Nothing matches — check the spelling or clear the search' : 'No pending entries'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Weighbridge form */}
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Record Weight</h3>
          {!selected ? (
            <p className="text-muted">Search or pick a truck from the list</p>
          ) : (
            <form onSubmit={handleSubmit}>
              {/* Entry summary */}
              <div
                style={{
                  padding: 12,
                  background: 'var(--gray-50)',
                  borderRadius: 'var(--radius)',
                  marginBottom: 16,
                }}
              >
                <strong>{selected.EntryNo}</strong> — {selected.SupplierName}
                <br />
                <span className="text-muted">
                  Vehicle: {selected.VehicleRegNo}{selected.DriverName ? ` · Driver: ${selected.DriverName}` : ''}
                </span>
                {selected.Notes && <div style={{ fontSize: 12, color: 'var(--gray-600)', marginTop: 4 }}>Gate notes: {selected.Notes}</div>}
                {isMultiItem && (
                  <div style={{ color: 'var(--primary)', fontSize: 13, marginTop: 4 }}>
                    {selected.items.length} materials — weigh each separately below
                  </div>
                )}
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Weighbridge Ticket No *</label>
                  <input
                    value={entryForm.ticketNo} autoFocus required
                    onChange={(e) => setEntryForm({ ...entryForm, ticketNo: e.target.value })}
                    placeholder="e.g. 9703"
                  />
                </div>
              </div>

              {poState.message && !poState.loading && (
                <div style={{ fontSize: 12, color: '#b45309', marginBottom: 8 }}>{poState.message}</div>
              )}

              {/* Weight input */}
              {isMultiItem ? renderMultiTable() : renderSingleForm()}

              {offPoItems.length > 0 && !poState.loading && (
                <div className="form-group">
                  <label>Why is {offPoItems.length === 1 ? offPoItems[0].materialName : 'this'} not on a PO? *</label>
                  <input
                    value={entryForm.nonPOReason}
                    onChange={(e) => setEntryForm({ ...entryForm, nonPOReason: e.target.value })}
                    placeholder="e.g. Emergency delivery approved by Ops Manager — PO to follow"
                  />
                  <div style={{ fontSize: 12, color: '#b45309', marginTop: 4 }}>
                    Busy can only receive (GRN) goods against a PO — Procurement must raise it before Stores receive.
                  </div>
                </div>
              )}

              {/* Routing */}
              <h4 style={{ marginBottom: 10 }}>Routing</h4>
              <div className="form-row">
                <div className="form-group">
                  <label>Destination *</label>
                  <select
                    value={entryForm.destination} required
                    onChange={(e) =>
                      setEntryForm({ ...entryForm, destination: e.target.value, locationId: '' })
                    }
                  >
                    <option value="">-- Select Destination --</option>
                    <option value="Factory">Factory (Raw Materials → QA Inspection)</option>
                    <option value="CentralStore">Central Stores (Ingredients, Spare Parts, Packaging)</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Location</label>
                  <select
                    value={entryForm.locationId}
                    onChange={(e) => setEntryForm({ ...entryForm, locationId: e.target.value })}
                  >
                    <option value="">-- Select Location --</option>
                    {locations
                      .filter((l) => !entryForm.destination || l.LocationType === entryForm.destination)
                      .map((l) => (
                        <option key={l.LocationId} value={l.LocationId}>
                          {l.LocationName}
                        </option>
                      ))}
                  </select>
                </div>
              </div>

              {entryForm.destination === 'Factory' && (
                <div className="form-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input
                      type="checkbox" checked={entryForm.skipQA}
                      onChange={(e) => setEntryForm({ ...entryForm, skipQA: e.target.checked })}
                    />
                    Skip QA Inspection (Packaging / Direct materials)
                  </label>
                  {entryForm.skipQA && (
                    <small style={{ color: 'var(--warning)', display: 'block', marginTop: 4 }}>
                      ⚠️ This entry will skip QA and go directly to Ops Manager approval.
                    </small>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button type="submit" className="btn btn-success" disabled={saving || poState.loading}>
                  {saving ? 'Saving…' : 'Confirm Weight'}
                </button>
                <button type="button" className="btn btn-outline" onClick={() => setSelected(null)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
