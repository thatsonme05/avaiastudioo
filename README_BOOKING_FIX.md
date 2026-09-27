# Booking / Membership Booking Fix

## Root cause

The live database can still have `bookings.id` and/or `pending_bookings.id` as UUID columns from an older schema. The application was generating readable Midtrans order IDs such as `AVAIA-...`, which PostgreSQL rejects when compared against a UUID column. This is why members with an active package could see:

`invalid input syntax for type uuid: "AVAIA-..."`

## Fix included in this release

1. Booking order IDs are now generated as UUIDs, which are valid for both UUID and text ID columns.
2. `migrations/013_booking_id_compatibility.sql` converts legacy UUID ID columns to text so the production schema matches the application design and remains compatible with Midtrans/imported booking IDs.

## Required Supabase migration

Run `migrations/013_booking_id_compatibility.sql` in Supabase SQL Editor.

After deployment, test: `login -> active membership -> choose class -> booking`. The booking should be confirmed using one package credit without opening Midtrans.
