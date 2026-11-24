import React, { useEffect, useState, useCallback } from 'react';
import * as XLSX from 'xlsx';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { planStock } from '../services/stockPlanning';
import PriceHistory from '../components/PriceHistory';

export default function ReorderLevelPage() {
  const { user } = useAuth();
  const canSync = ['Admin', 'Procurement', 'HeadOfProductionPlanning'].includes(user?.role);

  const [items, setItems]           = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [summary, setSummary]       = useState(null);

  // Filters
  const [search, setSearch]                 = useState('');
  const [itemgrp, setItemgrp]                = useState('');
  const [needsReorderOnly, setNeedsReorderOnly] = useState(false);
  const [overstockedOnly, setOverstockedOnly]   = useState(false);
  const [unackOnly, setUnackOnly]            = useState(false);
  // Inventory store (synced, 2026-11-11): '' = both inventories listed side by side
  // (each row is one store's own stock — never combined), or one of them.
  const [inventory, setInventory]           = useState('');
  const [inventoryOptions, setInventoryOptions] = useState([]);
  // Mat Centre view: any other store's own stock and use, live from Busy
  const [store, setStore]                   = useState('');
  const [storeOptions, setStoreOptions]     = useState([]);
  const [exporting, setExporting]           = useState(false);

  // Distinct filter options, derived once from a full pull
  const [itemgrpOptions, setItemgrpOptions]   = useState([]);

  // Pagination
  const [page, setPage]           = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal]         = useState(0);
  const LIMIT = 50;

  // Sync
  const [syncing, setSyncing]     = useState(false);
  const [syncMsg, setSyncMsg]     = useState('');

  // Acknowledge modal
  const [ackTarget, setAckTarget] = useState(null); // row object
  const [ackNotes, setAckNotes]   = useState('');
  const [ackSaving, setAckSaving] = useState(false);

  // Future planning modal ("what if I buy X")
  const [planTarget, setPlanTarget] = useState(null); // row object
  const [planQty, setPlanQty]       = useState('');
  // Per-row "If I buy…" quantities (default: the row's required qty)
  const [buyQty, setBuyQty]         = useState({});

  // Batch drilldown modal
  const [batchTarget, setBatchTarget]         = useState(null); // row object (item clicked)
  const [batchRows, setBatchRows]             = useState([]);
  const [batchTotalSleeping, setBatchTotalSleeping] = useState(0);
  const [batchRecon, setBatchRecon] = useState([]);
  const [batchLoading, setBatchLoading]       = useState(false);
  const [batchError, setBatchError]           = useState('');

  const loadSummary = useCallback(async () => {
    if (store) return; // the store view returns its own summary with the rows
    try {
      const res = await api.get('/procurement/reorder/summary', { params: inventory ? { inventory } : {} });
      setSummary(res.data);
    } catch {
      setSummary(null);
    }
  }, [store, inventory]);

  // The current filters as API params (the table page or, for export, everything).
  const filterParams = useCallback(() => {
    const params = {};
    if (search) params.search = search;
    if (itemgrp) params.itemgrp = itemgrp;
    if (needsReorderOnly) params.needsReorder = 'true';
    if (overstockedOnly) params.overstocked = 'true';
    if (unackOnly && !store) params.acknowledged = 'false';
    if (store) params.store = store;
    else if (inventory) params.inventory = inventory;
    return params;
  }, [search, itemgrp, needsReorderOnly, overstockedOnly, unackOnly, store, inventory]);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { ...filterParams(), page, limit: LIMIT };
      const res = await api.get(store ? '/procurement/reorder/store-view' : '/procurement/reorder', { params });
      setItems(Array.isArray(res.data?.data) ? res.data.data : []);
      setTotalPages(res.data?.totalPages || 1);
      setTotal(res.data?.total || 0);
      if (store && res.data?.summary) setSummary(res.data.summary);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load reorder data');
    } finally {
      setLoading(false);
    }
  }, [page, filterParams, store]);

  // Inventory stores (synced) and the other Mat Centres (live view) for the filter.
  useEffect(() => {
    Promise.all([
      api.get('/procurement/reorder/inventories').then((r) => r.data || []).catch(() => []),
      api.get('/procurement/reorder/stores').then((r) => r.data || []).catch(() => []),
    ]).then(([inv, stores]) => {
      setInventoryOptions(inv);
      const invNames = new Set(inv.map((i) => String(i.Store).toUpperCase()));
      const rank = (n) => (/^F\d/i.test(n) ? 1 : 2);
      setStoreOptions(stores.map((s) => s.name).filter((n) => !invNames.has(String(n).toUpperCase()))
        .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true })));
    });
  }, []);

  // Export everything matching the current filters to Excel (not just this page).
  const exportExcel = async () => {
    setExporting(true);
    try {
      const res = await api.get(store ? '/procurement/reorder/store-view' : '/procurement/reorder', { params: { ...filterParams(), page: 1, limit: 10000 } });
      const rows = (res.data?.data || []).map((r) => ({
        Store: r.Store || store || '',
        Item: r.ItemName,
        'Item group': r.ItemGroup,
        UOM: r.UOM,
        Stock: r.LiveStock,
        'Held in departments': store ? undefined : r.HeldInDepartments,
        'Reorder level': r.ReorderLevel,
        'Minimum level': r.MinimumStockLevel,
        'Maximum level': r.MaxStockLevel,
        'Needs reorder': r.NeedsReorder ? 'Yes' : 'No',
        'Qty to order (to max)': r.RequiredQty,
        Overstocked: r.Overstocked,
        'Use / month (avg 3 mo)': r.AvgMonthlyConsumption,
        'Months of stock': r.MonthsOfSupply,
        'Lead time (days)': r.LeadTimeDays,
        EOQ: r.EOQ,
        'Stock value (KES)': r.StockValue != null ? Math.round(r.StockValue) : null,
        'Busy reorder level': r.BusyReorderLevel,
        'Last used': r.BusyMonthYear,
        Acknowledged: r.AcknowledgedAt ? `${r.AcknowledgedByName || ''} ${fmtDate(r.AcknowledgedAt)}`.trim() : '',
      })).map((o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)));
      const ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = Object.keys(rows[0] || { Item: '' }).map((k) => ({ wch: k === 'Item' ? 42 : k === 'Item group' ? 26 : Math.max(10, k.length + 2) }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Reorder Levels');
      const scope = store || inventory || 'CS-and-F7';
      XLSX.writeFile(wb, `reorder-levels-${scope.replace(/\s+/g, '-')}${needsReorderOnly ? '-needs-reorder' : ''}-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) {
      setError(e.response?.data?.error || 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => { loadSummary(); }, [loadSummary]);
  useEffect(() => { loadItems(); }, [loadItems]);

  // One-time pull of every row to derive distinct item-group dropdown values
  // (~3,900 rows across the two inventory stores as of 2026-11-11).
  useEffect(() => {
    api.get('/procurement/reorder', { params: { limit: 10000, page: 1 } })
      .then(res => {
        const rows = Array.isArray(res.data?.data) ? res.data.data : [];
        setItemgrpOptions([...new Set(rows.map(r => r.ItemGroup).filter(Boolean))].sort());
      })
      .catch(() => {
        setItemgrpOptions([]);
      });
  }, []);

  // Reset to page 1 whenever a filter changes
  useEffect(() => { setPage(1); }, [search, itemgrp, needsReorderOnly, overstockedOnly, unackOnly, store, inventory]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      const res = await api.post('/procurement/reorder/sync');
      setSyncMsg(`Synced ${res.data.synced} item(s) — ${res.data.needsReorder} need reorder.`);
      await Promise.all([loadItems(), loadSummary()]);
    } catch (e) {
      setSyncMsg(e.response?.data?.error || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const openPlan = (row, qty) => { setPlanTarget(row); setPlanQty(qty != null && qty !== '' ? String(qty) : String(Number(row.RequiredQty) || 0)); };
  const closePlan = () => { setPlanTarget(null); setPlanQty(''); };
  const fmtDays = (d) => (d < 1 ? '< 1 day' : `${Math.round(d).toLocaleString()} day${Math.round(d) === 1 ? '' : 's'}`);
  // Short span for table cells: days under 2 months, months beyond.
  const fmtSpan = (d) => (d < 60 ? fmtDays(d) : `${(d / 30).toFixed(1)} months`);

  const openAcknowledge = (row) => {
    setAckTarget(row);
    setAckNotes('');
  };
  const closeAcknowledge = () => { setAckTarget(null); setAckNotes(''); };

  const submitAcknowledge = async () => {
    setAckSaving(true);
    try {
      await api.post(`/procurement/reorder/${ackTarget.ReorderStatusId}/acknowledge`, {
        notes: ackNotes || null,
      });
      closeAcknowledge();
      await Promise.all([loadItems(), loadSummary()]);
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to acknowledge');
    } finally {
      setAckSaving(false);
    }
  };

  const handleUnacknowledge = async (row) => {
    if (!window.confirm(`Undo acknowledgement for "${row.ItemName}"?`)) return;
    try {
      await api.post(`/procurement/reorder/${row.ReorderStatusId}/unacknowledge`);
      await Promise.all([loadItems(), loadSummary()]);
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to unacknowledge');
    }
  };

  // ── Batch drilldown ─────────────────────────────────────────────────────
  // Company-wide, same as reorder status itself — no factory param, since
  // dbo.ReorderStatus rows no longer carry one.
  const openBatches = async (row) => {
    setBatchTarget(row);
    setBatchRows([]);
    setBatchRecon([]);
    setBatchTotalSleeping(0);
    setBatchError('');
    setBatchLoading(true);
    try {
      const res = await api.get('/procurement/reorder/batches', {
        params: { itemName: row.ItemName },
      });
      setBatchRows(Array.isArray(res.data?.data) ? res.data.data : []);
      setBatchTotalSleeping(res.data?.totalSleepingAmount || 0);
      setBatchRecon(Array.isArray(res.data?.reconciliation) ? res.data.reconciliation : []);
    } catch (e) {
      setBatchError(e.response?.data?.error || 'Failed to load batch details');
    } finally {
      setBatchLoading(false);
    }
  };
  const closeBatches = () => {
    setBatchTarget(null);
    setBatchRows([]);
    setBatchTotalSleeping(0);
    setBatchError('');
  };

  const fmtDate = (d) => {
    if (!d) return '—';
    const date = new Date(d);
    return date.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const fmtDateTime = (d) => {
    if (!d) return '—';
    const date = new Date(d);
    return date.toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const fmtNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
  const fmtMoney = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }));

  // MonthsOfSupply display: distinguishes "no consumption history" (null)
  // from "0 required, nothing to order" (RequiredQty === 0) from a real
  // N-month coverage figure. See reorder-sync.service.js for how this is
  // computed and why it's left null rather than 0 when consumption is unknown.
  const fmtMonths = (row) => {
    if (row.RequiredQty === 0) return 'No order needed';
    if (row.MonthsOfSupply === null || row.MonthsOfSupply === undefined) return 'N/A — no consumption history';
    return `${fmtNum(row.MonthsOfSupply)} month${row.MonthsOfSupply === 1 ? '' : 's'}`;
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Reorder Levels</h1>
          <p className="page-subtitle">Stock against reorder levels, synced from Busy ERP — type a quantity under “If I Buy…” to see how long it will last</p>
        </div>
        {canSync && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <button className="btn btn-primary" onClick={handleSync} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync from Busy ERP'}
            </button>
            {syncMsg && <span style={{ fontSize: 12, color: '#6b7280' }}>{syncMsg}</span>}
          </div>
        )}
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

      {/* Summary stat cards */}
      {summary && (
        <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
          <StatCard label="Total Items Tracked" value={summary.TotalItems} />
          <StatCard label="Need Reorder" value={summary.NeedsReorderCount} tone="warning" />
          <StatCard label="Unacknowledged" value={summary.UnacknowledgedCount} tone="danger" />
          <StatCard label="Overstocked Items" value={summary.OverstockedCount} tone="info" />
          <StatCard label="Total Overstocked Qty" value={fmtNum(summary.TotalOverstockedQty)} small />
          <StatCard label="Total Stock Value" value={fmtMoney(summary.TotalStockValue)} small />
          <StatCard label="Last Synced" value={fmtDateTime(summary.LastSyncedAt)} small />
        </div>
      )}

      {/* Filters */}
      <div className="card" style={{ marginBottom: 20, padding: '12px 16px' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="form-control"
            style={{ maxWidth: 220 }}
            placeholder="Search item name…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select className="form-control" style={{ maxWidth: 240, fontWeight: store || inventory ? 600 : 400 }}
            value={store ? `mc:${store}` : inventory ? `inv:${inventory}` : ''}
            onChange={e => {
              const v = e.target.value;
              setStore(v.startsWith('mc:') ? v.slice(3) : '');
              setInventory(v.startsWith('inv:') ? v.slice(4) : '');
            }}
            title="Each inventory store with its own stock and levels; other Mat Centres show their own stock and use, live from Busy">
            <option value="">Central Stores + F7 (each on its own row)</option>
            <optgroup label="Inventory stores">
              {inventoryOptions.map(i => <option key={i.Store} value={`inv:${i.Store}`}>{i.Store} — {i.Items} items, {i.NeedsReorder} to reorder</option>)}
            </optgroup>
            <optgroup label="Other Mat Centres (live from Busy)">
              {storeOptions.map(s => <option key={s} value={`mc:${s}`}>{s}</option>)}
            </optgroup>
          </select>
          <select className="form-control" style={{ maxWidth: 200 }} value={itemgrp} onChange={e => setItemgrp(e.target.value)}>
            <option value="">All Item Groups</option>
            {itemgrpOptions.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: '#374151', cursor: 'pointer' }}>
            <input type="checkbox" checked={needsReorderOnly} onChange={e => setNeedsReorderOnly(e.target.checked)} />
            Needs Reorder Only
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: '#374151', cursor: 'pointer' }}>
            <input type="checkbox" checked={overstockedOnly} onChange={e => setOverstockedOnly(e.target.checked)} />
            Overstocked Only
          </label>
          {!store && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: '#374151', cursor: 'pointer' }}>
              <input type="checkbox" checked={unackOnly} onChange={e => setUnackOnly(e.target.checked)} />
              Unacknowledged Only
            </label>
          )}
          <span style={{ marginLeft: 'auto', fontSize: 13, color: '#6b7280' }}>
            {total} item{total !== 1 ? 's' : ''}
          </span>
          <button className="btn btn-outline" onClick={exportExcel} disabled={exporting || total === 0}
            title="Download every item matching these filters as an Excel file (e.g. tick Needs Reorder Only first)">
            {exporting ? 'Exporting…' : '⬇ Export to Excel'}
          </button>
        </div>
      </div>

      {store ? (
        <div className="alert alert-info" style={{ marginBottom: 12, fontSize: 13 }}>
          Showing <strong>{store}</strong> only — its own stock, with use and reorder levels worked out from what leaves this
          store (production, issues and transfers out), live from Busy. Central Stores' stock is shown under each figure.
          Acknowledging is done on the inventory store view.
        </div>
      ) : (
        <div style={{ marginBottom: 12, fontSize: 12, color: '#6b7280' }}>
          Each inventory store — <strong>Central Stores</strong> and <strong>F7</strong> — has its own items, stock and levels; they are
          never added together (an item kept in both has a row for each). Use / month is what leaves that store; goods already issued
          to a department count as used. Stock still sitting in departments is shown under the figure for information only.
        </div>
      )}

      {/* Table — one row per item; group / UOM / value / min–max / lead time sit under
          their main figure so the page fits without sideways scrolling. */}
      <div className="card" style={{ padding: 0, overflow: 'auto', maxHeight: '72vh' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading…</div>
        ) : items.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>No items match the current filters.</div>
        ) : (
          <table className="data-table" style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: 13 }}>
            <thead>
              <tr>
                <th style={stickyFirstColThStyle}>Item</th>
                <th style={{ ...stickyThStyle, textAlign: 'right' }} title={store ? `Stock in ${store} (and its value); Central Stores' below` : "Stock in this row's inventory store (and its value); stock already issued to departments below, not counted as available"}>
                  {store ? `Stock in ${store}` : inventory ? `Stock in ${inventory}` : 'Stock in store'}
                </th>
                <th style={{ ...stickyThStyle, textAlign: 'right' }} title="Computed from monthly use and lead time: reorder level, with minimum – maximum below">
                  Reorder Level<div style={subThStyle}>min – max</div>
                </th>
                <th style={{ ...stickyThStyle, textAlign: 'right' }} title="Average monthly use, last 3 complete months">Use / Month</th>
                <th style={stickyThStyle} title="How long the current stock lasts at the average monthly use">Stock Lasts</th>
                <th style={stickyThStyle} title="Latest date to order so it arrives (lead time) before the stock runs out">Order By</th>
                <th style={{ ...stickyThStyle, minWidth: 240 }} title="Type a quantity: how long the stock will last if you buy it, using monthly use, lead time and the reorder level">
                  If I Buy…<div style={subThStyle}>quantity → how long it lasts</div>
                </th>
                <th style={stickyThStyle}>Status</th>
                {!store && <th style={stickyThStyle}>Acknowledged</th>}
                <th style={stickyThStyle} />
              </tr>
            </thead>
            <tbody>
              {items.map(r => {
                const overstockedQty = r.Overstocked != null ? Number(r.Overstocked) : 0;
                const now = planStock(r, 0);
                const qtyText = buyQty[r.ReorderStatusId] ?? String(Number(r.RequiredQty) || '');
                const buy = planStock(r, qtyText);
                const busyLevels = r.BusyMinLevel != null || r.BusyReorderLevel != null || r.BusyMaxLevel != null;
                const belowBusy = r.BusyReorderLevel > 0 && Number(r.LiveStock) <= Number(r.BusyReorderLevel);
                return (
                <tr key={r.ReorderStatusId}>
                  <td style={{ ...stickyFirstColTdStyle, fontWeight: 500, minWidth: 200, maxWidth: 280 }}>
                    <button
                      onClick={() => openBatches(r)}
                      title="View batch-wise stock"
                      style={{
                        background: 'none', border: 'none', padding: 0,
                        color: '#2563eb', fontWeight: 500, fontSize: 'inherit',
                        cursor: 'pointer', textAlign: 'left', textDecoration: 'underline',
                        textDecorationColor: 'transparent',
                      }}
                      onMouseEnter={e => e.currentTarget.style.textDecorationColor = '#2563eb'}
                      onMouseLeave={e => e.currentTarget.style.textDecorationColor = 'transparent'}
                    >
                      {r.ItemName}
                    </button>
                    <div style={subTdStyle}>
                      {!store && r.Store && <span className="badge badge-blue" style={{ fontSize: 10, marginRight: 4 }}>{r.Store}</span>}
                      {r.ItemGroup || '—'}{r.UOM ? ` · ${r.UOM}` : ''}
                    </div>
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>
                    {fmtNum(r.LiveStock)}
                    <div style={subTdStyle}>{r.StockValue != null ? fmtMoney(r.StockValue) : ''}</div>
                    {store && <div style={subTdStyle} title="Central Stores stock at the last sync">Central Stores {fmtNum(r.CompanyStock)}</div>}
                    {!store && Number(r.HeldInDepartments) > 0 && (
                      <div style={{ ...subTdStyle, color: '#92400e' }} title="Already issued to departments / factories — treated as consumed, not available">
                        + {fmtNum(r.HeldInDepartments)} in depts
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'monospace' }}
                    title={busyLevels ? `Busy item critical levels — min ${fmtNum(r.BusyMinLevel)} / reorder ${fmtNum(r.BusyReorderLevel)} / max ${fmtNum(r.BusyMaxLevel)}` : undefined}>
                    <strong>{fmtNum(r.ReorderLevel)}</strong>
                    <div style={subTdStyle}>{fmtNum(r.MinimumStockLevel)} – {fmtNum(r.MaxStockLevel)}</div>
                    {belowBusy && <div style={{ ...subTdStyle, color: '#b91c1c' }}>below Busy reorder</div>}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{fmtNum(r.AvgMonthlyConsumption)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {!now.hasUsage ? <span style={{ color: '#9ca3af' }}>no recent use</span>
                      : now.daysCover <= 0 ? <span style={{ color: '#b91c1c', fontWeight: 600 }}>Out of stock</span>
                        : <>{fmtSpan(now.daysCover)}<div style={subTdStyle}>runs out {fmtDate(now.runOutDate)}</div></>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {!now.hasUsage ? <span style={{ color: '#9ca3af' }}>—</span>
                      : now.orderOverdueDays > 0
                        ? <span style={{ color: '#b91c1c', fontWeight: 600 }}>Overdue {now.orderOverdueDays}d<div style={{ ...subTdStyle, color: '#b91c1c' }}>{fmtDays(now.gapDays)} without stock</div></span>
                        : fmtDate(now.orderByDate)}
                    <div style={subTdStyle}>lead {r.LeadTimeDays != null ? `${Math.round(Number(r.LeadTimeDays))} days` : '—'}</div>
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <input type="number" min="0" step="any" value={qtyText}
                        onChange={e => setBuyQty(q => ({ ...q, [r.ReorderStatusId]: e.target.value }))}
                        title="Quantity to buy — starts at the suggested (required) quantity"
                        style={{ width: 84, padding: '3px 6px', fontSize: 12, border: '1px solid #d1d5db', borderRadius: 4 }} />
                      <div style={{ fontSize: 12, lineHeight: 1.35 }}>
                        {!buy.hasUsage ? <span style={{ color: '#9ca3af' }}>no use history to project</span>
                          : !(Number(qtyText) > 0) ? <span style={{ color: '#9ca3af' }}>enter a quantity</span>
                            : <>
                                <strong style={{ color: buy.overMaxQty > 0 ? '#d97706' : buy.coverAfterDays < 30 ? '#b91c1c' : '#065f46' }}>
                                  lasts {fmtSpan(buy.coverAfterDays)}
                                </strong>
                                <div style={{ color: '#6b7280' }}>until {fmtDate(buy.newRunOutDate)} · reorder again {fmtDate(buy.nextOrderDate)}</div>
                                {buy.overMaxQty > 0 && <div style={{ color: '#d97706' }}>{fmtNum(buy.overMaxQty)} above max</div>}
                              </>}
                      </div>
                    </div>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <span className={`badge ${r.NeedsReorder ? 'badge-red' : 'badge-green'}`}>
                      {r.NeedsReorder ? 'Needs Reorder' : 'OK'}
                    </span>
                    {overstockedQty > 0 && (
                      <div style={{ marginTop: 4 }}><span className="badge badge-yellow" title="Stock above the maximum level">Overstocked +{fmtNum(overstockedQty)}</span></div>
                    )}
                  </td>
                  {!store && <td style={{ fontSize: 12, maxWidth: 170 }}>
                    {r.AcknowledgedAt ? (
                      <div>
                        <div style={{ color: '#059669', fontWeight: 500 }}>{r.AcknowledgedByName || 'Acknowledged'}</div>
                        <div style={{ color: '#9ca3af' }}>{fmtDate(r.AcknowledgedAt)}</div>
                        {r.AcknowledgedMonthsCoverage != null && (
                          <div style={{ color: '#6b7280', marginTop: 2 }}>
                            Ordered {fmtNum(r.AcknowledgedRequiredQty)} → ~{fmtNum(r.AcknowledgedMonthsCoverage)} mo supply
                          </div>
                        )}
                        {r.AcknowledgedNotes && (
                          <div style={{ color: '#6b7280', marginTop: 2 }} title={r.AcknowledgedNotes}>
                            {r.AcknowledgedNotes.length > 30 ? r.AcknowledgedNotes.slice(0, 30) + '…' : r.AcknowledgedNotes}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span style={{ color: '#9ca3af' }}>Not reviewed</span>
                    )}
                  </td>}
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-secondary btn-sm" style={{ marginRight: 6 }}
                      onClick={() => openPlan(r, qtyText)} title="Full look-ahead for this quantity">Plan</button>
                    {store ? null : r.AcknowledgedAt ? (
                      <button className="btn btn-secondary btn-sm" onClick={() => handleUnacknowledge(r)}>Undo</button>
                    ) : (
                      <button className="btn btn-primary btn-sm" onClick={() => openAcknowledge(r)}>Acknowledge</button>
                    )}
                  </td>
                </tr>
              );})}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 16 }}>
          <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
          <span style={{ fontSize: 13, color: '#6b7280' }}>Page {page} of {totalPages}</span>
          <button className="btn btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</button>
        </div>
      )}

      {/* Acknowledge modal */}
      {ackTarget && (
        <div style={overlayStyle}>
          <div style={{ ...modalStyle, maxWidth: 440 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>Acknowledge Reorder Alert</h2>
              <button onClick={closeAcknowledge} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#6b7280' }}>×</button>
            </div>
            <p style={{ fontSize: 13, color: '#374151', marginBottom: 4 }}>
              <strong>{ackTarget.ItemName}</strong>
            </p>
            <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 4 }}>
              Required Qty: <strong>{fmtNum(ackTarget.RequiredQty)}</strong> · Lead Time: {ackTarget.LeadTimeDays != null ? `${Number(ackTarget.LeadTimeDays).toFixed(1)} days` : '—'}
            </p>
            <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
              Avg Monthly Consumption: <strong>{fmtNum(ackTarget.AvgMonthlyConsumption)}</strong> · Covers: <strong>{fmtMonths(ackTarget)}</strong>
            </p>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Notes (optional)</label>
              <textarea
                className="form-control"
                rows={3}
                value={ackNotes}
                onChange={e => setAckNotes(e.target.value)}
                placeholder="e.g. Order raised in Busy ERP as PO-1234"
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
              <button className="btn btn-secondary" onClick={closeAcknowledge} disabled={ackSaving}>Cancel</button>
              <button className="btn btn-primary" onClick={submitAcknowledge} disabled={ackSaving}>
                {ackSaving ? 'Saving…' : 'Acknowledge'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Future planning modal */}
      {planTarget && (() => {
        const p = planStock(planTarget, planQty);
        const row = (label, value, tone) => (
          <tr>
            <td style={{ padding: '6px 8px', color: '#6b7280', fontSize: 13 }}>{label}</td>
            <td style={{ padding: '6px 8px', fontSize: 13, fontWeight: 600, textAlign: 'right', color: tone || undefined }}>{value}</td>
          </tr>
        );
        return (
          <div style={overlayStyle}>
            <div style={{ ...modalStyle, maxWidth: 780 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <h2 style={{ margin: 0, fontSize: 17 }}>Look Ahead — {planTarget.ItemName}</h2>
                <button onClick={closePlan} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#6b7280' }}>×</button>
              </div>
              <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
                Assumes usage stays at the average monthly consumption and an order placed today arrives after the lead time.
              </p>
              {!p.hasUsage ? (
                <div className="alert alert-error">No consumption history for this item, so it can't be projected.</div>
              ) : (
                <>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      {row('Stock now', `${fmtNum(planTarget.LiveStock)} ${planTarget.UOM || ''}`)}
                      {row('Average use', `${fmtNum(planTarget.AvgMonthlyConsumption)} / month (${fmtNum(p.dailyUse)} / day)`)}
                      {row('Current stock lasts', p.daysCover <= 0 ? 'Out of stock' : `${fmtDays(p.daysCover)} → runs out ${fmtDate(p.runOutDate)}`, p.daysCover <= 0 ? '#b91c1c' : undefined)}
                      {row('Delivery takes (lead time)', fmtDays(p.leadDays))}
                      {row('Latest order date', p.orderOverdueDays > 0 ? `Overdue by ${p.orderOverdueDays} day${p.orderOverdueDays === 1 ? '' : 's'}` : fmtDate(p.orderByDate), p.orderOverdueDays > 0 ? '#b91c1c' : undefined)}
                      {p.gapDays > 0 && row('If ordered today', `${fmtDays(p.gapDays)} without stock before it arrives`, '#b91c1c')}
                    </tbody>
                  </table>

                  <div className="form-group" style={{ margin: '14px 0 8px' }}>
                    <label className="form-label">If we buy this quantity</label>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input className="form-control" type="number" min="0" step="any" value={planQty}
                        onChange={e => setPlanQty(e.target.value)} style={{ maxWidth: 160 }} />
                      <span style={{ fontSize: 12, color: '#6b7280' }}>
                        {planTarget.UOM || ''} · suggested (required qty): <button type="button" onClick={() => setPlanQty(String(Number(planTarget.RequiredQty) || 0))}
                          style={{ background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', padding: 0, fontSize: 12 }}>{fmtNum(planTarget.RequiredQty)}</button>
                      </span>
                    </div>
                  </div>

                  <table style={{ width: '100%', borderCollapse: 'collapse', background: '#f9fafb', borderRadius: 6 }}>
                    <tbody>
                      {row('Arrives', fmtDate(p.arrivalDate))}
                      {row('Stock on arrival (before this buy)', fmtNum(p.stockAtArrival))}
                      {row('Stock after the buy', fmtNum(p.afterBuy))}
                      {row('That lasts', `${fmtDays(p.coverAfterDays)} (${fmtNum(p.coverAfterMonths)} months)`)}
                      {row('Runs out again', fmtDate(p.newRunOutDate))}
                      {row(`Back down to the reorder level (${fmtNum(planTarget.ReorderLevel)}) — order again`, fmtDate(p.nextOrderDate))}
                      {planTarget.MaxStockLevel != null && row('Maximum level', fmtNum(planTarget.MaxStockLevel))}
                      {p.overMaxQty > 0 && row('Above maximum level by', fmtNum(p.overMaxQty), '#d97706')}
                    </tbody>
                  </table>
                </>
              )}
              {/* What it has cost before — and what this quantity would cost */}
              <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #e5e7eb' }}>
                <PriceHistory itemName={planTarget.ItemName} buyQty={planQty} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                <button className="btn btn-secondary" onClick={closePlan}>Close</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Batch drilldown modal */}
      {batchTarget && (
        <div style={overlayStyle}>
          <div style={{ ...modalStyle, maxWidth: 720 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>Batch-Wise Stock</h2>
              <button onClick={closeBatches} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#6b7280' }}>×</button>
            </div>
            <p style={{ fontSize: 13, color: '#374151', marginBottom: 14 }}>
              <strong>{batchTarget.ItemName}</strong>
            </p>

            {batchLoading ? (
              <div style={{ padding: 30, textAlign: 'center', color: '#6b7280' }}>Loading batches…</div>
            ) : batchError ? (
              <div className="alert alert-error">{batchError}</div>
            ) : batchRows.length === 0 ? (
              <div style={{ padding: 30, textAlign: 'center', color: '#6b7280' }}>No positive-stock batch records found for this item.</div>
            ) : (
              <>
                <div
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8,
                    padding: '10px 14px', marginBottom: 14,
                  }}
                >
                  <span style={{ fontSize: 13, color: '#6b7280' }}>Total Value Sleeping in Stock</span>
                  <span style={{ fontSize: 18, fontWeight: 700, color: '#dc2626' }}>{fmtMoney(batchTotalSleeping)}</span>
                </div>
                {batchRecon.length > 0 && (
                  <div style={{ fontSize: 12, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '6px 10px', marginBottom: 12 }}>
                    Busy's batch records don't add up to this item's stock in{' '}
                    {batchRecon.map((c) => `${c.store} (batches ${fmtNum(c.batchTotal)} vs stock ${fmtNum(c.stock)})`).join(', ')}
                    {' '}— usually opening batches carried into this year. The stock figure is right; correct the batches in Busy.
                  </div>
                )}

                <div style={{ overflow: 'auto', maxHeight: '50vh' }}>
                  <table className="data-table" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
                    <thead>
                      <tr>
                        <th style={stickyThStyle}>Factory</th>
                        <th style={stickyThStyle}>Batch No</th>
                        <th style={stickyThStyle}>Batch Date</th>
                        <th style={stickyThStyle}>Qty</th>
                        <th style={stickyThStyle}>Amount</th>
                        <th style={stickyThStyle}>Aging (days)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchRows.map((b, i) => (
                        <tr key={`${b.BatchNo}-${i}`}>
                          <td style={{ fontSize: 13 }}>{b.Factory}</td>
                          <td>{b.BatchNo}</td>
                          <td>{fmtDate(b.BatchDate)}</td>
                          <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{fmtNum(b.Qty)}</td>
                          <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{fmtMoney(b.Amount)}</td>
                          <td style={{ fontFamily: 'monospace', fontSize: 13, color: b.AgeDays > 90 ? '#dc2626' : undefined }}>
                            {b.AgeDays != null ? b.AgeDays : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button className="btn btn-secondary" onClick={closeBatches}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, tone, small }) {
  const toneColors = {
    warning: '#d97706',
    danger:  '#dc2626',
    info:    '#2563eb',
  };
  return (
    <div className="card" style={{ padding: '14px 20px', minWidth: 150 }}>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: small ? 14 : 24, fontWeight: 700, color: tone ? toneColors[tone] : '#111827' }}>
        {value === undefined || value === null ? '—' : value}
      </div>
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

// Secondary line under a header / cell value (group · UOM, min – max, lead time…).
const subThStyle = { fontSize: 11, fontWeight: 400, color: '#6b7280' };
const subTdStyle = { fontSize: 11, color: '#6b7280', fontFamily: 'inherit', fontWeight: 400, marginTop: 2 };

// Sticky table-header cell: stays pinned to the top of the scrolling
// container while the body scrolls underneath it.
const stickyThStyle = {
  position: 'sticky',
  top: 0,
  background: '#fff',
  zIndex: 2,
  boxShadow: 'inset 0 -1px 0 #e5e7eb', // keeps the header/body divider visible while stuck
};

// First-column header cell: sticky both to the top (like every other header
// cell) AND to the left edge, so it stays pinned in both directions —
// needs a higher z-index since it overlaps the regular sticky header row too.
const stickyFirstColThStyle = {
  ...stickyThStyle,
  left: 0,
  zIndex: 3,
};

// First-column body cell: sticky to the left edge only, so it stays visible
// while the table scrolls horizontally. Needs an explicit background since
// sticky cells don't get one automatically, and would otherwise let the
// scrolling columns behind it show through.
const stickyFirstColTdStyle = {
  position: 'sticky',
  left: 0,
  background: '#fff',
  zIndex: 1,
  boxShadow: 'inset -1px 0 0 #e5e7eb', // subtle divider so it reads as "frozen"
};
