/**
 * Busy GRN builder (2026-10-21)
 *
 * Receives one delivery (gate entry) in Busy as a GRN — "Mat. Rcvd. from
 * Party", VchType 4, series "GRN" (Njr-NNNN---2026-27) — against the
 * supplier's Busy PO lines, so Stores no longer re-type it in Busy. The XML
 * follows what Busy's GetVchXML returns for GRNs Stores enter by hand
 * (verified on Njr-2185, Njr-2188, Njr-2191):
 *
 *   header   STPTName = the PO's tax type; OF1 = weighbridge ticket;
 *            Transport = vehicle; Narration1 = "[MTS ENT-…] <delivery note>"
 *   lines    item, unit, qty, PO price, MC = the PO line's store; VAT
 *            inclusive → NettAmount / STAmount / STPercent per line, VAT
 *            exclusive → one "VAT" bill sundry; "Rounded Off" sundry
 *   batch    one per line, numbered the way Stores do it:
 *            yymmdd + " " + item alias + "0000" + supplier alias
 *            (e.g. "261021 CS-1421700000AP152"), max 25 characters
 *   PO link  PendingOrders → OrderRefs Method 2 against the PO line(s) — one
 *            item can fill several POs, oldest first; any allowance above
 *            them stays on the GRN against no PO (2026-10-29). Busy
 *            creates the GRN's own pending-challan reference itself on save
 *            (it did the same for the POs pushed from here).
 *
 * Quantities are what Stores confirm; prices, store and tax type always
 * come from the Busy PO, never from the browser.
 */
const { sql } = require('../db');
const { sql: erpSql } = require('../erpDb');
const { getOpenPoLines } = require('./busy-receiving.service');
const { busyPartyCode } = require('./entry-grn-link.service');

const GRN_VCHTYPE = 4;
// Statuses an entry is ready to be received in (same as the Receiving page).
const RECEIVABLE = ['OpsManagerApproved', 'QAAccepted', 'CentralStoreReceived', 'RoutingPending'];

// Tax types seen on Busy GRNs (60 days to 2026-10-21: Vat16% 386, VAT/Exempt 190,
// VAT/TaxIncl. 70, VAT/16% 42, VAT/8% 1). A GRN takes its PO's tax type.
const TAX_RATES = {
  'VAT/TaxIncl.': { rate: 16, inclusive: true },
  'Vat16%': { rate: 16, inclusive: false },
  'VAT/16%': { rate: 16, inclusive: false },
  'VAT/Exempt': { rate: 0, inclusive: false },
  'VAT/14%': { rate: 14, inclusive: false },
  'VAT/8%': { rate: 8, inclusive: false },
};

const NARRATION_MAX = 94;         // VchOtherInfo.Narration1
const BATCH_MAX = 25;             // Tran3.No
const narrationTag = (entryNo) => `[MTS ${entryNo}]`;

const xmlEscape = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
// Busy's own GRNs: TranType 3 / InputType 1 (all 567 keyed in Busy since Oct;
// 371 billed). Without them AddVchFromXML saved 0 / 0, and Busy's Purchase
// pending-GRN picker skips TranType 0 — none of the 47 pushed GRNs could be
// billed (2026-11-17).
const GRN_TRANTYPE = 3;
const GRN_INPUTTYPE = 1;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const pad = (n) => String(n).padStart(2, '0');
const busyDate = (d) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
const yymmdd = (d) => `${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

/** Stores' batch number: "261021 CS-1421700000AP152". Falls back to the entry number when an alias is missing. */
function batchNumber(date, itemAlias, partyAlias, entryNo) {
  const item = String(itemAlias || '').trim();
  const party = String(partyAlias || '').trim();
  const full = item && party ? `${yymmdd(date)} ${item}0000${party}` : `${yymmdd(date)} ${entryNo}`;
  if (full.length <= BATCH_MAX) return full;
  return full.replace(' ', '').slice(0, BATCH_MAX);
}

/**
 * Rejection (2026-10-29). Stores receive the full weighed quantity and cut
 * the price by the QA rejection % in the GRN line's "Disc %" (Busy's own
 * GRNs: ListPrice = PO price, DiscountPercent, Price = net, Amt = qty x list
 * less the %, e.g. Njr-2118 oranges 24 less 3% = 23.28; Njr-2094 tomatoes 15
 * less 3.75%). The PO is cleared at full quantity; POs never carry it.
 * QA's rate = rejected / (accepted + rejected), else rejected / net weight.
 */
function qaRejectionPct(qa, netWeight) {
  const rej = Number(qa?.RejectedQty) || 0;
  if (!(rej > 0)) return 0;
  const acc = Number(qa?.AcceptedQty);
  const base = acc >= 0 && qa?.AcceptedQty != null ? acc + rej : Number(netWeight) || 0;
  return base > 0 ? round2((100 * rej) / base) : 0;
}

/** One GRN line's money the way Busy works it out ("Simple Discount % of Amount"). */
function lineMoney({ qty, listPrice, discountPct = 0, taxInfo }) {
  const d = Number(discountPct) || 0;
  const amount = round2(qty * listPrice * (1 - d / 100));
  const price = round2(listPrice * (1 - d / 100));
  const netAmount = taxInfo.inclusive ? round2(amount / (1 + taxInfo.rate / 100)) : amount;
  return {
    listPrice, discountPct: d, discountPerUnit: round2(listPrice - price), price, amount, netAmount,
    taxAmount: taxInfo.inclusive ? round2(amount - netAmount) : 0,
  };
}

function grnTotals(lines, taxInfo) {
  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  const netSubtotal = round2(lines.reduce((s, l) => s + l.netAmount, 0));
  const vat = taxInfo.inclusive ? round2(lines.reduce((s, l) => s + l.taxAmount, 0)) : round2(subtotal * taxInfo.rate / 100);
  const grossTotal = taxInfo.inclusive ? subtotal : round2(subtotal + vat);
  const total = Math.round(grossTotal);
  return { subtotal, netSubtotal, vat, roundOff: round2(total - grossTotal), total };
}

/**
 * The <MaterialReceipt> Busy's AddVchFromXML / ModifyVchFromXMLByCode take.
 * vchNo/autoVchNo only when changing a saved GRN. A rejection goes in as
 * Busy's line discount (ListPrice / Discount / DiscountPercent); the PO
 * reference keeps the PO price, as on GRNs Stores enter by hand.
 */
function renderGrnXml({ seriesName, vchNo, autoVchNo, date: d, taxType, taxInfo, partyName, ticketNo, vehicle, narration, lines, subtotal, vat, roundOff }) {
  const sundries = [];
  if (!taxInfo.inclusive && taxInfo.rate > 0) {
    sundries.push(`<BSName>VAT</BSName><PercentVal>${taxInfo.rate}</PercentVal><PercentOperatedOn>${subtotal}</PercentOperatedOn><Amt>${vat}</Amt>`);
  }
  if (roundOff !== 0) sundries.push(`<BSName>Rounded Off (${roundOff > 0 ? '+' : '-'})</BSName><Amt>${Math.abs(roundOff)}</Amt>`);
  const due = (r) => (r.dueDate ? busyDate(new Date(r.dueDate)) : d);

  return '<MaterialReceipt>'
    + `<VchSeriesName>${xmlEscape(seriesName)}</VchSeriesName>`
    + `<Date>${d}</Date><VchType>${GRN_VCHTYPE}</VchType><TranType>${GRN_TRANTYPE}</TranType><StockUpdationDate>${d}</StockUpdationDate>`
    + (vchNo ? `<VchNo>${xmlEscape(vchNo)}</VchNo>${autoVchNo ? `<AutoVchNo>${autoVchNo}</AutoVchNo>` : ''}` : '')
    + `<STPTName>${xmlEscape(taxType)}</STPTName>`
    + `<MasterName1>${xmlEscape(partyName)}</MasterName1><InputType>${GRN_INPUTTYPE}</InputType>`
    + '<VchOtherInfoDetails>'
    + (ticketNo ? `<OFInfo><OF1>${xmlEscape(String(ticketNo).slice(0, 40))}</OF1></OFInfo>` : '')
    + `<Transport>${xmlEscape(String(vehicle || '.').slice(0, 40))}</Transport>`
    + `<Narration1>${xmlEscape(narration)}</Narration1>`
    + '</VchOtherInfoDetails>'
    + '<ItemEntries>'
    + lines.map((l) => '<ItemDetail>'
      + `<SrNo>${l.srNo}</SrNo><TranType>${GRN_TRANTYPE}</TranType><ItemName>${xmlEscape(l.itemName)}</ItemName>`
      + (l.unitName ? `<UnitName>${xmlEscape(l.unitName)}</UnitName>` : '')
      + `<Qty>${l.qty}</Qty><Price>${l.price}</Price>`
      + (l.discountPct > 0
        ? `<ListPrice>${l.listPrice}</ListPrice><Discount>${l.discountPerUnit}</Discount><DiscountPercent>${l.discountPct}</DiscountPercent>`
          + `<CompoundDiscount>${l.discountPct}</CompoundDiscount><DiscountStructure>Simple Discount % of Amount</DiscountStructure>`
        : '')
      + `<Amt>${l.amount}</Amt><NettAmount>${l.netAmount}</NettAmount>`
      + (taxInfo.inclusive
        ? `<STAmount>${l.taxAmount}</STAmount><STPercent>${taxInfo.rate}</STPercent><TaxBeforeSurcharge>${l.taxAmount}</TaxBeforeSurcharge>`
        : '')
      + `<MC>${xmlEscape(l.store)}</MC>`
      + (l.batchNo
        ? '<BatchEntries><BatchDetails>'
          + `<BatchNo>${xmlEscape(l.batchNo)}</BatchNo><MfgDate>${l.batchMfgDate || d}</MfgDate><ExpiryDate>${l.batchExpiryDate || d}</ExpiryDate>`
          + `<Qty>${l.qty}</Qty><QtyAltUnit>${l.qty}</QtyAltUnit>`
          + `<MainUnitPrice>${round2(l.netAmount / l.qty)}</MainUnitPrice><AltUnitPrice>${round2(l.netAmount / l.qty)}</AltUnitPrice>`
          + `<ItemSrNo>${l.srNo}</ItemSrNo><SrNo>1</SrNo>`
          + '</BatchDetails></BatchEntries>'
        : '')
      + '</ItemDetail>').join('')
    + '</ItemEntries>'
    + (sundries.length ? `<BillSundries>${sundries.map((s, i) => `<BSDetail><SrNo>${i + 1}</SrNo>${s}</BSDetail>`).join('')}</BillSundries>` : '')
    // one OrderDetail per item line, one OrderRefs per PO line it is received
    // against (as Busy's own Njr-2232); an allowance has no OrderRefs
    + '<PendingOrders>'
    + lines.map((l) => '<OrderDetail>'
      + `<MasterName1>${xmlEscape(l.itemName)}</MasterName1><MasterName2>${xmlEscape(partyName)}</MasterName2>`
      + l.refs.map((r, j) => '<OrderRefs>'
        // RefNo picks the PO line: Busy ignores tmpRefCode and matches the line's
        // own reference ("Pur-2946---2026-27/001" for the 2nd line of an item)
        + `<Method>2</Method><SrNo>${j + 1}</SrNo><RefNo>${xmlEscape(r.refNo || r.poNo)}</RefNo><Date>${d}</Date><DueDate>${due(r)}</DueDate>`
        + `<Value1>${r.qty}</Value1><Value2>${r.qty}</Value2><MainTranPrice>${l.listPrice}</MainTranPrice><AltTranPrice>${l.listPrice}</AltTranPrice>`
        + `<VchType>${GRN_VCHTYPE}</VchType><TranType>${GRN_TRANTYPE}</TranType><ItemSrNo>${l.srNo}</ItemSrNo><tmpRefCode>${r.refCode}</tmpRefCode><tmpRecType>4</tmpRecType>`
        + `<MC>${xmlEscape(l.store)}</MC>`
        + '</OrderRefs>').join('')
      + '</OrderDetail>').join('')
    + '</PendingOrders>'
    // A saved GRN (vchNo known) keeps its pending-challan refs on a modify.
    + (vchNo ? pendingChallansXml({ vchNo, date: d, partyName, lines: lines.map((l) => ({ ...l, challanPrice: l.price })) }) : '')
    + '</MaterialReceipt>';
}

/**
 * The GRN's own "pending challan" refs (Tran3 RecType 3, Method 1), one per
 * item line, RefNo = the GRN's own number — as on every GRN keyed in Busy.
 * They are what lists the GRN in a Purchase voucher's pending-GRN picker, so
 * Accounts can bill it. AddVchFromXML does NOT create them by itself
 * (2026-11-17: all 47 GRNs pushed from here lacked them, KES 13.3 M unbillable),
 * and a new voucher's number isn't known until Busy saves it, so they are
 * added straight after the save (addChallanRefs).
 */
function pendingChallansXml({ vchNo, date: d, partyName, lines }) {
  return '<PendingChallans>'
    + lines.map((l) => '<ChallanDetail>'
      + `<MasterName1>${xmlEscape(l.itemName)}</MasterName1><MasterName2>${xmlEscape(partyName)}</MasterName2>`
      + '<ChallanRefs>'
      + `<Method>1</Method><SrNo>1</SrNo><RefNo>${xmlEscape(vchNo)}</RefNo><Date>${d}</Date><DueDate>${d}</DueDate>`
      + `<Value1>${l.qty}</Value1><Value2>${l.qty}</Value2><MainTranPrice>${l.challanPrice}</MainTranPrice><AltTranPrice>${l.challanPrice}</AltTranPrice>`
      + `<VchType>${GRN_VCHTYPE}</VchType><TranType>${GRN_TRANTYPE}</TranType><ItemSrNo>${l.srNo}</ItemSrNo><MC>${xmlEscape(l.store)}</MC>`
      + '</ChallanRefs></ChallanDetail>').join('')
    + '</PendingChallans>';
}

/**
 * GRNs this system pushed ("[MTS" narration) that still have no pending-challan
 * refs and aren't billed — the ones Accounts can't see on a Purchase.
 */
async function grnsMissingChallans(erpPool, { since = '2026-10-01' } = {}) {
  return (await erpPool.request()
    .input('t', erpSql.Int, GRN_VCHTYPE).input('since', erpSql.DateTime, new Date(`${since}T00:00:00`))
    .query(`
      SELECT t1.VchCode, LTRIM(RTRIM(t1.VchNo)) AS VchNo, t1.[Date], LTRIM(RTRIM(p.Name)) AS Party, t1.VchAmtBaseCur AS Amount
      FROM dbo.Tran1 t1
      JOIN dbo.VchOtherInfo oi ON oi.VchCode = t1.VchCode
      LEFT JOIN dbo.Master1 p ON p.Code = t1.MasterCode1
      WHERE t1.VchType = @t AND t1.[Date] >= @since AND LEFT(oi.Narration1, 5) = '[MTS '
        AND (t1.TranType <> ${GRN_TRANTYPE}
             OR NOT EXISTS (SELECT 1 FROM dbo.Tran3 c WHERE c.VchCode = t1.VchCode AND c.RecType = 3 AND c.Method = 1))
      ORDER BY t1.[Date], t1.VchCode`)).recordset;
}

/**
 * Give a saved GRN its pending-challan refs if it has none, by re-saving
 * Busy's own XML of it (GetVchXML) with the PendingChallans block added —
 * prices, discounts, batches and PO refs stay exactly as Busy has them.
 * Checks afterwards that Busy created one ref per line and that the amount
 * and PO refs did not change.
 */
async function addChallanRefs(erpPool, vchCode, { dryRun = false } = {}) {
  const bridge = require('./busy-bridge.service');
  const req = () => erpPool.request().input('v', erpSql.Int, vchCode);
  const head = (await req().input('t', erpSql.Int, GRN_VCHTYPE).query(`
    SELECT LTRIM(RTRIM(t1.VchNo)) AS VchNo, t1.[Date], t1.VchAmtBaseCur AS Amount, LTRIM(RTRIM(p.Name)) AS PartyName, t1.TranType,
           (SELECT COUNT(*) FROM dbo.Tran3 c WHERE c.VchCode = t1.VchCode AND c.RecType = 3 AND c.Method = 1) AS Challans,
           (SELECT COUNT(*) FROM dbo.Tran3 c WHERE c.VchCode = t1.VchCode AND c.RecType IN (3, 4) AND c.TranType <> ${GRN_TRANTYPE}) AS BadRefs,
           (SELECT COUNT(*) FROM dbo.Tran3 c JOIN dbo.Tran3 u ON u.RefCode = c.RefCode AND u.RecType = 3 AND u.Method = 2
             WHERE c.VchCode = t1.VchCode AND c.RecType = 3 AND c.Method = 1) AS Billed,
           (SELECT COUNT(*) FROM dbo.Tran3 r WHERE r.VchCode = t1.VchCode AND r.RecType = 4 AND r.Method = 2) AS PoRefs
    FROM dbo.Tran1 t1 LEFT JOIN dbo.Master1 p ON p.Code = t1.MasterCode1
    WHERE t1.VchCode = @v AND t1.VchType = @t`)).recordset[0];
  if (!head) return { ok: false, error: `GRN ${vchCode} not found in Busy` };
  if (head.Challans > 0 && head.TranType === GRN_TRANTYPE && head.BadRefs === 0) return { ok: true, grnNo: head.VchNo, already: true };
  if (head.Billed > 0) return { ok: false, grnNo: head.VchNo, error: 'already billed — leave it to Accounts' };

  const lines = (await req().query(`
    SELECT t2.SrNo, LTRIM(RTRIM(it.Name)) AS ItemName, ABS(t2.D1) AS Qty, t2.D2 AS Price, LTRIM(RTRIM(mc.Name)) AS Store
    FROM dbo.Tran2 t2 LEFT JOIN dbo.Master1 it ON it.Code = t2.MasterCode1 LEFT JOIN dbo.Master1 mc ON mc.Code = t2.MasterCode2
    WHERE t2.VchCode = @v AND t2.RecType = 2 ORDER BY t2.SrNo`)).recordset;
  if (lines.length === 0) return { ok: false, grnNo: head.VchNo, error: 'GRN has no item lines' };

  const got = await bridge.getVoucherXml(vchCode);
  const xml = got && got.ok !== false ? String(got.xml || '') : '';
  if (!xml.includes('</MaterialReceipt>')) return { ok: false, grnNo: head.VchNo, error: `Could not read ${head.VchNo} from Busy` };
  // Busy's XML of a GRN pushed before 2026-11-17 has no TranType/InputType
  // (= 0); a challan block added earlier is rebuilt with TranType 3.
  const block = pendingChallansXml({
    vchNo: head.VchNo, date: busyDate(new Date(head.Date)), partyName: head.PartyName,
    lines: lines.map((l) => ({ srNo: l.SrNo, itemName: l.ItemName, qty: Number(l.Qty), challanPrice: Number(l.Price), store: l.Store })),
  });
  let newXml = xml.replace(/<PendingChallans>[\s\S]*?<\/PendingChallans>/, '').replace(/<TranType>\d+<\/TranType>/g, '').replace(/<InputType>\d+<\/InputType>/g, '');
  newXml = newXml
    .replace(`<VchType>${GRN_VCHTYPE}</VchType>`, `<VchType>${GRN_VCHTYPE}</VchType><TranType>${GRN_TRANTYPE}</TranType>`) // header: first VchType
    .replace(/(<\/MasterName1>)/, `$1<InputType>${GRN_INPUTTYPE}</InputType>`)                                       // header: party
    .replace(/(<OrderRefs>[\s\S]*?<VchType>\d+<\/VchType>)/g, `$1<TranType>${GRN_TRANTYPE}</TranType>`)
    .replace(/(<ItemDetail>[\s\S]*?<VchType>\d+<\/VchType>)/g, `$1<TranType>${GRN_TRANTYPE}</TranType>`)
    .replace('</MaterialReceipt>', `${block}</MaterialReceipt>`);
  if (dryRun) return { ok: true, grnNo: head.VchNo, dryRun: true, lines: lines.length, xml: newXml };

  const saved = await bridge.modifyVoucher(GRN_VCHTYPE, vchCode, newXml);
  if (!saved || !saved.ok) return { ok: false, grnNo: head.VchNo, error: saved?.error || 'Busy refused the change' };
  const after = (await req().query(`
    SELECT t1.VchAmtBaseCur AS Amount, t1.TranType, t1.InputType,
           (SELECT COUNT(*) FROM dbo.Tran3 c WHERE c.VchCode = t1.VchCode AND c.RecType IN (3, 4) AND c.TranType <> ${GRN_TRANTYPE}) AS BadRefs,
           (SELECT COUNT(*) FROM dbo.Tran3 c WHERE c.VchCode = t1.VchCode AND c.RecType = 3 AND c.Method = 1) AS Challans,
           (SELECT COUNT(*) FROM dbo.Tran3 r WHERE r.VchCode = t1.VchCode AND r.RecType = 4 AND r.Method = 2) AS PoRefs
    FROM dbo.Tran1 t1 WHERE t1.VchCode = @v`)).recordset[0];
  const problems = [];
  if (after.Challans !== lines.length) problems.push(`Busy created ${after.Challans} challan ref(s) for ${lines.length} line(s)`);
  if (after.TranType !== GRN_TRANTYPE || after.BadRefs > 0) problems.push(`TranType is ${after.TranType} (${after.BadRefs} ref(s) not ${GRN_TRANTYPE})`);
  if (Math.abs(Number(after.Amount) - Number(head.Amount)) > 0.5) problems.push(`amount changed ${head.Amount} → ${after.Amount}`);
  if (after.PoRefs !== head.PoRefs) problems.push(`PO refs changed ${head.PoRefs} → ${after.PoRefs}`);
  return { ok: problems.length === 0, grnNo: head.VchNo, lines: lines.length, challans: after.Challans, error: problems.join('; ') || undefined };
}

/** The delivery with what the GRN needs. */
async function loadEntry(pool, entryId) {
  const entry = (await pool.request().input('id', sql.Int, entryId).query(`
    SELECT de.EntryId, de.EntryNo, de.Status, de.VehicleRegNo, de.DriverName, de.Notes, de.Destination,
           de.BusyGRNVchCode, de.BusyGRNNo, de.NetWeight,
           s.SupplierId, s.SupplierName,
           -- A gate-typed duplicate merged into its Busy party receives as that party.
           COALESCE(ms.SupplierCode, s.SupplierCode) AS SupplierCode,
           (SELECT TOP 1 wr.TicketNo FROM dbo.WeighbridgeRecords wr WHERE wr.EntryId = de.EntryId AND wr.TicketNo IS NOT NULL) AS TicketNo
    FROM dbo.DeliveryEntries de JOIN dbo.Suppliers s ON s.SupplierId = de.SupplierId
    LEFT JOIN dbo.Suppliers ms ON ms.SupplierId = s.MergedIntoSupplierId
    WHERE de.EntryId = @id`)).recordset[0];
  if (!entry) return null;
  entry.items = (await pool.request().input('id', sql.Int, entryId).query(`
    SELECT dei.EntryItemId, dei.Quantity, dei.UOM, dei.Description, dei.BusyItemCode, dei.BusyPORefCode, dei.BusyPONo,
           m.MaterialName,
           (SELECT SUM(ISNULL(wr.FinalNetWeight, wr.NetWeight)) FROM dbo.WeighbridgeRecords wr WHERE wr.EntryItemId = dei.EntryItemId) AS NetKg
    FROM dbo.DeliveryEntryItems dei JOIN dbo.Materials m ON m.MaterialId = dei.MaterialId
    WHERE dei.EntryId = @id ORDER BY dei.EntryItemId`)).recordset;
  entry.qa = (await pool.request().input('id', sql.Int, entryId).query(`
    SELECT TOP 1 qi.InspectionNo, qi.OverallStatus, qi.AcceptedQty, qi.RejectedQty, u.FullName AS InspectorName
    FROM dbo.QAInspections qi LEFT JOIN dbo.Users u ON u.UserId = qi.InspectorId
    WHERE qi.EntryId = @id ORDER BY qi.InspectionId DESC`)).recordset[0] || null;
  return entry;
}

const OLD_PO_DAYS = 30;
const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * A chosen PO line that is much older than another approved PO still open for
 * the same item at a different price — usually the wrong PO (2026-11-02:
 * ENT-20261028-0005 tomatoes went in against Pur-155 of 14 May at 20 instead
 * of Pur-2946 of 27 Oct at 15). Not blocking: an old PO can be right.
 */
function olderPoNotes(draft, openLines) {
  const notes = [];
  for (const d of draft) {
    for (const r of d.refs) {
      const l = openLines.find((x) => x.refCode === r.refCode);
      if (!l?.poDate) continue;
      const newer = openLines.filter((x) => x.approved && x.itemCode === l.itemCode && x.poVchCode !== l.poVchCode
        && !d.refs.some((y) => y.refCode === x.refCode)
        && (new Date(x.poDate) - new Date(l.poDate)) / 86400000 >= OLD_PO_DAYS && Math.abs(x.price - l.price) > 0.0001);
      if (!newer.length) continue;
      const n = newer[newer.length - 1];
      notes.push(`Check the PO: ${l.poNo} is from ${fmtDate(l.poDate)} at ${l.price}, but ${n.poNo} of ${fmtDate(n.poDate)} `
        + `is also open for "${l.itemName}" at ${n.price}. Receiving against ${l.poNo} pays ${l.price}.`);
    }
  }
  return notes;
}

/**
 * Everything needed to receive the delivery in Busy, checked against Busy,
 * plus blocking problems. `xml` is only built when there are none.
 *   lines: [{ entryItemId, refCode, qty }] — omit an item that was not received.
 */
async function buildGrn(pool, erpPool, { entryId, lines: wanted = [], deliveryNote, seriesName, date = new Date() }) {
  const problems = [];
  const entry = await loadEntry(pool, entryId);
  if (!entry) return { problems: ['Delivery not found'] };

  if (entry.BusyGRNVchCode) problems.push(`${entry.EntryNo} is already received in Busy as ${entry.BusyGRNNo}.`);
  else if (!RECEIVABLE.includes(entry.Status)) problems.push(`${entry.EntryNo} is not ready to be received (status ${entry.Status}).`);

  // Supplier → Busy party, with its alias for the batch number.
  const partyCode = busyPartyCode(entry.SupplierCode);
  let party = null;
  if (!partyCode) problems.push(`"${entry.SupplierName}" is not a Busy supplier — merge it into its Busy account first (Busy Receiving → supplier clean-up).`);
  else {
    party = (await erpPool.request().input('c', erpSql.Int, partyCode)
      .query('SELECT Code, LTRIM(RTRIM(Name)) AS Name, LTRIM(RTRIM(Alias)) AS Alias FROM dbo.Master1 WHERE Code = @c AND MasterType = 2')).recordset[0] || null;
    if (!party) problems.push(`Busy has no party with code ${partyCode}.`);
  }

  // The supplier's open PO lines — the picker's options and the check for what was chosen.
  const openLines = partyCode ? await getOpenPoLines(erpPool, { partyCode }) : [];
  const byRef = new Map(openLines.map((l) => [l.refCode, l]));
  const itemsById = new Map(entry.items.map((i) => [Number(i.EntryItemId), i]));

  // One item can be received against several PO lines at once, the way Busy
  // does it (2026-10-29, e.g. Njr-2232: 11,000 against Pur-2398 10,000 +
  // Pur-2886 1,000): the quantity fills the chosen PO lines oldest first, each
  // up to what is still pending. Anything above that is the supplier's
  // allowance — it stays on the GRN at the PO price but against no PO (Busy
  // has 19 such GRNs in 180 days and never books a PO line above its order).
  const refsOf = (w) => [...new Set((Array.isArray(w.refCodes) ? w.refCodes : [w.refCode])
    .map((r) => parseInt(r, 10)).filter(Number.isFinite))];
  const qaPct = qaRejectionPct(entry.qa, entry.NetWeight);
  const chosen = (wanted || []).filter((w) => w && (refsOf(w).length || w.qty));
  if (chosen.length === 0) problems.push('Choose the PO line and quantity received for at least one item.');
  const usedRefs = new Set();
  const draft = [];
  for (const w of chosen) {
    const ei = itemsById.get(Number(w.entryItemId));
    if (!ei) { problems.push('An item does not belong to this delivery — reload and try again.'); continue; }
    const qty = round3(Number(w.qty));
    const refCodes = refsOf(w);
    if (!refCodes.length) { problems.push(`Choose the PO line for "${ei.MaterialName}".`); continue; }
    const poLines = [];
    for (const rc of refCodes) {
      const line = byRef.get(rc);
      if (!line) { problems.push(`A PO line chosen for "${ei.MaterialName}" is no longer pending in Busy.`); continue; }
      if (usedRefs.has(line.refCode)) problems.push(`${line.poNo} "${line.itemName}" is chosen twice.`);
      usedRefs.add(line.refCode);
      if (ei.BusyItemCode && line.itemCode !== ei.BusyItemCode) problems.push(`${line.poNo} line is for "${line.itemName}", not "${ei.MaterialName}".`);
      if (!line.approved) problems.push(`${line.poNo} is still awaiting approval in Busy — it must be approved before goods are received against it.`);
      if (!line.store) problems.push(`${line.poNo} line "${line.itemName}" has no store in Busy.`);
      poLines.push(line);
    }
    if (!poLines.length) continue;
    // Busy's order: oldest PO first (openLines is already PO date, voucher, line order).
    poLines.sort((a, b) => openLines.indexOf(a) - openLines.indexOf(b));
    const line = poLines[0];
    if (poLines.some((l) => l.itemCode !== line.itemCode)) problems.push(`The PO lines chosen for "${ei.MaterialName}" are for different items.`);
    if (poLines.some((l) => Math.abs(l.price - line.price) > 0.0001)) {
      problems.push(`"${line.itemName}": ${poLines.map((l) => `${l.poNo} is at ${l.price}`).join(', ')} — one GRN line has one price; receive them separately or ask Procurement to amend the price.`);
    }
    if (poLines.some((l) => l.store !== line.store)) problems.push(`"${line.itemName}": the chosen PO lines are for different stores (${[...new Set(poLines.map((l) => l.store))].join(', ')}).`);
    if (!(qty > 0)) { problems.push(`Enter the quantity received for "${line.itemName}".`); continue; }

    let left = qty;
    const refs = [];
    for (const l of poLines) {
      const take = round3(Math.min(left, l.pending));
      if (take > 0) refs.push({ refCode: l.refCode, poNo: l.poNo, refNo: l.refNo, dueDate: l.dueDate, pending: l.pending, qty: take });
      else problems.push(`${l.poNo} is not needed for ${qty} ${line.unitName || ''} of "${line.itemName}" — untick it.`);
      left = round3(left - take);
    }
    // Rejection %: QA's unless Stores enter another (0 = none).
    const given = w.rejectionPct;
    const rejectionPct = given === undefined || given === null || given === '' ? qaPct : round2(Number(given));
    if (!(rejectionPct >= 0 && rejectionPct < 100)) problems.push(`Rejection % for "${line.itemName}" must be from 0 to below 100.`);
    draft.push({ ei, line, qty, refs, allowance: left > 0.0005 ? left : 0, rejectionPct: rejectionPct >= 0 && rejectionPct < 100 ? rejectionPct : 0 });
  }

  // Tax type: the PO's. One GRN carries one tax type.
  const poVchCodes = [...new Set(draft.map((d) => d.line.poVchCode))];
  let taxType = null;
  if (poVchCodes.length) {
    const req = erpPool.request();
    poVchCodes.forEach((c, i) => req.input(`v${i}`, erpSql.Int, c));
    const rows = (await req.query(`
      SELECT t1.VchCode, LTRIM(RTRIM(st.Name)) AS TaxType FROM dbo.Tran1 t1 LEFT JOIN dbo.Master1 st ON st.Code = t1.CM1
      WHERE t1.VchCode IN (${poVchCodes.map((_, i) => `@v${i}`).join(',')})`)).recordset;
    const types = [...new Set(rows.map((r) => r.TaxType))];
    if (types.length > 1) problems.push(`These PO lines have different tax types in Busy (${types.join(', ')}) — receive them as separate GRNs in Busy.`);
    taxType = types[0] || null;
    if (taxType && !TAX_RATES[taxType]) problems.push(`Tax type "${taxType}" on the PO is not one this system can receive — receive this one in Busy by hand.`);
  }
  const taxInfo = TAX_RATES[taxType] || { rate: 0, inclusive: false };

  // Item aliases (batch numbers) and which items Busy tracks in batches.
  const itemCodes = [...new Set(draft.map((d) => d.line.itemCode))];
  const aliases = new Map();
  const batched = new Set();
  if (itemCodes.length) {
    const ids = itemCodes.map((c) => parseInt(c, 10)).filter(Number.isFinite).join(',');
    const [a, b] = await Promise.all([
      erpPool.request().query(`SELECT Code, LTRIM(RTRIM(Alias)) AS Alias FROM dbo.Master1 WHERE Code IN (${ids})`),
      erpPool.request().query(`SELECT DISTINCT MasterCode1 FROM dbo.Tran3 WHERE RecType = 2 AND VchType = ${GRN_VCHTYPE} AND MasterCode1 IN (${ids})`),
    ]);
    for (const r of a.recordset) aliases.set(r.Code, r.Alias);
    for (const r of b.recordset) batched.add(r.MasterCode1);
  }

  const lines = draft.map((d, i) => {
    const money = lineMoney({ qty: d.qty, listPrice: d.line.price, discountPct: d.rejectionPct, taxInfo });
    return {
      srNo: i + 1,
      entryItemId: d.ei.EntryItemId,
      refCode: d.refs[0].refCode,               // first (oldest) PO line
      poNo: d.refs.map((r) => r.poNo).join(', '),
      refs: d.refs,                              // [{ refCode, poNo, dueDate, pending, qty }] — what each PO line takes
      allowance: d.allowance,                    // received above the chosen PO lines — on no PO
      itemCode: d.line.itemCode,
      itemName: d.line.itemName,
      unitName: d.line.unitName,
      store: d.line.store,
      qty: d.qty,
      pending: round3(d.refs.reduce((s, r) => s + r.pending, 0)),
      ...money,                                  // listPrice (PO), discountPct (rejection), price (net), amount…
      qaRejectionPct: qaPct,
      batchNo: batched.has(d.line.itemCode) ? batchNumber(date, aliases.get(d.line.itemCode), party?.Alias, entry.EntryNo) : null,
    };
  });

  const { subtotal, netSubtotal, vat, roundOff, total } = grnTotals(lines, taxInfo);

  const note = String(deliveryNote ?? entry.Notes ?? '').replace(/\s+/g, ' ').trim();
  const narration = `${narrationTag(entry.EntryNo)} ${note}`.trim().slice(0, NARRATION_MAX);
  const notReceived = entry.items
    .filter((i) => !lines.some((l) => l.entryItemId === i.EntryItemId))
    .map((i) => i.MaterialName);

  const grn = {
    entryId: entry.EntryId,
    entryNo: entry.EntryNo,
    status: entry.Status,
    supplierName: entry.SupplierName,
    party,
    vehicle: entry.VehicleRegNo,
    ticketNo: entry.TicketNo,
    qa: entry.qa,
    taxType,
    taxRate: taxInfo.rate,
    taxInclusive: taxInfo.inclusive,
    date: busyDate(date),
    narration,
    lines,
    notReceived,
    subtotal,
    netSubtotal,
    vat,
    roundOff,
    total,
    problems: [...new Set(problems)],
    // not blocking: the supplier's allowance above the POs
    qaRejectionPct: qaPct,
    notes: [
      ...lines.filter((l) => l.allowance > 0).map((l) => `"${l.itemName}": ${l.allowance} ${l.unitName || ''} above ${l.poNo} `
        + `(pending ${l.pending}) is the supplier's allowance — it goes on the GRN at ${l.price} but against no PO, as in Busy.`),
      ...lines.filter((l) => Math.abs(l.discountPct - qaPct) > 0.005).map((l) => `"${l.itemName}": rejection ${l.discountPct}% entered — QA recorded ${qaPct}%.`),
      ...olderPoNotes(draft, openLines),
    ],
    // for the picker
    entryItems: entry.items.map((i) => ({
      entryItemId: i.EntryItemId, materialName: i.MaterialName, busyItemCode: i.BusyItemCode,
      refCode: i.BusyPORefCode, poNo: i.BusyPONo, quantity: i.Quantity, uom: i.UOM, netKg: i.NetKg, remarks: i.Description,
    })),
    openLines: openLines.map((l) => ({
      refCode: l.refCode, poNo: l.poNo, refNo: l.refNo, poDate: l.poDate, approved: l.approved, itemCode: l.itemCode, itemName: l.itemName,
      unitName: l.unitName, store: l.store, price: l.price, ordered: l.ordered, pending: l.pending,
    })),
  };

  if (grn.problems.length === 0) {
    grn.xml = renderGrnXml({
      seriesName, date: grn.date, taxType, taxInfo, partyName: party.Name, ticketNo: grn.ticketNo, vehicle: grn.vehicle,
      narration, lines, subtotal, vat, roundOff,
    });
  }
  return grn;
}

/**
 * Apply the rejection % to a GRN this system already saved in Busy
 * (2026-10-29 — Njr-2275 / Njr-2284 went in at full price). The GRN is
 * rebuilt from what Busy holds — same number, quantities, PO references,
 * batches, ticket and narration — with only the line discount changed, and
 * saved over itself. Blocked once the GRN is billed (the bill carries the
 * old value) or if it was entered in Busy by hand.
 */
async function buildGrnRejectionAmend(pool, erpPool, { entryId, rejectionPct, seriesName, poLineFor = null }) {
  const entry = await loadEntry(pool, entryId);
  if (!entry) return { problems: ['Delivery not found'] };
  if (!entry.BusyGRNVchCode) return { problems: [`${entry.EntryNo} has no Busy GRN yet.`] };
  const vchCode = entry.BusyGRNVchCode;
  const problems = [];
  const qaPct = qaRejectionPct(entry.qa, entry.NetWeight);
  const pct = rejectionPct === undefined || rejectionPct === null || rejectionPct === '' ? qaPct : round2(Number(rejectionPct));
  if (!(pct >= 0 && pct < 100)) problems.push('Rejection % must be from 0 to below 100.');

  const head = (await erpPool.request().input('v', erpSql.Int, vchCode).input('t', erpSql.Int, GRN_VCHTYPE).query(`
    SELECT LTRIM(RTRIM(t1.VchNo)) AS VchNo, t1.AutoVchNo, t1.[Date], t1.VchAmtBaseCur AS Total,
           LTRIM(RTRIM(p.Name)) AS PartyName, LTRIM(RTRIM(st.Name)) AS TaxType,
           LTRIM(RTRIM(oi.OF1)) AS OF1, LTRIM(RTRIM(oi.Transport)) AS Transport, LTRIM(RTRIM(oi.Narration1)) AS Narration
    FROM dbo.Tran1 t1
    LEFT JOIN dbo.Master1 p ON p.Code = t1.MasterCode1
    LEFT JOIN dbo.Master1 st ON st.Code = t1.CM1
    LEFT JOIN dbo.VchOtherInfo oi ON oi.VchCode = t1.VchCode
    WHERE t1.VchCode = @v AND t1.VchType = @t`)).recordset[0];
  if (!head) return { problems: [`Busy GRN ${entry.BusyGRNNo} was not found in Busy.`] };
  if (!String(head.Narration || '').startsWith('[MTS ')) problems.push(`${head.VchNo} was entered in Busy by hand — put the rejection % on it in Busy itself.`);

  const [itemRows, batchRows, refRows, sundryRows, billed] = await Promise.all([
    erpPool.request().input('v', erpSql.Int, vchCode).query(`
      SELECT t2.SrNo, LTRIM(RTRIM(it.Name)) AS ItemName, LTRIM(RTRIM(u.Name)) AS UnitName, ABS(t2.D1) AS Qty, t2.D2 AS Price,
             LTRIM(RTRIM(mc.Name)) AS Store
      FROM dbo.Tran2 t2 LEFT JOIN dbo.Master1 it ON it.Code = t2.MasterCode1 LEFT JOIN dbo.Master1 u ON u.Code = it.CM1
      LEFT JOIN dbo.Master1 mc ON mc.Code = t2.MasterCode2
      WHERE t2.VchCode = @v AND t2.RecType = 2 ORDER BY t2.SrNo`),
    erpPool.request().input('v', erpSql.Int, vchCode)
      .query('SELECT ItemSrNo, LTRIM(RTRIM(No)) AS BatchNo FROM dbo.Tran3 WHERE VchCode = @v AND RecType = 2'),
    erpPool.request().input('v', erpSql.Int, vchCode).query(`
      SELECT r.ItemSrNo, r.SrNo, r.RefCode, ABS(r.Value1) AS Qty, LTRIM(RTRIM(pt.VchNo)) AS PONo, LTRIM(RTRIM(o.No)) AS RefNo, o.Value3 AS POPrice, o.DueDate
      FROM dbo.Tran3 r
      JOIN dbo.Tran3 o ON o.RefCode = r.RefCode AND o.Method = 1 AND o.RecType = 4
      JOIN dbo.Tran1 pt ON pt.VchCode = o.VchCode
      WHERE r.VchCode = @v AND r.RecType = 4 AND r.Method = 2 ORDER BY r.ItemSrNo, r.SrNo`),
    erpPool.request().input('v', erpSql.Int, vchCode).query(`
      SELECT LTRIM(RTRIM(m.Name)) AS Name FROM dbo.Tran2 t2 JOIN dbo.Master1 m ON m.Code = t2.MasterCode1
      WHERE t2.VchCode = @v AND t2.RecType = 3`),
    erpPool.request().input('v', erpSql.Int, vchCode).query(`
      SELECT COUNT(*) AS n FROM dbo.Tran3 c JOIN dbo.Tran3 u ON u.RefCode = c.RefCode AND u.RecType = 3 AND u.Method = 2
      WHERE c.VchCode = @v AND c.RecType = 3 AND c.Method = 1`),
  ]);
  if (billed.recordset[0].n > 0) problems.push(`${head.VchNo} is already billed in Busy — Accounts must change the bill; it can't be changed from here.`);
  const otherSundries = sundryRows.recordset.map((s) => s.Name).filter((n) => n !== 'VAT' && !/^Rounded Off/.test(n));
  if (otherSundries.length) problems.push(`${head.VchNo} has ${otherSundries.join(', ')} — change it in Busy itself.`);

  const taxType = head.TaxType;
  const taxInfo = TAX_RATES[taxType];
  if (!taxInfo) problems.push(`Tax type "${taxType}" is not one this system can change — do it in Busy.`);
  const items = itemRows.recordset;
  // Moving a line to another PO line (2026-11-02, received against the wrong
  // PO / line): poLineFor = { [GRN line SrNo]: PO line RefCode } — the whole
  // quantity goes on that one line, at its price.
  const moved = new Map();
  for (const [srNo, refCode] of Object.entries(poLineFor || {})) {
    const item = items.find((i) => i.SrNo === Number(srNo));
    const po = (await erpPool.request().input('r', erpSql.Int, refCode).input('v', erpSql.Int, vchCode).query(`
      SELECT o.RefCode, ABS(o.Value1) AS Ordered, o.Value3 AS POPrice, o.DueDate, o.MasterCode1 AS ItemCode, o.MasterCode2 AS PartyCode,
             LTRIM(RTRIM(pt.VchNo)) AS PONo, LTRIM(RTRIM(o.No)) AS RefNo, pt.ApprovalStatus,
             (SELECT SUM(ABS(u.Value1)) FROM dbo.Tran3 u WHERE u.RefCode = o.RefCode AND u.Method = 2 AND u.RecType = 4 AND u.VchCode <> @v) AS Others
      FROM dbo.Tran3 o JOIN dbo.Tran1 pt ON pt.VchCode = o.VchCode
      WHERE o.RefCode = @r AND o.Method = 1 AND o.RecType = 4`)).recordset[0];
    const grnItem = (await erpPool.request().input('v', erpSql.Int, vchCode).input('s', erpSql.Int, Number(srNo))
      .query('SELECT t2.MasterCode1 AS ItemCode, t1.MasterCode1 AS PartyCode FROM dbo.Tran2 t2 JOIN dbo.Tran1 t1 ON t1.VchCode = t2.VchCode WHERE t2.VchCode = @v AND t2.SrNo = @s AND t2.RecType = 2')).recordset[0];
    if (!item || !grnItem) { problems.push(`${head.VchNo} has no line ${srNo}.`); continue; }
    if (!po) { problems.push(`PO line ${refCode} was not found in Busy.`); continue; }
    if (po.ItemCode !== grnItem.ItemCode || po.PartyCode !== grnItem.PartyCode) problems.push(`${po.RefNo} is not for "${item.ItemName}" from this supplier.`);
    if (po.ApprovalStatus !== 1) problems.push(`${po.PONo} is not approved in Busy.`);
    const free = Number(po.Ordered) - (Number(po.Others) || 0);
    if (Number(item.Qty) - free > 0.0005) problems.push(`${po.RefNo} has only ${free} pending — not enough for ${item.Qty}.`);
    moved.set(Number(srNo), [{ ItemSrNo: Number(srNo), SrNo: 1, RefCode: po.RefCode, Qty: Number(item.Qty), PONo: po.PONo, RefNo: po.RefNo, POPrice: po.POPrice, DueDate: po.DueDate }]);
  }
  const refsFor = (srNo) => moved.get(srNo) || refRows.recordset.filter((r) => r.ItemSrNo === srNo || (r.ItemSrNo === 0 && items.length === 1));
  if (refRows.recordset.some((r) => !items.some((i) => i.SrNo === r.ItemSrNo)) && items.length > 1) {
    problems.push(`Busy's PO references on ${head.VchNo} can't be matched to its lines — change it in Busy itself.`);
  }

  const date = busyDate(new Date(head.Date));
  const lines = items.map((i) => {
    const refs = refsFor(i.SrNo);
    // the list price is the PO's (Stores' GRNs: ListPrice = PO price); a GRN with no PO keeps its own
    const listPrice = Number(refs[0]?.POPrice) > 0 ? Number(refs[0].POPrice) : Number(i.Price);
    const money = lineMoney({ qty: Number(i.Qty), listPrice, discountPct: pct >= 0 && pct < 100 ? pct : 0, taxInfo: taxInfo || { rate: 0, inclusive: false } });
    return {
      srNo: i.SrNo, itemName: i.ItemName, unitName: i.UnitName, store: i.Store, qty: Number(i.Qty), currentPrice: Number(i.Price),
      ...money,
      batchNo: batchRows.recordset.find((b) => b.ItemSrNo === i.SrNo || (b.ItemSrNo === 0 && items.length === 1))?.BatchNo || null,
      refs: refs.map((r) => ({ refCode: r.RefCode, poNo: r.PONo, refNo: r.RefNo, qty: Number(r.Qty), dueDate: r.DueDate })),
    };
  });
  const totals = grnTotals(lines, taxInfo || { rate: 0, inclusive: false });
  const out = {
    entryId: entry.EntryId, entryNo: entry.EntryNo, vchCode, grnNo: head.VchNo, date, taxType,
    qa: entry.qa, qaRejectionPct: qaPct, rejectionPct: pct, currentTotal: Number(head.Total) || 0,
    lines, ...totals, problems: [...new Set(problems)],
  };
  if (out.problems.length === 0) {
    out.xml = renderGrnXml({
      seriesName, vchNo: head.VchNo, autoVchNo: head.AutoVchNo, date, taxType, taxInfo, partyName: head.PartyName,
      ticketNo: head.OF1, vehicle: head.Transport, narration: head.Narration, lines, subtotal: totals.subtotal, vat: totals.vat, roundOff: totals.roundOff,
    });
  }
  return out;
}

/**
 * A Busy GRN this system already saved for this entry but didn't link (Busy
 * saved, then our side failed) — found by the narration tag, so a retry
 * links it instead of receiving the goods twice.
 */
async function findExistingPushedGrn(erpPool, { entryNo, partyCode }) {
  const r = await erpPool.request()
    .input('vchType', erpSql.Int, GRN_VCHTYPE)
    .input('party', erpSql.Int, partyCode)
    .input('tag', erpSql.NVarChar(100), narrationTag(entryNo))
    .query(`
      SELECT TOP 1 t1.VchCode, LTRIM(RTRIM(t1.VchNo)) AS VchNo
      FROM dbo.Tran1 t1 JOIN dbo.VchOtherInfo oi ON oi.VchCode = t1.VchCode
      -- prefix compare, not LIKE: "[" is a LIKE wildcard
      WHERE t1.VchType = @vchType AND t1.MasterCode1 = @party AND LEFT(oi.Narration1, LEN(@tag)) = @tag
      ORDER BY t1.VchCode DESC`);
  return r.recordset[0] || null;
}

/** PO lines the saved GRN actually received against (Tran3 Method 2) — to confirm Busy took the PO link. */
async function grnPoRefs(erpPool, vchCode) {
  const r = await erpPool.request().input('v', erpSql.Int, vchCode)
    .query('SELECT RefCode, ABS(Value1) AS Qty FROM dbo.Tran3 WHERE VchCode = @v AND RecType = 4 AND Method = 2');
  return r.recordset;
}

module.exports = {
  GRN_VCHTYPE, RECEIVABLE, buildGrn, buildGrnRejectionAmend, addChallanRefs, grnsMissingChallans, findExistingPushedGrn, grnPoRefs, batchNumber, loadEntry, qaRejectionPct,
};
