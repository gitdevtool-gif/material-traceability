import React, { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../services/api';

// ── API base ─────────────────────────────────────────────────────────────
// Uses the same shared axios instance AuthContext.js itself calls
// (api.post('/auth/login'), api.get('/auth/me')) — that instance already
// carries whatever interceptor attaches the token from localStorage, so
// this page authenticates exactly the same way every other page does.
const API_BASE = '/production/aging';

function useAgingApi() {
  // GET/POST wrapper that unwraps axios's { data } envelope and normalizes
  // errors to a plain Error with the backend's message, same shape the
  // rest of this file already expects from its old fetch-based version.
  const request = useCallback(async (path, options = {}) => {
    try {
      const method = (options.method || 'GET').toLowerCase();
      const res = method === 'post'
        ? await api.post(`${API_BASE}${path}`)
        // Cache-bust GETs: without this, some browsers/proxies will serve a
        // cached response for the exact same URL (e.g. /summary, /?page=1&...)
        // even right after a sync just wrote fresh rows, making the UI look
        // like it "didn't refresh" when the DB is actually already correct.
        : await api.get(`${API_BASE}${path}`, {
            params: { _: Date.now() },
            headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
          });
      return res.data;
    } catch (err) {
      const message = err.response?.data?.error || err.message || 'Request failed';
      throw new Error(message);
    }
  }, []);

  return request;
}

// ── Formatting helpers ───────────────────────────────────────────────────
// Values as stored: true remaining batch balances (positive) since 2026-10-18, see aging-sync.service.js.
const fmtMoney = (n) =>
  n == null ? '—' : `KES ${Number(n).toLocaleString('en-KE', { maximumFractionDigits: 0 })}`;
const fmtQty = (n) => (n == null ? '—' : Number(n).toLocaleString('en-KE', { maximumFractionDigits: 2 }));
const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  if (dt.getFullYear() <= 1900) return '—'; // sentinel dates like 1899-12-30
  return dt.toLocaleDateString('en-KE', { year: 'numeric', month: 'short', day: 'numeric' });
};

const BUCKET_COLOR = {
  '0-30':   '#2e7d32',
  '31-60':  '#9e9d24',
  '61-90':  '#f9a825',
  '91-180': '#ef6c00',
  '180+':   '#c62828',
  'Unknown': '#757575',
};

export default function AgingAnalysis() {
  const api = useAgingApi();

  // ── Filter state ─────────────────────────────────────────────────────
  const [factory, setFactory] = useState('');
  const [category, setCategory] = useState('');
  const [itemName, setItemName] = useState('');
  const [bucket, setBucket] = useState('');
  const [minAge, setMinAge] = useState('');
  const [sortBy, setSortBy] = useState('AgeDays');
  const [sortDir, setSortDir] = useState('DESC');
  const [page, setPage] = useState(1);
  const [limit] = useState(50);

  // ── Data state ───────────────────────────────────────────────────────
  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState(null);
  const [tableData, setTableData] = useState({ data: [], total: 0, totalPages: 1 });
  const [tableError, setTableError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [resetSyncing, setResetSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState(null);

  // The stores Aging Analysis covers — the server's list (summary.stores)
  // replaces this seed once loaded. Categories widen as real rows come in.
  const [knownFactories, setKnownFactories] = useState([
    'F1', 'F1w', 'F1F', 'F2P', 'F2W', 'F2F', 'F3', 'F4', 'F5',
    'F6', 'F6F', 'F6 BULK STOCK', 'F7', 'F8', 'F9', 'F9 F', 'F10',
    'CENTRAL STORES', 'sales returns sylvia', 'BIG COLD',
  ]);
  const [knownCategories, setKnownCategories] = useState([]);

  const loadSummary = useCallback(async () => {
    try {
      setSummaryError(null);
      const params = new URLSearchParams();
      if (factory)  params.set('factory', factory);
      if (category) params.set('category', category);
      if (itemName) params.set('itemName', itemName);
      if (bucket)   params.set('bucket', bucket);
      if (minAge)   params.set('minAge', minAge);
      const qs = params.toString();
      const result = await api(`/summary${qs ? `?${qs}` : ''}`);
      setSummary(result);
      if (Array.isArray(result.stores) && result.stores.length) setKnownFactories(result.stores);
    } catch (err) {
      setSummaryError(err.message);
    }
  }, [api, factory, category, itemName, bucket, minAge]);

  const loadTable = useCallback(async () => {
    try {
      setLoading(true);
      setTableError(null);
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
        sortBy,
        sortDir,
      });
      if (factory)  params.set('factory', factory);
      if (category) params.set('category', category);
      if (itemName) params.set('itemName', itemName);
      if (bucket)   params.set('bucket', bucket);
      if (minAge)   params.set('minAge', minAge);

      const result = await api(`/?${params.toString()}`);
      setTableData(result);

      setKnownCategories(prev => {
        const next = new Set(prev);
        result.data.forEach(r => r.Category && next.add(r.Category));
        return Array.from(next).sort();
      });
    } catch (err) {
      setTableError(err.message);
    } finally {
      setLoading(false);
    }
  }, [api, page, limit, sortBy, sortDir, factory, category, itemName, bucket, minAge]);

  useEffect(() => { loadSummary(); }, [loadSummary]);
  useEffect(() => { loadTable(); }, [loadTable]);

  // Reset to page 1 whenever a filter (not sort/page itself) changes
  useEffect(() => { setPage(1); }, [factory, category, itemName, bucket, minAge]);

  const handleSort = (col) => {
    if (sortBy === col) {
      setSortDir(d => (d === 'ASC' ? 'DESC' : 'ASC'));
    } else {
      setSortBy(col);
      setSortDir('DESC');
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const result = await api('/sync', { method: 'POST' });
      setSyncMessage(`Synced ${result.synced} batch(es).`);
      await Promise.all([loadSummary(), loadTable()]);
    } catch (err) {
      setSyncMessage(`Sync failed: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  // Destructive: wipes dbo.AgingStock then re-syncs from scratch (see
  // /reset-sync route). Confirm first — there's no undo once it truncates.
  const handleResetSync = async () => {
    const confirmed = window.confirm(
      'This will permanently delete all locally-synced aging stock data and pull a fresh copy from the ERP. This cannot be undone. Continue?'
    );
    if (!confirmed) return;

    setResetSyncing(true);
    setSyncMessage(null);
    try {
      const result = await api('/reset-sync', { method: 'POST' });
      setSyncMessage(`Reset complete — synced ${result.synced} batch(es) fresh.`);
      await Promise.all([loadSummary(), loadTable()]);
    } catch (err) {
      setSyncMessage(`Reset & sync failed: ${err.message}`);
    } finally {
      setResetSyncing(false);
    }
  };

  const clearFilters = () => {
    setFactory(''); setCategory(''); setItemName(''); setBucket(''); setMinAge('');
  };

  // ── Excel export (2026-11-24) ─────────────────────────────────────────
  // Every batch matching the active filters and sort (not just this page),
  // e.g. CENTRAL STORES + 180+ days for the dead-stock review. Sheet 1 is
  // the batches; sheet 2 records the filters, the totals per bucket and
  // when the data was synced, so the file explains itself when shared.
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const params = new URLSearchParams({ sortBy, sortDir });
      if (factory)  params.set('factory', factory);
      if (category) params.set('category', category);
      if (itemName) params.set('itemName', itemName);
      if (bucket)   params.set('bucket', bucket);
      if (minAge)   params.set('minAge', minAge);
      const result = await api(`/export?${params.toString()}`);
      const rows = result.data || [];
      if (rows.length === 0) { setExportError('No batches match these filters — nothing to export.'); return; }

      // Styled like the page (colours, frozen header, KES / date formats) —
      // see utils/agingExcel.js. ExcelJS is loaded only when exporting.
      const [{ default: ExcelJS }, { buildAgingWorkbook, agingFileName }] = await Promise.all([
        import('exceljs'), import('../utils/agingExcel'),
      ]);
      const filters = { factory, category, itemName, bucket, minAge, sortBy, sortDir };
      const wb = buildAgingWorkbook(ExcelJS, {
        rows, lastSyncedAt: result.lastSyncedAt, truncated: result.truncated, maxRows: result.maxRows, filters,
      });
      const buf = await wb.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = agingFileName(filters);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      setExportError(`Export failed: ${err.message}`);
    } finally {
      setExporting(false);
    }
  };

  // Bar widths only: bucket amounts are signed, so proportions use magnitude.
  const bucketTotalAmount = useMemo(() => {
    if (!summary) return 0;
    return summary.buckets.reduce((s, b) => s + Math.abs(b.TotalAmount || 0), 0)
      + Math.abs(summary.unknownBucket?.TotalAmount || 0);
  }, [summary]);

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Aging Analysis</h1>
          <div style={{ color: '#666', fontSize: 13, marginTop: 4 }}>
            Stock by age, First In First Out (as Busy's stock ageing): each store's closing stock is taken
            from its most recent receipts; "Received on" is the receipt voucher, older years marked (2025-26).
            {summary?.lastSyncedAt && (
              <> Last synced {new Date(summary.lastSyncedAt).toLocaleString('en-KE')}.</>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={handleSync} disabled={syncing || resetSyncing}>
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
            <button
              onClick={handleResetSync}
              disabled={syncing || resetSyncing}
              title="Delete all local aging data and re-sync from scratch"
              style={{ color: '#c62828', borderColor: '#c62828' }}
            >
              {resetSyncing ? 'Resetting…' : 'Reset & Resync'}
            </button>
          </div>
          {syncMessage && <div style={{ fontSize: 12, marginTop: 6, color: syncMessage.startsWith('Sync failed') || syncMessage.startsWith('Reset & sync failed') ? '#c62828' : '#2e7d32' }}>{syncMessage}</div>}
        </div>
      </div>

      {summaryError && <div style={{ color: '#c62828', marginBottom: 16 }}>Couldn't load summary: {summaryError}</div>}

      {/* ── Summary cards ─────────────────────────────────────────────── */}
      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 20 }}>
          <SummaryCard label="Total capital tied up" value={fmtMoney(summary.totals.TotalCapital)} />
          <SummaryCard
            label="Capital over 90 days"
            value={fmtMoney(summary.totals.CapitalOver90Days)}
            sub={summary.totals.TotalCapital
              ? `${((summary.totals.CapitalOver90Days / summary.totals.TotalCapital) * 100).toFixed(0)}% of total`
              : null}
            highlight
          />
          <SummaryCard label="Total batches" value={summary.totals.TotalBatches?.toLocaleString()} />
          <SummaryCard label="Oldest batch" value={summary.totals.OldestBatchAgeDays != null ? `${summary.totals.OldestBatchAgeDays} days` : '—'} />
          {summary.unknownBucket && summary.unknownBucket.BatchCount > 0 && (
            <SummaryCard
              label="Negative stock (no date)"
              value={fmtMoney(summary.unknownBucket.TotalAmount)}
              sub={`${summary.unknownBucket.BatchCount.toLocaleString()} item line(s) issued before received — netted off the total as Busy does; fix in Busy`}
              warn
            />
          )}
        </div>
      )}

      {/* ── Bucket bar ────────────────────────────────────────────────── */}
      {summary && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', height: 28, borderRadius: 6, overflow: 'hidden' }}>
            {summary.buckets.map(b => {
              const pct = bucketTotalAmount ? (Math.abs(b.TotalAmount || 0) / bucketTotalAmount) * 100 : 0;
              return pct > 0 ? (
                <div
                  key={b.Bucket}
                  title={`${b.Bucket} days: ${fmtMoney(b.TotalAmount)} (${b.BatchCount} batches)`}
                  onClick={() => setBucket(bucket === b.Bucket ? '' : b.Bucket)}
                  style={{
                    width: `${pct}%`,
                    background: BUCKET_COLOR[b.Bucket],
                    cursor: 'pointer',
                    opacity: bucket && bucket !== b.Bucket ? 0.4 : 1,
                  }}
                />
              ) : null;
            })}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap', fontSize: 12 }}>
            {summary.buckets.map(b => (
              <div
                key={b.Bucket}
                onClick={() => setBucket(bucket === b.Bucket ? '' : b.Bucket)}
                style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontWeight: bucket === b.Bucket ? 700 : 400 }}
              >
                <span style={{ width: 10, height: 10, background: BUCKET_COLOR[b.Bucket], borderRadius: 2, display: 'inline-block' }} />
                {b.Bucket}d — {fmtMoney(b.TotalAmount)} ({b.BatchCount})
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Top aging (action list) ──────────────────────────────────── */}
      {summary?.topAging?.length > 0 && (
        <div style={{ marginBottom: 24, border: '1px solid #eee', borderRadius: 8, padding: 16 }}>
          <h3 style={{ marginTop: 0, fontSize: 15 }}>Top items to act on (90+ days, ranked by capital tied up)</h3>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#666' }}>
                <th>Item</th><th>Factory</th><th>Received on</th><th>Age</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {summary.topAging.map(row => (
                <tr
                  key={row.AgingStockId}
                  style={{ borderTop: '1px solid #f0f0f0', cursor: 'pointer' }}
                  onClick={() => { setItemName(row.ItemName); setFactory(row.Factory); setBucket(''); }}
                >
                  <td>{row.ItemName}</td>
                  <td>{row.Factory}</td>
                  <td>{row.BatchNo}</td>
                  <td>{row.AgeDays}d</td>
                  <td style={{ textAlign: 'right' }}>{fmtQty(row.Qty)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtMoney(row.Amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Filters ───────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        <select value={factory} onChange={e => setFactory(e.target.value)}>
          <option value="">All aging stores</option>
          {knownFactories.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
        <select value={category} onChange={e => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {knownCategories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <input
          placeholder="Search item name…"
          value={itemName}
          onChange={e => setItemName(e.target.value)}
          style={{ minWidth: 180 }}
        />
        <select value={bucket} onChange={e => setBucket(e.target.value)} title="Age bucket (also set by clicking the bar above)">
          <option value="">All ages</option>
          {['0-30', '31-60', '61-90', '91-180', '180+'].map(b => <option key={b} value={b}>{b} days</option>)}
        </select>
        <input
          type="number"
          placeholder="Min age (days)"
          value={minAge}
          onChange={e => setMinAge(e.target.value)}
          style={{ width: 130 }}
        />
        {(factory || category || itemName || bucket || minAge) && (
          <button onClick={clearFilters}>Clear filters</button>
        )}
        <div style={{ flex: 1 }} />
        <button
          onClick={handleExport}
          disabled={exporting || loading || tableData.total === 0}
          title="Download every batch matching the current filters (not just this page) as an Excel file"
          style={{ fontWeight: 600 }}
        >
          {exporting ? 'Exporting…' : `⬇ Export to Excel${tableData.total ? ` (${tableData.total.toLocaleString()})` : ''}`}
        </button>
      </div>
      {(factory || category || itemName || bucket || minAge) && (
        <div style={{ fontSize: 12, color: '#666', marginTop: -6, marginBottom: 12 }}>
          Filtered: {[factory && `store ${factory}`, category && `category ${category}`, itemName && `item “${itemName}”`,
            bucket && `${bucket} days`, minAge && `at least ${minAge} days old`].filter(Boolean).join(' · ')}
          {' '}— the export includes exactly these batches.
        </div>
      )}
      {exportError && <div style={{ color: '#c62828', marginBottom: 12 }}>{exportError}</div>}

      {tableError &&<div style={{ color: '#c62828', marginBottom: 12 }}>Couldn't load batches: {tableError}</div>}

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #eee' }}>
            <SortableTh label="Item" col="ItemName" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
            <th>Category</th>
            <th>Factory</th>
            <th>Received on (voucher)</th>
            <th>Date</th>
            <th>Due Date</th>
            <SortableTh label="Age" col="AgeDays" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} align="right" />
            <th>Bucket</th>
            <SortableTh label="Qty" col="Qty" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} align="right" />
            <SortableTh label="Amount" col="Amount" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} align="right" />
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={10} style={{ padding: 20, textAlign: 'center', color: '#666' }}>Loading…</td></tr>
          ) : tableData.data.length === 0 ? (
            <tr><td colSpan={10} style={{ padding: 20, textAlign: 'center', color: '#666' }}>No batches match these filters.</td></tr>
          ) : (
            tableData.data.map(row => (
              <tr key={row.AgingStockId} style={{ borderTop: '1px solid #f5f5f5' }}>
                <td>{row.ItemName}</td>
                <td>{row.Category}</td>
                <td>{row.Factory}</td>
                <td>{row.BatchNo}</td>
                <td>{fmtDate(row.BatchDate)}</td>
                <td>{fmtDate(row.DueDate)}</td>
                <td style={{ textAlign: 'right' }}>{row.AgeBucket === 'Unknown' ? '—' : `${row.AgeDays}d`}</td>
                <td>
                  <span style={{
                    background: BUCKET_COLOR[row.AgeBucket], color: '#fff', fontSize: 11,
                    padding: '2px 8px', borderRadius: 10,
                  }}>
                    {row.AgeBucket}
                  </span>
                </td>
                <td style={{ textAlign: 'right' }}>{fmtQty(row.Qty)}</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtMoney(row.Amount)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {/* ── Pagination ────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, fontSize: 13 }}>
        <div>{tableData.total.toLocaleString()} batch(es)</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</button>
          <span>Page {tableData.page || page} of {tableData.totalPages || 1}</span>
          <button disabled={page >= (tableData.totalPages || 1)} onClick={() => setPage(p => p + 1)}>Next</button>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, sub, highlight, warn }) {
  return (
    <div style={{
      border: '1px solid #eee', borderRadius: 8, padding: '12px 16px',
      background: warn ? '#fff8e1' : highlight ? '#fff3f0' : '#fff',
    }}>
      <div style={{ fontSize: 12, color: '#666' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function SortableTh({ label, col, sortBy, sortDir, onSort, align }) {
  const active = sortBy === col;
  return (
    <th
      onClick={() => onSort(col)}
      style={{ cursor: 'pointer', textAlign: align || 'left', userSelect: 'none' }}
    >
      {label} {active ? (sortDir === 'ASC' ? '▲' : '▼') : ''}
    </th>
  );
}