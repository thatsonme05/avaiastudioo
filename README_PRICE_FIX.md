# Booking price mismatch fix (guest checkout charged wrong amount)

## Bug
When booking a class as a guest (not logged in, no active membership package),
the modal correctly showed the class price (e.g. `IDR 100,000`), but the
Midtrans checkout sometimes charged a different amount (e.g. `IDR 85,000`).

## Root cause
`POST /api/payment/create` (the endpoint that creates the Midtrans
transaction for class bookings) took the `amount` field straight from the
request body sent by the browser and used it as-is for
`transaction_details.gross_amount` — it never checked it against the actual
price stored on the class in the database.

This is different from `POST /api/membership-purchase/create` (package
purchases), which has always done this correctly: it re-fetches `pkg.price`
from the `memberships` table and ignores whatever the client sends.

Because logged-in members with an active package skip Midtrans entirely
(they pay with a package credit), only guests / non-package checkouts ever
hit the untrusted code path — which is why the symptom only showed up when
not logged in. Any staleness in the browser (the schedule page auto-refreshes
every 8 seconds, cached tabs, etc.) — or outright tampering, since this was
also a price-tampering vulnerability — could make the amount actually sent
to Midtrans differ from the price the page displayed.

## Fix
In `/api/payment/create`, the server now re-reads the class price from the
`schedule -> classes(price)` relation for the exact `schedule_id` being
booked, and uses **that** verified price for the pending booking record,
`gross_amount`, and `item_details`. The `amount` sent by the client is only
used for the initial "is data present" check — it can no longer influence
how much Midtrans actually charges. If a class has no valid price configured,
booking now fails with a clear error instead of silently charging a
default/fallback amount.

## Deployment
No database migration needed — this is a server.js-only change.

1. Replace `server.js` in your Node.js app directory with the one in this
   fix (or apply the diff to `/api/payment/create`).
2. Restart/redeploy the Node.js application.
3. Test as a guest (logged out): book a class with Midtrans configured, and
   confirm the amount shown in the Midtrans Snap popup matches the class
   price shown in the booking modal.
