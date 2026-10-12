-- ============================================================
-- SCHEMA ATUAL DO PULSE (Pulse 2.0) — INSTALAÇÃO NOVA
--
-- Use este arquivo, sozinho, em um projeto Supabase NOVO (SQL Editor,
-- uma vez). Ele já é o estado final: equivale a
-- supabase-schema.sql (v1) + migrations 001, 002, 003 e 004, SEM as
-- colunas legadas (estado, opt_out_negligencia, ultimo_toque), que o
-- app não lê nem escreve mais.
--
-- NÃO use este arquivo em um banco que já tem dados do Pulse v1: para
-- esses, siga a sequência de atualização (001 → 002 → 003 → 004) descrita
-- em PULSE_HANDOFF.md. É idempotente (pode rodar de novo sem efeito).
-- ============================================================

create table if not exists public.frentes (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nome text not null,
  area text not null check (area in ('work', 'life', 'art')),
  tipo text not null check (tipo in ('projeto', 'prática', 'domínio')),
  parent_id uuid references public.frentes(id) on delete cascade,
  ciclo_vida text not null default 'ativa' check (ciclo_vida in ('ativa', 'concluída', 'arquivada')),
  condicao text not null default 'normal' check (condicao in ('normal', 'bloqueada', 'aguardando', 'pausada')),
  cadencia_esperada integer,
  ultimo_movimento bigint,
  contexto_foco text,
  contexto_bloqueio text,
  pausa_motivo text,
  pausa_retomada_em bigint,
  criada_em bigint not null
);

create table if not exists public.registros (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  frente_id uuid not null references public.frentes(id) on delete cascade,
  data bigint not null,
  criado_em bigint not null,
  texto text not null,
  conta_como_movimento boolean not null,
  duracao_min integer
);

create table if not exists public.eventos_estruturais (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  frente_id uuid not null references public.frentes(id) on delete cascade,
  tipo text not null check (tipo in ('criação', 'ciclo_vida_mudou', 'condição_mudou', 'cadência_mudou', 'hierarquia_mudou')),
  valor_anterior text,
  valor_novo text,
  criado_em bigint not null
);

-- índices usados pelas leituras do app (por frente, por pai, por data)
create index if not exists frentes_parent_id_idx on public.frentes (parent_id);
create index if not exists registros_frente_data_idx on public.registros (frente_id, data desc);
create index if not exists eventos_estruturais_frente_idx on public.eventos_estruturais (frente_id, criado_em desc);

-- RLS: cada usuário só enxerga e mexe nas próprias linhas.
alter table public.frentes enable row level security;
alter table public.registros enable row level security;
alter table public.eventos_estruturais enable row level security;

drop policy if exists "cada usuário só vê suas próprias frentes" on public.frentes;
create policy "cada usuário só vê suas próprias frentes"
  on public.frentes for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "cada usuário só vê seus próprios registros" on public.registros;
create policy "cada usuário só vê seus próprios registros"
  on public.registros for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "cada usuário só vê seus próprios eventos" on public.eventos_estruturais;
create policy "cada usuário só vê seus próprios eventos"
  on public.eventos_estruturais for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
