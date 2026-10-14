-- Record whether a journal outcome came from broker-observed prices or feed estimates.
-- Existing rows remain UNVERIFIED so historical estimates are never mislabeled as broker results.
alter table public.signal_records
  add column if not exists entry_delay_seconds integer
    check (entry_delay_seconds is null or entry_delay_seconds between 0 and 3600),
  add column if not exists result_source text not null default 'UNVERIFIED'
    check (result_source in ('UNVERIFIED', 'BROKER_MANUAL', 'FEED_ESTIMATE'));

comment on column public.signal_records.entry_delay_seconds is
  'User-recorded seconds between signal availability and actual manual entry; null if not measured.';
comment on column public.signal_records.result_source is
  'BROKER_MANUAL only when outcome/prices were observed from the broker; FEED_ESTIMATE is not broker settlement.';
