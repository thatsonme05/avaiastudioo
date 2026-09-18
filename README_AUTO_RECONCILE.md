# Auto-reconcile: stuck "paid but not confirmed" bookings/memberships

## The problem
A booking is only moved from `pending_bookings` into `bookings` (i.e. shows
up in the admin Bookings list) by one of three things:
1. Midtrans's webhook (`POST /api/payment/notification`) reaching the
   server, or
2. The customer's browser landing on `/payment/finish` after paying, which
   actively re-checks the payment status with Midtrans, or
3. An admin manually clicking **"Check Pending Payments"**.

In practice, (1) can fail to fire if the Notification URL isn't configured
correctly in the Midtrans dashboard, and (2) can fail if the customer pays
via an app-switch method (GoPay, QRIS, e-wallets — very common on mobile)
and never returns to that browser tab. When both fail, the payment is
genuinely successful and the money is received, but the record just sits in
`pending_bookings`/`pending_package_purchases` forever — invisible in the
Bookings list — until someone happens to click the manual button. Nothing
was ever "not saved to the database"; it's just stuck one step before
becoming a confirmed booking.

## The fix
Added an automatic background sweep that runs the exact same
Midtrans-verified confirmation logic every few minutes on its own, with no
admin action required:

- `server.js`: extracted the "Check Pending Payments" logic into a shared
  `reconcileAllPendingPayments(minAgeMs)` function, used by both:
  - `POST /api/admin/reconcile-pending` (the existing manual button — same
    behavior as before), and
  - a new `setInterval` sweep started in `startServer()`, which runs every
    **3 minutes** and only looks at pending payments **older than 90
    seconds** (so it doesn't bother Midtrans's API while a customer might
    still be actively completing checkout).
- The sweep only ever *confirms* a payment if Midtrans itself reports it as
  actually paid (same `activelyConfirmWithMidtrans` used everywhere else) —
  it cannot grant a booking/membership that wasn't really paid for.
- A confirmed booking still triggers the same invoice email + admin/member
  notifications it always has, since it goes through the same
  `confirmBooking` / `confirmPackagePurchase` functions regardless of which
  of the (now four) paths triggered it.
- Only runs when Midtrans is configured (`USE_MT`); harmless/no-op
  otherwise. Logs a line to the server console whenever it actually
  confirms or fails to check something, so it's visible in your hosting
  logs.

## Still worth checking on your end
This auto-sweep is a safety net, not a substitute for the webhook working —
please still verify in your Midtrans Dashboard → **Settings → Configuration**
that the **Payment Notification URL** is set to:

```
https://yourdomain.com/api/payment/notification
```

in the correct mode (Sandbox vs Production, matching whichever Server Key
your `.env` is using). With that correctly set, most payments will confirm
within seconds via the webhook, and the sweep only ever needs to catch the
rare miss.

## Deployment
No database migration needed.

1. Replace `server.js` with the version in this package.
2. Restart/redeploy.
3. Check the startup log — you should see a line like:
   `Auto-reconcile: every 3min for payments older than 90s`
4. Any bookings/memberships currently stuck in "pending" will confirm
   automatically within the next sweep cycle (or click "Check Pending
   Payments" once to confirm them immediately).
