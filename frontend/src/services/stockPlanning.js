const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Looks ahead for one Reorder Levels row: when the stock runs out, when the
 * order has to be placed, and what buying `buyQty` does to cover.
 *
 * Assumes usage continues at the item's average monthly consumption
 * (AvgMonthlyConsumption / 30 per day) and that an order placed today
 * arrives after the item's lead time (LeadTimeDays).
 *
 * @param {object} row      ReorderStatus row (LiveStock, AvgMonthlyConsumption, LeadTimeDays, ReorderLevel, MaxStockLevel)
 * @param {number} buyQty   quantity that would be bought
 * @param {Date}   [today]
 * @returns {{ hasUsage: false } | object}
 */
export function planStock(row, buyQty, today = new Date()) {
  const live = Number(row.LiveStock) || 0;
  const monthly = row.AvgMonthlyConsumption != null ? Number(row.AvgMonthlyConsumption) : 0;
  if (!(monthly > 0)) return { hasUsage: false };

  const daily = monthly / 30;
  const lead = row.LeadTimeDays != null ? Number(row.LeadTimeDays) : 0;
  const addDays = (n) => new Date(today.getTime() + n * DAY_MS);

  const daysCover = Math.max(0, live) / daily;
  const orderInDays = daysCover - lead;             // negative = already late
  const stockAtArrival = Math.max(0, live - daily * lead);
  const qty = Math.max(0, Number(buyQty) || 0);
  const afterBuy = stockAtArrival + qty;
  const coverAfterDays = afterBuy / daily;          // counted from the arrival date
  const reorderLevel = Number(row.ReorderLevel) || 0;
  const maxLevel = Number(row.MaxStockLevel) || 0;

  return {
    hasUsage: true,
    dailyUse: daily,
    leadDays: lead,
    daysCover,
    runOutDate: addDays(daysCover),
    orderByDate: addDays(orderInDays),
    orderOverdueDays: orderInDays < 0 ? Math.ceil(-orderInDays) : 0,
    gapDays: Math.max(0, lead - daysCover),          // days with no stock if ordered today
    arrivalDate: addDays(lead),
    stockAtArrival,
    afterBuy,
    coverAfterDays,
    coverAfterMonths: coverAfterDays / 30,
    newRunOutDate: addDays(lead + coverAfterDays),
    nextOrderDate: afterBuy > reorderLevel ? addDays(lead + (afterBuy - reorderLevel) / daily) : addDays(lead),
    overMaxQty: maxLevel > 0 && afterBuy > maxLevel ? afterBuy - maxLevel : 0,
  };
}
