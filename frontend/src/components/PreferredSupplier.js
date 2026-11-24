/**
 * The supplier the person who raised a requisition asked for, carried
 * through every approval and procurement screen (2026-10-30 — it used to
 * show only on the Central Stores review and was then lost).
 */
import React from 'react';

/** Table cell content: the preferred supplier of one requisition item, or a dash. */
export function PreferredSupplierCell({ item }) {
  const name = item?.PreferredSupplierName;
  if (!name) return <span style={{ color: '#9ca3af' }}>—</span>;
  return (
    <span title="Requested by the person who raised the order" style={{ color: '#92400e', fontWeight: 600 }}>
      ★ {name}
      {!item.PreferredSupplierId && (
        <span style={{ display: 'block', fontWeight: 400, fontSize: 11, color: '#6b7280' }}>not in the supplier list</span>
      )}
    </span>
  );
}

/** Small line under an item name, for tables without a supplier column. */
export function PreferredSupplierNote({ item }) {
  if (!item?.PreferredSupplierName) return null;
  return (
    <div style={{ fontSize: 11, color: '#92400e' }} title="Requested by the person who raised the order">
      ★ Preferred supplier: {item.PreferredSupplierName}
    </div>
  );
}

/** Badge on a supplier in an RFQ supplier picker. */
export function PreferredBadge({ items }) {
  return (
    <span className="badge badge-yellow" style={{ fontSize: 10, marginLeft: 6 }}
      title={items ? `Requested for: ${items}` : 'Requested by the person who raised the order'}>
      ★ Requested{items ? ` — ${items.length > 60 ? `${items.slice(0, 57)}…` : items}` : ''}
    </span>
  );
}
