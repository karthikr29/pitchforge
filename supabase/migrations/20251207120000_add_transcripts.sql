-- Create transcripts table for storing call transcripts
create extension if not exists "uuid-ossp";

create table if not exists public.transcripts (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz not null default now(),
  persona_id text,
  company_id text,
  duration_sec numeric,
  messages jsonb not null default '[]'::jsonb
);

alter table public.transcripts enable row level security;

-- Open policies (adjust later to restrict to authenticated users if desired)
do
$$
begin
  if not exists (
    select 1 from pg_policies where policyname = 'transcripts_select_all' and tablename = 'transcripts'
  ) then
    create policy transcripts_select_all on public.transcripts
      for select using (true);
  end if;

  if not exists (
    select 1 from pg_policies where policyname = 'transcripts_insert_all' and tablename = 'transcripts'
  ) then
    create policy transcripts_insert_all on public.transcripts
      for insert with check (true);
  end if;

  if not exists (
    select 1 from pg_policies where policyname = 'transcripts_delete_all' and tablename = 'transcripts'
  ) then
    create policy transcripts_delete_all on public.transcripts
      for delete using (true);
  end if;
end
$$;


