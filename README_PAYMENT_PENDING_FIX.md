# Why Bank Transfer / VA bookings got stuck more than QRIS

## Root cause
Midtrans Snap calls a different JS callback depending on the payment method:

- **QRIS** (and other instant methods) usually settle *during* the checkout
  session → Snap calls `onSuccess` → the browser is sent to
  `/payment/finish`, which **actively re-checks** the payment status with
  the server the moment it loads (`public/pages/payment-finish.html`
  polls `GET /api/payment/status/:orderId`, which itself re-verifies with
  Midtrans and finalizes the booking right there).
- **Bank Transfer / Virtual Account** (and any method that isn't complete
  yet when Snap closes) → Snap calls `onPending` instead → the browser is
  sent to `/payment/pending`. That page was **static** — it never checked
  anything, and its only "Check Status" button pointed to `/dashboard`,
  which is a dead end for a guest who never created an account.

So for a guest paying by bank transfer: they get a VA number, close the tab,
transfer the money later from their banking app — and nothing on that page
was ever capable of noticing it arrived. The booking wasn't lost (it's still
sitting in `pending_bookings`), it just had no path left except the
Midtrans webhook or the automatic background sweep (see
`README_AUTO_RECONCILE.md`) to eventually catch it — both of which already
exist, but the customer-facing page gave zero visibility into that.

## Fix
Rewrote `public/pages/payment-pending.html` to mirror
`public/pages/payment-finish.html`:
- It now actively polls `GET /api/payment/status/:orderId` (a few times,
  spaced out more than the finish page since bank transfers legitimately
  take longer), so if the customer keeps the tab open, or refreshes it
  after actually paying, it shows the real "Booking Confirmed!" state
  immediately instead of a static "pending" message forever.
- If still not paid after polling, it clearly says the customer doesn't
  need to keep the tab open — the webhook + automatic sweep will still
  confirm it later and email them (bookings already send a confirmation
  email with invoice on confirmation, regardless of which path triggered it).
- The "Check Status" / result buttons no longer send guests to `/dashboard`
  — logged-out visitors get "Back to Schedule" instead.

This doesn't change how bookings get confirmed server-side (that logic was
already correct and already self-heals via the webhook + the 3-minute
auto-reconcile sweep) — it only fixes the customer-facing page so guests
paying by bank transfer get the same real-time feedback QRIS payers already
had, instead of a dead-looking static screen.

## Deployment
No database or backend changes.

1. Replace `public/pages/payment-pending.html` with the version in this
   package.
2. Restart/redeploy.
3. Test: start a guest booking, choose Bank Transfer, then (in another tab,
   or via Midtrans's Sandbox simulator) mark that VA as paid — the pending
   page should update to "Booking Confirmed!" within a few seconds without
   needing a manual refresh.
