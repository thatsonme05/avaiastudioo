-- Run this once in Supabase → SQL Editor.
-- Creates a public storage bucket for uploaded images (hero slideshow
-- photos, About Us photo) so they persist permanently instead of living
-- on Hostinger's local disk, which gets wiped on every redeploy.

insert into storage.buckets (id, name, public)
values ('uploads', 'uploads', true)
on conflict (id) do nothing;
