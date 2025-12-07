-- Enable pgvector for embeddings
create extension if not exists vector;

-- Companies with minutes and subscription flags
create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text,
  subscription_type text default 'trial',
  minutes_balance integer default 30,
  custom_scripts_allowed boolean default false,
  created_at timestamptz default now()
);

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies (id) on delete cascade,
  role text default 'member',
  created_at timestamptz default now()
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies (id) on delete cascade,
  user_id uuid references public.users (id) on delete set null,
  started_at timestamptz default now(),
  ended_at timestamptz,
  total_seconds integer,
  feedback_json jsonb
);

create table if not exists public.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations (id) on delete cascade,
  role text check (role in ('user','ai','system')),
  content text,
  created_at timestamptz default now(),
  sequence integer generated always as identity
);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies (id) on delete cascade,
  title text not null,
  source_path text,
  status text default 'uploaded',
  created_at timestamptz default now()
);

create table if not exists public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.documents (id) on delete cascade,
  company_id uuid references public.companies (id) on delete cascade,
  chunk_index integer,
  content text,
  embedding vector(1536)
);

create index if not exists document_chunks_embedding_idx on public.document_chunks using ivfflat (embedding vector_cosine_ops);
create index if not exists document_chunks_company_idx on public.document_chunks(company_id);

create table if not exists public.usage_ledger (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete cascade,
  seconds_used integer not null,
  billed_at timestamptz default now()
);

-- Seed personas table for server reference
create table if not exists public.personas (
  id text primary key,
  name text not null,
  role text not null,
  difficulty text not null,
  voice text not null,
  prompt text not null
);

insert into public.personas (id, name, role, difficulty, voice, prompt)
values
  ('budget-brian','Budget Brian','CFO','medium','echo','You are a price-sensitive customer. You are interested but constantly bring up competitors'' lower prices. Be polite but firm about budget.'),
  ('skeptical-sarah','Skeptical Sarah','Head of Ops','hard','nova','You doubt marketing claims. You ask for proof, case studies, and data. You interrupt frequently with ''How do I know that''s true?'''),
  ('busy-bob','Busy Bob','CEO','hard','onyx','You are time-pressed. You frequently say ''Get to the point'' and ''I only have 5 minutes.'' You value ROI.'),
  ('technical-tom','Technical Tom','CTO','medium','fable','You ask specific feature questions. You want to understand integrations and specs. You are methodical.'),
  ('indecisive-irene','Indecisive Irene','Director','easy','shimmer','You struggle to make decisions. You say ''I''m not sure'' and ''What if it doesn''t work?'' You need reassurance.')
on conflict (id) do update 
  set 
    name = excluded.name,
    role = excluded.role,
    difficulty = excluded.difficulty,
    voice = excluded.voice,
    prompt = excluded.prompt;

-- RPC: decrement minutes atomically
create or replace function decrement_minutes(p_company_id uuid, p_minutes integer)
returns companies
language plpgsql
as $$
declare
  updated_row companies;
begin
  update companies
  set minutes_balance = greatest(minutes_balance - p_minutes, 0)
  where id = p_company_id
  returning * into updated_row;
  return updated_row;
end;
$$;

-- RPC: match_documents for RAG
create or replace function match_documents(
  query_embedding vector(1536),
  company_id uuid,
  match_count int default 4
) returns table(id uuid, content text, similarity float)
language plpgsql
as $$
begin
  return query
  select dc.id, dc.content, 1 - (dc.embedding <=> query_embedding) as similarity
  from document_chunks dc
  where dc.company_id = company_id
  order by dc.embedding <=> query_embedding
  limit match_count;
end;
$$;

