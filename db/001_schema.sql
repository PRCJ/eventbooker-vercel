-- EventBooker schema.
--
-- Correctness notes that the table shapes themselves enforce:
--   * seats has PRIMARY KEY (show_id, label) -- exactly one row per physical seat,
--     so "two copies of A12" is unrepresentable, not merely unlikely.
--   * reservations has UNIQUE (user_id, idempotency_key) -- one key, one reservation.
--   * payments has UNIQUE (reservation_id) -- one reservation, one capture.

create extension if not exists pgcrypto;

create table if not exists shows (
  id               uuid primary key default gen_random_uuid(),
  name             text        not null,
  price_paise      bigint      not null check (price_paise >= 0),
  per_user_limit   int         not null default 4 check (per_user_limit > 0),
  -- 0 => reserve confirms immediately. >0 => reserve creates a time-boxed hold.
  hold_ttl_seconds int         not null default 0 check (hold_ttl_seconds >= 0),
  total_seats      int         not null check (total_seats > 0),
  created_at       timestamptz not null default now()
);

do $$ begin
  create type seat_status as enum ('available', 'held', 'confirmed');
exception when duplicate_object then null; end $$;

create table if not exists reservations (
  id                  uuid primary key default gen_random_uuid(),
  show_id             uuid        not null references shows(id) on delete cascade,
  user_id             text        not null,
  -- 'declined' rows are kept on purpose: an idempotency key that lost a race must
  -- keep losing on replay, otherwise "same key, same outcome" is a lie.
  status              text        not null check (status in ('held','confirmed','cancelled','expired','declined')),
  decline_reason      text,
  seats               text[]      not null,
  amount_paise        bigint      not null default 0,
  idempotency_key     text        not null,
  request_fingerprint text        not null,
  replay_count        int         not null default 0,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz
);

create unique index if not exists reservations_idem_uniq
  on reservations (user_id, idempotency_key);

create index if not exists reservations_show_user_active
  on reservations (show_id, user_id) where status in ('held','confirmed');

create table if not exists seats (
  show_id        uuid        not null references shows(id) on delete cascade,
  label          text        not null,
  status         seat_status not null default 'available',
  -- Both denormalised from reservations so the hot path never has to join.
  reservation_id uuid,
  holder_user_id text,
  held_until     timestamptz,
  updated_at     timestamptz not null default now(),
  primary key (show_id, label),
  -- A seat is either free and unowned, or taken and owned. No in-between.
  constraint seats_ownership_coherent check (
    (status = 'available' and reservation_id is null and holder_user_id is null and held_until is null)
    or (status = 'held'      and reservation_id is not null and holder_user_id is not null and held_until is not null)
    or (status = 'confirmed' and reservation_id is not null and holder_user_id is not null and held_until is null)
  )
);

create index if not exists seats_show_holder on seats (show_id, holder_user_id)
  where holder_user_id is not null;
create index if not exists seats_show_status on seats (show_id, status);
create index if not exists seats_expiring on seats (held_until) where status = 'held';

create table if not exists payments (
  id             uuid primary key default gen_random_uuid(),
  reservation_id uuid        not null unique references reservations(id) on delete cascade,
  user_id        text        not null,
  amount_paise   bigint      not null,
  status         text        not null check (status in ('captured','refunded')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- A held seat whose clock ran out is available to everyone else, even if the
-- sweeper has not physically rewritten the row yet. Every read path and the
-- reserve path agree on this one definition.
create or replace function seat_is_free(p_status seat_status, p_held_until timestamptz)
returns boolean language sql stable parallel safe as $$
  select p_status = 'available'
      or (p_status = 'held' and p_held_until is not null and p_held_until <= now());
$$;

create or replace function seat_effective_status(p_status seat_status, p_held_until timestamptz)
returns seat_status language sql stable parallel safe as $$
  select case when seat_is_free(p_status, p_held_until) then 'available'::seat_status else p_status end;
$$;
