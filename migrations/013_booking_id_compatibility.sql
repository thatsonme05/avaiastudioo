-- Avaia Studio — booking ID compatibility hardening
--
-- The application uses payment order IDs as the primary key of bookings.
-- Some older production databases still have bookings.id and/or
-- pending_bookings.id as uuid columns, while the application schema expects text.
-- Convert UUID columns to text without touching existing IDs.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'bookings'
      AND column_name = 'id'
      AND data_type = 'uuid'
  ) THEN
    ALTER TABLE public.bookings
      ALTER COLUMN id TYPE text
      USING id::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pending_bookings'
      AND column_name = 'id'
      AND data_type = 'uuid'
  ) THEN
    ALTER TABLE public.pending_bookings
      ALTER COLUMN id TYPE text
      USING id::text;
  END IF;
END $$;

COMMENT ON COLUMN public.bookings.id IS
  'Payment/booking order ID. Text for Midtrans and imported booking compatibility.';

COMMENT ON COLUMN public.pending_bookings.id IS
  'Pending payment order ID. Text for Midtrans compatibility.';
