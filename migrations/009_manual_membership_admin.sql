-- Add metadata needed for memberships entered manually by admin.
ALTER TABLE public.member_packages
  ADD COLUMN IF NOT EXISTS package_id uuid REFERENCES public.memberships(id) ON DELETE SET NULL;

ALTER TABLE public.member_packages
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'online';

CREATE INDEX IF NOT EXISTS member_packages_member_id_idx ON public.member_packages(member_id);
CREATE INDEX IF NOT EXISTS member_packages_package_id_idx ON public.member_packages(package_id);
CREATE INDEX IF NOT EXISTS member_packages_source_idx ON public.member_packages(source);
