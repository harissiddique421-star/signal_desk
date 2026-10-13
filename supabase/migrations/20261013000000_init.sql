-- Signal Desk — initial schema
-- Every table is user-scoped and protected by row-level security.
-- The app only ever connects with the anon key + the user's session (no service-role key).

-- gen_random_uuid() is built into Postgres 13+, no extension needed.

-- ---------------------------------------------------------------------------
-- Signal records (signal history + demo journal)
-- ---------------------------------------------------------------------------
create table if not exists public.signal_records (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at         timestamptz not null default now(),

  source             text not null check (char_length(source) between 2 and 64),
  pair               text not null check (char_length(pair) between 3 and 20),
  market_type        text not null check (market_type in ('LIVE', 'OTC')),
  analysis_kind      text not null check (analysis_kind in ('LIVE_FEED', 'SAMPLE', 'SCREENSHOT')),
  decision           text not null check (decision in ('CALL', 'PUT', 'NO_TRADE')),
  engine_decision    text not null check (engine_decision in ('CALL', 'PUT', 'NO_TRADE')),
  signal_candle_time timestamptz,
  entry_reference    numeric,
  expiry_seconds     integer not null default 60 check (expiry_seconds = 60),
  agreement_score    numeric not null check (agreement_score between -1 and 1),
  rule_version       text not null,
  evidence           jsonb not null default '[]'::jsonb,
  reasons            jsonb not null default '[]'::jsonb,
  is_demo            boolean not null default true check (is_demo = true),

  -- Observed outcome (filled in by the user for demo trades)
  outcome            text not null default 'UNRESOLVED' check (outcome in ('UNRESOLVED', 'WIN', 'LOSS', 'TIE')),
  entry_price        numeric check (entry_price is null or entry_price > 0),
  exit_price         numeric check (exit_price is null or exit_price > 0),
  payout_percent     numeric check (payout_percent is null or (payout_percent > 0 and payout_percent <= 200)),
  resolved_at        timestamptz,
  notes              text check (notes is null or char_length(notes) <= 1000),

  -- A NO_TRADE can never be marked as a win or loss
  constraint outcome_needs_trade check (decision <> 'NO_TRADE' or outcome = 'UNRESOLVED'),
  constraint resolved_consistency check ((outcome = 'UNRESOLVED') = (resolved_at is null))
);

create index if not exists signal_records_user_created_idx on public.signal_records (user_id, created_at desc);

alter table public.signal_records enable row level security;
alter table public.signal_records force row level security;

create policy "signal_records_select_own" on public.signal_records
  for select to authenticated using (user_id = auth.uid());
create policy "signal_records_insert_own" on public.signal_records
  for insert to authenticated with check (user_id = auth.uid());
create policy "signal_records_update_own" on public.signal_records
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "signal_records_delete_own" on public.signal_records
  for delete to authenticated using (user_id = auth.uid());

-- Only outcome-related columns may change after creation (signal evidence is immutable).
create or replace function public.signal_records_guard_update()
returns trigger language plpgsql as $$
begin
  if new.user_id is distinct from old.user_id
     or new.created_at is distinct from old.created_at
     or new.source is distinct from old.source
     or new.pair is distinct from old.pair
     or new.market_type is distinct from old.market_type
     or new.analysis_kind is distinct from old.analysis_kind
     or new.decision is distinct from old.decision
     or new.engine_decision is distinct from old.engine_decision
     or new.signal_candle_time is distinct from old.signal_candle_time
     or new.entry_reference is distinct from old.entry_reference
     or new.evidence is distinct from old.evidence
     or new.reasons is distinct from old.reasons
     or new.rule_version is distinct from old.rule_version then
    raise exception 'signal evidence is immutable; only outcome fields can be updated';
  end if;
  return new;
end $$;

drop trigger if exists signal_records_guard_update on public.signal_records;
create trigger signal_records_guard_update before update on public.signal_records
  for each row execute function public.signal_records_guard_update();

-- ---------------------------------------------------------------------------
-- Per-user settings
-- ---------------------------------------------------------------------------
create table if not exists public.user_settings (
  user_id         uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  payout_percent  numeric not null default 80 check (payout_percent > 0 and payout_percent <= 200),
  sound_alerts    boolean not null default false,
  rule_overrides  jsonb not null default '{}'::jsonb,
  updated_at      timestamptz not null default now()
);

alter table public.user_settings enable row level security;
alter table public.user_settings force row level security;

create policy "user_settings_select_own" on public.user_settings
  for select to authenticated using (user_id = auth.uid());
create policy "user_settings_upsert_own" on public.user_settings
  for insert to authenticated with check (user_id = auth.uid());
create policy "user_settings_update_own" on public.user_settings
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Audit log (append-only for users)
-- ---------------------------------------------------------------------------
create table if not exists public.audit_logs (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  action     text not null check (char_length(action) between 3 and 64),
  entity     text,
  entity_id  text,
  metadata   jsonb not null default '{}'::jsonb
);

create index if not exists audit_logs_user_created_idx on public.audit_logs (user_id, created_at desc);

alter table public.audit_logs enable row level security;
alter table public.audit_logs force row level security;

create policy "audit_logs_insert_own" on public.audit_logs
  for insert to authenticated with check (user_id = auth.uid());
create policy "audit_logs_select_own" on public.audit_logs
  for select to authenticated using (user_id = auth.uid());
-- No update/delete policies: users cannot alter or remove audit entries.

-- Anonymous role gets nothing.
revoke all on public.signal_records, public.user_settings, public.audit_logs from anon;
