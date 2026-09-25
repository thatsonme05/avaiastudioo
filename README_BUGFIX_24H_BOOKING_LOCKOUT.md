# Critical fix: people couldn't re-book after an abandoned checkout (up to 24h lockout)

## Symptom
Reported as: booking sometimes fails, and pending bookings get "stuck" —
some people simply can't book a class at all.

## Root cause
Two changes, each reasonable on its own, combined into a serious bug:

1. `migrations/017_integrity_hardening.sql` added a unique index so the
   SAME person (matched by name+email+phone) cannot have more than one
   non-cancelled `pending_bookings`/`bookings` row for the SAME class
   session at once. This correctly stops genuine duplicate bookings.
2. `PENDING_PAYMENT_MAX_AGE_MS` in `server.js` — the app's own "give up
   waiting on this payment" timer, independent of whatever Midtrans
   reports — was set to **24 hours**.

Put together: if someone opened checkout for a class and then abandoned it
(closed the tab, the Midtrans widget glitched, they changed their mind, a
network error), their `pending_bookings` row stayed "open" for up to a full
day. During that entire window, the unique index from (1) blocked that same
person from booking that same class again at all — they'd get "This
attendee already has a booking or pending payment for this class session."
even though, from their side, they never actually completed anything.

This is very likely to happen in normal use — abandoning a checkout and
then immediately trying again is a completely ordinary thing for a real
customer to do.

## Fix
- `SNAP_PAGE_EXPIRY_MINUTES = 60` — the Midtrans Snap checkout page itself
  now expires in 1 hour instead of Midtrans's default 24 hours, so a stale
  checkout link can't be confusingly reopened much later. (Note: per
  Midtrans's own docs this alone does not fire a webhook — it's a
  complementary hygiene fix, not the mechanism that unblocks re-booking.)
- **`PENDING_PAYMENT_MAX_AGE_MS` reduced from 24 hours to 90 minutes** —
  this is the actual fix. This timer fires regardless of what Midtrans's
  own status API says, so it's what reliably frees up the slot and clears
  the row (via the existing `cancelBooking`/`cancelPackagePurchase` path)
  so the same person can book again — checked both by the background
  reconcile sweep (every 3 minutes) and immediately whenever the person's
  own browser polls `/api/payment/status/:orderId` (e.g. from the
  payment-pending page), so in practice most people are unblocked within
  a couple of minutes of their abandoned checkout aging past 90 minutes,
  not 24 hours.
- The same `page_expiry` was added to both the class-booking checkout and
  the membership-purchase checkout, since both go through the same
  Midtrans Snap flow and both have the same identity-based unique index
  from migration 017 protecting them.

90 minutes still comfortably covers a real, slow, legitimate payment (e.g.
a bank transfer VA) while no longer leaving a genuine customer locked out
of booking for most of a day over an abandoned attempt.

## Files changed
- `server.js`
