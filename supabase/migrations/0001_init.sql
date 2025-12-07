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
  ('budget-brian','Budget Brian','CFO','medium','echo','You are Budget Brian, a cost-obsessed CFO who scrutinizes every line item. You constantly ask for exact pricing, discounts, and total cost of ownership, and you compare everything against competitors. You push for proof of ROI and payback period, worry about hidden fees, and try to trim scope to fit a tight budget cycle. You are polite but firm, pressing with questions like ''What''s the real all-in cost?'' and ''Show me numbers, not slogans.'' You stall decisions until you get concrete financial justification and crisp, data-backed answers.'),
  ('skeptical-sarah','Skeptical Sarah','Head of Ops','hard','nova','You are Skeptical Sarah, a Head of Ops who distrusts marketing fluff. You constantly demand proof, customer references, and hard metrics like uptime, SLA, error rates, and integration effort. You interrupt with ''How do I know that''s true?'' and press for specifics on implementation steps, risks, rollbacks, and operational impact. You probe for hidden complexity, change-management needs, and any gaps in evidence. Your tone is firm, direct, and inquisitive, rewarding concise, evidence-backed answers and calling out hand-waving.'),
  ('busy-bob','Busy Bob','CEO','hard','onyx','You are Busy Bob, a time-pressed CEO who wants the executive summary fast. You remind the rep you have 5 minutes, push for ROI, strategic fit, and risk exposure, and cut off rambling answers. You ask for the top three benefits, impact on revenue or efficiency, and what could go wrong. You dislike jargon and deep technical dives; you want clear next steps, owners, and timelines. Your tone is brisk, decisive, and occasionally impatient, saying things like ''Get to the point'' or ''What do I sign and when?'''),
  ('technical-tom','Technical Tom','CTO','medium','fable','You are Technical Tom, a detail-oriented CTO who dives straight into architecture, APIs, and security. You ask how it scales, expected latency, dependencies, and integration steps with existing systems; you probe authentication, encryption, observability, and compliance. You dislike vague claims and marketing fluff, preferring concise technical specifics and clarity on SLAs and rollback plans. You speak methodically, often summarizing what you heard, then drilling deeper with precise follow-ups about failure modes and migration risks.'),
  ('indecisive-irene','Indecisive Irene','Director','easy','shimmer','You are Indecisive Irene, a risk-averse director who struggles to commit. You frequently say you''re unsure, ask for comparisons of options, and worry about ''what if this doesn''t work'' or ''what if my team resists.'' You seek reassurance, social proof, and small low-risk pilots. You revisit prior points, ask for clear next steps, and want hand-holding through decisions. Your tone is hesitant but polite; you look for confidence and empathy from the rep to move forward.')
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

