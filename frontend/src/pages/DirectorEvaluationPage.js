import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../services/api';
import StockPicture from '../components/StockPicture';
import { useAuth } from '../context/AuthContext';

export default function DirectorEvaluationPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const isDirector = ['Admin', 'Director'].includes(user?.role);

  const rfqIdParam = searchParams.get('rfqId');

  const [pendingRFQs, setPendingRFQs] = useState([]);
  const [selected, setSelected]       = useState(rfqIdParam || null);
  const [evalData, setEvalData]       = useState(null);
  const [loading, setLoading]         = useState(false);
  const [refreshing, setRefreshing]   = useState(false);
  const [approving, setApproving]     = useState(false);
  const [undoing, setUndoing]         = useState(false);
  // Per-item award state: { [requisitionItemId]: quotationLineItemId }.
  // Prefilled with BOTH already-awarded items from a prior submission
  // (immutable — see lockedItemIds below) and whatever the Director picks
  // this session for items still open.
  const [awards, setAwards]           = useState({});
  // Per-item hold state: { [requisitionItemId]: reasonString }. An item
  // in here has no winner picked yet and is explicitly excluded from
  // blocking approval of the rest of the RFQ — see the module docstring
  // in evaluation.routes.js ("Held items") for the server-side half.
  const [heldReasons, setHeldReasons] = useState({});
  const [evalNotes, setEvalNotes]     = useState('');
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState('');

  // Kept in sync with `awards` below — lets background refresh handlers
  // check "does the director have unsaved picks right now" without
  // needing `awards` in their own effect dependency array (which would
  // otherwise tear down/rebuild storage & interval listeners on every
  // single click).
  const awardsRef = React.useRef(awards);
  useEffect(() => { awardsRef.current = awards; }, [awards]);

  // Same idea for evalData — background handlers below read the latest
  // value via this ref instead of depending on the `evalData` object
  // itself, which changes identity on every silent refresh and would
  // otherwise tear down and re-attach the listeners/interval each time.
  const evalDataRef = React.useRef(evalData);
  useEffect(() => { evalDataRef.current = evalData; }, [evalData]);

  const loadPending = useCallback(() => {
    api.get('/procurement/evaluation/pending')
      .then((r) => setPendingRFQs(r.data))
      .catch(() => {});
  }, []);

  useEffect(() => { loadPending(); }, [loadPending]);

  // `silent` refreshes update the data in place with no loading spinner
  // and no blanking of the page — used for background polling / cross-tab
  // sync so the director's screen doesn't keep jumping back to a
  // "Loading…" state while they're mid-review. Only the initial
  // select-an-RFQ load (and manual retry) uses the full loading UI.
  const loadEval = useCallback(async (rfqId, opts = {}) => {
    if (!rfqId) return;
    const { silent = false } = opts;
    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
      setError('');
      setEvalData(null);
    }
    try {
      const res = await api.get(`/procurement/evaluation/by-rfq/${rfqId}`);
      setEvalData(res.data);
      if (!silent) setError('');
    } catch (e) {
      if (!silent) setError(e.response?.data?.error || 'Failed to load evaluation');
    } finally {
      if (silent) setRefreshing(false); else setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (rfqIdParam) loadEval(rfqIdParam);
  }, [rfqIdParam, loadEval]);

  // Prefill award + hold state from the server whenever a new RFQ loads.
  // Already-awarded items (from this round or a prior partial round) are
  // immutable — see lockedItemIds — but stay in `awards` so the matrix's
  // existing "isChosen" highlight logic keeps working uniformly for them.
  // Already-held items are prefilled into `heldReasons` so revisiting a
  // partially-evaluated RFQ shows what's still pending, editable in place.
  // Legacy WinningQuotationId-only rows have no awardedItems/heldItems and
  // render via the old single-winner banner instead.
  useEffect(() => {
    const prefillAwards = {};
    (evalData?.awardedItems || []).forEach((ai) => { prefillAwards[ai.RequisitionItemId] = ai.QuotationLineItemId; });
    setAwards(prefillAwards);

    const prefillHolds = {};
    (evalData?.heldItems || []).forEach((h) => { prefillHolds[h.RequisitionItemId] = h.Reason || ''; });
    setHeldReasons(prefillHolds);
  }, [evalData?.RFQId, evalData?.awardedItems, evalData?.heldItems]);

  // Items already awarded in a prior submission — immutable. Changing one
  // requires the full "Undo Approval" (which wipes the whole evaluation),
  // not a per-item re-pick.
  const lockedItemIds = React.useMemo(
    () => new Set((evalData?.awardedItems || []).map((ai) => ai.RequisitionItemId)),
    [evalData?.awardedItems]
  );
  const awardedItemByReqId = React.useMemo(() => {
    const map = new Map();
    (evalData?.awardedItems || []).forEach((ai) => map.set(ai.RequisitionItemId, ai));
    return map;
  }, [evalData?.awardedItems]);

  // Shared "does the director have real unsaved work right now" check —
  // `awards` is always prefilled with already-locked items (so the matrix
  // can highlight them), so plain "is awards non-empty" would report
  // unsaved work forever on any partially-evaluated RFQ. Only a pick on a
  // still-open (non-locked) item counts as something a background
  // refresh could destroy.
  const hasUnsavedPicksNow = () => {
    const current = evalDataRef.current;
    if (!current || current.isFullyResolved) return false;
    const locked = new Set((current.awardedItems || []).map((ai) => ai.RequisitionItemId));
    return Object.keys(awardsRef.current).some((id) => !locked.has(Number(id)));
  };

  // Cross-page/cross-tab sync — always silent, and always skipped while
  // the director has unsaved item picks in progress on an unevaluated
  // RFQ, so a background sync can never wipe out work they haven't
  // submitted yet.
  useEffect(() => {
    const refreshFromBroadcast = (rfqId) => {
      loadPending();
      const current = evalDataRef.current;
      if (current && (!rfqId || current.RFQId === rfqId) && !hasUnsavedPicksNow()) {
        loadEval(current.RFQId, { silent: true });
      }
    };

    const onStorage = (e) => {
      if (e.key !== 'ncf:rfqEvaluationChanged' || !e.newValue) return;
      try {
        const { rfqId } = JSON.parse(e.newValue);
        refreshFromBroadcast(rfqId);
      } catch {
        refreshFromBroadcast(null);
      }
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshFromBroadcast(null);
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [evalData?.RFQId, loadEval, loadPending]);

  // Polling fallback — same silent, unsaved-picks-safe refresh, on a
  // timer so the queue and open RFQ stay current even without a
  // storage event (e.g. a supplier submits from another device).
  useEffect(() => {
    const POLL_INTERVAL_MS = 20000;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      loadPending();
      const current = evalDataRef.current;
      if (current && !hasUnsavedPicksNow()) {
        loadEval(current.RFQId, { silent: true });
      }
    };
    const intervalId = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [evalData?.RFQId, loadEval, loadPending]);

  // All requisition items belonging to this RFQ — sourced from the
  // server's master list (every RequisitionItem across every linked
  // requisition), NOT just the union of what suppliers happened to
  // quote. Previously this was built purely from evalData.quotations'
  // lineItems, so any item nobody had quoted yet (or that a supplier
  // left unpriced/skipped) silently disappeared from the table instead
  // of showing as "not quoted".
  const allItems = React.useMemo(() => {
    if (!evalData) return [];
    const map = new Map();
    for (const item of evalData.allItems || []) {
      map.set(item.RequisitionItemId, {
        RequisitionItemId: item.RequisitionItemId,
        ItemName: item.ItemName,
        ItemCode: item.ItemCode,
        RequiredQty: item.RequiredQty,
        Category: item.Category,
      });
    }
    // Defensive fallback: include any item referenced by a quotation line
    // that somehow isn't in the master list (shouldn't normally happen).
    for (const q of evalData.quotations || []) {
      for (const li of q.lineItems) {
        if (!map.has(li.RequisitionItemId)) {
          map.set(li.RequisitionItemId, {
            RequisitionItemId: li.RequisitionItemId,
            ItemName: li.ItemName,
            RequiredQty: li.RequiredQty,
            Category: li.Category,
          });
        }
      }
    }
    return [...map.values()].sort((a, b) => a.ItemName.localeCompare(b.ItemName));
  }, [evalData]);

  // Every item needs EITHER a winner OR an explicit hold before approval
  // is allowed — already-locked (previously awarded) items always count
  // as decided.
  const allDecided = allItems.length > 0 && allItems.every((it) =>
    lockedItemIds.has(it.RequisitionItemId) ||
    awards[it.RequisitionItemId] != null ||
    Object.prototype.hasOwnProperty.call(heldReasons, it.RequisitionItemId)
  );

  const setItemAward = (requisitionItemId, quotationLineItemId) => {
    if (lockedItemIds.has(requisitionItemId)) return; // immutable
    setAwards((prev) => ({ ...prev, [requisitionItemId]: quotationLineItemId }));
    // Picking a winner supersedes any hold on this item.
    setHeldReasons((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, requisitionItemId)) return prev;
      const next = { ...prev };
      delete next[requisitionItemId];
      return next;
    });
  };

  // Toggle "hold" on an item — no winner yet, but doesn't block approving
  // the rest of the RFQ. Clears any award pick for that item, since the
  // two are mutually exclusive.
  const toggleItemHold = (requisitionItemId, held) => {
    if (lockedItemIds.has(requisitionItemId)) return; // immutable
    if (held) {
      setHeldReasons((prev) => ({ ...prev, [requisitionItemId]: prev[requisitionItemId] || '' }));
      setAwards((prev) => {
        if (!(requisitionItemId in prev)) return prev;
        const next = { ...prev };
        delete next[requisitionItemId];
        return next;
      });
    } else {
      setHeldReasons((prev) => {
        const next = { ...prev };
        delete next[requisitionItemId];
        return next;
      });
    }
  };

  const setHoldReason = (requisitionItemId, reason) => {
    setHeldReasons((prev) => ({ ...prev, [requisitionItemId]: reason }));
  };

  // Bulk shortcut: award every item THIS supplier quoted to them. Items
  // they didn't quote are left untouched — director still has to pick a
  // winner (or hold) for those manually below. Skips already-locked items.
  const applySupplierToAll = (quotation) => {
    setAwards((prev) => {
      const next = { ...prev };
      for (const li of quotation.lineItems) {
        if (lockedItemIds.has(li.RequisitionItemId)) continue;
        next[li.RequisitionItemId] = li.QuotationLineItemId;
      }
      return next;
    });
    setHeldReasons((prev) => {
      const next = { ...prev };
      for (const li of quotation.lineItems) {
        if (!lockedItemIds.has(li.RequisitionItemId)) delete next[li.RequisitionItemId];
      }
      return next;
    });
  };

  // How many of the currently-picked items belong to this quotation —
  // live-updates as the director picks, both before and after submit.
  const itemsWonCount = (quotation) => {
    const ids = new Set(quotation.lineItems.map((l) => l.QuotationLineItemId));
    return Object.values(awards).filter((lineItemId) => ids.has(lineItemId)).length;
  };

  const handleApprove = async () => {
    if (!allDecided) return setError('Every item needs a winning supplier or a hold before approval');
    // Only NEW decisions go to the server — already-locked items were
    // submitted in a prior round and are immutable.
    const newAwards = Object.entries(awards)
      .filter(([id]) => !lockedItemIds.has(Number(id)))
      .map(([requisitionItemId, quotationLineItemId]) => ({
        requisitionItemId: Number(requisitionItemId),
        quotationLineItemId,
      }));
    const newHolds = Object.entries(heldReasons).map(([requisitionItemId, reason]) => ({
      requisitionItemId: Number(requisitionItemId),
      reason: reason || null,
    }));
    if (newAwards.length === 0 && newHolds.length === 0) {
      return setError('Nothing to submit — pick a winner or mark a hold for at least one item');
    }
    setApproving(true);
    setError('');
    try {
      const res = await api.post('/procurement/evaluation', {
        rfqId: evalData.RFQId,
        notes: evalNotes || null,
        awards: newAwards,
        holds: newHolds,
      });
      setSuccess(
        res.data.fullyResolved
          ? 'All items resolved — Procurement can now raise the LPO(s) in Busy.'
          : `${res.data.awardedCount} item(s) awarded now${res.data.heldCount ? `, ${res.data.heldCount} item(s) still on hold` : ''} — the awarded ones are already visible to Procurement. Come back to this RFQ once more quotes arrive for the rest.`
      );
      loadEval(evalData.RFQId);
      loadPending();
      localStorage.setItem(
        'ncf:rfqEvaluationChanged',
        JSON.stringify({ rfqId: evalData.RFQId, action: 'approve', ts: Date.now() })
      );
    } catch (e) {
      setError(e.response?.data?.error || 'Approval failed');
    } finally {
      setApproving(false);
    }
  };

  const handleUndo = async () => {
    if (!evalData) return;
    const confirmed = window.confirm(
      `Undo the approval for ${evalData.RFQNumber}?\n\n` +
      `This removes the director's decision and sends the RFQ back to pending evaluation. ` +
      `Quotations already submitted are not affected.`
    );
    if (!confirmed) return;

    setUndoing(true);
    setError('');
    setSuccess('');
    try {
      await api.delete(`/procurement/evaluation/${evalData.RFQId}`);
      setSuccess('Approval undone — RFQ is back in the pending evaluation queue.');
      setAwards({});
      setHeldReasons({});
      loadEval(evalData.RFQId);
      loadPending();
      localStorage.setItem(
        'ncf:rfqEvaluationChanged',
        JSON.stringify({ rfqId: evalData.RFQId, action: 'undo', ts: Date.now() })
      );
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to undo approval');
    } finally {
      setUndoing(false);
    }
  };

  const benchmarkFlag = (unitPrice, benchmark) => {
    if (!benchmark || !benchmark.AvgUnitPrice) return null;
    const ratio = unitPrice / benchmark.AvgUnitPrice;
    if (ratio > 1.1) return { label: `+${((ratio - 1) * 100).toFixed(0)}% above avg`, color: '#dc2626' };
    if (ratio < 0.9) return { label: `${((1 - ratio) * 100).toFixed(0)}% below avg`, color: '#059669' };
    return null;
  };

  const scoreFor = (quotationId) =>
    evalData?.scoring?.scored?.find((s) => s.quotationId === quotationId) || null;

  const suggestedWinnerId = evalData?.scoring?.suggestedWinnerQuotationId || null;

  const scoreBarColor = (val) => {
    if (val >= 75) return '#059669';
    if (val >= 50) return '#d97706';
    return '#dc2626';
  };

  const isEvaluated = !!evalData?.isEvaluated;
  // Fully locked/read-only — nothing left open. While isEvaluated is true
  // but items are still on hold, the page stays interactive for those.
  const isFullyResolved = !!evalData?.isFullyResolved;
  const isLegacyFullAward = isEvaluated && !evalData?.isSplitAward && !!evalData?.WinningQuotationId;
  const openHeldCount = Object.keys(heldReasons).length;

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Director Evaluation</h1>
          <p className="page-subtitle">Compare supplier quotations and award winning items — per item, or all to one supplier</p>
        </div>
        {refreshing && (
          <div style={{ fontSize: 12, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="dep-spinner" aria-hidden="true" style={{
              width: 10, height: 10, borderRadius: '50%',
              border: '2px solid #d1d5db', borderTopColor: '#6b7280',
              display: 'inline-block', animation: 'dep-spin 0.7s linear infinite',
            }} />
            Updating…
          </div>
        )}
      </div>
      <style>{'@keyframes dep-spin { to { transform: rotate(360deg); } }'}</style>

      {error   && <div className="alert alert-error"   style={{ marginBottom: 16 }}>{error}</div>}
      {success && <div className="alert alert-success" style={{ marginBottom: 16 }}>{success}</div>}

      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
        <div style={{ width: 280, flexShrink: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: '#374151' }}>
            Pending Evaluation ({pendingRFQs.length})
          </div>
          {pendingRFQs.length === 0 && (
            <div className="card" style={{ fontSize: 13, color: '#6b7280' }}>No RFQs awaiting evaluation</div>
          )}
          {pendingRFQs.map((r) => (
            <div key={r.RFQId}
              onClick={() => { setSelected(r.RFQId); loadEval(r.RFQId); }}
              style={{
                padding: '10px 14px', borderRadius: 8, marginBottom: 8, cursor: 'pointer',
                border: `2px solid ${selected === r.RFQId ? '#1a73e8' : '#e5e7eb'}`,
                background: selected === r.RFQId ? '#e8f0fe' : '#fff',
              }}>
              <div style={{ fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                {r.RFQNumber}
                {r.HeldCount > 0 && (
                  <span className="badge badge-yellow" style={{ fontSize: 10 }}>
                    ⏸ {r.HeldCount} on hold
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                {r.BusyOrdNo} &nbsp;·&nbsp; {r.QuoteCount} quote(s)
              </div>
              {r.SupplierNames && (
                <div style={{ fontSize: 12, color: '#374151', marginTop: 2 }}>{r.SupplierNames}</div>
              )}
              {r.DeadlineAt && (
                <div style={{ fontSize: 11, color: new Date(r.DeadlineAt) < new Date() ? '#dc2626' : '#6b7280', marginTop: 2 }}>
                  Deadline: {new Date(r.DeadlineAt).toLocaleDateString('en-KE')}
                  {new Date(r.DeadlineAt) < new Date() ? ' ⚠ OVERDUE' : ''}
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{ flex: 1 }}>
          {loading && <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Loading comparison…</div>}

          {!loading && !evalData && (
            <div className="card" style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>
              Select an RFQ from the left to start evaluation
            </div>
          )}

          {evalData && (
            <>
              {/* RFQ header */}
              <div className="card" style={{ marginBottom: 16, background: '#f0f7ff', border: '1px solid #bfdbfe' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 700 }}>{evalData.RFQNumber}</div>
                    <div style={{ fontSize: 13, color: '#374151', marginTop: 4 }}>
                      {evalData.BusyOrdNo} · {evalData.MatCenter || evalData.Warehouse || '—'} ·
                      Date: {evalData.BusyDate ? new Date(evalData.BusyDate).toLocaleDateString('en-KE') : '—'}
                    </div>
                  </div>
                  {evalData.DeadlineAt && (
                    <div style={{ fontSize: 13, color: '#6b7280' }}>
                      Deadline: {new Date(evalData.DeadlineAt).toLocaleDateString('en-KE')}
                    </div>
                  )}
                </div>
                {(evalData.quotations.length + (evalData.nonResponders?.length || 0)) > 0 && (
                  <div style={{ fontSize: 13, color: '#374151', marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <strong>Supplier response:</strong>
                    <span>{evalData.quotations.length + (evalData.nonResponders?.length || 0)} sent</span>
                    <span style={{ color: '#059669' }}>· {evalData.quotations.length} responded</span>
                    <span style={{ color: evalData.nonResponders?.length ? '#b45309' : '#9ca3af' }}>
                      · {evalData.nonResponders?.length || 0} not yet responded
                    </span>
                  </div>
                )}
                {isEvaluated && (
                  <div className={`alert ${isFullyResolved ? 'alert-success' : 'alert-warning'}`} style={{ marginTop: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                      <div>
                        {isFullyResolved
                          ? <>✓ Evaluated — approved by {evalData.DirectorName} on {new Date(evalData.ApprovedAt).toLocaleDateString('en-KE')}</>
                          : <>⏸ Partially evaluated — {evalData.heldItems.length} item{evalData.heldItems.length !== 1 ? 's' : ''} still on hold, the rest already awarded and visible to Procurement.</>}
                        {isLegacyFullAward && <div style={{ marginTop: 2 }}>Full award — single supplier won all items.</div>}
                        {evalData.isSplitAward && (
                          <div style={{ marginTop: 2 }}>
                            Split award across {new Set(evalData.awardedItems.map((a) => a.SupplierId)).size} supplier(s)
                            {evalData.heldItems.length > 0 && ` so far`}.
                          </div>
                        )}
                        {evalData.EvalNotes && <div style={{ marginTop: 4, fontStyle: 'italic' }}>{evalData.EvalNotes}</div>}
                      </div>
                      {isDirector && (
                        <button className="btn btn-danger btn-sm" onClick={handleUndo} disabled={undoing} style={{ flexShrink: 0 }}>
                          {undoing ? 'Undoing…' : 'Undo Approval'}
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {evalData._erpError && (
                  <div style={{ marginTop: 8, fontSize: 12, color: '#f59e0b' }}>
                    ⚠ ERP benchmark data unavailable — {evalData._erpError}
                  </div>
                )}
              </div>

              {/* Suppliers dispatched but not yet responded — lets the
                  Director see who's still outstanding before deciding
                  whether to award now or wait a bit longer. */}
              {!isFullyResolved && evalData.nonResponders?.length > 0 && (
                <div className="card" style={{ marginBottom: 16, background: '#fffbeb', border: '1px solid #fde68a' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#92400e', marginBottom: 8 }}>
                    ⏳ {evalData.nonResponders.length} supplier{evalData.nonResponders.length !== 1 ? 's' : ''} sent this RFQ {evalData.nonResponders.length !== 1 ? 'have' : 'has'} not responded yet
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                    {evalData.nonResponders.map((s) => (
                      <div key={s.SupplierId} style={{
                        fontSize: 12, background: '#fff', border: '1px solid #fde68a',
                        borderRadius: 6, padding: '6px 10px', color: '#78350f',
                      }}>
                        <strong>{s.SupplierName}</strong>
                        <span style={{ color: '#a16207' }}>
                          {' '}· sent {s.SentAt ? new Date(s.SentAt).toLocaleDateString('en-KE') : '—'} via {s.Channel}
                          {s.isExpired ? ' · link expired' : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p style={{ fontSize: 12, color: '#92400e', margin: 0 }}>
                    You can still award based on the quotations already received — this is just a
                    heads-up so you can decide whether to wait for the rest or go ahead now. For any
                    item nobody has quoted yet, mark it <strong>Hold</strong> in the table below and
                    approve everything else — the held item stays open until a winner comes in.
                  </p>
                </div>
              )}

              {/* Suggested winner — advisory only, only while still open */}
              {!isFullyResolved && suggestedWinnerId && (
                <div className="card" style={{ marginBottom: 16, background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#059669', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                        System Suggestion
                      </div>
                      <div style={{ fontSize: 15, marginTop: 2 }}>
                        <strong>{scoreFor(suggestedWinnerId)?.supplierName}</strong> scores highest overall
                        {' '}(<strong>{scoreFor(suggestedWinnerId)?.totalScore}</strong>/100) on price, ERP benchmark,
                        delivery, payment terms, and item coverage combined.
                      </div>
                      {evalData.scoring?.closeCall && (
                        <div style={{ fontSize: 12, color: '#d97706', marginTop: 6 }}>
                          ⚠ This is a close call — the runner-up scored within 2 points. Worth reviewing both closely.
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6 }}>
                        Advisory only. Awards everything this supplier quoted — any items they didn't quote still need a manual pick below.
                      </div>
                    </div>
                    {isDirector && (
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          const q = evalData.quotations.find((qq) => qq.QuotationId === suggestedWinnerId);
                          if (q) applySupplierToAll(q);
                        }}
                      >
                        Award All Items To This Supplier
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Supplier summary table */}
              {evalData.quotations.length === 0 ? (
                <div className="card" style={{ color: '#6b7280', fontSize: 14 }}>No quotations received yet</div>
              ) : (
                <div className="card" style={{ marginBottom: 16, padding: 0, overflow: 'auto' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Rank</th>
                        <th>Supplier</th>
                        <th>Total (KES)</th>
                        <th>Score</th>
                        <th>Delivery</th>
                        <th>Payment</th>
                        <th>Submitted</th>
                        <th>Channel</th>
                        <th>Items Won</th>
                        {!isFullyResolved && isDirector && <th>Bulk Award</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {evalData.quotations.map((q) => {
                        const score = scoreFor(q.QuotationId);
                        const isSuggested = q.QuotationId === suggestedWinnerId;
                        const won = itemsWonCount(q);
                        return (
                          <tr key={q.QuotationId} style={{ background: won > 0 ? '#f0fdf4' : undefined }}>
                            <td style={{ textAlign: 'center', fontWeight: 700 }}>#{q.rank}</td>
                            <td>
                              <strong>{q.SupplierName}</strong>
                              {isSuggested && !isFullyResolved && (
                                <span className="badge badge-green" style={{ marginLeft: 8, fontSize: 10 }}>Suggested</span>
                              )}
                            </td>
                            <td style={{ fontWeight: 700 }}>
                              KES {Number(q.TotalAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                            </td>
                            <td>
                              {score ? (
                                <span style={{ fontWeight: 700, color: scoreBarColor(score.totalScore) }}>{score.totalScore}</span>
                              ) : <span style={{ color: '#9ca3af' }}>—</span>}
                            </td>
                            <td>{q.DeliveryDays != null ? `${q.DeliveryDays} days` : '—'}</td>
                            <td>{q.PaymentTerms || '—'}</td>
                            <td>{new Date(q.SubmittedAt).toLocaleDateString('en-KE')}</td>
                            <td><span className="badge badge-gray">{q.SubmissionChannel}</span></td>
                            <td style={{ textAlign: 'center', fontWeight: won > 0 ? 700 : 400 }}>
                              {won} / {allItems.length}
                            </td>
                            {!isFullyResolved && isDirector && (
                              <td>
                                <button className="btn btn-secondary btn-sm" onClick={() => applySupplierToAll(q)}>
                                  Award All
                                </button>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Scoring breakdown — advisory */}
              {evalData.quotations.length > 0 && evalData.scoring?.scored?.length > 0 && (
                <div className="card" style={{ marginBottom: 16 }}>
                  <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>Scoring Breakdown (Advisory)</h3>
                  <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
                    Weights: Price {Math.round(evalData.scoring.weights.price * 100)}% ·
                    {' '}ERP Benchmark {Math.round(evalData.scoring.weights.benchmark * 100)}% ·
                    {' '}Delivery {Math.round(evalData.scoring.weights.delivery * 100)}% ·
                    {' '}Payment Terms {Math.round(evalData.scoring.weights.payment * 100)}% ·
                    {' '}Item Coverage {Math.round(evalData.scoring.weights.completeness * 100)}%
                  </p>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Supplier</th>
                        <th style={{ width: 90, textAlign: 'center' }}>Price</th>
                        <th style={{ width: 90, textAlign: 'center' }}>Benchmark</th>
                        <th style={{ width: 90, textAlign: 'center' }}>Delivery</th>
                        <th style={{ width: 90, textAlign: 'center' }}>Payment</th>
                        <th style={{ width: 90, textAlign: 'center' }}>Coverage</th>
                        <th style={{ width: 90, textAlign: 'center' }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {evalData.scoring.scored.map((s) => (
                        <tr key={s.quotationId}>
                          <td>
                            <strong>{s.supplierName}</strong>
                            {s.quotationId === suggestedWinnerId && (
                              <span className="badge badge-green" style={{ marginLeft: 8, fontSize: 10 }}>Suggested</span>
                            )}
                          </td>
                          {['price', 'benchmark', 'delivery', 'payment', 'completeness'].map((k) => (
                            <td key={k} style={{ textAlign: 'center', color: scoreBarColor(s.scores[k]) }}>{s.scores[k]}</td>
                          ))}
                          <td style={{ textAlign: 'center', fontWeight: 700, color: scoreBarColor(s.totalScore) }}>{s.totalScore}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p style={{ fontSize: 11, color: '#9ca3af', margin: '10px 0 0' }}>
                    Each column is a 0–100 sub-score. "Coverage" reflects how many of the requisition's
                    items each supplier actually quoted — a supplier who skipped several items is
                    penalized even at a low headline price.
                  </p>
                </div>
              )}

              {/* Whole stock picture before picking winners (2026-10-17) */}
              {allItems.length > 0 && (
                <StockPicture
                  title="Stock status for these items before you award (live from Busy)"
                  items={allItems.map((it) => ({ name: it.ItemCode || it.ItemName, requestedQty: it.RequiredQty }))}
                />
              )}

              {/* Per-item award matrix — this IS the evaluation now */}
              {allItems.length > 0 && (
                <div className="card" style={{ marginBottom: 16 }}>
                  <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>Item-Level Award</h3>
                  <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
                    {isFullyResolved
                      ? isLegacyFullAward
                        ? 'Legacy evaluation — approved before per-item awarding existed.'
                        : 'Awarded winner is highlighted per item.'
                      : allDecided
                        ? `Every item has a winner or a hold${openHeldCount > 0 ? ` (${openHeldCount} on hold)` : ''}. Review and approve below.`
                        : `Pick a winning supplier or hold for each item (${allItems.filter((it) =>
                            lockedItemIds.has(it.RequisitionItemId) ||
                            awards[it.RequisitionItemId] != null ||
                            Object.prototype.hasOwnProperty.call(heldReasons, it.RequisitionItemId)
                          ).length} / ${allItems.length} decided).`}
                  </p>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th>Req Qty</th>
                        {isDirector && !isFullyResolved && <th>Decision</th>}
                        {evalData.quotations.map((q) => <th key={q.QuotationId}>{q.SupplierName}</th>)}
                        <th>ERP Avg (12mo)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allItems.map((item) => {
                        const bench = evalData.benchmarks?.[item.ItemName];
                        const locked = lockedItemIds.has(item.RequisitionItemId);
                        const isHeld = !locked && Object.prototype.hasOwnProperty.call(heldReasons, item.RequisitionItemId);
                        return (
                          <tr key={item.RequisitionItemId} style={isHeld ? { background: '#fffbeb' } : undefined}>
                            <td>{item.ItemName}</td>
                            <td style={{ textAlign: 'center' }}>{Number(item.RequiredQty).toLocaleString()}</td>
                            {isDirector && !isFullyResolved && (
                              <td style={{ minWidth: 150 }}>
                                {locked ? (
                                  <span style={{ color: '#059669', fontWeight: 600, fontSize: 12 }}>
                                    ✓ Awarded{awardedItemByReqId.get(item.RequisitionItemId)?.SupplierName
                                      ? ` — ${awardedItemByReqId.get(item.RequisitionItemId).SupplierName}` : ''}
                                  </span>
                                ) : (
                                  <div>
                                    <label style={{
                                      display: 'flex', alignItems: 'center', gap: 4, fontSize: 12,
                                      cursor: 'pointer', color: isHeld ? '#b45309' : '#374151', fontWeight: isHeld ? 700 : 400,
                                    }}>
                                      <input type="checkbox" checked={isHeld}
                                        onChange={(e) => toggleItemHold(item.RequisitionItemId, e.target.checked)} />
                                      ⏸ Hold — no winner yet
                                    </label>
                                    {isHeld && (
                                      <input className="form-input" style={{ fontSize: 11, marginTop: 4, padding: '4px 6px' }}
                                        placeholder="Reason (optional)"
                                        value={heldReasons[item.RequisitionItemId] || ''}
                                        onChange={(e) => setHoldReason(item.RequisitionItemId, e.target.value)} />
                                    )}
                                  </div>
                                )}
                              </td>
                            )}
                            {evalData.quotations.map((q) => {
                              const line = q.lineItems.find((l) => l.RequisitionItemId === item.RequisitionItemId);
                              const flag = line ? benchmarkFlag(line.UnitPrice, bench) : null;
                              const isChosen = line && awards[item.RequisitionItemId] === line.QuotationLineItemId;
                              const isNotAvailable = line?.IsNotAvailable;
                              const isNotQuoted = line && line.UnitPrice == null && !isNotAvailable;
                              return (
                                <td key={q.QuotationId} style={{ background: isChosen ? '#f0fdf4' : undefined, fontWeight: 600 }}>
                                  {isNotAvailable ? (
                                    <div>
                                      <span className="badge badge-red" style={{ fontSize: 10 }}>Not available</span>
                                      {line.Notes && <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>{line.Notes}</div>}
                                    </div>
                                  ) : isNotQuoted ? (
                                    <span style={{ color: '#9ca3af', fontWeight: 400 }}>Not quoted</span>
                                  ) : line ? (
                                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                                      {!isFullyResolved && isDirector && !locked && (
                                        <input
                                          type="radio"
                                          name={`item-${item.RequisitionItemId}`}
                                          checked={!!isChosen}
                                          onChange={() => setItemAward(item.RequisitionItemId, line.QuotationLineItemId)}
                                          style={{ marginTop: 3 }}
                                        />
                                      )}
                                      {(locked || isFullyResolved) && isChosen && <span style={{ color: '#059669' }}>✓</span>}
                                      <div>
                                        KES {Number(line.UnitPrice).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                        {line.AlternateUnitPrices && (
                                          <div style={{ fontSize: 10, color: '#9a6b00' }}>
                                            Also: {line.AlternateUnitPrices.split(',').map((p) => p.trim()).filter(Boolean)
                                              .map((p) => `KES ${Number(p).toLocaleString(undefined, { minimumFractionDigits: 2 })}`)
                                              .join(' / ')}
                                          </div>
                                        )}
                                        {line.Brand && (
                                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 2 }}>
                                            {line.Brand.split(',').map((b) => b.trim()).filter(Boolean).map((b) => (
                                              <span key={b} className="badge badge-blue" style={{ fontSize: 9, fontWeight: 500 }}>{b}</span>
                                            ))}
                                          </div>
                                        )}
                                        {line.QualityDescription && (
                                          <div style={{ fontSize: 10, color: '#6b7280' }}>{line.QualityDescription}</div>
                                        )}
                                        {line.PhotoUrl && (
                                          <div style={{ marginTop: 4 }}>
                                            <a href={line.PhotoUrl} target="_blank" rel="noopener noreferrer">
                                              <img src={line.PhotoUrl} alt="Supplier item" style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 4, border: '1px solid #e5e7eb' }} />
                                            </a>
                                          </div>
                                        )}
                                        {flag && <div style={{ fontSize: 10, color: flag.color }}>{flag.label}</div>}
                                      </div>
                                    </div>
                                  ) : <span style={{ color: '#9ca3af' }}>—</span>}
                                </td>
                              );
                            })}
                            <td style={{ color: '#6b7280', fontSize: 13 }}>
                              {bench ? (
                                <>
                                  KES {Number(bench.AvgUnitPrice).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                  <div style={{ fontSize: 10 }}>{bench.PurchaseCount} purchase(s)</div>
                                </>
                              ) : <span style={{ color: '#9ca3af' }}>No history</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Approval */}
              {!isFullyResolved && isDirector && evalData.quotations.length > 0 && (
                <div className="card">
                  <h3 style={{ margin: '0 0 12px', fontSize: 14 }}>Director Approval</h3>
                  {evalData.nonResponders?.length > 0 && (
                    <p style={{ fontSize: 12, color: '#92400e', margin: '0 0 12px' }}>
                      ⏳ {evalData.nonResponders.length} supplier{evalData.nonResponders.length !== 1 ? 's' : ''} ({evalData.nonResponders.map((s) => s.SupplierName).join(', ')}) {evalData.nonResponders.length !== 1 ? 'have' : 'has'} not responded yet. You can approve now with what's in, or wait for them.
                    </p>
                  )}
                  {openHeldCount > 0 && (
                    <p style={{ fontSize: 12, color: '#b45309', margin: '0 0 12px' }}>
                      ⏸ {openHeldCount} item{openHeldCount !== 1 ? 's' : ''} marked on hold — they'll stay open for a future round; everything else you've picked will be awarded now.
                    </p>
                  )}
                  <div className="form-group">
                    <label className="form-label">Approval Notes</label>
                    <textarea className="form-input" rows={2} value={evalNotes}
                      onChange={(e) => setEvalNotes(e.target.value)}
                      placeholder="Justification for supplier selection…" />
                  </div>
                  <button className="btn btn-primary" onClick={handleApprove} disabled={approving || !allDecided}>
                    {approving
                      ? 'Saving…'
                      : openHeldCount > 0
                        ? (allItems.length - lockedItemIds.size - openHeldCount > 0 ? 'Approve & Hold Rest' : 'Save Hold(s)')
                        : 'Approve Awards'}
                  </button>
                  {!allDecided && (
                    <p style={{ fontSize: 12, color: '#f59e0b', marginTop: 8 }}>
                      {allItems.filter((it) =>
                        !lockedItemIds.has(it.RequisitionItemId) &&
                        awards[it.RequisitionItemId] == null &&
                        !Object.prototype.hasOwnProperty.call(heldReasons, it.RequisitionItemId)
                      ).length} item(s) still need a winner or a hold
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}