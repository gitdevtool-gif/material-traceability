import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';

export default function QuotationCapturePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const rfqIdParam        = searchParams.get('rfqId');
  const dispatchIdParam   = searchParams.get('dispatchId');
  const quotationIdParam  = searchParams.get('quotationId');

  const [rfqId, setRfqId]       = useState(rfqIdParam || '');
  const [rfq, setRfq]           = useState(null);
  const [dispatch, setDispatch] = useState(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState('');

  // Editing an already-captured quote (e.g. supplier negotiates a discount
  // over the phone after already submitting) instead of capturing a new
  // one. editingQuotationId set -> PUT instead of POST, form pre-filled
  // from the existing quote. alreadyAwarded is purely informational: an
  // award snapshots its own price into QuoteEvaluationItems at decision
  // time (see quotations.routes.js PUT), so editing here is always safe —
  // it just won't retroactively change what was already decided.
  const [editingQuotationId, setEditingQuotationId] = useState(null);
  const [alreadyAwarded, setAlreadyAwarded]         = useState(false);

  // Supplier search (find a pending dispatch by supplier name, without
  // needing to know the RFQ number — useful when a supplier calls in)
  const [supplierQuery, setSupplierQuery]     = useState('');
  const [supplierResults, setSupplierResults] = useState([]);
  const [supplierSearching, setSupplierSearching] = useState(false);
  const [supplierSearchError, setSupplierSearchError] = useState('');
  const [supplierSearched, setSupplierSearched] = useState(false);

  // Form fields
  const [submissionChannel, setChannel] = useState('manual');
  const [validUntil, setValidUntil]     = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [deliveryDays, setDeliveryDays] = useState('');
  const [notes, setNotes]               = useState('');
  const [lineItems, setLineItems]       = useState([]);
  const [submitting, setSubmitting]     = useState(false);

  const loadRFQ = useCallback(async (id) => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const res = await api.get(`/procurement/rfq/${id}`);
      setRfq(res.data);
      // Pre-fill line items from EVERY requisition linked to this RFQ —
      // a bundled/multi-requisition RFQ was previously only pulling items
      // from res.data.RequisitionId (the first linked requisition, kept
      // only as a legacy convenience field), silently cutting off items
      // that belonged to any other requisition in the bundle.
      const requisitionIds = (res.data.requisitions && res.data.requisitions.length > 0)
        ? res.data.requisitions.map((r) => r.RequisitionId)
        : [res.data.RequisitionId].filter(Boolean);
      const reqResults = await Promise.all(
        requisitionIds.map((rid) => api.get(`/procurement/requisitions/${rid}`))
      );
      const items = reqResults.flatMap((r) => r.data.items || []);
      const baseLineItems = items.map((item) => ({
        requisitionItemId: item.RequisitionItemId,
        itemName: item.ItemName,
        requiredQty: item.Qty,
        requiredUnit: item.Unit,
        requestedBrand: item.PreferredBrand,
        requestedQuality: item.PreferredQuality,
        unitPrice: '',
        qty: item.Qty,
        brand: '',
        qualityDescription: '',
        isVatInclusive: false,
        alternatePrices: '',
        notes: '',
        isNotAvailable: false,
      }));

      if (quotationIdParam) {
        // Editing an existing quote — overlay its saved line items onto
        // the base item list, and pre-fill the header fields from it.
        const [quotesRes, evalRes] = await Promise.all([
          api.get(`/procurement/quotations/by-rfq/${id}`),
          api.get(`/procurement/evaluation/by-rfq/${id}`).catch(() => null),
        ]);
        const quote = (quotesRes.data || []).find((q) => String(q.QuotationId) === quotationIdParam);
        if (!quote) {
          setError('That quotation could not be found on this RFQ');
          setLineItems(baseLineItems);
        } else {
          setEditingQuotationId(quote.QuotationId);
          setChannel(quote.SubmissionChannel || 'manual');
          setValidUntil(quote.ValidUntil ? quote.ValidUntil.slice(0, 10) : '');
          setPaymentTerms(quote.PaymentTerms || '');
          setDeliveryDays(quote.DeliveryDays != null ? String(quote.DeliveryDays) : '');
          setNotes(quote.Notes || '');
          setAlreadyAwarded(!!evalRes?.data?.QuoteEvaluationId);

          const savedByItemId = new Map((quote.lineItems || []).map((li) => [li.RequisitionItemId, li]));
          setLineItems(baseLineItems.map((item) => {
            const saved = savedByItemId.get(item.requisitionItemId);
            if (!saved) return item;
            return {
              ...item,
              unitPrice: saved.IsNotAvailable ? '' : String(saved.UnitPrice ?? ''),
              qty: saved.IsNotAvailable ? item.requiredQty : (saved.Qty ?? item.requiredQty),
              brand: saved.Brand || '',
              qualityDescription: saved.QualityDescription || '',
              isVatInclusive: !!saved.IsVatInclusive,
              alternatePrices: saved.AlternateUnitPrices || '',
              notes: saved.Notes || '',
              isNotAvailable: !!saved.IsNotAvailable,
            };
          }));

          const d = res.data.dispatches?.find((x) => x.QuotationId === quote.QuotationId);
          if (d) setDispatch(d);
        }
      } else {
        setLineItems(baseLineItems);
        // Pre-select dispatch
        if (dispatchIdParam) {
          const d = res.data.dispatches?.find((x) => String(x.RFQDispatchId) === dispatchIdParam);
          if (d) setDispatch(d);
        }
      }
    } catch (e) {
      setError(e.response?.data?.error || 'RFQ not found');
    } finally {
      setLoading(false);
    }
  }, [dispatchIdParam, quotationIdParam]);

  useEffect(() => {
    if (rfqIdParam) loadRFQ(rfqIdParam);
  }, [rfqIdParam, loadRFQ]);

  // ── Supplier search ──────────────────────────────────────────────────────
  const handleSupplierSearch = async (e) => {
    e.preventDefault();
    if (!supplierQuery.trim()) return;
    setSupplierSearching(true);
    setSupplierSearchError('');
    setSupplierSearched(true);
    try {
      const res = await api.get('/procurement/rfq/dispatches/search', {
        params: { supplier: supplierQuery.trim() },
      });
      setSupplierResults(Array.isArray(res.data?.data) ? res.data.data : []);
    } catch (e2) {
      setSupplierSearchError(e2.response?.data?.error || 'Search failed');
      setSupplierResults([]);
    } finally {
      setSupplierSearching(false);
    }
  };

  // Selecting a result just updates the URL params — the existing
  // rfqIdParam/dispatchIdParam effect + loadRFQ pre-select logic above
  // takes it from there, so there's no separate fetch path to maintain.
  const selectSupplierResult = (row) => {
    setSearchParams({ rfqId: String(row.RFQId), dispatchId: String(row.RFQDispatchId) });
  };

  // A dispatch scoped to specific items (dbo.RFQDispatchItems — set when
  // procurement restricted this supplier at send time, see rfq.routes.js)
  // should only offer THOSE items here, so a manually-captured quote can't
  // silently include something this supplier was never asked about.
  // No restriction (itemsRestricted false, or no dispatch picked yet)
  // means "every item on the RFQ", same as before this feature.
  const visibleLineItems = (dispatch && dispatch.itemsRestricted)
    ? lineItems.filter((li) => dispatch.AssignedItemIds.includes(li.requisitionItemId))
    : lineItems;

  const total = visibleLineItems.reduce(
    (sum, li) => sum + (parseFloat(li.unitPrice) || 0) * (parseFloat(li.qty) || 0), 0
  );

  const updateLine = (itemId, patch) =>
    setLineItems((prev) => prev.map((li) =>
      li.requisitionItemId === itemId ? { ...li, ...patch } : li
    ));

  // Marking a line "not available" clears anything already entered for it —
  // there's no price to record once the supplier doesn't have the item.
  const toggleNotAvailable = (itemId, checked) => updateLine(itemId, checked
    ? { isNotAvailable: true, unitPrice: '', brand: '', qualityDescription: '', alternatePrices: '' }
    : { isNotAvailable: false });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!dispatch) return setError('Select which supplier this quote is from');
    // A line counts as "acted on" whether it got a real price or was
    // explicitly marked not available — untouched lines are just omitted,
    // same as before this feature. Scoped to this dispatch's visible items
    // only, so leftover data from a previously-selected dispatch can't leak
    // into a quote for a supplier who was never asked about that item.
    const actedOn = visibleLineItems.filter((li) => li.isNotAvailable || parseFloat(li.unitPrice) > 0);
    if (actedOn.length === 0) return setError('Enter pricing, or mark not available, for at least one item');

    setSubmitting(true);
    setError('');
    try {
      const lineItemsPayload = actedOn.map((li) => ({
        requisitionItemId: li.requisitionItemId,
        unitPrice: li.isNotAvailable ? 0 : parseFloat(li.unitPrice),
        qty: li.isNotAvailable ? 0 : parseFloat(li.qty),
        brand: li.isNotAvailable ? null : (li.brand || null),
        qualityDescription: li.isNotAvailable ? null : (li.qualityDescription || null),
        isVatInclusive: !!li.isVatInclusive,
        alternatePrices: li.isNotAvailable ? null : (li.alternatePrices || null),
        notes: li.notes || null,
        isNotAvailable: !!li.isNotAvailable,
      }));

      if (editingQuotationId) {
        await api.put(`/procurement/quotations/${editingQuotationId}`, {
          submissionChannel,
          validUntil: validUntil || null,
          paymentTerms: paymentTerms || null,
          deliveryDays: deliveryDays || null,
          notes: notes || null,
          lineItems: lineItemsPayload,
        });
        setSuccess('Quotation updated successfully');
      } else {
        await api.post('/procurement/quotations', {
          rfqDispatchId: dispatch.RFQDispatchId,
          submissionChannel,
          validUntil: validUntil || null,
          paymentTerms: paymentTerms || null,
          deliveryDays: deliveryDays || null,
          notes: notes || null,
          lineItems: lineItemsPayload,
        });
        setSuccess('Quotation captured successfully');
      }
      setTimeout(() => navigate(`/procurement/requisitions/${rfq.RequisitionId}`), 1500);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save quotation');
    } finally {
      setSubmitting(false);
    }
  };

  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">{editingQuotationId ? 'Amend Quotation' : 'Capture Quotation'}</h1>
          <p className="page-subtitle">
            {editingQuotationId
              ? "Update prices or terms on a quote already on file — e.g. the supplier negotiated a discount over the phone"
              : 'Record a phone, WhatsApp, or email quote from a supplier'}
          </p>
        </div>
      </div>

      {/* RFQ selector + supplier search */}
      {!rfqIdParam && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <div className="form-group" style={{ flex: '1 1 260px' }}>
              <label className="form-label">RFQ ID</label>
              <div style={{ display: 'flex', gap: 10 }}>
                <input className="form-input" style={{ width: 180 }} value={rfqId}
                  onChange={(e) => setRfqId(e.target.value)} placeholder="e.g. 5" />
                <button className="btn btn-primary" onClick={() => loadRFQ(rfqId)} disabled={loading}>
                  Load RFQ
                </button>
              </div>
            </div>

            <div style={{ width: 1, background: '#e5e7eb', alignSelf: 'stretch' }} />

            <div className="form-group" style={{ flex: '2 1 360px' }}>
              <label className="form-label">Or search by supplier name</label>
              <form onSubmit={handleSupplierSearch} style={{ display: 'flex', gap: 10 }}>
                <input
                  className="form-input"
                  style={{ flex: 1, minWidth: 200 }}
                  value={supplierQuery}
                  onChange={(e) => setSupplierQuery(e.target.value)}
                  placeholder="e.g. Acme Suppliers Ltd"
                />
                <button type="submit" className="btn btn-primary" disabled={supplierSearching || !supplierQuery.trim()}>
                  {supplierSearching ? 'Searching…' : 'Search'}
                </button>
              </form>
              <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 6, marginBottom: 0 }}>
                Shows RFQs sent to this supplier that don't have a quotation yet.
              </p>
            </div>
          </div>

          {/* Supplier search results */}
          {supplierSearchError && (
            <div className="alert alert-error" style={{ marginTop: 16 }}>{supplierSearchError}</div>
          )}
          {supplierSearched && !supplierSearchError && (
            <div style={{ marginTop: 16 }}>
              {supplierResults.length === 0 ? (
                <p style={{ fontSize: 13, color: '#6b7280' }}>
                  No pending dispatches found for suppliers matching "{supplierQuery}".
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {supplierResults.map((r) => (
                    <button
                      key={r.RFQDispatchId}
                      onClick={() => selectSupplierResult(r)}
                      style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        gap: 12, padding: '10px 14px', border: '1px solid #e5e7eb', borderRadius: 6,
                        background: '#fff', cursor: 'pointer', textAlign: 'left', width: '100%',
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = '#f9fafb'}
                      onMouseLeave={(e) => e.currentTarget.style.background = '#fff'}
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{r.SupplierName}</div>
                        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                          {r.RFQNumber} · {r.MatCenter || '—'} · {r.ItemCount} item{r.ItemCount !== 1 ? 's' : ''} · {r.Channel}
                        </div>
                      </div>
                      <div style={{ fontSize: 12, color: '#6b7280', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        Deadline: {fmtDate(r.DeadlineAt)}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {loading && <p style={{ color: '#6b7280' }}>Loading…</p>}
      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}
      {success && <div className="alert alert-success" style={{ marginBottom: 16 }}>{success}</div>}

      {rfq && (
        <form onSubmit={handleSubmit}>
          {/* RFQ summary */}
          <div className="card" style={{ marginBottom: 20, background: '#f0f7ff', border: '1px solid #bfdbfe' }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{rfq.RFQNumber}</div>
            <div style={{ fontSize: 13, color: '#374151', marginTop: 4 }}>
              Ordno: {rfq.BusyOrdNo} &nbsp;·&nbsp; MatCentre: {rfq.MatCenter || '—'} &nbsp;·&nbsp;
              Deadline: {rfq.DeadlineAt ? new Date(rfq.DeadlineAt).toLocaleDateString('en-KE') : '—'}
            </div>
          </div>

          {/* Supplier selection — fixed to one supplier when amending an
              existing quote, since a quote belongs to a specific dispatch. */}
          {editingQuotationId ? (
            <div className="card" style={{ marginBottom: 20 }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 14 }}>Supplier</h3>
              <div style={{ fontSize: 14 }}>
                <strong>{dispatch?.SupplierName || '—'}</strong>
                {dispatch && (
                  <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 8 }}>
                    {dispatch.Channel} · {dispatch.Email || dispatch.Phone || '—'}
                  </span>
                )}
              </div>
              {alreadyAwarded && (
                <div className="alert alert-warning" style={{ marginTop: 12, fontSize: 13 }}>
                  This RFQ has already been evaluated and awarded. Saving here updates what's shown
                  for this supplier's quote, but won't change the Director's decision already on
                  record. If the final negotiated price differs from what was awarded, record that at
                  LPO Reconciliation instead.
                </div>
              )}
            </div>
          ) : (
            <div className="card" style={{ marginBottom: 20 }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 14 }}>Supplier (dispatch) *</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(rfq.dispatches || []).filter((d) => !d.QuotationId).map((d) => (
                  <label key={d.RFQDispatchId}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 12px', border: `1px solid ${dispatch?.RFQDispatchId === d.RFQDispatchId ? '#1a73e8' : '#e5e7eb'}`,
                      borderRadius: 6, cursor: 'pointer',
                      background: dispatch?.RFQDispatchId === d.RFQDispatchId ? '#e8f0fe' : '#fff',
                    }}>
                    <input type="radio" name="dispatch" checked={dispatch?.RFQDispatchId === d.RFQDispatchId}
                      onChange={() => setDispatch(d)} />
                    <span style={{ fontWeight: 600 }}>{d.SupplierName}</span>
                    <span style={{ fontSize: 12, color: '#6b7280' }}>{d.Channel} · {d.Email || d.Phone || '—'}</span>
                  </label>
                ))}
                {(rfq.dispatches || []).filter((d) => !d.QuotationId).length === 0 && (
                  <p style={{ fontSize: 13, color: '#6b7280' }}>All dispatches already have quotations recorded.</p>
                )}
              </div>
            </div>
          )}

          {/* Quote meta */}
          <div className="card" style={{ marginBottom: 20 }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 14 }}>Quote Details</h3>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <div className="form-group">
                <label className="form-label">Submission Channel</label>
                <select className="form-input" value={submissionChannel} onChange={(e) => setChannel(e.target.value)}>
                  <option value="manual">Manual (staff entry)</option>
                  <option value="email">Email</option>
                  <option value="phone">Phone</option>
                  <option value="whatsapp">WhatsApp</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Valid Until</label>
                <input type="date" className="form-input" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Delivery Days</label>
                <input type="number" className="form-input" value={deliveryDays} min="0"
                  onChange={(e) => setDeliveryDays(e.target.value)} placeholder="e.g. 3" style={{ width: 100 }} />
              </div>
              <div className="form-group" style={{ flex: 2, minWidth: 240 }}>
                <label className="form-label">Payment Terms</label>
                <input className="form-input" value={paymentTerms}
                  onChange={(e) => setPaymentTerms(e.target.value)} placeholder="e.g. 30 days credit" />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Notes</label>
              <textarea className="form-input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
                placeholder="Any additional terms or conditions…" />
            </div>
          </div>

          {/* Line items */}
          <div className="card" style={{ marginBottom: 20 }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 14 }}>Item Pricing</h3>
            {dispatch && dispatch.itemsRestricted && (
              <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
                This supplier was only sent {visibleLineItems.length} of {lineItems.length} item(s) on this RFQ — only those are shown here.
              </p>
            )}
            <table className="data-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Required Qty</th>
                  <th>Unit Price (KES) *</th>
                  <th>Other Price Options</th>
                  <th>VAT</th>
                  <th>Qty Offered</th>
                  <th>Brand</th>
                  <th>Quality Description</th>
                  <th>Line Total</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {visibleLineItems.map((li) => {
                  const rowDisabled = li.isNotAvailable;
                  return (
                    <tr key={li.requisitionItemId} style={li.isNotAvailable ? { background: '#fef2f2' } : undefined}>
                      <td>
                        {li.itemName}
                        {(li.requestedBrand || li.requestedQuality) && (
                          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                            Requested: {[li.requestedBrand, li.requestedQuality].filter(Boolean).join(' · ')}
                          </div>
                        )}
                        <label style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 4, fontSize: 11, color: '#dc2626', fontWeight: 600, cursor: 'pointer' }}>
                          <input type="checkbox" checked={li.isNotAvailable}
                            onChange={(e) => toggleNotAvailable(li.requisitionItemId, e.target.checked)} />
                          Supplier doesn't have this item
                        </label>
                      </td>
                      <td style={{ textAlign: 'center' }}>{Number(li.requiredQty).toLocaleString()}{li.requiredUnit ? ` ${li.requiredUnit}` : ''}</td>
                      <td>
                        <input type="number" className="form-input" style={{ width: 120 }}
                          value={li.unitPrice} min="0" step="0.01" disabled={rowDisabled}
                          onChange={(e) => updateLine(li.requisitionItemId, { unitPrice: e.target.value })} />
                      </td>
                      <td>
                        <PriceMultiInput
                          value={li.alternatePrices}
                          disabled={rowDisabled}
                          onChange={(next) => updateLine(li.requisitionItemId, { alternatePrices: next })}
                        />
                      </td>
                      <td>
                        <select className="form-input" style={{ width: 100 }} disabled={rowDisabled}
                          value={li.isVatInclusive ? 'incl' : 'excl'}
                          onChange={(e) => updateLine(li.requisitionItemId, { isVatInclusive: e.target.value === 'incl' })}>
                          <option value="excl">Excl. VAT</option>
                          <option value="incl">Incl. VAT</option>
                        </select>
                      </td>
                      <td>
                        <input type="number" className="form-input" style={{ width: 100 }}
                          value={li.qty} min="0" disabled={rowDisabled}
                          onChange={(e) => updateLine(li.requisitionItemId, { qty: e.target.value })} />
                      </td>
                      <td>
                        <BrandMultiInput
                          value={li.brand}
                          disabled={rowDisabled}
                          onChange={(next) => updateLine(li.requisitionItemId, { brand: next })}
                        />
                      </td>
                      <td>
                        <input className="form-input" style={{ width: 160 }} value={li.qualityDescription}
                          disabled={rowDisabled}
                          onChange={(e) => updateLine(li.requisitionItemId, { qualityDescription: e.target.value })}
                          placeholder="e.g. Grade A" />
                      </td>
                      <td style={{ fontWeight: 600 }}>
                        {li.isNotAvailable ? (
                          <span style={{ color: '#dc2626', fontWeight: 600 }}>Not available</span>
                        ) : li.unitPrice && li.qty
                          ? `KES ${(parseFloat(li.unitPrice) * parseFloat(li.qty)).toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                          : '—'}
                      </td>
                      <td>
                        <input className="form-input" style={{ width: 140 }} value={li.notes}
                          onChange={(e) => updateLine(li.requisitionItemId, { notes: e.target.value })}
                          placeholder={li.isNotAvailable ? 'Why not available? (optional)' : undefined} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={7} style={{ textAlign: 'right', fontWeight: 700, padding: '10px 12px' }}>Total</td>
                  <td style={{ fontWeight: 700, padding: '10px 12px' }}>
                    KES {total.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Saving…' : editingQuotationId ? 'Save Changes' : 'Save Quotation'}
            </button>
            <button type="button" className="btn btn-secondary"
              onClick={() => navigate(-1)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// Same brand chip-editor used on the public supplier quote page — lets
// procurement staff record multiple brands per line item, and click an
// existing chip to edit it in place.
function BrandMultiInput({ value, disabled, onChange }) {
  const [draft, setDraft] = useState('');
  const [editingIndex, setEditingIndex] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const brands = (value || '').split(',').map((b) => b.trim()).filter(Boolean);

  const addBrand = () => {
    const next = draft.trim();
    if (!next) return;
    if (!brands.includes(next)) {
      onChange([...brands, next].join(', '));
    }
    setDraft('');
  };

  const removeBrand = (b) => {
    onChange(brands.filter((x) => x !== b).join(', '));
  };

  const startEditBrand = (idx) => {
    if (disabled) return;
    setEditingIndex(idx);
    setEditDraft(brands[idx]);
  };

  const commitEditBrand = () => {
    if (editingIndex === null) return;
    const idx = editingIndex;
    const updated = editDraft.trim();
    const next = [...brands];
    if (!updated) {
      next.splice(idx, 1); // cleared out — treat like removing this brand
    } else {
      next[idx] = updated;
    }
    onChange(next.join(', '));
    setEditingIndex(null);
    setEditDraft('');
  };

  const cancelEditBrand = () => {
    setEditingIndex(null);
    setEditDraft('');
  };

  return (
    <div style={{ minWidth: 140 }}>
      {brands.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
          {brands.map((b, idx) => (
            editingIndex === idx ? (
              <input
                key={idx}
                autoFocus
                className="form-input"
                style={{ width: 90, padding: '2px 6px', fontSize: 12 }}
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onBlur={commitEditBrand}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitEditBrand(); }
                  if (e.key === 'Escape') { e.preventDefault(); cancelEditBrand(); }
                }}
              />
            ) : (
              <span key={idx}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  background: '#eef2f7', borderRadius: 12, padding: '2px 8px', fontSize: 12,
                }}>
                <span
                  onClick={() => startEditBrand(idx)}
                  title={!disabled ? 'Click to edit this brand' : undefined}
                  style={{ cursor: disabled ? 'default' : 'pointer' }}>
                  {b}
                </span>
                {!disabled && (
                  <button type="button" onClick={() => removeBrand(b)}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, lineHeight: 1, fontSize: 12 }}
                    title="Remove brand">×</button>
                )}
              </span>
            )
          ))}
        </div>
      )}
      {!disabled && (
        <input className="form-input" style={{ width: 130, fontSize: 12 }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              addBrand();
            }
          }}
          onBlur={addBrand}
          placeholder={brands.length ? '+ Add brand' : 'e.g. Dorman'} />
      )}
    </div>
  );
}

// Chip-editor for recording more than one unit price for the same item —
// e.g. the supplier quoted 150 but also offered 165 for a premium grade,
// or gave a couple of negotiable price points. These are purely
// supplementary/display values: the main "Unit Price" field next to this
// one is still the single price used for the line/grand totals and for
// evaluation — this list is just extra context shown alongside it.
function PriceMultiInput({ value, disabled, onChange }) {
  const [draft, setDraft] = useState('');
  const [editingIndex, setEditingIndex] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const prices = (value || '').split(',').map((p) => p.trim()).filter(Boolean);

  const addPrice = () => {
    const trimmed = draft.trim();
    const n = parseFloat(trimmed);
    if (!trimmed || isNaN(n) || n < 0) { setDraft(''); return; }
    if (!prices.includes(trimmed)) {
      onChange([...prices, trimmed].join(', '));
    }
    setDraft('');
  };

  const removePrice = (p) => {
    onChange(prices.filter((x) => x !== p).join(', '));
  };

  const startEditPrice = (idx) => {
    if (disabled) return;
    setEditingIndex(idx);
    setEditDraft(prices[idx]);
  };

  const commitEditPrice = () => {
    if (editingIndex === null) return;
    const idx = editingIndex;
    const updated = editDraft.trim();
    const next = [...prices];
    if (!updated || isNaN(parseFloat(updated)) || parseFloat(updated) < 0) {
      next.splice(idx, 1); // cleared out or invalid — treat like removing this price
    } else {
      next[idx] = updated;
    }
    onChange(next.join(', '));
    setEditingIndex(null);
    setEditDraft('');
  };

  const cancelEditPrice = () => {
    setEditingIndex(null);
    setEditDraft('');
  };

  return (
    <div style={{ minWidth: 140 }}>
      {prices.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
          {prices.map((p, idx) => (
            editingIndex === idx ? (
              <input
                key={idx}
                autoFocus
                type="number"
                className="form-input"
                style={{ width: 80, padding: '2px 6px', fontSize: 12 }}
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onBlur={commitEditPrice}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitEditPrice(); }
                  if (e.key === 'Escape') { e.preventDefault(); cancelEditPrice(); }
                }}
              />
            ) : (
              <span key={idx}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  background: '#fef3e7', borderRadius: 12, padding: '2px 8px', fontSize: 12,
                }}>
                <span
                  onClick={() => startEditPrice(idx)}
                  title={!disabled ? 'Click to edit this price' : undefined}
                  style={{ cursor: disabled ? 'default' : 'pointer' }}>
                  {Number(p).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
                {!disabled && (
                  <button type="button" onClick={() => removePrice(p)}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, lineHeight: 1, fontSize: 12 }}
                    title="Remove price">×</button>
                )}
              </span>
            )
          ))}
        </div>
      )}
      {!disabled && (
        <input type="number" className="form-input" style={{ width: 100, fontSize: 12 }}
          value={draft} min="0" step="0.01"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              addPrice();
            }
          }}
          onBlur={addPrice}
          placeholder={prices.length ? '+ Add price' : 'e.g. 165'} />
      )}
    </div>
  );
}