# Bugfix: booking price becomes 0 / "slots left" shows a huge number

## Root cause (the exact bug reported)

`public/pages/home.html` (the "Today's Classes" widget on the homepage)
called:

```js
openBooking('id','className','dateStr','time','instructor',slots,price)   // 7 args
```

but `openBooking` in `public/js/core.js` is defined as:

```js
function openBooking(schedId, name, dayName, preferredDateStr, time, instructor, slots, price)  // 8 params
```

The `dayName` argument was missing from the home.html call, so every
argument after it shifted one position to the left:

- the real `price` (e.g. `100000`) landed in the `slots` parameter →
  displayed as "**100000** spots left" in the booking modal
- nothing was left for the final `price` parameter → it fell back to
  `price||0` → displayed as **IDR 0**, and the booking request was then
  rejected server-side with "Incomplete data" because `amount` was `0`.

`public/pages/schedule.html` already passed all 8 arguments correctly —
that's why the bug only ever showed up when booking from the homepage.

### Fix
`home.html` now passes `todayName` as the `dayName` argument, matching
`schedule.html`. Also added the missing `data-sid`/`data-n` attributes to
the homepage's slots label so the optimistic slot-count UI update
(`updateSlotEl`) works there too, consistent with the schedule page.

## Secondary bugs found and fixed (slot-count integrity)

These don't need the exact same trigger as above, but could also make a
class's "slots left" drift over time, so they're fixed as part of the same
pass:

1. **`cancelBooking()`** (used by the Midtrans webhook, the customer-facing
   payment-status polling, and the automatic background reconcile sweep) —
   two of these could fire for the same order within moments of each other.
   Previously the "release this slot" step was a plain
   check-then-act, so both callers could pass the check and both release the
   same slot, adding one extra slot each time it happened. Fixed with an
   atomic compare-and-swap update (`.eq('slot_released', false)`), so only
   one caller's release can ever succeed.
2. **`DELETE /api/my-bookings/:id`** (a member cancelling their own booking)
   — a fast double-click or a duplicate request could race the same way,
   releasing the slot twice and refunding a package credit twice. Fixed by
   making the cancellation an atomic `UPDATE ... WHERE status <> 'cancelled'`
   claim; only the request that actually flips the status runs the
   slot-release / credit-refund side effects.
3. **`DELETE /api/bookings/:id`** (admin hard-deleting a booking) — this
   never released the class slot at all, even for a still-active
   (`confirmed`) booking, permanently shrinking that session's capacity.
   Now it releases the slot (and refunds a package credit, if that's how it
   was paid) when the deleted booking was still `confirmed`.

## Security item found and flagged

`JWT_SECRET` silently falls back to a hardcoded, publicly-known string
(`avaia-dev-secret-CHANGE-IN-PRODUCTION`) if the `JWT_SECRET` environment
variable isn't set. If this ships to production unset, anyone can forge a
valid admin/staff/member login token. The server now prints a loud warning
at startup when this happens. **Action required before launch:** set a
long random `JWT_SECRET` in your production `.env` (e.g.
`openssl rand -hex 32`).

## Round 2: membership/credit display bugs

### Bug: admin's Members table shows the wrong (old, exhausted) package

`public/js/admin.js` → `loadAMb()`. When picking which package to show for
a member, the code merged **active** and **depleted** packages into one
list and picked whichever one *expired soonest* — with no preference for
one that still has real credits. So a member with an old, already
fully-used package (say "5 Classes", 0 left) that happens to expire before
a brand-new package they just bought (say "10 Classes", full credits, later
expiry) would have the table show the *old, exhausted* package — hiding the
real active one, showing the wrong credit count, and disabling the "－"
deduct-credit button for someone who actually still has plenty of credits.

**Fix:** an active package (soonest-expiring among actives) is now always
preferred; the table only falls back to showing a depleted package when
there is no active one at all — which is what the "＋ restore credit"
button needs to stay usable right after the very last credit is used.

### Bug: "Membership Type" badge gets stuck on an old package name

`members.membership_type` in the database is written once, at purchase
time, to whatever package was just bought (e.g. "Single Class") — and
**nothing ever resets it** when that package later expires or its credits
run out. So both the admin's Members table and a member's own Dashboard
could go on displaying "Single Class" (or any other old package name)
indefinitely after it stopped being true, which is confusing/misleading —
it can look like the membership is still valid when it no longer is.

Note: this label was purely cosmetic — the actual booking flow always
independently re-checks real package validity (status, expiry, remaining
credits) on the server before allowing a credit-based booking, so an
expired/depleted package could never actually be used to book for free.
But a misleading badge is still worth fixing before launch.

**Fix:** both places now compute this label live, from whichever package is
currently genuinely active, instead of trusting the stored column — so it
automatically flips to "Drop-in" the moment nothing active is left, with
nothing to fall out of sync.
- `public/js/admin.js` (Members table)
- `public/pages/dashboard.html` (member's own "Membership Type" stat)

### Bug: only one package per member was ever shown/editable — real root cause

This is the actual root cause behind the "10 Classes vs 5 Classes" confusion,
found after digging further: the admin Members table didn't just *pick the
wrong* package sometimes (round 2's first fix) — it only ever showed **one**
package per member at all, full stop. A member can genuinely have **more
than one active package at the same time** (e.g. an older "5 Classes" pack
they haven't finished yet, plus a brand-new "10 Classes" pack bought before
the first ran out — both real, both active, neither expired or depleted).

With only one row surfaced (whichever expires soonest), the *other* package
was completely invisible and **impossible to edit from this table** — no
matter how many times the visible one was edited, it's a different database
row, so the real "10 Classes" package was simply never being touched. This
is exactly what caused: `membership_type` (which shows the most-recently
purchased package) saying "10 Classes", while the only editable row
available was still the older "5 Classes" one, and editing it could never
make "10 Classes" appear because that edit was landing on the wrong record
entirely.

**Fix (structural, not another heuristic):** `public/js/admin.js` now lists
**every** active/depleted package for a member, each as its own line with
its own working Edit/Deduct/Restore buttons tied to *its own* database id.
Nothing is picked-and-hidden anymore, so this entire class of "wrong package
shown/edited" bug cannot recur. The "Membership Type" badge also now lists
every currently-active package name (joined with " + ") instead of just one,
so it can never disagree with what's shown below it.

**Note:** if you already ran the "Round 2" fix from this package and are
re-deploying, this replaces that fix — the earlier active-vs-depleted
priority fix is still in there (each package still needs to know whether
it's active or depleted, now shown as a "(depleted)" tag per line rather
than by hiding one), but the real fix is no longer picking just one row.

## Round 3: CRITICAL — duplicate membership packages

### Bug: one purchase could create many duplicate `member_packages` rows

Found from real production data: some members had a shocking number of
active packages at once — one member had **23** active "5 Classes"/"Single
Class" packages, another had **4** identical "10 Classes" packages with the
same expiry date. This is not something anyone actually purchased 23 times —
it's a bug.

`confirmPackagePurchase()` (called by the Midtrans webhook, the customer's
own browser polling `/api/payment/status`, and the background auto-reconcile
sweep — all of which can fire for the *same* orderId within moments of each
other) checked for an existing row by `payment_order_id`, and if none was
found yet, inserted a new package row with a **random** `uuidv4()` id. If two
or more of those triggers overlapped before the first one's insert landed,
every one of them would see "no existing row yet" and every one of them
would successfully insert its own separate row — each a full, real package
with its own `credits_total`/`credits_used` — because a random id can never
collide with another random id. A `payment_order_id` unique index exists in
`migrations/008_payment_flow_hardening.sql`, but the data shows it either
was never applied to this database or isn't preventing this in practice.

As bookings got redeemed afterward, credits were consumed from whichever
duplicate happened to be "soonest to expire" at that moment (by design, so
credits don't go to waste) — which is exactly why the duplicates in the data
show scattered, inconsistent `credits_used` values instead of all being
identical.

**Fix:** `member_packages.id` is now derived **deterministically** from the
orderId (`uuidv5(orderId, fixed-namespace)`) instead of being random. The
exact same orderId always produces the exact same id, so every overlapping
confirmation attempt for one order tries to insert the *same primary key* —
only the first can ever succeed; every other one fails immediately on the
primary key itself (not a secondary index, which is what makes this
airtight) and correctly falls through to the existing "return the winning
row instead" recovery path. This is the same technique that already
protects the `bookings` table (`id = orderId` there), applied here too.

**This only prevents new duplicates going forward.** The duplicate rows
already sitting in the database for members like the one above need a
one-time manual cleanup — merge each member's real total used credits into
one retained package per real purchase, and remove/cancel the rest. This is
data surgery, not something a code deploy can safely do automatically, and
needs a short investigation per affected member first (to tell apart a
genuine bug-duplicate from a member who legitimately bought more than one
package) before writing the correction.

## Round 4: the actual root cause, found from real data — double-submit on "Add Manual Membership"

Investigating the worst case (23 active packages for one member) turned up
the *real* mechanism: almost all of the duplicates had `source =
'admin_manual'` with `payment_order_id = null` — meaning they were created
through the admin panel's **"Add Manual Membership"** form (for memberships
sold in person, no online payment involved), not through the online
payment/webhook path Round 3 hardened.

That form's "Activate Membership" button had **no double-submit
protection** at all, client- or server-side. A manual sale has no orderId to
de-duplicate by the way an online payment does, so a slow connection, an
accidental double-click, or a staff member clicking again because they
didn't see immediate feedback could — and, from the data, did — fire the
exact same submission over and over, each one creating a brand new, fully
real, independently-spendable package row.

**This is a more serious bug than a display glitch:** because each
duplicate row is a real row the booking system can independently redeem
credits from, a member with e.g. 16 duplicate "5 Classes" packages could
book far more real classes for free than the one package they actually paid
for — in the data, one such cluster already shows 20 credits consumed
across duplicates of what should have been a single 5-credit package.
Whether to treat that gap as a system error to absorb or something to
reconcile with the member is a business decision for the studio, not
something this fix decides — but you should know about it.

**Fix:**
- `public/pages/admin.html` / `public/js/admin.js` — the "Activate
  Membership" button now disables itself for the duration of the request
  (and `saveManualPkg()` bails out immediately if a save is already in
  flight), so a double-click or a slow-network re-click can no longer fire
  two submissions.
- `server.js` (`POST /api/member-packages/manual`) — as defense in depth,
  before inserting it now checks for an existing row with the exact same
  member, package, credits, price and dates; if one already exists, it
  reuses that record instead of creating another, so even a stray retry
  (a second tab, a resent request) can't create a duplicate either.

**Cleaning up the existing duplicates** (already in the database from before
this fix) still needs to be done once, by hand, in SQL — see the
conversation this package came from for the exact audit/cleanup queries
used, since it involves judgment calls (e.g. capping consolidated credit
usage at the package's real total) that shouldn't be run blindly.

## Files changed
- `public/pages/home.html`
- `public/pages/dashboard.html`
- `public/pages/admin.html`
- `public/js/admin.js`
- `server.js`

## Deployment
No database migration needed.
1. Replace `public/pages/home.html` and `server.js` with the versions in
   this package (or apply this diff to your existing files).
2. Make sure `JWT_SECRET` is set to a long random value in your production
   `.env` — check your startup logs for the security warning to confirm.
3. Restart/redeploy.
4. Test: from the **homepage** ("Today's Classes" widget), book a class as
   both a guest and a logged-in member — confirm the price shown matches
   the class price and the "spots left" text shows a sane number, and that
   the booking completes successfully (not "Incomplete data").
5. Also test cancelling a booking (as a member) and, separately, deleting a
   confirmed booking from Admin → Bookings — confirm the class's "slots
   left" count on the Schedule page goes up by exactly 1 each time.
