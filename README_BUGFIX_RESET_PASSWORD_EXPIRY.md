# Investigating: fresh password-reset link immediately shows "expired"

## What was checked
The forgot-password/reset-password code in `server.js` was reviewed line by
line (token generation, storage, hashing, comparison) and the frontend
`reset-password.html`'s token handling. In isolation, the logic is correct:
a token is generated, `reset_token_expires` is set to now+60 minutes, and
the reset endpoint rejects it only if that stored timestamp is in the past.
No duplicate/conflicting route, no other code path writes to
`reset_token_expires`, and common Postgres/PostgREST timestamp-format edge
cases were tested directly in Node and parse correctly.

Because a real (not simulated) instance of this bug couldn't be reproduced
here, this change takes two tracks instead of guessing at a fix:

## 1. Hardening (shipped now)
- The expiry comparison now uses explicit epoch-millisecond math
  (`new Date(...).getTime()`) instead of comparing `Date` objects directly,
  and explicitly treats an unparseable `reset_token_expires` as invalid
  rather than however `NaN < NaN`-style comparisons happen to fall out.
- `forgot-password` now logs the exact expiry timestamp it computed
  side-by-side with what Supabase reports back immediately after saving it.
- `reset-password` now logs full detail (raw stored value, parsed epoch,
  server's own epoch, how many ms overdue) any time it rejects a token as
  expired or unparseable.

If the bug recurs after deploying this, the server log will show exactly
where the two clocks/values diverge — search for `reset-password expiry
check:` and `forgot-password: reset_token_expires computed`.

## 2. Diagnostic query (run this now)
This checks the *database's own* clock against the stored expiry directly —
useful right now if the affected member's row still has `reset_token_hash`
set (it only clears on a successful reset, so a failed "expired" attempt
should still be sitting there to inspect):

```sql
select id, email, reset_token_expires, now() as db_now,
       reset_token_expires > now() as should_still_be_valid,
       round(extract(epoch from (reset_token_expires - now()))/60) as minutes_remaining
from members
where reset_token_hash is not null
order by reset_token_expires desc;
```

- If `should_still_be_valid` is `true` here but the member got "expired" a
  few minutes ago → the bug is a clock mismatch between the app server and
  the database, and the new logging will pin down the exact gap on the next
  attempt.
- If it's `false` and clearly already in the past → the token really is
  expired by the time it's checked, which points at something upstream
  (e.g. the app server's own system clock running fast) rather than this
  comparison logic — again, the new logs will show the app server's own
  "now" value to compare directly against `db_now` above.

## Files changed
- `server.js`
