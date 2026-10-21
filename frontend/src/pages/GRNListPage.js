import React, { useEffect, useState, useRef } from 'react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';

const STATUS_BADGE = {
  Created: 'badge-blue',
  FullyReceived: 'badge-green',
  PartiallyReceived: 'badge-yellow',
  Reversed: 'badge-red',
};

export default function GRNListPage() {
  const [grns, setGrns] = useState([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [printData, setPrintData] = useState(null);
  const printRef = useRef();
  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';

  const load = () => {
    setLoading(true);
    const params = { page, limit: 25 };
    if (search) params.search = search;
    if (statusFilter) params.status = statusFilter;
    api.get('/grn', { params })
      .then((r) => setGrns(r.data.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [page, statusFilter]);

  const handlePrint = async (grnNo) => {
    try {
      const res = await api.get(`/grn/${encodeURIComponent(grnNo)}`);
      setPrintData(res.data);
      setTimeout(() => {
        const printContent = printRef.current;
        if (!printContent) return;
        const win = window.open('', '_blank');
        win.document.write(`
          <html><head><title>GRN Receipt - ${grnNo}</title>
          <style>
            @page { size: A4; margin: 15mm; }
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: 'Times New Roman', Times, serif; font-size: 12px; color: #000; }
            .receipt { width: 100%; max-width: 750px; margin: 0 auto; }
            .header { text-align: center; border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 10px; }
            .header h1 { font-size: 18px; font-weight: bold; text-transform: uppercase; margin-bottom: 2px; }
            .header h2 { font-size: 14px; font-weight: bold; text-transform: uppercase; text-decoration: underline; }
            .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 20px; margin-bottom: 10px; }
            .info-row { display: flex; gap: 4px; font-size: 12px; }
            .info-label { font-weight: bold; min-width: 120px; }
            .info-value { border-bottom: 1px dotted #000; flex: 1; min-height: 18px; }
            .factory-section { margin: 8px 0; font-size: 12px; }
            .factory-section span { display: inline-block; width: 22px; height: 22px; border: 1px solid #000; text-align: center; line-height: 22px; margin: 0 2px; font-weight: bold; }
            .factory-section span.active { background: #000; color: #fff; }
            table { width: 100%; border-collapse: collapse; margin: 10px 0; }
            th, td { border: 1px solid #000; padding: 4px 6px; text-align: center; font-size: 11px; }
            th { background: #f0f0f0; font-weight: bold; font-size: 11px; }
            td { min-height: 24px; }
            .signatures { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; margin-top: 30px; font-size: 12px; }
            .sig-block { text-align: center; }
            .sig-line { border-top: 1px solid #000; margin-top: 40px; padding-top: 4px; }
            .receipt-no { font-size: 14px; font-weight: bold; text-align: right; margin-bottom: 4px; }
          </style></head><body>
          ${printContent.innerHTML}
          <script>window.onload = function() { window.print(); window.close(); }<\/script>
          </body></html>
        `);
        win.document.close();
        setPrintData(null);
      }, 100);
    } catch {
      alert('Failed to load GRN details for printing');
    }
  };

  // Derive factory number from LocationName (e.g. "F7" → 7, "F1" → 1)
  const factoryNum = (() => {
    const loc = printData?.LocationName || '';
    const match = loc.match(/^F(\d+)$/i);
    return match ? parseInt(match[1]) : null;
  })();

  const handleDeleteGRN = async (grnNo) => {
    if (!window.confirm(`Delete GRN ${grnNo}? This will remove all GRN items and reset the entry status to QAAccepted.`)) return;
    try {
      await api.delete(`/grn/${encodeURIComponent(grnNo)}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to delete GRN');
    }
  };

  return (
    <div>
      <div className="page-header"><h1>GRN List</h1></div>

      <div className="card">
        <form onSubmit={(e) => { e.preventDefault(); setPage(1); load(); }} className="flex-between mb-4" style={{ gap: 12 }}>
          <input
            placeholder="Search GRN no, entry no, supplier…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1, padding: '8px 12px', border: '1px solid var(--gray-300)', borderRadius: 'var(--radius)' }}
          />
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            style={{ padding: '8px 12px', border: '1px solid var(--gray-300)', borderRadius: 'var(--radius)' }}>
            <option value="">All Statuses</option>
            <option value="Created">Created</option>
            <option value="FullyReceived">Fully Received</option>
            <option value="PartiallyReceived">Partially Received</option>
            <option value="Reversed">Reversed</option>
          </select>
          <button type="submit" className="btn btn-primary">Search</button>
        </form>

        {loading ? <div>Loading…</div> : (
          <table className="data-table">
            <thead>
              <tr>
                <th>GRN No</th>
                <th>Entry No</th>
                <th>Supplier</th>
                <th>Department</th>
                <th>Location</th>
                <th>Status</th>
                <th>Received By</th>
                <th>Date</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {grns.map((g) => (
                <tr key={g.GRNId}>
                  <td><strong>{g.GRNNo}</strong></td>
                  <td>{g.EntryNo}</td>
                  <td>{g.SupplierName}</td>
                  <td>{g.ReceivingDept === 'CentralStore' ? 'Central Store' : 'Factory'}</td>
                  <td>{g.LocationName || '-'}</td>
                  <td><span className={`badge ${STATUS_BADGE[g.GRNStatus] || 'badge-gray'}`}>{g.GRNStatus}</span></td>
                  <td>{g.ReceivedByName}</td>
                  <td>{new Date(g.ReceivedAt).toLocaleString()}</td>
                  <td style={{ display: 'flex', gap: 4 }}>
                    <button className="btn btn-outline" style={{ padding: '4px 10px', fontSize: 12 }}
                      onClick={() => handlePrint(g.GRNNo)} title="Print GRN Receipt">
                      🖨️ Print
                    </button>
                    {isAdmin && (
                      <button className="btn" style={{ padding: '4px 10px', fontSize: 12, background: '#dc2626', color: '#fff', border: 'none' }}
                        onClick={() => handleDeleteGRN(g.GRNNo)} title="Delete GRN">
                        🗑️
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {grns.length === 0 && (
                <tr><td colSpan="9" className="text-center text-muted">No GRNs found</td></tr>
              )}
            </tbody>
          </table>
        )}

        <div className="flex-between mt-4">
          <div />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>
            <button className="btn btn-outline" disabled={grns.length < 25} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        </div>
      </div>

      {/* Hidden Print Template */}
      {printData && (
        <div style={{ position: 'absolute', left: '-9999px', top: 0 }}>
          <div ref={printRef}>
            <div className="receipt">
              <div className="receipt-no">No: {printData.GRNNo}</div>
              <div className="header">
                <h1>Njoro Canning Factory</h1>
                <h2>Raw Material Receipts</h2>
              </div>

              <div className="factory-section">
                <strong>Factory / Section:</strong>{' '}
                <span className="active" style={{ padding: '2px 8px', minWidth: 'auto', width: 'auto' }}>
                  {printData.LocationName || '—'}
                </span>
              </div>

              <div className="info-grid">
                <div className="info-row">
                  <span className="info-label">WB Ticket No:</span>
                  <span className="info-value">{printData.WBTicketNo || ''}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">DATE:</span>
                  <span className="info-value">{printData.ReceivedAt ? new Date(printData.ReceivedAt).toLocaleDateString() : ''}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">Supplier Name:</span>
                  <span className="info-value">{printData.SupplierName}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">Vehicle No:</span>
                  <span className="info-value">{printData.VehicleRegNo}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">Order No:</span>
                  <span className="info-value">{printData.PurchaseOrderNo || ''}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">Item Delivered:</span>
                  <span className="info-value">{(printData.items || []).map(it => it.MaterialName).join(', ')}</span>
                </div>
              </div>

              <table>
                <thead>
                  <tr>
                    <th style={{width: '8%'}}>No. of Bags</th>
                    <th style={{width: '13%'}}>Weight (Kgs)</th>
                    <th style={{width: '13%'}}>Moisture %</th>
                    <th style={{width: '13%'}}>Rejected %</th>
                    <th style={{width: '13%'}}>Qty Accepted</th>
                    <th style={{width: '16%'}}>Amount (KES)</th>
                    <th style={{width: '24%'}}>Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  {(printData.items || []).map((item, i) => (
                    <tr key={i}>
                      <td></td>
                      <td>{printData.WBNetWeight || item.ReceivedQty || ''}</td>
                      <td>{item.Moisture || ''}</td>
                      <td>{item.RejectedQty > 0 && item.ReceivedQty ? ((item.RejectedQty / item.ReceivedQty) * 100).toFixed(1) + '%' : ''}</td>
                      <td>{printData.QAAcceptedQty || printData.WBNetWeight || item.AcceptedQty || ''}</td>
                      <td>{item.ErpAmount ? Number(item.ErpAmount).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''}</td>
                      <td>{item.Remarks || item.RejectionReason || item.QARemarks || ''}</td>
                    </tr>
                  ))}
                  {/* Ensure at least 5 rows for the form look */}
                  {Array.from({ length: Math.max(0, 5 - (printData.items || []).length) }).map((_, i) => (
                    <tr key={`empty-${i}`}>
                      <td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td><td></td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="signatures">
                <div className="sig-block">
                  <div className="sig-line">Delivered By / Sign</div>
                  <div style={{marginTop: 4, fontSize: 11}}>{printData.DriverName || ''}</div>
                </div>
                <div className="sig-block">
                  <div className="sig-line">OC Responsible / Sign</div>
                </div>
                <div className="sig-block">
                  <div className="sig-line">Received By / Sign</div>
                  <div style={{marginTop: 4, fontSize: 11}}>{printData.ReceivedByName || ''}</div>
                </div>
              </div>

              <div style={{ marginTop: 40, textAlign: 'center', fontSize: 10, color: '#666', borderTop: '1px solid #ccc', paddingTop: 8 }}>
                njorocanning@2026 all rights reserved
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
