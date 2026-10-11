-- ============================================================
-- MIGRATION 002 — BLOCO 2 (MEMÓRIA), ETAPA ADITIVA
-- Só adiciona. Não remove nada. A migration de remoção dos
-- campos antigos (estado, opt_out_negligencia, ultimo_toque) 
-- continua pendente, à parte, após a validação combinada
-- anteriormente — este arquivo não mexe nisso.
-- ============================================================

-- Registro ganha criado_em (quando foi inserido no sistema),
-- distinto de data (quando o fato aconteceu — já existia e
-- continua sendo o campo usado em sinal/histórico/retrospectiva).
alter table public.registros
  add column criado_em bigint;

-- Para registros já existentes, não há como saber retroativamente
-- quando cada um foi de fato inserido — a única data confiável que
-- temos é `data` em si. Popula criado_em = data para o histórico
-- existente (assume que nenhum registro existente era retroativo,
-- o que é verdade: a UI nunca permitiu isso antes do Bloco 2).
update public.registros
set criado_em = data
where criado_em is null;

alter table public.registros
  alter column criado_em set not null;
