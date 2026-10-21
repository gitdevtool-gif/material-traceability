import React, { useEffect, useState } from 'react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';

const fmtDT = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
const fmtDate = (v) => (v ? new Date(v).toLocaleDateString() : '—');

export default function QAInspectionPage() {
  const [pending, setPending] = useState([]);
  const [selected, setSelected] = useState(null);
  const [entryDetail, setEntryDetail] = useState(null);
  const [inspection, setInspection] = useState(null);
  const [form, setForm] = useState({ coaProvided: false, coaReference: '', samplesTaken: false, physicalCheckDone: false, vehicleInspectionDone: false, remarks: '' });
  const [tests, setTests] = useState([]);
  const [decision, setDecision] = useState({ decision: '', acceptedQty: '', rejectedQty: '', remarks: '' });
  const [rejectionForm, setRejectionForm] = useState({ rejectionReason: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [step, setStep] = useState('list'); // list | create | tests | decide | report | templates
  const [reportData, setReportData] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportDateFrom, setReportDateFrom] = useState('');
  const [reportDateTo, setReportDateTo] = useState('');
  const [reportFactory, setReportFactory] = useState('');
  const [factories, setFactories] = useState([]);
  const [reportPage, setReportPage] = useState(1);
  const [reportPageSize, setReportPageSize] = useState(10);
  // Template config state
  const [templates, setTemplates] = useState([]);
  const [templateLocations, setTemplateLocations] = useState([]);
  const [templateMaterials, setTemplateMaterials] = useState([]);
  const [templateForm, setTemplateForm] = useState({ locationId: '', materialId: '', testName: '', testMethod: '', expectedValue: '' });
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateFilterLoc, setTemplateFilterLoc] = useState('');
  const [templateFilterMat, setTemplateFilterMat] = useState('');
  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';

  const canSeeAllFactories = ['Admin', 'Supervisor', 'QAManager', 'Viewer'].includes(user?.role);

  // Extract factory identifier from user email (e.g. f1production@... → F1)
  const userFactory = (() => {
    if (!user?.email) return null;
    const m = user.email.toLowerCase().match(/^f(\d+)production@/);
    return m ? `F${m[1]}` : null;
  })();

  // Factory filter for the pending-entries list (canSeeAllFactories users
  // only — factory-restricted users are already auto-filtered server-side
  // by their email, so this control isn't shown to them).
  const [listFactory, setListFactory] = useState('');
  const [listFactories, setListFactories] = useState([]);

  const loadPending = (factory) => {
    const params = {};
    if (factory) params.factory = factory;
    api.get('/qa/pending', { params }).then((r) => setPending(r.data)).catch(() => {});
  };
  useEffect(() => { loadPending(listFactory); }, [listFactory]);

  // Full materials list — used as a fallback for the per-test material
  // picker when an entry has no recorded DeliveryEntryItems (a data gap
  // upstream at Gate Entry, not something QA can fix), so a test can still
  // be linked to a real material instead of silently submitting a blank
  // one that the database will reject.
  const [allMaterials, setAllMaterials] = useState([]);
  useEffect(() => {
    api.get('/materials?active=true').then(r => setAllMaterials(r.data)).catch(() => {});
  }, []);

  // Load the factory dropdown options once — visible to every user, not
  // just canSeeAllFactories roles. Reuses /locations the same way the
  // Templates step does.
  useEffect(() => {
    api.get('/locations')
      .then(r => setListFactories(r.data.filter(l => l.LocationType === 'Factory').map(l => l.LocationName)))
      .catch(() => {});
  }, []);

  const loadReport = (from, to, factory) => {
    setReportLoading(true);
    setReportPage(1);
    const params = {};
    if (from) params.dateFrom = from;
    if (to) params.dateTo = to;
    if (factory) params.factory = factory;
    api.get('/qa/summary', { params })
      .then((r) => {
        setReportData(r.data);
        if (r.data.factories) setFactories(r.data.factories);
      })
      .catch(() => {})
      .finally(() => setReportLoading(false));
  };

  const showReport = () => {
    setStep('report');
    setSelected(null); setInspection(null);
    loadReport(reportDateFrom, reportDateTo, reportFactory);
  };

  const handleSelect = async (entry) => {
    setSelected(entry);
    setError(''); setSuccess('');
    try {
      const res = await api.get(`/entries/${entry.EntryNo}`);
      setEntryDetail(res.data);
      if (entry.InspectionNo) {
        const qaRes = await api.get(`/qa/${entry.InspectionNo}`);
        setInspection(qaRes.data);
        setTests(qaRes.data.tests || []);
        setStep('tests');
      } else {
        setInspection(null);
        setTests([]);
        setForm({ coaProvided: false, coaReference: '', samplesTaken: false, physicalCheckDone: false, vehicleInspectionDone: false, remarks: '' });
        setStep('create');
      }
    } catch { setError('Failed to load entry details'); }
  };

  const handleCreateInspection = async (e) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const res = await api.post('/qa', { entryNo: selected.EntryNo, ...form });
      setInspection(res.data);
      setSuccess(`QA Inspection ${res.data.InspectionNo} created`);
      setStep('tests');

      // Try to load test templates for this entry's factory+materials
      let templateTests = [];
      try {
        const tplRes = await api.get('/qa/templates/for-inspection', { params: { entryNo: selected.EntryNo } });
        templateTests = (tplRes.data || []).map(t => ({
          materialId: t.MaterialId, materialName: `${t.MaterialCode} — ${t.MaterialName}`,
          testName: t.TestName, testMethod: t.TestMethod || '', expectedValue: '',
          actualValue: '', result: 'Pending', remarks: '',
        }));
      } catch { /* no templates configured */ }

      if (templateTests.length > 0) {
        setTests(templateTests);
      } else {
        // Fallback: Init test rows from entry items
        const items = entryDetail?.items || [];
        setTests(items.map(it => ({
          materialId: it.MaterialId, materialName: `${it.MaterialCode} — ${it.MaterialName}`,
          testName: '', testMethod: '', expectedValue: '', actualValue: '', result: 'Pending', remarks: '',
        })));
      }
      loadPending(listFactory);
    } catch (err) { setError(err.response?.data?.error || 'Failed to create inspection'); }
    finally { setSaving(false); }
  };

  const addTestRow = () => {
    const items = entryDetail?.items || [];
    setTests([...tests, {
      materialId: items[0]?.MaterialId || '', materialName: items[0] ? `${items[0].MaterialCode} — ${items[0].MaterialName}` : '',
      testName: '', testMethod: '', expectedValue: '', actualValue: '', result: 'Pending', remarks: '',
    }]);
  };

  const setTestField = (i, field) => (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    const updated = [...tests]; updated[i] = { ...updated[i], [field]: val };
    if (field === 'materialId') {
      const mat = (entryDetail?.items || []).find(it => it.MaterialId === parseInt(val));
      updated[i].materialName = mat ? `${mat.MaterialCode} — ${mat.MaterialName}` : '';
    }
    setTests(updated);
  };

  const handleSubmitTests = async () => {
    if (!inspection) return;
    const newTests = tests.filter(t => t.testName && !t.TestResultId);
    if (newTests.length === 0) { setError('Add at least one test with a test name'); return; }
    if (newTests.some(t => !t.materialId || isNaN(parseInt(t.materialId)))) {
      setError('Select a material for every test row before saving — one or more rows are missing it.');
      return;
    }
    setSaving(true); setError('');
    try {
      await api.post(`/qa/${inspection.InspectionNo}/tests`, {
        tests: newTests.map(t => ({
          materialId: parseInt(t.materialId), testName: t.testName, testMethod: t.testMethod,
          expectedValue: t.expectedValue, actualValue: t.actualValue, result: t.result, remarks: t.remarks,
        })),
      });
      setSuccess('Test results saved');
      // Reload
      const qaRes = await api.get(`/qa/${inspection.InspectionNo}`);
      setInspection(qaRes.data);
      setTests(qaRes.data.tests || []);
      setStep('decide');
    } catch (err) { setError(err.response?.data?.error || 'Failed to save tests'); }
    finally { setSaving(false); }
  };

  const handleDecision = async (e) => {
    e.preventDefault();
    if (!decision.decision) { setError('Select a decision'); return; }
    if (decision.decision === 'Rejected' && !rejectionForm.rejectionReason) {
      setError('Rejection reason is required'); return;
    }
    setSaving(true); setError('');
    try {
      const res = await api.patch(`/qa/${inspection.InspectionNo}/decision`, {
        decision: decision.decision,
        acceptedQty: decision.acceptedQty ? parseFloat(decision.acceptedQty) : null,
        rejectedQty: decision.rejectedQty ? parseFloat(decision.rejectedQty) : null,
        remarks: decision.remarks,
      });

      // Auto-create rejection note when decision is Rejected
      if (decision.decision === 'Rejected') {
        try {
          await api.post('/rejections', {
            entryNo: selected.EntryNo,
            rejectionReason: rejectionForm.rejectionReason,
            notes: rejectionForm.notes,
            items: (entryDetail?.items || []).map(it => ({
              materialId: it.MaterialId,
              rejectedQty: parseFloat(decision.rejectedQty) || it.Quantity,
              uom: it.UOM,
              rejectionReason: rejectionForm.rejectionReason,
            })),
          });
          setSuccess(`QA Decision: Rejected. Rejection note created for ${selected.EntryNo}.`);
        } catch (rejErr) {
          setSuccess(`QA Decision: Rejected. Note: Rejection note could not be auto-created — ${rejErr.response?.data?.error || 'unknown error'}`);
        }
      } else {
        setSuccess(`QA Decision: ${res.data.decision}. Entry status: ${res.data.entryStatus}`);
      }

      setSelected(null); setInspection(null); setStep('list');
      setRejectionForm({ rejectionReason: '', notes: '' });
      loadPending(listFactory);
    } catch (err) { setError(err.response?.data?.error || 'Failed to submit decision'); }
    finally { setSaving(false); }
  };

  const goBack = () => { setSelected(null); setInspection(null); setStep('list'); setError(''); setSuccess(''); };

  const handleDeleteInspection = async (inspectionNo) => {
    if (!window.confirm(`Delete QA inspection ${inspectionNo}? This will remove all test results and rejection notes. The entry will be reset to WeighbridgeCompleted.`)) return;
    try {
      await api.delete(`/qa/${inspectionNo}`);
      setSuccess(`QA Inspection ${inspectionNo} deleted`);
      setSelected(null); setInspection(null); setStep('list');
      loadPending(listFactory);
    } catch (err) { setError(err.response?.data?.error || 'Failed to delete inspection'); }
  };

  // ── Template management ──
  const loadTemplates = async () => {
    setTemplateLoading(true);
    try {
      const params = {};
      if (templateFilterLoc) params.locationId = templateFilterLoc;
      else if (userFactory && !canSeeAllFactories) {
        // Factory users auto-filter to their own factory
        const myFac = templateLocations.find(l => l.LocationType === 'Factory' && l.LocationName.toUpperCase().includes(userFactory));
        if (myFac) params.locationId = myFac.LocationId;
      }
      if (templateFilterMat) params.materialId = templateFilterMat;
      const res = await api.get('/qa/templates', { params });
      setTemplates(res.data);
    } catch { setTemplates([]); }
    finally { setTemplateLoading(false); }
  };

  const showTemplates = () => {
    setStep('templates');
    setSelected(null); setInspection(null);
    setError(''); setSuccess('');
    // Load locations & materials for dropdowns
    api.get('/locations').then(r => {
      setTemplateLocations(r.data);
      // Auto-select user's factory
      if (userFactory && !canSeeAllFactories) {
        const myFactory = r.data.find(l => l.LocationType === 'Factory' && l.LocationName.toUpperCase().includes(userFactory));
        if (myFactory) {
          setTemplateForm(f => ({ ...f, locationId: String(myFactory.LocationId) }));
          setTemplateFilterLoc(String(myFactory.LocationId));
        }
      }
    }).catch(() => {});
    api.get('/materials').then(r => setTemplateMaterials(r.data)).catch(() => {});
    loadTemplates();
  };

  const handleAddTemplate = async (e) => {
    e.preventDefault();
    if (!templateForm.locationId || !templateForm.materialId || !templateForm.testName) {
      setError('Factory, Material, and Test Name are required'); return;
    }
    setSaving(true); setError('');
    try {
      await api.post('/qa/templates', {
        locationId: parseInt(templateForm.locationId),
        materialId: parseInt(templateForm.materialId),
        testName: templateForm.testName,
        testMethod: templateForm.testMethod,
        expectedValue: templateForm.expectedValue,
      });
      setTemplateForm({ ...templateForm, testName: '', testMethod: '', expectedValue: '' });
      setSuccess('Template added');
      loadTemplates();
    } catch (err) { setError(err.response?.data?.error || 'Failed to add template'); }
    finally { setSaving(false); }
  };

  const handleDeleteTemplate = async (id) => {
    if (!window.confirm('Delete this test template?')) return;
    try {
      await api.delete(`/qa/templates/${id}`);
      loadTemplates();
    } catch (err) { setError(err.response?.data?.error || 'Failed to delete template'); }
  };

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>QA Inspection {userFactory && <span style={{ fontSize: 16, fontWeight: 400, color: 'var(--gray-500)' }}>— {userFactory}</span>}</h1>
        {step === 'list' && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-outline" onClick={showTemplates} style={{ fontSize: 13 }}>⚙️ Configure Tests</button>
            <button className="btn btn-outline" onClick={showReport} style={{ fontSize: 13 }}>📊 Report Summary</button>
          </div>
        )}
      </div>
      {success && <div className="card" style={{ color: 'var(--success)' }}>{success}</div>}
      {error && <div className="card" style={{ color: 'var(--danger)' }}>{error}</div>}

      {/* STEP: REPORT SUMMARY */}
      {step === 'report' && (
        <div>
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3>QA Report Summary</h3>
              <button className="btn btn-outline" onClick={goBack}>← Back to Inspections</button>
            </div>

            <div className="form-row" style={{ marginBottom: 16 }}>
              <div className="form-group">
                <label>Date From</label>
                <input type="date" value={reportDateFrom} onChange={e => setReportDateFrom(e.target.value)} />
              </div>
              <div className="form-group">
                <label>Date To</label>
                <input type="date" value={reportDateTo} onChange={e => setReportDateTo(e.target.value)} />
              </div>
              <div className="form-group">
                <label>Factory / Location</label>
                <select value={reportFactory} onChange={e => setReportFactory(e.target.value)}>
                  <option value="">All Factories</option>
                  {factories.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
              <div className="form-group" style={{ display: 'flex', alignItems: 'end' }}>
                <button className="btn btn-primary" onClick={() => loadReport(reportDateFrom, reportDateTo, reportFactory)}>Filter</button>
              </div>
            </div>

            {reportLoading ? <div>Loading report…</div> : reportData && (
              <>
                {/* Stats Cards */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
                  <div style={{ padding: 16, background: 'var(--gray-50)', borderRadius: 'var(--radius)', textAlign: 'center', borderLeft: '4px solid var(--primary)' }}>
                    <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--primary)' }}>{reportData.stats.TotalInspections}</div>
                    <div style={{ fontSize: 12, color: 'var(--gray-600)' }}>Total Inspections</div>
                  </div>
                  <div style={{ padding: 16, background: '#f0fdf4', borderRadius: 'var(--radius)', textAlign: 'center', borderLeft: '4px solid #16a34a' }}>
                    <div style={{ fontSize: 28, fontWeight: 700, color: '#16a34a' }}>{reportData.stats.Accepted}</div>
                    <div style={{ fontSize: 12, color: 'var(--gray-600)' }}>Accepted</div>
                  </div>
                  <div style={{ padding: 16, background: '#fef2f2', borderRadius: 'var(--radius)', textAlign: 'center', borderLeft: '4px solid #dc2626' }}>
                    <div style={{ fontSize: 28, fontWeight: 700, color: '#dc2626' }}>{reportData.stats.Rejected}</div>
                    <div style={{ fontSize: 12, color: 'var(--gray-600)' }}>Rejected</div>
                  </div>
                  <div style={{ padding: 16, background: '#fffbeb', borderRadius: 'var(--radius)', textAlign: 'center', borderLeft: '4px solid #d97706' }}>
                    <div style={{ fontSize: 28, fontWeight: 700, color: '#d97706' }}>{reportData.stats.Quarantine}</div>
                    <div style={{ fontSize: 12, color: 'var(--gray-600)' }}>Quarantine</div>
                  </div>
                  <div style={{ padding: 16, background: '#eff6ff', borderRadius: 'var(--radius)', textAlign: 'center', borderLeft: '4px solid #2563eb' }}>
                    <div style={{ fontSize: 28, fontWeight: 700, color: '#2563eb' }}>{reportData.stats.Conditional}</div>
                    <div style={{ fontSize: 12, color: 'var(--gray-600)' }}>Conditional</div>
                  </div>
                  <div style={{ padding: 16, background: 'var(--gray-50)', borderRadius: 'var(--radius)', textAlign: 'center', borderLeft: '4px solid var(--gray-500)' }}>
                    <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--gray-600)' }}>{reportData.stats.InProgress}</div>
                    <div style={{ fontSize: 12, color: 'var(--gray-600)' }}>In Progress</div>
                  </div>
                </div>

                {/* Quantity Summary */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
                  <div style={{ padding: 16, background: '#f0fdf4', borderRadius: 'var(--radius)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600 }}>Total Accepted Qty</span>
                    <span style={{ fontSize: 22, fontWeight: 700, color: '#16a34a' }}>{Number(reportData.stats.TotalAcceptedQty).toLocaleString()} kg</span>
                  </div>
                  <div style={{ padding: 16, background: '#fef2f2', borderRadius: 'var(--radius)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600 }}>Total Rejected Qty</span>
                    <span style={{ fontSize: 22, fontWeight: 700, color: '#dc2626' }}>{Number(reportData.stats.TotalRejectedQty).toLocaleString()} kg</span>
                  </div>
                </div>

                {/* Finalized Inspections Table */}
                <h4 style={{ margin: '16px 0 8px' }}>Recent Decisions</h4>
                <div style={{ overflowX: 'auto' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Inspection No</th>
                        <th>Entry No</th>
                        <th>Supplier</th>
                        <th>Material</th>
                        <th>Vehicle</th>
                        <th>Factory</th>
                        <th>Net Wt (kg)</th>
                        <th>Rejected Qty</th>
                        <th>Accepted Qty</th>
                        <th>Decision</th>
                        <th>Inspector</th>
                        <th>Approved By</th>
                        <th>Date</th>
                        <th>Remarks</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const allInsp = reportData.inspections;
                        const totalPages = Math.max(1, Math.ceil(allInsp.length / reportPageSize));
                        const safePage = Math.min(reportPage, totalPages);
                        const paged = allInsp.slice((safePage - 1) * reportPageSize, safePage * reportPageSize);
                        return paged.length === 0
                          ? <tr><td colSpan="14" className="text-center text-muted">No finalized inspections found</td></tr>
                          : paged.map(insp => (
                        <tr key={insp.InspectionNo}>
                          <td><strong>{insp.InspectionNo}</strong></td>
                          <td>{insp.EntryNo}</td>
                          <td>{insp.SupplierName}</td>
                          <td style={{ maxWidth: 180, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{insp.Materials || '—'}</td>
                          <td>{insp.VehicleRegNo}</td>
                          <td><span className="badge badge-blue">{insp.Factory || '—'}</span></td>
                          <td>{insp.NetWeight}</td>
                          <td style={{ color: insp.RejectedQty > 0 ? '#dc2626' : undefined }}>{insp.RejectedQty || '—'}</td>
                          <td style={{ color: '#16a34a' }}>{insp.AcceptedQty || '—'}</td>
                          <td>
                            <span className={`badge badge-${insp.OverallStatus === 'Accepted' ? 'success' : insp.OverallStatus === 'Rejected' ? 'danger' : insp.OverallStatus === 'Quarantine' ? 'warning' : 'info'}`}>
                              {insp.OverallStatus}
                            </span>
                          </td>
                          <td>{insp.InspectorName}</td>
                          <td>{insp.ApprovedByName || '—'}</td>
                          <td>{insp.ApprovedAt ? new Date(insp.ApprovedAt).toLocaleDateString() : '—'}</td>
                          <td style={{ maxWidth: 200, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{insp.OverallRemarks || '—'}</td>
                        </tr>
                      ));
                      })()}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {reportData.inspections.length > 0 && (() => {
                  const total = reportData.inspections.length;
                  const totalPages = Math.max(1, Math.ceil(total / reportPageSize));
                  const safePage = Math.min(reportPage, totalPages);
                  return (
                    <div style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '12px 0', fontSize: 13, flexWrap: 'wrap', gap: 12, marginTop: 8,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--gray-500)' }}>
                        <span>Show</span>
                        <select value={reportPageSize} onChange={e => { setReportPageSize(Number(e.target.value)); setReportPage(1); }}
                          style={{ padding: '4px 8px', border: '1px solid var(--gray-300)', borderRadius: 'var(--radius)', fontSize: 13 }}>
                          {[5, 10, 20, 50].map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                        <span>of {total} inspections</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <button className="btn btn-outline" style={{ padding: '4px 10px', fontSize: 13 }}
                          disabled={safePage <= 1} onClick={() => setReportPage(1)}>«</button>
                        <button className="btn btn-outline" style={{ padding: '4px 10px', fontSize: 13 }}
                          disabled={safePage <= 1} onClick={() => setReportPage(p => p - 1)}>‹</button>
                        {Array.from({ length: totalPages }, (_, i) => i + 1)
                          .filter(p => p === 1 || p === totalPages || Math.abs(p - safePage) <= 1)
                          .reduce((acc, p, i, arr) => {
                            if (i > 0 && p - arr[i - 1] > 1) acc.push('...');
                            acc.push(p);
                            return acc;
                          }, [])
                          .map((p, i) => typeof p === 'string'
                            ? <span key={`e${i}`} style={{ padding: '4px 6px', color: 'var(--gray-400)' }}>{p}</span>
                            : <button key={p} className="btn" onClick={() => setReportPage(p)}
                                style={{
                                  padding: '4px 10px', fontSize: 13, minWidth: 32,
                                  background: p === safePage ? 'var(--primary)' : '#fff',
                                  color: p === safePage ? '#fff' : 'var(--gray-700)',
                                  border: `1px solid ${p === safePage ? 'var(--primary)' : 'var(--gray-300)'}`,
                                }}>{p}</button>
                          )}
                        <button className="btn btn-outline" style={{ padding: '4px 10px', fontSize: 13 }}
                          disabled={safePage >= totalPages} onClick={() => setReportPage(p => p + 1)}>›</button>
                        <button className="btn btn-outline" style={{ padding: '4px 10px', fontSize: 13 }}
                          disabled={safePage >= totalPages} onClick={() => setReportPage(totalPages)}>»</button>
                      </div>
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        </div>
      )}

      {/* STEP: CONFIGURE TEST TEMPLATES */}
      {step === 'templates' && (
        <div>
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3>Configure QA Test Templates</h3>
              <button className="btn btn-outline" onClick={goBack}>← Back to Inspections</button>
            </div>
            <p style={{ color: 'var(--gray-500)', marginBottom: 16, fontSize: 13 }}>
              Define which test parameters should be checked for each material at each factory. Expected values / limits are entered by QA during inspection.
            </p>

            {/* Add template form */}
            <form onSubmit={handleAddTemplate} style={{ padding: 16, background: 'var(--gray-50)', borderRadius: 'var(--radius)', marginBottom: 16 }}>
              <h4 style={{ marginBottom: 12 }}>Add Test Template</h4>
              <div className="form-row">
                <div className="form-group">
                  <label>Factory / Location *</label>
                  {userFactory && !canSeeAllFactories ? (
                    <input value={templateLocations.find(l => String(l.LocationId) === templateForm.locationId)?.LocationName || userFactory} readOnly
                      style={{ background: '#f3f4f6', fontWeight: 600 }} />
                  ) : (
                    <select value={templateForm.locationId} onChange={e => setTemplateForm({ ...templateForm, locationId: e.target.value })} required>
                      <option value="">-- Select Factory --</option>
                      {templateLocations.filter(l => l.LocationType === 'Factory').map(l => (
                        <option key={l.LocationId} value={l.LocationId}>{l.LocationName}</option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="form-group">
                  <label>Material *</label>
                  <select value={templateForm.materialId} onChange={e => setTemplateForm({ ...templateForm, materialId: e.target.value })} required>
                    <option value="">-- Select Material --</option>
                    {templateMaterials.map(m => (
                      <option key={m.MaterialId} value={m.MaterialId}>{m.MaterialCode} — {m.MaterialName}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Test Name *</label>
                  <input value={templateForm.testName} onChange={e => setTemplateForm({ ...templateForm, testName: e.target.value })}
                    placeholder="e.g. Moisture, pH, Brix" required />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Test Method</label>
                  <input value={templateForm.testMethod} onChange={e => setTemplateForm({ ...templateForm, testMethod: e.target.value })}
                    placeholder="e.g. Lab Analysis, Visual" />
                </div>
                <div className="form-group" style={{ display: 'flex', alignItems: 'end' }}>
                  <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Adding…' : '+ Add Template'}</button>
                </div>
              </div>
            </form>

            {/* Filter */}
            <div className="form-row" style={{ marginBottom: 12 }}>
              <div className="form-group">
                <label>Filter by Factory</label>
                {canSeeAllFactories ? (
                  <select value={templateFilterLoc} onChange={e => { setTemplateFilterLoc(e.target.value); }}>
                    <option value="">All Factories</option>
                    {templateLocations.filter(l => l.LocationType === 'Factory').map(l => (
                      <option key={l.LocationId} value={l.LocationId}>{l.LocationName}</option>
                    ))}
                  </select>
                ) : (
                  <input value={templateLocations.find(l => String(l.LocationId) === templateFilterLoc)?.LocationName || userFactory || ''} readOnly
                    style={{ background: '#f3f4f6', fontWeight: 600 }} />
                )}
              </div>
              <div className="form-group">
                <label>Filter by Material</label>
                <select value={templateFilterMat} onChange={e => { setTemplateFilterMat(e.target.value); }}>
                  <option value="">All Materials</option>
                  {templateMaterials.map(m => (
                    <option key={m.MaterialId} value={m.MaterialId}>{m.MaterialCode} — {m.MaterialName}</option>
                  ))}
                </select>
              </div>
              <div className="form-group" style={{ display: 'flex', alignItems: 'end' }}>
                <button type="button" className="btn btn-outline" onClick={loadTemplates}>Filter</button>
              </div>
            </div>

            {/* Templates table */}
            {templateLoading ? <div>Loading templates…</div> : (
              <table className="data-table">
                <thead>
                  <tr><th>Factory</th><th>Material</th><th>Test Parameter</th><th>Method</th><th></th></tr>
                </thead>
                <tbody>
                  {templates.map(t => (
                    <tr key={t.TemplateId}>
                      <td>{t.LocationName}</td>
                      <td>{t.MaterialCode} — {t.MaterialName}</td>
                      <td><strong>{t.TestName}</strong></td>
                      <td>{t.TestMethod || '—'}</td>
                      <td>
                        <button className="btn btn-outline" style={{ padding: '2px 8px', fontSize: 12, color: '#dc2626', borderColor: '#dc2626' }}
                          onClick={() => handleDeleteTemplate(t.TemplateId)}>🗑️</button>
                      </td>
                    </tr>
                  ))}
                  {templates.length === 0 && (
                    <tr><td colSpan="5" className="text-center text-muted">No templates configured yet</td></tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* STEP: LIST */}
      {step === 'list' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>Entries Awaiting QA ({pending.length})</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ fontSize: 13, color: 'var(--gray-600)', margin: 0 }}>Factory</label>
              <select value={listFactory} onChange={e => setListFactory(e.target.value)} style={{ minWidth: 160 }}>
                <option value="">All Factories</option>
                {listFactories.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
          </div>
          <table className="data-table">
            <thead>
              <tr><th>Entry No</th><th>Factory</th><th>Supplier</th><th>Consignment</th><th>Vehicle</th><th>Net Wt</th><th>Delivery Date</th><th>WB Completed</th><th>Status</th><th>QA Status</th><th></th></tr>
            </thead>
            <tbody>
              {pending.map(e => (
                <tr key={e.EntryId}>
                  <td><strong>{e.EntryNo}</strong></td>
                  <td>{e.FactoryName || '—'}</td>
                  <td>{e.SupplierName}</td>
                  <td>{e.ConsignmentNo}</td>
                  <td>{e.VehicleRegNo}</td>
                  <td>{e.NetWeight} kg</td>
                  <td style={{ fontSize: 12, whiteSpace: 'nowrap', color: 'var(--gray-600)' }}>
                    {fmtDate(e.DeliveryDate)}
                    {e.DeliveryTime && <><br /><span style={{ color: 'var(--gray-500)' }}>{String(e.DeliveryTime).slice(0, 5)}</span></>}
                  </td>
                  <td style={{ fontSize: 12, whiteSpace: 'nowrap', color: 'var(--gray-600)' }}>{fmtDT(e.WBCompletedAt)}</td>
                  <td><span className={`badge badge-${e.Status === 'WeighbridgeCompleted' ? 'info' : e.Status === 'Quarantine' ? 'warning' : 'default'}`}>{e.Status}</span></td>
                  <td>{e.QAStatus || '—'}</td>
                  <td style={{ display: 'flex', gap: 4 }}>
                    <button className="btn btn-primary" style={{ padding: '4px 12px', fontSize: 13 }} onClick={() => handleSelect(e)}>
                      {e.InspectionNo ? 'Continue' : 'Inspect'}
                    </button>
                    {isAdmin && e.InspectionNo && (
                      <button className="btn btn-outline" style={{ padding: '4px 10px', fontSize: 12, color: '#dc2626', borderColor: '#dc2626' }}
                        onClick={() => handleDeleteInspection(e.InspectionNo)} title="Delete inspection">🗑️</button>
                    )}
                  </td>
                </tr>
              ))}
              {pending.length === 0 && <tr><td colSpan="10" className="text-center text-muted">No entries pending QA</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* STEP: CREATE INSPECTION */}
      {step === 'create' && selected && (
        <form className="card" onSubmit={handleCreateInspection}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3>Start QA Inspection — {selected.EntryNo}</h3>
            <button type="button" className="btn btn-outline" onClick={goBack}>Back</button>
          </div>
          <div style={{ padding: 12, background: 'var(--gray-50)', borderRadius: 'var(--radius)', margin: '12px 0' }}>
            <strong>Supplier:</strong> {entryDetail?.SupplierName} | <strong>Consignment:</strong> {entryDetail?.ConsignmentNo} | <strong>Vehicle:</strong> {entryDetail?.VehicleRegNo} | <strong>Net Weight:</strong> {entryDetail?.NetWeight} kg
            {entryDetail?.PurchaseOrderNo && <><br /><strong>PO:</strong> {entryDetail.PurchaseOrderNo}</>}
          </div>
          <div className="form-row">
            <div className="form-group">
              <label><input type="checkbox" checked={form.coaProvided} onChange={e => setForm({ ...form, coaProvided: e.target.checked })} /> COA (Certificate of Analysis) Provided</label>
            </div>
            <div className="form-group">
              <label>COA Reference</label>
              <input value={form.coaReference} onChange={e => setForm({ ...form, coaReference: e.target.value })} placeholder="COA document ref" />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label><input type="checkbox" checked={form.samplesTaken} onChange={e => setForm({ ...form, samplesTaken: e.target.checked })} /> Samples Taken for Testing</label>
            </div>
            <div className="form-group">
              <label><input type="checkbox" checked={form.physicalCheckDone} onChange={e => setForm({ ...form, physicalCheckDone: e.target.checked })} /> Physical Inspection Done</label>
            </div>
            <div className="form-group">
              <label><input type="checkbox" checked={form.vehicleInspectionDone} onChange={e => setForm({ ...form, vehicleInspectionDone: e.target.checked })} /> Vehicle Inspection Done</label>
            </div>
          </div>
          <div className="form-group">
            <label>Remarks</label>
            <textarea rows="2" value={form.remarks} onChange={e => setForm({ ...form, remarks: e.target.value })} />
          </div>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Creating…' : 'Create Inspection'}</button>
        </form>
      )}

      {/* STEP: TESTS */}
      {step === 'tests' && inspection && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3>QA Tests — {inspection.InspectionNo}</h3>
            <div style={{ display: 'flex', gap: 8 }}>
              {isAdmin && (
                <button type="button" className="btn" style={{ padding: '4px 12px', fontSize: 13, background: '#dc2626', color: '#fff', border: 'none' }}
                  onClick={() => handleDeleteInspection(inspection.InspectionNo)}>🗑️ Delete</button>
              )}
              <button type="button" className="btn btn-outline" onClick={goBack}>Back</button>
            </div>
          </div>
          <div style={{ padding: 12, background: 'var(--gray-50)', borderRadius: 'var(--radius)', margin: '12px 0' }}>
            <strong>Entry:</strong> {selected?.EntryNo} | <strong>Supplier:</strong> {entryDetail?.SupplierName} |
            <strong> COA:</strong> {inspection.COAProvided ? `Yes (${inspection.COAReference || 'N/A'})` : 'No'} |
            <strong> Samples:</strong> {inspection.SamplesTaken ? 'Yes' : 'No'} |
            <strong> Physical Check:</strong> {inspection.PhysicalCheckDone ? 'Yes' : 'No'} |
            <strong> Vehicle Inspection:</strong> {inspection.VehicleInspectionDone ? 'Yes' : 'No'}
          </div>

          <h4 style={{ margin: '16px 0 8px' }}>Test Results</h4>
          <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr><th>Material</th><th>Test Parameter</th><th>Method</th><th>Expected / Limit</th><th>Actual Value</th><th>Result</th><th>Remarks</th></tr>
            </thead>
            <tbody>
              {tests.map((t, i) => (
                <tr key={i}>
                  <td>
                    {t.TestResultId ? (t.MaterialCode ? `${t.MaterialCode} — ${t.MaterialName}` : t.materialName) : (
                      <>
                        <select value={t.materialId} onChange={setTestField(i, 'materialId')} style={{ minWidth: 120 }}>
                          <option value="">-- Select --</option>
                          {((entryDetail?.items?.length ? entryDetail.items : allMaterials)).map(it => (
                            <option key={it.MaterialId} value={it.MaterialId}>{it.MaterialCode} — {it.MaterialName}</option>
                          ))}
                        </select>
                        {!entryDetail?.items?.length && (
                          <div style={{ fontSize: 11, color: '#b45309', marginTop: 2 }}>
                            No items recorded on this entry — pick the material manually.
                          </div>
                        )}
                      </>
                    )}
                  </td>
                  <td>{t.TestResultId ? t.TestName : <input value={t.testName} onChange={setTestField(i, 'testName')} placeholder="e.g. Spotted, Moisture" style={{ width: 120 }} />}</td>
                  <td>{t.TestResultId ? t.TestMethod : <input value={t.testMethod} onChange={setTestField(i, 'testMethod')} placeholder="Lab / Visual" style={{ width: 90 }} />}</td>
                  <td style={{ fontWeight: 600, color: 'var(--primary)', whiteSpace: 'nowrap' }}>
                    {t.TestResultId ? (t.ExpectedValue || '—') : <input value={t.expectedValue} onChange={setTestField(i, 'expectedValue')} placeholder="e.g. 5% MAX, NIL, <12" style={{ width: 110, fontWeight: 600 }} />}
                  </td>
                  <td>{t.TestResultId ? t.ActualValue : <input value={t.actualValue} onChange={setTestField(i, 'actualValue')} placeholder="Actual value" style={{ width: 90 }} />}</td>
                  <td>{t.TestResultId ? <span className={`badge badge-${t.Result === 'Pass' ? 'success' : t.Result === 'Fail' ? 'danger' : 'warning'}`}>{t.Result}</span> : (
                    <select value={t.result} onChange={setTestField(i, 'result')}>
                      <option value="Pending">Pending</option><option value="Pass">Pass</option><option value="Fail">Fail</option><option value="Conditional">Conditional</option>
                    </select>
                  )}</td>
                  <td>{t.TestResultId ? t.Remarks : <input value={t.remarks} onChange={setTestField(i, 'remarks')} style={{ width: 100 }} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button type="button" className="btn btn-outline" onClick={addTestRow}>+ Add Test</button>
            <button type="button" className="btn btn-primary" onClick={handleSubmitTests} disabled={saving}>{saving ? 'Saving…' : 'Save Tests & Proceed to Decision'}</button>
          </div>
        </div>
      )}

      {/* STEP: DECISION */}
      {(step === 'decide' || (step === 'tests' && tests.length > 0 && tests.every(t => t.TestResultId))) && inspection && (
        <form className="card" onSubmit={handleDecision} style={{ marginTop: 16 }}>
          <h3>QA Decision — {inspection.InspectionNo}</h3>
          <div style={{ padding: 12, background: 'var(--gray-50)', borderRadius: 'var(--radius)', margin: '12px 0' }}>
            <strong>Tests Summary:</strong> {tests.filter(t => t.Result === 'Pass').length} Pass, {tests.filter(t => t.Result === 'Fail').length} Fail, {tests.filter(t => t.Result === 'Conditional').length} Conditional
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Decision *</label>
              <select value={decision.decision} onChange={e => setDecision({ ...decision, decision: e.target.value })} required>
                <option value="">-- Select Decision --</option>
                <option value="Accepted">Accepted — Proceed to GRN</option>
                <option value="Rejected">Rejected — Create Rejection Note</option>
                <option value="Quarantine">Quarantine — Hold for further review</option>
                <option value="Conditional">Conditional Accept</option>
              </select>
            </div>
            <div className="form-group">
              <label>Rejected Qty</label>
              <input type="number" step="0.01" value={decision.rejectedQty} onChange={e => {
                const rejected = e.target.value;
                const net = entryDetail?.NetWeight || 0;
                const accepted = rejected ? (parseFloat(net) - parseFloat(rejected)).toFixed(2) : '';
                setDecision({ ...decision, rejectedQty: rejected, acceptedQty: accepted });
              }} />
            </div>
            <div className="form-group">
              <label>Accepted Qty (auto)</label>
              <input type="number" step="0.01" value={decision.acceptedQty} readOnly
                style={{ background: '#f3f4f6', fontWeight: 600 }} />
            </div>
          </div>
          <div className="form-group">
            <label>Remarks</label>
            <textarea rows="2" value={decision.remarks} onChange={e => setDecision({ ...decision, remarks: e.target.value })} />
          </div>

          {decision.decision === 'Rejected' && (
            <div style={{ padding: 16, background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 'var(--radius)', margin: '12px 0' }}>
              <h4 style={{ color: '#dc2626', marginBottom: 12 }}>Rejection Details</h4>
              <div className="form-group">
                <label>Rejection Reason *</label>
                <textarea rows="2" value={rejectionForm.rejectionReason}
                  onChange={e => setRejectionForm({ ...rejectionForm, rejectionReason: e.target.value })}
                  placeholder="Describe why the goods are being rejected" required />
              </div>
              <div className="form-group">
                <label>Additional Notes</label>
                <textarea rows="2" value={rejectionForm.notes}
                  onChange={e => setRejectionForm({ ...rejectionForm, notes: e.target.value })}
                  placeholder="Supplier notification details, return instructions, etc." />
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn btn-success" disabled={saving}>{saving ? 'Submitting…' : 'Submit Decision'}</button>
            <button type="button" className="btn btn-outline" onClick={goBack}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}