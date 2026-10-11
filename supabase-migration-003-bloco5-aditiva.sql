-- ============================================================
-- MIGRATION 003 — BLOCO 5 (ESTRUTURA/PORTABILIDADE), ETAPA ADITIVA
-- Só adiciona. Não remove nada. Os campos legados pendentes
-- (estado, opt_out_negligencia, ultimo_toque) continuam
-- intocados — não são removidos aqui, como já decidido
-- anteriormente (aguardam validação do relatório de conversão).
-- ============================================================

-- eventos_estruturais.tipo ganha 'hierarquia_mudou' como valor
-- válido (reparenting do Bloco 5). O constraint de check tem nome
-- auto-gerado pelo Postgres quando criado inline (como na migration
-- 001); descobrimos e recriamos pelo padrão information_schema para
-- não depender de adivinhar o nome exato.
do $$
declare
  nome_constraint text;
begin
  select con.conname into nome_constraint
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  where rel.relname = 'eventos_estruturais'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) like '%tipo%';

  if nome_constraint is not null then
    execute format('alter table public.eventos_estruturais drop constraint %I', nome_constraint);
  end if;
end $$;

alter table public.eventos_estruturais
  add constraint eventos_estruturais_tipo_check
  check (tipo in ('criação', 'ciclo_vida_mudou', 'condição_mudou', 'cadência_mudou', 'hierarquia_mudou'));
