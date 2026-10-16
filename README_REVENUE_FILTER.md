# Analytics: Total Revenue date filter (matches Bookings filter UI)

## What changed
The "Total Revenue" stat card in Analytics now has the same filter pattern
already used in the **Bookings** tab: a **Date** picker + **Month** dropdown
+ **Year** dropdown (auto-populated), all auto-applying on change, plus a
**Clear Filters** button. No separate "Apply" button, consistent with how
Bookings filtering already works. Picking an exact date clears Month/Year,
same rule as Bookings.

Filtering only changes the Total Revenue number and the small "N paid
bookings" label next to it — it does not affect the Weekly/Monthly chart
below, which still shows the full 12-period trend.

**Confirmed: revenue only counts successful payments.** `classRevenue` sums
only bookings with `status === 'confirmed'`; `packageRevenue` sums
`member_packages`, which only ever get created either by the Midtrans
webhook after a real successful payment, or by an admin manually recording
an actual completed sale (e.g. cash payment). Pending/cancelled bookings
never contribute. This filter doesn't change that — it only narrows the date
range the same confirmed-only totals are summed over.

## Backend (`server.js` — `GET /api/stats/admin`)
Accepts optional query params (filtering is by the booking/package's
**payment date**, i.e. `created_at` / `purchased_at` — consistent with how
the existing Weekly/Monthly charts already bucket revenue):
- `?from=2026-09-05&to=2026-09-05` — exact date (what the Date picker sends)
- `?year=2026&month=9` — whole month
- `?year=2026` — whole year

Response adds when any filter is present:
- `summary.filteredRevenue`
- `summary.filteredBookingsCount`
- `summary.filteredRange`

With no query params, behavior is unchanged (`summary.totalRevenue` =
all-time).

## Frontend (`public/pages/admin.html`, `public/js/admin.js`)
- Date/Month/Year controls under the Total Revenue number, mirroring the
  Bookings tab's `bk-f-date` / `bk-f-month` / `bk-f-year` pattern
  (`an-rev-f-date` / `an-rev-f-month` / `an-rev-f-year`).
- `onAnRevDateFilterChange()` / `applyRevenueFilter()` / `clearRevenueFilter()`
  mirror `onBkDateFilterChange()` / `renderABkTable()` / `clearBkFilters()`.
- While a filter is active, the label under Total Revenue switches from
  "▲/▼ x% vs last month" to "N paid bookings", since a growth percentage
  doesn't make sense for an arbitrary custom range.

## Deployment
No database migration needed.

1. Replace `server.js`, `public/pages/admin.html`, `public/js/admin.js` with
   the versions in this package.
2. Restart/redeploy.
3. In Analytics, pick a Month + Year (or a single Date) — Total Revenue
   updates immediately to that period's confirmed-only revenue. Click Clear
   Filters to go back to all-time.
