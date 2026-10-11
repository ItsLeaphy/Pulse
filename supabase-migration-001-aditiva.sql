-- ============================================================
-- MIGRATION 001 — PULSE 2.0, ETAPA ADITIVA
-- Não remove nenhuma coluna existente. Objetivo: criar as
-- colunas/tabela novas, popular a partir dos dados antigos,
-- e deixar o sistema em condição de rodar os dois modelos lado
-- a lado até a validação (ver passo 6 do plano).
-- ============================================================

-- ---- 1. novas colunas em frentes (nullable/default pra não quebrar linhas existentes) ----

alter table public.frentes
  add column ciclo_vida text check (ciclo_vida in ('ativa', 'concluída', 'arquivada')),
  add column condicao text check (condicao in ('normal', 'bloqueada', 'aguardando', 'pausada')),
  add column contexto_foco text,
  add column contexto_bloqueio text,
  add column pausa_motivo text,
  add column pausa_retomada_em bigint;

-- cadencia_esperada precisa virar nullable (hoje é "not null") —
-- domínio no modelo novo pode não ter cadência própria.
alter table public.frentes
  alter column cadencia_esperada drop not null;

-- ---- 2. popular ciclo_vida e condicao a partir do estado antigo ----
-- Regra combinada:
--   'ativa'                -> ciclo_vida='ativa',      condicao=normal (ou pausada se opt_out_negligencia=true)
--   'pausada_por_decisão'  -> ciclo_vida='ativa',      condicao='pausada'
--   'arquivada'            -> ciclo_vida='arquivada',  condicao=normal (não há condição operacional relevante p/ frente arquivada)

update public.frentes
set ciclo_vida = case
    when estado = 'arquivada' then 'arquivada'
    else 'ativa'
  end,
  condicao = case
    when estado = 'pausada_por_decisão' then 'pausada'
    when estado = 'ativa' and opt_out_negligencia = true then 'pausada'
    else 'normal'
  end
where ciclo_vida is null;  -- idempotente: roda de novo sem duplicar efeito

-- ---- 3. tabela de eventos estruturais ----

create table public.eventos_estruturais (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  frente_id uuid not null references public.frentes(id) on delete cascade,
  tipo text not null check (tipo in ('criação', 'ciclo_vida_mudou', 'condição_mudou', 'cadência_mudou')),
  valor_anterior text,
  valor_novo text,
  criado_em bigint not null
);

alter table public.eventos_estruturais enable row level security;

create policy "cada usuário só vê seus próprios eventos"
  on public.eventos_estruturais for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---- 4. eventos sintéticos de criação para frentes existentes ----
-- Só "criação", usando criada_em (confiável). Nada de condição/ciclo
-- de vida inventado para o passado. Idempotente via not exists.

insert into public.eventos_estruturais (id, user_id, frente_id, tipo, valor_anterior, valor_novo, criado_em)
select gen_random_uuid(), f.user_id, f.id, 'criação', null, null, f.criada_em
from public.frentes f
where not exists (
  select 1 from public.eventos_estruturais e
  where e.frente_id = f.id and e.tipo = 'criação'
);

-- ============================================================
-- NÃO EXECUTADO NESTA MIGRATION (fica para a migration 002,
-- só depois da validação do relatório de conversão):
--   - drop column estado
--   - drop column opt_out_negligencia
--   - tornar ciclo_vida / condicao not null
-- ============================================================
