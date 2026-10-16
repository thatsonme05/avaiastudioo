# Dashboard: Total Revenue date filter + missing package revenue fix

## What changed
1. **Bug fix**: the Dashboard's "Total Revenue" card previously only summed
   confirmed class bookings — it silently excluded membership package sales
   entirely. It now fetches the same authoritative total the Analytics tab
   already used (`/api/stats/admin` → `summary.totalRevenue`), which
   correctly includes both.
2. **New**: added the same Date / Month / Year filter (auto-applying, with
   a Clear Filters button) used on the Analytics revenue card, so the
   Dashboard's Total Revenue can also be narrowed to a specific day, month,
   or year.

Filtering still only ever counts `confirmed` bookings + real completed
package purchases — same rule as everywhere else in the app.

## Frontend (`public/pages/admin.html`, `public/js/admin.js`)
- Added Date/Month/Year controls under the Dashboard's Total Revenue number
  (`db-rev-f-date` / `db-rev-f-month` / `db-rev-f-year`), mirroring the
  Analytics/Bookings filter pattern.
- `updateStats()` now calls the new `loadDashboardRevenue()`, which fetches
  `/api/stats/admin` (optionally with a date filter) instead of computing
  revenue client-side from the Bookings list only.

## Deployment
No backend/database changes — `server.js`'s `/api/stats/admin` already
supported these filters from the Analytics fix.

1. Replace `public/pages/admin.html` and `public/js/admin.js`.
2. Restart/redeploy.
3. Open the Dashboard tab — Total Revenue should now match the Analytics
   total exactly when unfiltered, and update when you pick a Date/Month/Year.
