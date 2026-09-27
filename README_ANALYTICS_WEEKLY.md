# Analytics: Weekly / Monthly revenue toggle

## What changed
The Analytics tab in the admin dashboard only ever showed a fixed
"Last 12 Months" revenue chart. There was no way to view revenue per week.

Revenue counting itself was already correct (only bookings with
`status === 'confirmed'` — i.e. payment succeeded — are counted; `pending`
and `cancelled` bookings never contributed). This change only adds the
missing weekly granularity on top of that same, already-correct data.

## Backend (`lib/stats.js`)
- Added `weekly12`: revenue + booking count for the last 12 calendar weeks
  (Monday–Sunday), built the same way as the existing `monthly12`, from the
  same `confirmed` bookings + `memberPackages` data.
- Added `summary.weeklyRevenueGrowthPct`, `summary.thisWeekRevenue`,
  `summary.lastWeekRevenue` (this week vs last week), mirroring the existing
  monthly growth fields.
- `GET /api/stats/admin` now returns `weekly12` alongside `monthly12` — no
  route or query-param changes needed.

## Frontend (`public/pages/admin.html`, `public/js/admin.js`, `public/css/admin.css`)
- Added a **Monthly / Weekly** segmented toggle above the revenue chart in
  Analytics.
- `renderRevenueChart()` switches the chart + growth label between
  `monthly12` and `weekly12` instantly (no extra API call — both series are
  already included in the one `/api/stats/admin` response).
- Added `.seg` / `.seg-btn` styles for the toggle control.

## Deployment
No database migration needed.

1. Replace `server.js`, `lib/stats.js`, `public/pages/admin.html`,
   `public/js/admin.js`, and `public/css/admin.css` with the versions in
   this package.
2. Restart/redeploy the Node.js application.
3. In the admin dashboard, open **Analytics** and confirm you can switch
   between "Monthly" and "Weekly" on the Revenue chart, and that the totals
   only include bookings that were actually paid (`confirmed`).
