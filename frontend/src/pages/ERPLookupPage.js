import React, { useState, useEffect, useCallback } from 'react';
import api from '../services/api';

const PAGE_SIZE_OPTIONS = [25, 50, 100];

export default function ERPLookupPage() {
  const [data, setData] = useState([]);
  const [erpHealth, setErpHealth] = useState(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);

  useEffect(() => {
    api.get('/erp/health').then(r => setErpHealth(r.data)).catch(() => setErpHealth({ status: 'error' }));
  }, []);

  const fetchData = useCallback(async (pg = page, lim = limit) => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ page: pg, limit: lim });
      if (search) params.set('search', search);
      const res = await api.get(`/erp/goods-received?${params}`);
      setData(res.data.data);
      setTotal(res.data.total);
      setTotalPages(res.data.totalPages);
      setPage(res.data.page);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to fetch ERP data');
    } finally { setLoading(false); }
  }, [search, page, limit]);

  const handleSearch = (e) => {
    e?.preventDefault();
    setPage(1);
    fetchData(1, limit);
  };

  const goToPage = (pg) => {
    if (pg < 1 || pg > totalPages) return;
    setPage(pg);
    fetchData(pg, limit);
  };

  const handleLimitChange = (newLimit) => {
    setLimit(newLimit);
    setPage(1);
    fetchData(1, newLimit);
  };

  useEffect(() => { fetchData(1, limit); }, []); // eslint-disable-line

  // Build page number buttons (show max 7 around current page)
  const getPageNumbers = () => {
    const pages = [];
    const maxButtons = 7;
    let start = Math.max(1, page - Math.floor(maxButtons / 2));
    let end = Math.min(totalPages, start + maxButtons - 1);
    if (end - start < maxButtons - 1) start = Math.max(1, end - maxButtons + 1);
    for (let i = start; i <= end; i++) pages.push(i);
    return pages;
  };

  return (
    <div>
      <div className="page-header">
        <h1>ERP Goods Received (Busy ERP)</h1>
        <span className={`badge badge-${erpHealth?.status === 'ok' ? 'success' : 'danger'}`}>
          ERP: {erpHealth?.status === 'ok' ? 'Connected' : 'Disconnected'}
        </span>
      </div>

      {error && <div className="card" style={{ color: 'var(--danger)' }}>{error}</div>}

      <div className="card">
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by voucher no, name, batch no, mat center..." style={{ flex: 1 }} />
          <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Loading…' : 'Search'}</button>
        </form>

        {/* Summary row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, fontSize: 13, color: 'var(--gray-600)' }}>
          <span>
            Showing {data.length === 0 ? 0 : (page - 1) * limit + 1}–{Math.min(page * limit, total)} of <strong>{total.toLocaleString()}</strong> records
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Rows per page:
            <select value={limit} onChange={e => handleLimitChange(Number(e.target.value))}
              style={{ padding: '4px 8px', borderRadius: 'var(--radius)', border: '1px solid var(--gray-300)' }}>
              {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </span>
        </div>

        <table className="data-table">
          <thead>
            <tr>
              <th>#</th><th>Vch No</th><th>Date</th><th>Name</th><th>Batch No</th>
              <th>Mat Center</th><th>Qty</th><th>Price</th><th>Amount</th><th>Date Received</th>
            </tr>
          </thead>
          <tbody>
            {data.map((r, i) => (
              <tr key={i}>
                <td style={{ color: 'var(--gray-400)' }}>{(page - 1) * limit + i + 1}</td>
                <td><strong>{r.VchNo}</strong></td>
                <td>{r.Date ? new Date(r.Date).toLocaleDateString() : '—'}</td>
                <td>{r.Name}</td>
                <td>{r['Batch No'] || '—'}</td>
                <td>{r['Mat Center'] || '—'}</td>
                <td>{r.Qty}</td>
                <td>{r.Price?.toFixed(2)}</td>
                <td>{r.Amount?.toFixed(2)}</td>
                <td>{r['Date Received'] ? new Date(r['Date Received']).toLocaleDateString() : '—'}</td>
              </tr>
            ))}
            {data.length === 0 && !loading && <tr><td colSpan="10" className="text-center text-muted">No records found</td></tr>}
          </tbody>
        </table>

        {/* Pagination controls */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 4, marginTop: 16 }}>
            <button className="btn" onClick={() => goToPage(1)} disabled={page === 1}
              style={{ padding: '6px 10px', fontSize: 13 }}>«</button>
            <button className="btn" onClick={() => goToPage(page - 1)} disabled={page === 1}
              style={{ padding: '6px 10px', fontSize: 13 }}>‹</button>
            {getPageNumbers().map(p => (
              <button key={p} className={`btn ${p === page ? 'btn-primary' : ''}`}
                onClick={() => goToPage(p)}
                style={{ padding: '6px 12px', fontSize: 13, fontWeight: p === page ? 600 : 400 }}>
                {p}
              </button>
            ))}
            <button className="btn" onClick={() => goToPage(page + 1)} disabled={page === totalPages}
              style={{ padding: '6px 10px', fontSize: 13 }}>›</button>
            <button className="btn" onClick={() => goToPage(totalPages)} disabled={page === totalPages}
              style={{ padding: '6px 10px', fontSize: 13 }}>»</button>
          </div>
        )}
      </div>
    </div>
  );
}
