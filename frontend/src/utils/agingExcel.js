/**
 * Aging Analysis Excel export, styled like the page (2026-11-24).
 *
 * Built with ExcelJS (SheetJS community edition cannot write cell styles).
 * Kept free of React so it can be tested in Node with real data:
 *   const wb = buildAgingWorkbook(ExcelJS, { rows, lastSyncedAt, truncated, maxRows, filters })
 *
 * Sheet "Aging": title with the active filters, frozen header row with
 * filter arrows, bucket cells coloured like the page's bucket pills,
 * dates as real Excel dates (01-May-2023), quantities to 2 decimals, KES
 * amounts with thousands separators, a TOTAL row.
 * Sheet "Summary": filters, and capital per age bucket with the same colours.
 */

// Same colours as BUCKET_COLOR in pages/AgingAnalysis.js
export const BUCKET_ARGB = {
  '0-30': 'FF2E7D32',
  '31-60': 'FF9E9D24',
  '61-90': 'FFF9A825',
  '91-180': 'FFEF6C00',
  '180+': 'FFC62828',
  Unknown: 'FF757575',
};
const BUCKET_ORDER = ['0-30', '31-60', '61-90', '91-180', '180+', 'Unknown'];
const bucketLabel = (b) => (b === 'Unknown' ? 'Negative stock (no date)' : `${b} days`);

const HEADER_FILL = 'FF1F2937'; // dark slate, like the app's sidebar
const TITLE_FILL = 'FF0F4C81';
const ZEBRA_FILL = 'FFF9FAFB';
const TOTAL_FILL = 'FFE5E7EB';
const BORDER_GREY = 'FFE5E7EB';

const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin', color: { argb: BORDER_GREY } };

const validDate = (d) => {
  if (!d) return null;
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) || dt.getFullYear() <= 1900 ? null : dt;
};
const num = (n, dp = 2) => {
  const x = Number(n);
  return n == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** dp) / 10 ** dp;
};

const COLUMNS = [
  { header: 'Item', key: 'item', width: 44 },
  { header: 'Category', key: 'category', width: 26 },
  { header: 'Store', key: 'store', width: 16 },
  { header: 'Received on (voucher)', key: 'voucher', width: 26 },
  { header: 'Date', key: 'date', width: 13, numFmt: 'dd-mmm-yyyy', align: 'center' },
  { header: 'Due Date', key: 'due', width: 13, numFmt: 'dd-mmm-yyyy', align: 'center' },
  { header: 'Age (days)', key: 'age', width: 11, numFmt: '#,##0"d"', align: 'right' },
  { header: 'Bucket', key: 'bucket', width: 24, align: 'center' },
  { header: 'Qty', key: 'qty', width: 12, numFmt: '#,##0.00', align: 'right' },
  { header: 'Unit cost (KES)', key: 'unit', width: 15, numFmt: '#,##0.00', align: 'right' },
  { header: 'Amount (KES)', key: 'amount', width: 18, numFmt: '"KES "#,##0', align: 'right' },
];

export function buildAgingWorkbook(ExcelJS, { rows, lastSyncedAt, truncated, maxRows, filters = {} }) {
  const { factory, category, itemName, bucket, minAge, sortBy, sortDir } = filters;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Material Traceability System';
  wb.created = new Date();

  const filterText = [factory || 'All aging stores', category, bucket && `${bucket} days`,
    minAge && `at least ${minAge} days old`, itemName && `item contains "${itemName}"`].filter(Boolean).join(' · ');
  const syncedText = lastSyncedAt ? new Date(lastSyncedAt).toLocaleString('en-KE') : '—';
  const total = rows.reduce((s, r) => s + (Number(r.Amount) || 0), 0);
  const ncol = COLUMNS.length;

  // ── Sheet 1: Aging ──────────────────────────────────────────────────────
  const ws = wb.addWorksheet('Aging', {
    views: [{ state: 'frozen', ySplit: 4 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  ws.columns = COLUMNS.map((c) => ({ key: c.key, width: c.width }));

  ws.mergeCells(1, 1, 1, ncol);
  const title = ws.getCell(1, 1);
  title.value = `Aging Analysis — ${filterText}`;
  title.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  title.fill = solid(TITLE_FILL);
  title.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(1).height = 26;

  ws.mergeCells(2, 1, 2, ncol);
  const sub = ws.getCell(2, 1);
  sub.value = `Exported ${new Date().toLocaleString('en-KE')} · data synced from Busy ${syncedText} · `
    + `${rows.length.toLocaleString()} batch(es) · KES ${Math.round(total).toLocaleString('en-KE')}`
    + (truncated ? ` · only the first ${Number(maxRows).toLocaleString()} batches — narrow the filters for the rest` : '');
  sub.font = { italic: true, size: 10, color: { argb: 'FF4B5563' } };
  sub.alignment = { indent: 1 };

  const head = ws.getRow(4);
  COLUMNS.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = solid(HEADER_FILL);
    cell.alignment = { vertical: 'middle', horizontal: c.align || 'left', wrapText: true };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FF111827' } } };
  });
  head.height = 20;

  rows.forEach((r, i) => {
    const unknown = r.AgeBucket === 'Unknown';
    const row = ws.getRow(5 + i);
    row.values = {
      item: r.ItemName || '',
      category: r.Category || '',
      store: r.Factory || '',
      voucher: r.BatchNo || '',
      date: validDate(r.BatchDate),
      due: validDate(r.DueDate),
      age: unknown ? null : num(r.AgeDays, 0),
      bucket: bucketLabel(r.AgeBucket),
      qty: num(r.Qty),
      unit: Number(r.Qty) ? num(Number(r.Amount) / Number(r.Qty)) : null,
      amount: num(r.Amount),
    };
    COLUMNS.forEach((c, ci) => {
      const cell = row.getCell(ci + 1);
      if (c.numFmt) cell.numFmt = c.numFmt;
      if (c.align) cell.alignment = { horizontal: c.align };
      cell.border = { bottom: thin };
      if (i % 2 === 1) cell.fill = solid(ZEBRA_FILL);
    });
    // Bucket pill colours, as on the page
    const b = row.getCell(8);
    b.fill = solid(BUCKET_ARGB[r.AgeBucket] || BUCKET_ARGB.Unknown);
    b.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    // Old stock stands out: age in the bucket colour from 91 days
    if (r.AgeBucket === '91-180' || r.AgeBucket === '180+') {
      row.getCell(7).font = { bold: true, color: { argb: BUCKET_ARGB[r.AgeBucket] } };
    }
    row.getCell(11).font = { bold: true, color: Number(r.Amount) < 0 ? { argb: 'FFC62828' } : undefined };
  });

  const totalRow = ws.getRow(5 + rows.length + 1);
  totalRow.getCell(1).value = 'TOTAL';
  totalRow.getCell(2).value = `${rows.length.toLocaleString()} batch(es)`;
  totalRow.getCell(11).value = Math.round(total);
  totalRow.getCell(11).numFmt = '"KES "#,##0';
  for (let c = 1; c <= ncol; c += 1) {
    const cell = totalRow.getCell(c);
    cell.font = { bold: true, size: 12 };
    cell.fill = solid(TOTAL_FILL);
    cell.border = { top: { style: 'medium', color: { argb: 'FF111827' } } };
  }
  totalRow.getCell(11).alignment = { horizontal: 'right' };

  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + rows.length, column: ncol } };
  ws.pageSetup.printTitlesRow = '4:4';

  // ── Sheet 2: Summary ────────────────────────────────────────────────────
  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ width: 30 }, { width: 14 }, { width: 20 }, { width: 12 }];
  sum.mergeCells(1, 1, 1, 4);
  const st = sum.getCell(1, 1);
  st.value = 'Aging Analysis — summary';
  st.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  st.fill = solid(TITLE_FILL);
  sum.getRow(1).height = 24;

  const info = [
    ['Exported', new Date().toLocaleString('en-KE')],
    ['Data last synced from Busy', syncedText],
    ['Store', factory || 'All aging stores'],
    ['Category', category || 'All'],
    ['Item name contains', itemName || '—'],
    ['Age bucket', bucket ? `${bucket} days` : 'All'],
    ['Minimum age (days)', minAge || '—'],
    ['Sorted by', `${sortBy || 'AgeDays'} ${sortDir === 'ASC' ? 'ascending' : 'descending'}`],
  ];
  info.forEach(([k, v], i) => {
    const row = sum.getRow(3 + i);
    row.getCell(1).value = k;
    row.getCell(1).font = { bold: true, color: { argb: 'FF4B5563' } };
    row.getCell(2).value = v;
  });

  const by = Object.fromEntries(BUCKET_ORDER.map((b) => [b, { n: 0, amt: 0 }]));
  for (const r of rows) {
    const b = by[r.AgeBucket] || (by[r.AgeBucket] = { n: 0, amt: 0 });
    b.n += 1;
    b.amt += Number(r.Amount) || 0;
  }
  const h = 3 + info.length + 1;
  const hr = sum.getRow(h);
  ['Age bucket', 'Batches', 'Amount (KES)', '% of total'].forEach((t, i) => {
    const c = hr.getCell(i + 1);
    c.value = t;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = solid(HEADER_FILL);
    c.alignment = { horizontal: i === 0 ? 'left' : 'right' };
  });
  let rr = h + 1;
  for (const b of BUCKET_ORDER.filter((x) => by[x].n > 0)) {
    const row = sum.getRow(rr);
    row.getCell(1).value = bucketLabel(b);
    row.getCell(1).fill = solid(BUCKET_ARGB[b]);
    row.getCell(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.getCell(2).value = by[b].n;
    row.getCell(2).numFmt = '#,##0';
    row.getCell(3).value = Math.round(by[b].amt);
    row.getCell(3).numFmt = '"KES "#,##0';
    row.getCell(4).value = total ? by[b].amt / total : null;
    row.getCell(4).numFmt = '0.0%';
    for (let c = 1; c <= 4; c += 1) row.getCell(c).border = { bottom: thin };
    rr += 1;
  }
  const tr = sum.getRow(rr);
  tr.getCell(1).value = 'Total';
  tr.getCell(2).value = rows.length;
  tr.getCell(2).numFmt = '#,##0';
  tr.getCell(3).value = Math.round(total);
  tr.getCell(3).numFmt = '"KES "#,##0';
  for (let c = 1; c <= 4; c += 1) {
    tr.getCell(c).font = { bold: true };
    tr.getCell(c).fill = solid(TOTAL_FILL);
    tr.getCell(c).border = { top: { style: 'medium', color: { argb: 'FF111827' } } };
  }
  if (truncated) {
    sum.getRow(rr + 2).getCell(1).value = `Only the first ${Number(maxRows).toLocaleString()} batches are included — narrow the filters for the rest.`;
    sum.getRow(rr + 2).getCell(1).font = { italic: true, color: { argb: 'FFC62828' } };
  }

  return wb;
}

export function agingFileName({ factory, category, bucket, minAge, itemName }) {
  const slug = [factory || 'all-stores', category, bucket && `${bucket}d`, minAge && `min${minAge}d`, itemName]
    .filter(Boolean).join('-').replace(/[^A-Za-z0-9+-]+/g, '-').replace(/-+/g, '-').slice(0, 80);
  return `aging-${slug}-${new Date().toISOString().slice(0, 10)}.xlsx`;
}
