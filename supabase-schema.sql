-- ============================================================
-- SCHEMA DO PULSE
-- Rode isso inteiro no SQL Editor do painel do Supabase, uma
-- vez, logo depois de criar o projeto.
-- ============================================================

create table public.frentes (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nome text not null,
  area text not null check (area in ('work', 'life', 'art')),
  tipo text not null check (tipo in ('projeto', 'prática', 'domínio')),
  parent_id uuid references public.frentes(id) on delete cascade,
  estado text not null check (estado in ('ativa', 'pausada_por_decisão', 'arquivada')),
  cadencia_esperada integer not null,
  ultimo_toque bigint not null,
  ultimo_movimento bigint,
  opt_out_negligencia boolean not null default false,
  criada_em bigint not null
);

create table public.registros (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  frente_id uuid not null references public.frentes(id) on delete cascade,
  data bigint not null,
  texto text not null,
  conta_como_movimento boolean not null,
  duracao_min integer
);

-- RLS: cada usuário só enxerga e mexe nas próprias linhas.
-- Isso é o que torna seguro usar a chave "anon" (pública) no
-- app, mesmo com o repositório aberto no GitHub.
alter table public.frentes enable row level security;
alter table public.registros enable row level security;

create policy "cada usuário só vê suas próprias frentes"
  on public.frentes for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "cada usuário só vê seus próprios registros"
  on public.registros for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
