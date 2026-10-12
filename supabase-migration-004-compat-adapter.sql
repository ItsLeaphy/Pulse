-- ============================================================
-- MIGRATION 004 — COMPATIBILIDADE DO BANCO COM O ADAPTER ATUAL
-- (Fase A · estabilização). ADITIVA / NÃO DESTRUTIVA: não remove
-- coluna, não apaga dado.
--
-- PROBLEMA: no schema v1, frentes.estado e frentes.ultimo_toque são
-- NOT NULL sem default. O adapter atual (storage-supabase.ts) não
-- escreve mais essas colunas; o Postgres checa NOT NULL na linha
-- proposta ANTES de resolver o conflito do upsert, então TODO
-- salvarFrente (criar ou editar) falha com o erro 23502
-- ("null value in column ... violates not-null constraint").
-- As migrations 001–003 não corrigem isso (001 só relaxou
-- cadencia_esperada).
--
-- O QUE FAZ:
--   1. verifica que 001, 002 e 003 já foram aplicadas (senão para,
--      com mensagem clara);
--   2. relaxa NOT NULL das colunas legadas que o app não escreve;
--   3. dá defaults a ciclo_vida/condicao (backfill já foi feito em 001);
--   4. cria índices de leitura (se não existirem).
--
-- COMO APLICAR: SQL Editor do Supabase, uma vez, DEPOIS de 001, 002
-- e 003. Pode rodar de novo (idempotente).
-- A remoção definitiva das colunas legadas continua PENDENTE, em
-- migration futura, só após a validação do relatório de conversão
-- (estado/opt_out_negligencia → ciclo_vida/condicao).
-- ============================================================

do $$
begin
  if to_regclass('public.eventos_estruturais') is null then
    raise exception 'Aplique a migration 001 antes da 004 (tabela eventos_estruturais ausente).';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'registros' and column_name = 'criado_em'
  ) then
    raise exception 'Aplique a migration 002 antes da 004 (registros.criado_em ausente).';
  end if;
  if not exists (
    select 1 from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    where rel.relname = 'eventos_estruturais' and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%hierarquia_mudou%'
  ) then
    raise exception 'Aplique a migration 003 antes da 004 (tipo hierarquia_mudou ausente).';
  end if;
end $$;

alter table public.frentes alter column estado drop not null;
alter table public.frentes alter column ultimo_toque drop not null;
alter table public.frentes alter column opt_out_negligencia drop not null;

alter table public.frentes alter column ciclo_vida set default 'ativa';
alter table public.frentes alter column condicao set default 'normal';

create index if not exists frentes_parent_id_idx on public.frentes (parent_id);
create index if not exists registros_frente_data_idx on public.registros (frente_id, data desc);
create index if not exists eventos_estruturais_frente_idx on public.eventos_estruturais (frente_id, criado_em desc);

-- Verificação (opcional) — deve listar estado, ultimo_toque e
-- opt_out_negligencia com is_nullable = 'YES':
--   select column_name, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'frentes'
--   order by ordinal_position;
