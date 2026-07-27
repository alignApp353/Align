-- =========================================================
-- ALYGNN COMPANY WORKSPACES
-- Companies, members, access requests, invitations and PINs
-- =========================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------
-- 1. COMPANIES
-- ---------------------------------------------------------

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),

  account_number text not null unique,
  company_name text not null,
  verified_domain text,

  verification_status text not null default 'onboarding'
    check (
      verification_status in (
        'onboarding',
        'pending_review',
        'approved',
        'rejected',
        'suspended'
      )
    ),

  owner_user_id uuid not null references auth.users(id) on delete restrict,

  website text,
  business_phone text,
  industry text,
  company_size text,
  headquarters text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists companies_owner_user_id_idx
on public.companies(owner_user_id);

create index if not exists companies_account_number_idx
on public.companies(account_number);


-- ---------------------------------------------------------
-- 2. COMPANY MEMBERS
-- ---------------------------------------------------------

create table if not exists public.company_members (
  id uuid primary key default gen_random_uuid(),

  company_id uuid not null
    references public.companies(id)
    on delete cascade,

  user_id uuid not null
    references auth.users(id)
    on delete cascade,

  role text not null default 'recruiter'
    check (
      role in (
        'owner',
        'admin',
        'hiring_manager',
        'recruiter',
        'viewer'
      )
    ),

  membership_status text not null default 'active'
    check (
      membership_status in (
        'pending',
        'active',
        'suspended',
        'removed'
      )
    ),

  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique(company_id, user_id)
);

create index if not exists company_members_company_id_idx
on public.company_members(company_id);

create index if not exists company_members_user_id_idx
on public.company_members(user_id);


-- ---------------------------------------------------------
-- 3. COMPANY ACCESS REQUESTS
-- ---------------------------------------------------------

create table if not exists public.company_access_requests (
  id uuid primary key default gen_random_uuid(),

  company_id uuid not null
    references public.companies(id)
    on delete cascade,

  user_id uuid not null
    references auth.users(id)
    on delete cascade,

  business_email text not null,

  requested_role text not null default 'recruiter'
    check (
      requested_role in (
        'admin',
        'hiring_manager',
        'recruiter',
        'viewer'
      )
    ),

  status text not null default 'pending'
    check (
      status in (
        'pending',
        'approved',
        'declined',
        'cancelled'
      )
    ),

  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists company_access_requests_company_id_idx
on public.company_access_requests(company_id);

create index if not exists company_access_requests_user_id_idx
on public.company_access_requests(user_id);


-- Prevent duplicate pending requests
create unique index if not exists company_access_requests_pending_unique
on public.company_access_requests(company_id, user_id)
where status = 'pending';


-- ---------------------------------------------------------
-- 4. COMPANY INVITATIONS
-- ---------------------------------------------------------

create table if not exists public.company_invitations (
  id uuid primary key default gen_random_uuid(),

  company_id uuid not null
    references public.companies(id)
    on delete cascade,

  email text not null,

  role text not null default 'recruiter'
    check (
      role in (
        'admin',
        'hiring_manager',
        'recruiter',
        'viewer'
      )
    ),

  invitation_token_hash text not null unique,

  status text not null default 'pending'
    check (
      status in (
        'pending',
        'accepted',
        'expired',
        'revoked'
      )
    ),

  invited_by uuid not null
    references auth.users(id)
    on delete restrict,

  expires_at timestamptz not null,
  accepted_at timestamptz,

  created_at timestamptz not null default now()
);

create index if not exists company_invitations_company_id_idx
on public.company_invitations(company_id);

create index if not exists company_invitations_email_idx
on public.company_invitations(lower(email));


-- ---------------------------------------------------------
-- 5. ONE-TIME ACCESS PINS
-- ---------------------------------------------------------

create table if not exists public.company_access_pins (
  id uuid primary key default gen_random_uuid(),

  company_id uuid not null
    references public.companies(id)
    on delete cascade,

  pin_hash text not null,

  intended_email text,

  role text not null default 'recruiter'
    check (
      role in (
        'admin',
        'hiring_manager',
        'recruiter',
        'viewer'
      )
    ),

  created_by uuid not null
    references auth.users(id)
    on delete restrict,

  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,

  failed_attempts integer not null default 0,
  max_attempts integer not null default 5,

  created_at timestamptz not null default now()
);

create index if not exists company_access_pins_company_id_idx
on public.company_access_pins(company_id);

create index if not exists company_access_pins_expires_at_idx
on public.company_access_pins(expires_at);


-- ---------------------------------------------------------
-- 6. SECURITY AND ACTIVITY LOG
-- ---------------------------------------------------------

create table if not exists public.company_activity_log (
  id uuid primary key default gen_random_uuid(),

  company_id uuid not null
    references public.companies(id)
    on delete cascade,

  actor_user_id uuid
    references auth.users(id)
    on delete set null,

  action text not null,
  target_user_id uuid
    references auth.users(id)
    on delete set null,

  details jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now()
);

create index if not exists company_activity_log_company_id_idx
on public.company_activity_log(company_id);

create index if not exists company_activity_log_created_at_idx
on public.company_activity_log(created_at desc);


-- ---------------------------------------------------------
-- 7. AUTOMATIC UPDATED_AT
-- ---------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists companies_set_updated_at
on public.companies;

create trigger companies_set_updated_at
before update on public.companies
for each row
execute function public.set_updated_at();


drop trigger if exists company_members_set_updated_at
on public.company_members;

create trigger company_members_set_updated_at
before update on public.company_members
for each row
execute function public.set_updated_at();


drop trigger if exists access_requests_set_updated_at
on public.company_access_requests;

create trigger access_requests_set_updated_at
before update on public.company_access_requests
for each row
execute function public.set_updated_at();


-- ---------------------------------------------------------
-- 8. ROW-LEVEL SECURITY
-- API service role bypasses RLS.
-- Browser users only receive limited access.
-- ---------------------------------------------------------

alter table public.companies enable row level security;
alter table public.company_members enable row level security;
alter table public.company_access_requests enable row level security;
alter table public.company_invitations enable row level security;
alter table public.company_access_pins enable row level security;
alter table public.company_activity_log enable row level security;


-- Users can view companies they actively belong to
drop policy if exists "Members can view their company"
on public.companies;

create policy "Members can view their company"
on public.companies
for select
to authenticated
using (
  exists (
    select 1
    from public.company_members cm
    where cm.company_id = companies.id
      and cm.user_id = auth.uid()
      and cm.membership_status = 'active'
  )
);


-- Users can view their own membership
drop policy if exists "Users can view their memberships"
on public.company_members;

create policy "Users can view their memberships"
on public.company_members
for select
to authenticated
using (user_id = auth.uid());


-- Owners and admins can view all company members
drop policy if exists "Owners and admins can view company members"
on public.company_members;

create policy "Owners and admins can view company members"
on public.company_members
for select
to authenticated
using (
  exists (
    select 1
    from public.company_members viewer
    where viewer.company_id = company_members.company_id
      and viewer.user_id = auth.uid()
      and viewer.membership_status = 'active'
      and viewer.role in ('owner', 'admin')
  )
);


-- Users can view their own access requests
drop policy if exists "Users can view their access requests"
on public.company_access_requests;

create policy "Users can view their access requests"
on public.company_access_requests
for select
to authenticated
using (user_id = auth.uid());


-- Owners and admins can view company access requests
drop policy if exists "Owners and admins can view access requests"
on public.company_access_requests;

create policy "Owners and admins can view access requests"
on public.company_access_requests
for select
to authenticated
using (
  exists (
    select 1
    from public.company_members cm
    where cm.company_id = company_access_requests.company_id
      and cm.user_id = auth.uid()
      and cm.membership_status = 'active'
      and cm.role in ('owner', 'admin')
  )
);


-- Owners and admins can view company activity
drop policy if exists "Owners and admins can view company activity"
on public.company_activity_log;

create policy "Owners and admins can view company activity"
on public.company_activity_log
for select
to authenticated
using (
  exists (
    select 1
    from public.company_members cm
    where cm.company_id = company_activity_log.company_id
      and cm.user_id = auth.uid()
      and cm.membership_status = 'active'
      and cm.role in ('owner', 'admin')
  )
);
