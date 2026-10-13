-- ============================================================
-- MIGRATION 005 — OPERAÇÕES ATÔMICAS (funções RPC transacionais)
--
-- ADITIVA: cria 4 funções e as permissões de execução. Não altera
-- tabelas, não altera policies, não remove nada, não toca em dados.
-- Idempotente (create or replace + grants repetíveis).
--
-- ORDEM DE APLICAÇÃO: rode ESTA migration ANTES de publicar a versão do
-- app que a usa. O app antigo continua funcionando com ela aplicada; o
-- app novo NÃO funciona sem ela (ele recusa gravar de forma não
-- atômica e mostra "banco desatualizado").
--
-- Pré-requisito: 001 → 002 → 003 → 004 (ou supabase-schema-atual.sql).
--
-- Por que existe: o app gravava a Frente numa chamada HTTP e o evento
-- estrutural / o cache `ultimo_movimento` em outra. Se a segunda falhasse
-- (ou a página fosse recarregada) ficava um estado intermediário. Cada
-- função abaixo executa TUDO dentro de uma única transação do Postgres:
-- ou todas as alterações são efetivadas, ou nenhuma.
--
-- Segurança:
--  * SECURITY INVOKER (padrão, explícito): a função roda com as
--    permissões de QUEM CHAMA. As policies de RLS existentes continuam
--    valendo em cada leitura/escrita; um usuário não enxerga nem altera
--    linhas de outro. NÃO usa SECURITY DEFINER.
--  * search_path fixo (public, pg_temp).
--  * EXECUTE revogado de PUBLIC e anon; concedido só a authenticated.
--  * Referências a frentes (pai, dona de registro/evento) são checadas
--    sob RLS: o FK do Postgres ignora RLS, então sem essa checagem um
--    usuário poderia anexar linhas à frente de outro se soubesse o id.
--
-- Concorrência e retry (sem coluna nova de versão):
--  * "esperado" = o estado que o cliente leu antes de alterar. A função
--    compara com o estado atual (compare-and-swap):
--      atual = esperado        → aplica
--      atual = novo            → "ja_aplicada" (retry de resposta
--                                perdida; não regrava, não duplica evento)
--      qualquer outro          → erro PU409 (alterada em outro lugar);
--                                nada é sobrescrito
--  * Criação (esperado nulo) é idempotente por id: se já existe, não
--    sobrescreve ("ja_existia").
--  * Eventos têm id fixo, definido pelo cliente: `on conflict do nothing`.
--  * `ultimo_movimento` NUNCA vem do cliente: é recalculado aqui a partir
--    dos registros (fonte de verdade), com a frente travada (FOR UPDATE)
--    para serializar operações concorrentes sobre a mesma frente.
--
-- Erros (SQLSTATE próprios; chegam ao app como code/message):
--    PU404  frente/registro não existe (mais)
--    PU409  alterado em outro lugar depois de lido (conflito)
--    PU422  dados inválidos (nome vazio, ciclo na hierarquia, pai
--           inexistente, evento de outra frente...)
-- ============================================================

-- Pré-condições: falha cedo, com mensagem clara, em vez de erro obscuro.
do $$
begin
  if to_regclass('public.eventos_estruturais') is null then
    raise exception 'Migration 005: tabela eventos_estruturais não existe. Aplique 001, 002, 003 e 004 antes (ou use supabase-schema-atual.sql).';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'registros' and column_name = 'criado_em') then
    raise exception 'Migration 005: coluna registros.criado_em não existe. Aplique 002 antes.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'frentes' and column_name = 'ciclo_vida') then
    raise exception 'Migration 005: coluna frentes.ciclo_vida não existe. Aplique 001 antes.';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'frentes' and column_name in ('estado', 'ultimo_toque') and is_nullable = 'NO'
  ) then
    raise exception 'Migration 005: colunas legadas (estado/ultimo_toque) ainda são NOT NULL. Aplique 004 antes.';
  end if;
end
$$;

-- ------------------------------------------------------------
-- Auxiliares (internos). Só colunas que o app controla; o cache
-- ultimo_movimento fica de fora de propósito (é derivado).
-- ------------------------------------------------------------
create or replace function public.pulse_frente_comparavel(f public.frentes)
returns jsonb
language sql
immutable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'nome', f.nome,
    'area', f.area,
    'tipo', f.tipo,
    'parent_id', f.parent_id,
    'ciclo_vida', f.ciclo_vida,
    'condicao', f.condicao,
    'cadencia_esperada', f.cadencia_esperada,
    'contexto_foco', f.contexto_foco,
    'contexto_bloqueio', f.contexto_bloqueio,
    'pausa_motivo', f.pausa_motivo,
    'pausa_retomada_em', f.pausa_retomada_em,
    'criada_em', f.criada_em
  )
$$;

create or replace function public.pulse_registro_comparavel(r public.registros)
returns jsonb
language sql
immutable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'frente_id', r.frente_id,
    'data', r.data,
    'criado_em', r.criado_em,
    'texto', r.texto,
    'conta_como_movimento', r.conta_como_movimento,
    'duracao_min', r.duracao_min
  )
$$;

-- ------------------------------------------------------------
-- 1) pulse_salvar_frente
--    Cria ou altera UMA frente + grava os eventos estruturais dessa
--    mudança, tudo na mesma transação. Cobre: criação (com evento de
--    criação), edição (com todos os eventos), mudança de ciclo de
--    vida / condição / cadência e movimentação na hierarquia.
--
--    p_frente   : estado novo (chaves = colunas de frentes)
--    p_esperado : estado que o cliente leu (null = criação)
--    p_eventos  : array de eventos (id fixo, frente_id = p_frente.id)
--    retorna    : { status: criada|ja_existia|aplicada|ja_aplicada,
--                   frente: {...linha final...} }
-- ------------------------------------------------------------
create or replace function public.pulse_salvar_frente(p_frente jsonb, p_esperado jsonb, p_eventos jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_novo public.frentes;
  v_esp public.frentes;
  v_atual public.frentes;
  v_final public.frentes;
  v_status text;
  v_n int;
begin
  if p_frente is null or jsonb_typeof(p_frente) <> 'object' then
    raise exception 'Frente inválida.' using errcode = 'PU422';
  end if;
  v_novo := jsonb_populate_record(null::public.frentes, p_frente);
  if v_novo.id is null then
    raise exception 'Frente sem id.' using errcode = 'PU422';
  end if;
  if v_novo.nome is null or btrim(v_novo.nome) = '' then
    raise exception 'Dê um nome para a frente.' using errcode = 'PU422';
  end if;
  if p_eventos is not null and jsonb_typeof(p_eventos) <> 'array' then
    raise exception 'Lista de eventos inválida.' using errcode = 'PU422';
  end if;

  if p_eventos is not null and exists (
    select 1 from jsonb_populate_recordset(null::public.eventos_estruturais, p_eventos) e
    where e.frente_id is distinct from v_novo.id
  ) then
    raise exception 'Evento pertence a outra frente.' using errcode = 'PU422';
  end if;

  select * into v_atual from public.frentes where id = v_novo.id for update;

  if not found then
    if p_esperado is not null then
      raise exception 'Esta frente não existe mais (foi excluída em outro lugar).' using errcode = 'PU404';
    end if;
    if v_novo.parent_id is not null then
      perform 1 from public.frentes where id = v_novo.parent_id for share;
      if not found then
        raise exception 'A frente-mãe não existe mais. Volte e escolha outra.' using errcode = 'PU422';
      end if;
    end if;
    -- "on conflict do nothing": se uma chamada idêntica está em andamento
    -- (clique duplo, retry durante a espera), a perdedora espera a outra
    -- e cai em "ja_existia" em vez de falhar com violação de chave.
    insert into public.frentes (
      id, user_id, nome, area, tipo, parent_id, ciclo_vida, condicao, cadencia_esperada,
      ultimo_movimento, contexto_foco, contexto_bloqueio, pausa_motivo, pausa_retomada_em, criada_em
    ) values (
      v_novo.id, auth.uid(), btrim(v_novo.nome), v_novo.area, v_novo.tipo, v_novo.parent_id, v_novo.ciclo_vida,
      v_novo.condicao, v_novo.cadencia_esperada, null, v_novo.contexto_foco, v_novo.contexto_bloqueio,
      v_novo.pausa_motivo, v_novo.pausa_retomada_em, v_novo.criada_em
    )
    on conflict (id) do nothing;
    get diagnostics v_n = row_count;
    if v_n = 1 then
      v_status := 'criada';
    else
      select * into v_atual from public.frentes where id = v_novo.id;
      if not found then
        raise exception 'Este identificador já está em uso.' using errcode = 'PU409';
      end if;
      v_status := 'ja_existia';
    end if;
  elsif p_esperado is null then
    -- criação repetida (retry de resposta perdida): nunca sobrescreve
    v_status := 'ja_existia';
  else
    v_esp := jsonb_populate_record(null::public.frentes, p_esperado);
    -- o nome é gravado sem espaços nas pontas; compara no mesmo formato
    v_novo.nome := btrim(v_novo.nome);
    if public.pulse_frente_comparavel(v_atual) = public.pulse_frente_comparavel(v_novo) then
      v_status := 'ja_aplicada';
    elsif public.pulse_frente_comparavel(v_atual) = public.pulse_frente_comparavel(v_esp) then
      if v_novo.parent_id is not null and v_novo.parent_id is distinct from v_atual.parent_id then
        if v_novo.parent_id = v_novo.id then
          raise exception 'Uma frente não pode ser filha de si mesma.' using errcode = 'PU422';
        end if;
        perform 1 from public.frentes where id = v_novo.parent_id for share;
        if not found then
          raise exception 'A frente-mãe não existe mais. Volte e escolha outra.' using errcode = 'PU422';
        end if;
        if exists (
          with recursive descendentes as (
            select id from public.frentes where parent_id = v_novo.id
            union
            select f.id from public.frentes f join descendentes d on f.parent_id = d.id
          )
          select 1 from descendentes where id = v_novo.parent_id
        ) then
          raise exception 'Não é possível mover uma frente para dentro de uma das suas próprias sub-frentes (criaria um ciclo).' using errcode = 'PU422';
        end if;
      end if;
      update public.frentes set
        nome = v_novo.nome,
        area = v_novo.area,
        tipo = v_novo.tipo,
        parent_id = v_novo.parent_id,
        ciclo_vida = v_novo.ciclo_vida,
        condicao = v_novo.condicao,
        cadencia_esperada = v_novo.cadencia_esperada,
        contexto_foco = v_novo.contexto_foco,
        contexto_bloqueio = v_novo.contexto_bloqueio,
        pausa_motivo = v_novo.pausa_motivo,
        pausa_retomada_em = v_novo.pausa_retomada_em,
        criada_em = v_novo.criada_em,
        -- cache derivado: sempre dos registros, nunca do cliente
        ultimo_movimento = (
          select max(r.data) from public.registros r where r.frente_id = v_novo.id and r.conta_como_movimento
        )
      where id = v_novo.id;
      v_status := 'aplicada';
    else
      raise exception 'Esta frente foi alterada em outro lugar (outra aba ou aparelho) depois que você a abriu. Recarregue a página e refaça a alteração.' using errcode = 'PU409';
    end if;
  end if;

  -- eventos só entram quando ESTA chamada aplicou a mudança; em
  -- "ja_aplicada"/"ja_existia" a transação original já os gravou.
  if v_status in ('criada', 'aplicada') and p_eventos is not null then
    insert into public.eventos_estruturais (id, user_id, frente_id, tipo, valor_anterior, valor_novo, criado_em)
    select e.id, auth.uid(), e.frente_id, e.tipo, e.valor_anterior, e.valor_novo, e.criado_em
    from jsonb_populate_recordset(null::public.eventos_estruturais, p_eventos) e
    on conflict (id) do nothing;
  end if;

  select * into v_final from public.frentes where id = v_novo.id;
  return jsonb_build_object('status', v_status, 'frente', to_jsonb(v_final) - 'user_id');
end
$$;

-- ------------------------------------------------------------
-- 2) pulse_salvar_registro
--    Cria ou edita UM registro e recalcula o ultimo_movimento da
--    frente dele, na mesma transação.
--
--    p_registro : estado novo (chaves = colunas de registros)
--    p_esperado : estado lido pelo cliente (null = criação)
--    retorna    : { status: criado|ja_existia|aplicado|ja_aplicado,
--                   registro: {...}, ultimo_movimento: bigint|null }
-- ------------------------------------------------------------
create or replace function public.pulse_salvar_registro(p_registro jsonb, p_esperado jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_novo public.registros;
  v_esp public.registros;
  v_atual public.registros;
  v_final public.registros;
  v_status text;
  v_um bigint;
begin
  if p_registro is null or jsonb_typeof(p_registro) <> 'object' then
    raise exception 'Registro inválido.' using errcode = 'PU422';
  end if;
  v_novo := jsonb_populate_record(null::public.registros, p_registro);
  if v_novo.id is null or v_novo.frente_id is null then
    raise exception 'Registro sem id ou sem frente.' using errcode = 'PU422';
  end if;
  if v_novo.texto is null or v_novo.data is null or v_novo.criado_em is null or v_novo.conta_como_movimento is null then
    raise exception 'Registro incompleto.' using errcode = 'PU422';
  end if;

  -- trava a frente (visível sob RLS) antes do registro: ordem fixa
  -- frente → registro evita deadlock e serializa o recálculo do cache
  perform 1 from public.frentes where id = v_novo.frente_id for update;
  if not found then
    raise exception 'A frente deste registro não existe mais.' using errcode = 'PU404';
  end if;

  select * into v_atual from public.registros where id = v_novo.id for update;

  if not found then
    if p_esperado is not null then
      raise exception 'Este registro não existe mais (foi excluído em outro lugar).' using errcode = 'PU404';
    end if;
    insert into public.registros (id, user_id, frente_id, data, criado_em, texto, conta_como_movimento, duracao_min)
    values (v_novo.id, auth.uid(), v_novo.frente_id, v_novo.data, v_novo.criado_em, v_novo.texto,
            v_novo.conta_como_movimento, v_novo.duracao_min);
    v_status := 'criado';
  elsif p_esperado is null then
    v_status := 'ja_existia'; -- retry de criação: não sobrescreve
  else
    if v_atual.frente_id <> v_novo.frente_id then
      raise exception 'Um registro não pode mudar de frente.' using errcode = 'PU422';
    end if;
    v_esp := jsonb_populate_record(null::public.registros, p_esperado);
    if public.pulse_registro_comparavel(v_atual) = public.pulse_registro_comparavel(v_novo) then
      v_status := 'ja_aplicado';
    elsif public.pulse_registro_comparavel(v_atual) = public.pulse_registro_comparavel(v_esp) then
      update public.registros set
        data = v_novo.data,
        criado_em = v_novo.criado_em,
        texto = v_novo.texto,
        conta_como_movimento = v_novo.conta_como_movimento,
        duracao_min = v_novo.duracao_min
      where id = v_novo.id;
      v_status := 'aplicado';
    else
      raise exception 'Este registro foi alterado em outro lugar depois que você o abriu. Recarregue a página e refaça a alteração.' using errcode = 'PU409';
    end if;
  end if;

  -- recalcula do zero (também "cura" um cache antigo divergente)
  select max(r.data) into v_um from public.registros r where r.frente_id = v_novo.frente_id and r.conta_como_movimento;
  update public.frentes set ultimo_movimento = v_um
  where id = v_novo.frente_id and ultimo_movimento is distinct from v_um;

  select * into v_final from public.registros where id = v_novo.id;
  return jsonb_build_object('status', v_status, 'registro', to_jsonb(v_final) - 'user_id', 'ultimo_movimento', v_um);
end
$$;

-- ------------------------------------------------------------
-- 3) pulse_excluir_registro
--    Exclui UM registro e recalcula ultimo_movimento da frente.
--    Idempotente: registro inexistente → status "ja_removido".
-- ------------------------------------------------------------
create or replace function public.pulse_excluir_registro(p_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_frente uuid;
  v_um bigint;
  v_n int;
begin
  select frente_id into v_frente from public.registros where id = p_id;
  if not found then
    return jsonb_build_object('status', 'ja_removido', 'ultimo_movimento', null);
  end if;

  perform 1 from public.frentes where id = v_frente for update; -- mesma ordem: frente → registro
  delete from public.registros where id = p_id;
  get diagnostics v_n = row_count;

  select max(r.data) into v_um from public.registros r where r.frente_id = v_frente and r.conta_como_movimento;
  update public.frentes set ultimo_movimento = v_um
  where id = v_frente and ultimo_movimento is distinct from v_um;

  return jsonb_build_object('status', case when v_n > 0 then 'removido' else 'ja_removido' end, 'ultimo_movimento', v_um);
end
$$;

-- ------------------------------------------------------------
-- 4) pulse_excluir_frente
--    Exclusão PERMANENTE de uma frente + descendentes + registros +
--    eventos delas, numa transação. Não depende de ON DELETE CASCADE
--    (remove explicitamente, de baixo para cima). Idempotente.
-- ------------------------------------------------------------
create or replace function public.pulse_excluir_frente(p_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_eventos int;
  v_registros int;
  v_frentes int;
begin
  with recursive arvore as (
    select id from public.frentes where id = p_id
    union -- (não union all) termina mesmo com ciclo em dado corrompido
    select f.id from public.frentes f join arvore a on f.parent_id = a.id
  )
  select array_agg(id) into v_ids from arvore;

  if v_ids is null then
    return jsonb_build_object('status', 'ja_removida', 'frentes', 0, 'registros', 0, 'eventos', 0);
  end if;

  perform 1 from public.frentes where id = any (v_ids) order by id for update;

  delete from public.eventos_estruturais where frente_id = any (v_ids);
  get diagnostics v_eventos = row_count;
  delete from public.registros where frente_id = any (v_ids);
  get diagnostics v_registros = row_count;
  delete from public.frentes where id = any (v_ids);
  get diagnostics v_frentes = row_count;

  return jsonb_build_object('status', 'removida', 'frentes', v_frentes, 'registros', v_registros, 'eventos', v_eventos);
end
$$;

-- ------------------------------------------------------------
-- Permissões: só usuários autenticados executam. (O Supabase concede
-- EXECUTE a anon/authenticated por padrão em funções novas; revoga-se
-- explicitamente.)
-- ------------------------------------------------------------
revoke all on function public.pulse_frente_comparavel(public.frentes) from public, anon;
revoke all on function public.pulse_registro_comparavel(public.registros) from public, anon;
revoke all on function public.pulse_salvar_frente(jsonb, jsonb, jsonb) from public, anon;
revoke all on function public.pulse_salvar_registro(jsonb, jsonb) from public, anon;
revoke all on function public.pulse_excluir_registro(uuid) from public, anon;
revoke all on function public.pulse_excluir_frente(uuid) from public, anon;

grant execute on function public.pulse_frente_comparavel(public.frentes) to authenticated;
grant execute on function public.pulse_registro_comparavel(public.registros) to authenticated;
grant execute on function public.pulse_salvar_frente(jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.pulse_salvar_registro(jsonb, jsonb) to authenticated;
grant execute on function public.pulse_excluir_registro(uuid) to authenticated;
grant execute on function public.pulse_excluir_frente(uuid) to authenticated;

-- O PostgREST (API do Supabase) recarrega o catálogo de funções ao
-- receber este aviso; sem ele, a função nova pode demorar a aparecer.
notify pgrst, 'reload schema';
