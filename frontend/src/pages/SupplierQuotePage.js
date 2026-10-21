import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import './SupplierQuotePage.css';

/**
 * Public page — no authentication.
 * Supplier opens this URL from the RFQ email / WhatsApp message.
 * Mounted at /supplier-quote/:token.
 *
 * Suppliers can revisit this link at any time before the deadline/token
 * expiry and EDIT their submitted quotation — the form pre-fills from
 * their last submission, and resubmitting updates it (the backend
 * withdraws the old quotation and inserts a new one, keeping history).
 *
 * The backend serves both this React bundle AND the public /rfq/:token
 * API from the same origin (http://localhost:4008, exposed publicly by
 * Cloudflare Tunnel at https://rfq.njorocanning.co.ke), so we always
 * call the API with a same-origin RELATIVE path.  This avoids any
 * dependency on REACT_APP_API_URL at build time and works correctly
 * both on the LAN and via the public Cloudflare hostname.
 *
 * "Not quoted" items (2026-08-11): FIXED — submit used to filter out any
 * line item without a unitPrice before POSTing (`lineItems.filter(li =>
 * parseFloat(li.unitPrice) > 0)`), so if a supplier left an item blank it
 * never reached the backend at all — no record of it, no way to tell
 * "declined to quote" apart from "wasn't part of the RFQ" on the
 * evaluation side. It now sends EVERY item every time, with unitPrice/qty
 * set to null for anything left unpriced, so the backend can store an
 * explicit "not quoted" row instead of a silent gap.
 *
 * Per-line VAT + photo (2026-08-18): Each line now carries an
 * inclusive/exclusive VAT choice and an optional photo of that specific
 * item. The photo uploads immediately on file select (POST
 * /rfq/:token/items/:requisitionItemId/photo) and the returned URL rides
 * along in the final submit payload — it is NOT re-uploaded on submit.
 */
export default function SupplierQuotePage() {
  const { token } = useParams();

  const [rfq, setRfq]           = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState(false);
  const [isEditing, setIsEditing] = useState(false); // true once we know a prior quote exists

  // Form state
  const [validUntil, setValidUntil]     = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [deliveryDays, setDeliveryDays] = useState('');
  const [notes, setNotes]               = useState('');
  const [lineItems, setLineItems]       = useState([]);
  const [submitting, setSubmitting]     = useState(false);
  const [submitError, setSubmitError]   = useState('');
  const [lastSubmittedAt, setLastSubmittedAt] = useState(null);

  useEffect(() => {
    fetch(`/rfq/${token}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        setRfq(data);

        const existing = data.existingQuotation;
        const existingLineById = new Map(
          (existing?.lineItems || []).map((li) => [li.RequisitionItemId, li])
        );

        setLineItems(
          (data.items || []).map((item) => {
            const prior = existingLineById.get(item.RequisitionItemId);
            return {
              requisitionItemId:  item.RequisitionItemId,
              itemName:           item.ItemName,
              requiredQty:        item.Qty,
              requiredUnit:       item.Unit,
              category:           item.Category,
              requestedBrand:     item.PreferredBrand,
              requestedQuality:   item.PreferredQuality,
              referencePhotoUrl:  item.ReferencePhotoUrl || null,
              unitPrice:          prior && prior.UnitPrice != null ? String(prior.UnitPrice) : '',
              qty:                prior && prior.Qty != null ? prior.Qty : item.Qty,
              brand:              prior ? (prior.Brand || '') : '',
              qualityDescription: prior ? (prior.QualityDescription || '') : '',
              notes:              prior ? (prior.Notes || '') : '',
              isVatInclusive:     prior ? !!prior.IsVatInclusive : false,
              alternatePrices:    prior ? (prior.AlternateUnitPrices || '') : '',
              photoUrl:           prior ? (prior.PhotoUrl || '') : '',
              isNotAvailable:     prior ? !!prior.IsNotAvailable : false,
              photoUploading:     false,
              photoError:         '',
            };
          })
        );

        if (existing) {
          setIsEditing(true);
          setValidUntil(existing.validUntil ? existing.validUntil.slice(0, 10) : '');
          setPaymentTerms(existing.paymentTerms || '');
          setDeliveryDays(existing.deliveryDays != null ? String(existing.deliveryDays) : '');
          setNotes(existing.notes || '');
          setLastSubmittedAt(existing.submittedAt || null);
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  const total = lineItems.reduce(
    (sum, li) => sum + (parseFloat(li.unitPrice) || 0) * (parseFloat(li.qty) || 0),
    0
  );

  // Items the supplier hasn't priced yet — shown as a heads-up before they
  // submit, so a blank field is a deliberate choice rather than something
  // they didn't notice. Items explicitly marked "not available" are
  // tracked separately — that's a deliberate declaration, not an
  // oversight, so it doesn't belong in the same warning.
  const notAvailableCount = lineItems.filter((li) => li.isNotAvailable).length;
  const unpricedCount = lineItems.filter((li) => !li.isNotAvailable && !(parseFloat(li.unitPrice) > 0)).length;

  const updateLine = (i, patch) =>
    setLineItems((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      return next;
    });

  // Marking an item unavailable clears anything already entered for it —
  // a supplier who can't supply the item shouldn't be quoting a price on it.
  const toggleNotAvailable = (i, checked) => updateLine(i, checked
    ? { isNotAvailable: true, unitPrice: '', brand: '', qualityDescription: '', alternatePrices: '', photoUrl: '' }
    : { isNotAvailable: false });

  const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

  const handlePhotoSelect = async (i, file) => {
    if (!file) return;
    if (file.size > MAX_PHOTO_BYTES) {
      updateLine(i, { photoError: 'Photo must be under 5MB' });
      return;
    }

    updateLine(i, { photoUploading: true, photoError: '' });

    try {
      const li = lineItems[i];
      const formData = new FormData();
      formData.append('photo', file);

      const res = await fetch(`/rfq/${token}/items/${li.requisitionItemId}/photo`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      const { photoUrl } = await res.json();
      updateLine(i, { photoUrl, photoUploading: false });
    } catch (err) {
      updateLine(i, { photoUploading: false, photoError: err.message });
    }
  };

  const removePhoto = (i) => updateLine(i, { photoUrl: '', photoError: '' });

  const handleSubmit = async (e) => {
    e.preventDefault();
    const actedOnCount = lineItems.filter((li) => li.isNotAvailable || parseFloat(li.unitPrice) > 0).length;
    if (actedOnCount === 0) {
      setSubmitError('Please enter a unit price, or mark as not available, for at least one item.');
      return;
    }
    if (lineItems.some((li) => li.photoUploading)) {
      setSubmitError('Please wait for photo uploads to finish before submitting.');
      return;
    }

    setSubmitting(true);
    setSubmitError('');

    try {
      const res = await fetch(`/rfq/${token}/submit`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          validUntil:   validUntil   || null,
          paymentTerms: paymentTerms || null,
          deliveryDays: deliveryDays || null,
          notes:        notes        || null,
          // Send EVERY item, not just priced ones — unpriced items go
          // through as null price/qty so the backend records them as an
          // explicit "not quoted" line instead of omitting them entirely.
          lineItems: lineItems.map((li) => {
            const hasPrice = !li.isNotAvailable && parseFloat(li.unitPrice) > 0;
            return {
              requisitionItemId:  li.requisitionItemId,
              unitPrice:          hasPrice ? parseFloat(li.unitPrice) : null,
              qty:                hasPrice ? parseFloat(li.qty) : null,
              brand:              li.isNotAvailable ? null : (li.brand || null),
              qualityDescription: li.isNotAvailable ? null : (li.qualityDescription || null),
              notes:              li.notes || null,
              isVatInclusive:     !!li.isVatInclusive,
              alternatePrices:    li.isNotAvailable ? null : (li.alternatePrices || null),
              photoUrl:           li.isNotAvailable ? null : (li.photoUrl || null),
              isNotAvailable:     !!li.isNotAvailable,
            };
          }),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      setSuccess(true);
    } catch (err) {
      setSubmitError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Header shared across all states ──
  const Header = ({ sub }) => (
    <div className="sq-header">
      <div className="sq-header-title">Njoro Canning Factory</div>
      <div className="sq-header-sub">{sub}</div>
    </div>
  );

  // ── Loading / error states ──
  if (loading) {
    return (
      <div className="sq-page">
        <div className="sq-card">
          <div className="sq-body" style={{ textAlign: 'center', color: '#6b7280' }}>
            Loading quotation request…
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="sq-page">
        <div className="sq-card">
          <Header sub="Supplier Quotation Portal" />
          <div className="sq-body sq-state">
            <div className="sq-state-icon">⚠️</div>
            <p className="sq-state-title" style={{ color: '#dc2626' }}>{error}</p>
            <p className="sq-state-sub">
              If you believe this is an error, please contact the Procurement team directly.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="sq-page">
        <div className="sq-card">
          <Header sub="Supplier Quotation Portal" />
          <div className="sq-body sq-state">
            <div className="sq-state-icon" style={{ fontSize: 48 }}>🎉</div>
            <p className="sq-state-title" style={{ color: '#059669', fontSize: 18 }}>
              {isEditing ? 'Quotation Updated Successfully!' : 'Quotation Submitted Successfully!'}
            </p>
            <p className="sq-state-sub">
              Thank you, <strong>{rfq.supplierName}</strong>. Your quotation for{' '}
              <strong>{rfq.rfqNumber}</strong> has been received.
              <br />
              Total: <strong>KES {total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong>
            </p>
            <p className="sq-state-hint">
              The procurement team will evaluate all quotations and contact you with the outcome.
              You may revisit this link to update your quotation again before the deadline.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const deadlineStr = rfq.deadline
    ? new Date(rfq.deadline).toLocaleDateString('en-KE', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      })
    : null;

  const lastSubmittedStr = lastSubmittedAt
    ? new Date(lastSubmittedAt).toLocaleDateString('en-KE', {
        day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : null;

  // ── Main form ──
  return (
    <div className="sq-page">
      <div className="sq-card">
        <Header sub={`Request for Quotation — ${rfq.rfqNumber}`} />

        <div className="sq-body">
          <p className="sq-greeting">
            Dear <strong>{rfq.supplierName}</strong>, please submit your best prices for the
            items listed below.
          </p>

          {rfq.isEvaluated ? (
            <div className="sq-callout sq-callout-info">
              This RFQ has already been evaluated by Njoro Canning Factory and is now closed
              for changes. Your submitted quotation is shown below for your records.
            </div>
          ) : isEditing && (
            <div className="sq-callout sq-callout-info">
              You already submitted a quotation{lastSubmittedStr ? ` on ${lastSubmittedStr}` : ''}.
              It's pre-filled below — make any changes and resubmit to update it.
            </div>
          )}

          {!rfq.isEvaluated && (
            <div className="sq-callout sq-callout-warn">
              {deadlineStr
                ? <>Quotation Deadline: <strong>{deadlineStr}</strong></>
                : <strong>Please submit as soon as possible</strong>}
            </div>
          )}

          {rfq.notes && (
            <div className="sq-callout sq-callout-info">
              <strong>Note from Procurement:</strong> {rfq.notes}
            </div>
          )}

          <form onSubmit={handleSubmit}>
            {/* Quote terms — responsive grid */}
            <div className="sq-terms-grid">
              <div className="sq-form-group">
                <label className="sq-label">Quote Valid Until</label>
                <input type="date" className="sq-input" value={validUntil} disabled={rfq.isEvaluated}
                  onChange={(e) => setValidUntil(e.target.value)} />
              </div>
              <div className="sq-form-group">
                <label className="sq-label">Delivery Lead Time (days)</label>
                <input type="number" className="sq-input" value={deliveryDays} disabled={rfq.isEvaluated}
                  min="0" onChange={(e) => setDeliveryDays(e.target.value)}
                  placeholder="e.g. 3" />
              </div>
              <div className="sq-form-group sq-terms-wide">
                <label className="sq-label">Payment Terms</label>
                <input className="sq-input" value={paymentTerms} disabled={rfq.isEvaluated}
                  onChange={(e) => setPaymentTerms(e.target.value)}
                  placeholder="e.g. 30 days EOM, Cash on delivery" />
              </div>
            </div>

            {/* Items — desktop table */}
            <div className="sq-table-wrap sq-desktop-only">
              <table className="sq-table">
                <thead>
                  <tr>
                    <th style={{ width: 36 }}>#</th>
                    <th>Item Description</th>
                    <th style={{ width: 90, textAlign: 'center' }}>Required Qty</th>
                    <th style={{ width: 130 }}>Unit Price (KES) *</th>
                    <th style={{ width: 130 }}>Other Price Options</th>
                    <th style={{ width: 100 }}>VAT</th>
                    <th style={{ width: 110 }}>Qty You Can Supply</th>
                    <th style={{ width: 130 }}>Brand</th>
                    <th style={{ width: 170 }}>Quality Description</th>
                    <th style={{ width: 120 }}>Line Total</th>
                    <th style={{ width: 150 }}>Notes</th>
                    <th style={{ width: 110 }}>Photo</th>
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((li, i) => {
                    const unpriced = !li.isNotAvailable && !(parseFloat(li.unitPrice) > 0);
                    const rowDisabled = rfq.isEvaluated || li.isNotAvailable;
                    return (
                      <tr key={li.requisitionItemId}
                        className={i % 2 === 0 ? 'sq-row-alt' : ''}
                        style={li.isNotAvailable ? { opacity: 0.6, background: '#fef2f2' } : unpriced ? { opacity: 0.85 } : undefined}>
                        <td style={{ textAlign: 'center' }}>{i + 1}</td>
                        <td>
                          <strong>{li.itemName}</strong>
                          {li.category && (
                            <span className="sq-category-pill">{li.category}</span>
                          )}
                          {(li.requestedBrand || li.requestedQuality) && (
                            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                              Requested: {[li.requestedBrand, li.requestedQuality].filter(Boolean).join(' · ')}
                            </div>
                          )}
                          {li.referencePhotoUrl && (
                            <div style={{ marginTop: 4 }}>
                              <a href={li.referencePhotoUrl} target="_blank" rel="noopener noreferrer">
                                <img src={li.referencePhotoUrl} alt="Reference" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 4, border: '1px solid #e5e7eb' }} />
                              </a>
                            </div>
                          )}
                          {!rfq.isEvaluated && (
                            <label className="sq-not-available-toggle">
                              <input type="checkbox" checked={li.isNotAvailable}
                                onChange={(e) => toggleNotAvailable(i, e.target.checked)} />
                              Not available
                            </label>
                          )}
                          {li.isNotAvailable ? (
                            <div style={{ fontSize: 11, color: '#dc2626', marginTop: 2, fontWeight: 600 }}>
                              Marked not available
                            </div>
                          ) : unpriced && !rfq.isEvaluated && (
                            <div style={{ fontSize: 11, color: '#b45309', marginTop: 2 }}>
                              Not quoted yet
                            </div>
                          )}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {Number(li.requiredQty).toLocaleString()}{li.requiredUnit ? ` ${li.requiredUnit}` : ''}
                        </td>
                        <td>
                          <input type="number" className="sq-input sq-input-sm"
                            value={li.unitPrice} min="0" step="0.01" disabled={rowDisabled}
                            placeholder="0.00"
                            onChange={(e) => updateLine(i, { unitPrice: e.target.value })} />
                        </td>
                        <td>
                          <PriceMultiInput
                            value={li.alternatePrices}
                            disabled={rowDisabled}
                            onChange={(next) => updateLine(i, { alternatePrices: next })}
                          />
                        </td>
                        <td>
                          <select className="sq-input sq-input-sm" disabled={rowDisabled}
                            value={li.isVatInclusive ? 'incl' : 'excl'}
                            onChange={(e) => updateLine(i, { isVatInclusive: e.target.value === 'incl' })}>
                            <option value="excl">Excl. VAT</option>
                            <option value="incl">Incl. VAT</option>
                          </select>
                        </td>
                        <td>
                          <input type="number" className="sq-input sq-input-sm"
                            value={li.qty} min="0" disabled={rowDisabled}
                            onChange={(e) => updateLine(i, { qty: e.target.value })} />
                        </td>
                        <td>
                          <BrandMultiInput
                            value={li.brand}
                            disabled={rowDisabled}
                            onChange={(next) => updateLine(i, { brand: next })}
                          />
                        </td>
                        <td>
                          <input className="sq-input sq-input-sm"
                            value={li.qualityDescription} disabled={rowDisabled}
                            onChange={(e) => updateLine(i, { qualityDescription: e.target.value })}
                            placeholder="e.g. Grade A, food-grade" />
                        </td>
                        <td style={{ fontWeight: 600 }}>
                          {!li.isNotAvailable && li.unitPrice && li.qty
                            ? `KES ${(parseFloat(li.unitPrice) * parseFloat(li.qty)).toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                            : '—'}
                        </td>
                        <td>
                          <input className="sq-input sq-input-sm"
                            value={li.notes} disabled={rfq.isEvaluated}
                            onChange={(e) => updateLine(i, { notes: e.target.value })}
                            placeholder={li.isNotAvailable ? 'Optional — why not available?' : 'Optional'} />
                        </td>
                        <td>
                          <PhotoPicker
                            line={li}
                            disabled={rowDisabled}
                            onSelect={(file) => handlePhotoSelect(i, file)}
                            onRemove={() => removePhoto(i)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="sq-total-row">
                    <td colSpan={9} style={{ textAlign: 'right' }}>Grand Total</td>
                    <td style={{ fontSize: 15, color: '#1e3a5f' }}>
                      KES {total.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Items — mobile card list */}
            <div className="sq-mobile-only sq-cards">
              {lineItems.map((li, i) => {
                const lineTotal =
                  !li.isNotAvailable && li.unitPrice && li.qty
                    ? parseFloat(li.unitPrice) * parseFloat(li.qty)
                    : 0;
                const unpriced = !li.isNotAvailable && !(parseFloat(li.unitPrice) > 0);
                const rowDisabled = rfq.isEvaluated || li.isNotAvailable;
                return (
                  <div key={li.requisitionItemId} className="sq-item-card" style={li.isNotAvailable ? { background: '#fef2f2', borderColor: '#fca5a5' } : undefined}>
                    <div className="sq-item-head">
                      <span className="sq-item-num">#{i + 1}</span>
                      <strong className="sq-item-name">{li.itemName}</strong>
                    </div>
                    {li.category && (
                      <div style={{ marginBottom: 8 }}>
                        <span className="sq-category-pill">{li.category}</span>
                      </div>
                    )}
                    {(li.requestedBrand || li.requestedQuality) && (
                      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
                        Requested: {[li.requestedBrand, li.requestedQuality].filter(Boolean).join(' · ')}
                      </div>
                    )}
                    {li.referencePhotoUrl && (
                      <div style={{ marginBottom: 8 }}>
                        <a href={li.referencePhotoUrl} target="_blank" rel="noopener noreferrer">
                          <img src={li.referencePhotoUrl} alt="Reference" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 4, border: '1px solid #e5e7eb' }} />
                        </a>
                      </div>
                    )}
                    {!rfq.isEvaluated && (
                      <label className="sq-not-available-toggle" style={{ marginBottom: 8 }}>
                        <input type="checkbox" checked={li.isNotAvailable}
                          onChange={(e) => toggleNotAvailable(i, e.target.checked)} />
                        This item is not available
                      </label>
                    )}
                    {li.isNotAvailable ? (
                      <div style={{ fontSize: 12, color: '#dc2626', fontWeight: 600, marginBottom: 8 }}>
                        Marked not available
                      </div>
                    ) : unpriced && !rfq.isEvaluated && (
                      <div style={{ fontSize: 12, color: '#b45309', marginBottom: 8 }}>
                        Not quoted yet
                      </div>
                    )}
                    <div className="sq-item-meta">
                      Required Qty:&nbsp;
                      <strong>{Number(li.requiredQty).toLocaleString()}{li.requiredUnit ? ` ${li.requiredUnit}` : ''}</strong>
                    </div>

                    <div className="sq-item-grid">
                      <div className="sq-form-group">
                        <label className="sq-label">Unit Price (KES) *</label>
                        <input type="number" className="sq-input"
                          value={li.unitPrice} min="0" step="0.01" disabled={rowDisabled}
                          placeholder="0.00"
                          onChange={(e) => updateLine(i, { unitPrice: e.target.value })} />
                      </div>
                      <div className="sq-form-group">
                        <label className="sq-label">VAT</label>
                        <select className="sq-input" disabled={rowDisabled}
                          value={li.isVatInclusive ? 'incl' : 'excl'}
                          onChange={(e) => updateLine(i, { isVatInclusive: e.target.value === 'incl' })}>
                          <option value="excl">Excl. VAT</option>
                          <option value="incl">Incl. VAT</option>
                        </select>
                      </div>
                    </div>

                    <div className="sq-form-group">
                      <label className="sq-label">Other Price Options</label>
                      <PriceMultiInput
                        value={li.alternatePrices}
                        disabled={rowDisabled}
                        onChange={(next) => updateLine(i, { alternatePrices: next })}
                      />
                    </div>

                    <div className="sq-item-grid">
                      <div className="sq-form-group">
                        <label className="sq-label">Qty You Can Supply</label>
                        <input type="number" className="sq-input"
                          value={li.qty} min="0" disabled={rowDisabled}
                          onChange={(e) => updateLine(i, { qty: e.target.value })} />
                      </div>
                      <div className="sq-form-group">
                        <label className="sq-label">Brand</label>
                        <BrandMultiInput
                          value={li.brand}
                          disabled={rowDisabled}
                          onChange={(next) => updateLine(i, { brand: next })}
                        />
                      </div>
                    </div>

                    <div className="sq-form-group">
                      <label className="sq-label">Quality Description</label>
                      <input className="sq-input"
                        value={li.qualityDescription} disabled={rowDisabled}
                        onChange={(e) => updateLine(i, { qualityDescription: e.target.value })}
                        placeholder="e.g. Grade A, food-grade" />
                    </div>

                    <div className="sq-form-group">
                      <label className="sq-label">Notes (optional)</label>
                      <input className="sq-input"
                        value={li.notes} disabled={rfq.isEvaluated}
                        onChange={(e) => updateLine(i, { notes: e.target.value })}
                        placeholder={li.isNotAvailable ? 'Optional — why not available?' : 'e.g. brand, packaging…'} />
                    </div>

                    <div className="sq-form-group">
                      <label className="sq-label">Photo (optional)</label>
                      <PhotoPicker
                        line={li}
                        disabled={rowDisabled}
                        onSelect={(file) => handlePhotoSelect(i, file)}
                        onRemove={() => removePhoto(i)}
                      />
                    </div>

                    <div className="sq-item-total">
                      Line Total:&nbsp;
                      <strong>
                        {lineTotal
                          ? `KES ${lineTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                          : '—'}
                      </strong>
                    </div>
                  </div>
                );
              })}

              <div className="sq-grand-total">
                Grand Total:&nbsp;
                <strong>KES {total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong>
              </div>
            </div>

            <div className="sq-form-group">
              <label className="sq-label">Additional Notes / Remarks</label>
              <textarea className="sq-input sq-textarea" value={notes} disabled={rfq.isEvaluated}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Any additional terms, conditions, or remarks…" />
            </div>

            {!rfq.isEvaluated && unpricedCount > 0 && (
              <div className="sq-callout sq-callout-warn" style={{ marginBottom: 12 }}>
                {unpricedCount} of {lineItems.length} item(s) have no price entered and will be
                submitted as <strong>"Not quoted"</strong>. If you can supply these, please add a
                price — or tick <strong>"Not available"</strong> if you don't carry the item at all.
              </div>
            )}

            {!rfq.isEvaluated && notAvailableCount > 0 && (
              <div className="sq-callout sq-callout-warn" style={{ marginBottom: 12, background: '#fef2f2', borderLeftColor: '#dc2626', color: '#991b1b' }}>
                {notAvailableCount} item(s) marked as <strong>not available</strong>.
              </div>
            )}

            {submitError && (
              <div className="sq-error">{submitError}</div>
            )}

            {!rfq.isEvaluated && (
              <button type="submit" disabled={submitting} className="sq-submit-btn">
                {submitting
                  ? (isEditing ? 'Updating…' : 'Submitting…')
                  : (isEditing ? 'Update Quotation' : 'Submit Quotation')}
              </button>
            )}
          </form>

          <p className="sq-footer">
            Njoro Canning Factory · P.O. Box 100, Njoro, Kenya<br />
            By submitting this form you confirm that the prices are valid as stated.
          </p>
        </div>
      </div>
    </div>
  );
}

// Multi-brand chip input — suppliers can carry more than one brand for
// the same item (e.g. two acceptable alternatives). Brands are kept as a
// single comma-separated string in state/DB (QuotationLineItems.Brand),
// exactly like before this feature — only the editing UI changed.
//
// Editing existing brands (2026-08-18): clicking a brand chip now turns
// it into an inline text field so the supplier can CORRECT/UPDATE that
// brand's text directly, instead of having to remove the chip and
// re-add it from scratch. Adding new brands and removing them works
// exactly as before.
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
    <div>
      {brands.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
          {brands.map((b, idx) => (
            editingIndex === idx ? (
              <input
                key={idx}
                autoFocus
                className="sq-input sq-input-sm"
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
              <span key={idx} className="sq-category-pill" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
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
        <input className="sq-input sq-input-sm"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              addBrand();
            }
          }}
          onBlur={addBrand}
          placeholder={brands.length ? '+ Add another brand' : 'e.g. Dorman'} />
      )}
    </div>
  );
}

// Chip-editor letting a supplier record more than one unit price for the
// same item — e.g. they quoted 150 but can also offer 165 for a premium
// grade, or want to give a couple of negotiable price points. These are
// purely supplementary/display values: the main "Unit Price (KES) *"
// field is still the single price used for line/grand totals and for
// Njoro's evaluation — this list is just extra context shown alongside it.
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
    <div>
      {prices.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
          {prices.map((p, idx) => (
            editingIndex === idx ? (
              <input
                key={idx}
                autoFocus
                type="number"
                className="sq-input sq-input-sm"
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
              <span key={idx} className="sq-category-pill" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
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
        <input type="number" className="sq-input sq-input-sm"
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

// Small shared control for the per-line photo: shows a thumbnail once
// uploaded, or a file input + spinner/error while uploading.
function PhotoPicker({ line, disabled, onSelect, onRemove }) {
  if (line.photoUrl) {
    return (
      <div className="sq-photo-preview">
        <a href={line.photoUrl} target="_blank" rel="noopener noreferrer">
          <img src={line.photoUrl} alt="Item" className="sq-photo-thumb" />
        </a>
        {!disabled && (
          <button type="button" className="sq-photo-remove" onClick={onRemove} title="Remove photo">×</button>
        )}
      </div>
    );
  }

  return (
    <div className="sq-photo-picker">
      {!disabled && (
        <label className="sq-photo-upload-btn">
          {line.photoUploading ? 'Uploading…' : '+ Photo'}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            style={{ display: 'none' }}
            disabled={line.photoUploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              onSelect(file);
              e.target.value = ''; // allow re-selecting the same file later
            }}
          />
        </label>
      )}
      {line.photoError && <div className="sq-photo-error">{line.photoError}</div>}
    </div>
  );
}