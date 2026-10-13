# PULSE — HANDOFF

Estado técnico **verificável** para quem continuar o projeto (inclusive em outra
conta/sessão). Propósito, modelo e princípios: `PULSE_PRODUCT_BRIEF.md` (não
repetidos aqui). Cada afirmação abaixo foi conferida no código ou executada; o
que **não** foi validado está dito como tal. Fontes de cada teste são
separadas: *executado no ambiente de desenvolvimento*, *PostgreSQL real local*
e *relatado pela usuária no Supabase real*.

## 1. Fase atual

**Fase A — Estabilização técnica, pacote 2: fechamento da consistência.**
Operações compostas de persistência agora são atômicas (RPC transacional no
Supabase). **A migration 005 NÃO foi aplicada nem testada no Supabase real da
usuária** — a atomicidade está provada em PostgreSQL real local, não no
Supabase. Fases B (sistema de registros), C (UI) e D (compreensão) **não foram
iniciadas**.

## 2. Git

- Repositório sem remote (criado a partir do zip da Fase 2). Branches:
  - `master` / `a67ecc5` — baseline (conteúdo exato do zip da Fase 2).
  - `fase-a-estabilizacao` — pacote 1 (`7bc7dde`, `abc2abe`).
  - **`fase-a-fechamento-consistencia`** — este pacote (parte de `fase-a-estabilizacao`). Último commit: ver `git log -1`.
- Nenhum reset, force-push ou reescrita de histórico. Tudo commitado é trabalho desta série de sessões; nada de terceiros.
- Sem segredos no repositório (`.env*` ignorados; `.env.example` só placeholders; a senha `pulse_test` do banco de teste local é descartável e documentada).

## 3. Estado verificado do Supabase real (relatado pela usuária — não executado por Claude)

Aplicadas ao Supabase real: migrations **001, 002, 003 e 004**. Verificações da usuária: tabela `eventos_estruturais` existe; `registros.criado_em` existe e é obrigatório; `frentes.ciclo_vida`/`condicao` existem; `estado`/`ultimo_toque`/`opt_out_negligencia` aceitam NULL; restrição do evento `hierarquia_mudou` existe; RLS + política em `eventos_estruturais`.

Testes manuais da usuária no app publicado (versão **anterior a este pacote**, sem a 005), todos passaram: login; carregar Home e Frentes; criar Frente temporária; criar Registro; recarregar com dados preservados; concluir a Frente e editar o nome depois; excluir Registro e Frente temporários. Isso valida os caminhos normais da versão anterior; **não** valida atomicidade nem nada desta versão.

## 4. O que mudou neste pacote

**Problema confirmado no código antes da mudança** (`frente-ops.ts`): criar/editar/mudar/mover Frente gravava a linha e depois os eventos em chamadas separadas; criar/editar/excluir Registro gravava e depois recalculava `últimoMovimento` (que lia todos os registros e regravava a frente com um valor lido antes — também podia sobrescrever com valor velho); `excluirFrenteComFilhos` fazia N+M remoções soltas. `ErroParcial.completar()` vivia só em memória: recarregar a página perdia a recuperação.

**Solução:**
- `supabase-migration-005-operacoes-atomicas.sql` (aditiva; **não aplicada**): 4 funções RPC — `pulse_salvar_frente(p_frente, p_esperado, p_eventos)`, `pulse_salvar_registro(p_registro, p_esperado)`, `pulse_excluir_registro(p_id)`, `pulse_excluir_frente(p_id)` — + 2 auxiliares internas. Cada uma = uma transação.
  - `SECURITY INVOKER` (não DEFINER), `search_path` fixo, EXECUTE revogado de `PUBLIC`/`anon`, concedido a `authenticated`. RLS continua valendo; funções checam sob RLS que pai/frente-dona existem (o FK ignora RLS).
  - Retry/conflito sem coluna nova: compare-and-swap com o estado "esperado" lido pelo cliente. atual=esperado → aplica; atual=novo → `ja_aplicada` (não regrava nem duplica evento); outro → `PU409` (nada sobrescrito). Criação idempotente por id (`ja_existia`; criações simultâneas idênticas → 1 `criada` + resto `ja_existia`). Eventos têm id fixo + `on conflict do nothing`.
  - `ultimo_movimento` **nunca vem do cliente**: recalculado dos registros dentro da transação, com a frente travada (`FOR UPDATE`, ordem frente→registro).
  - Exclusão de árvore explícita (não depende de `ON DELETE CASCADE`), termina mesmo com ciclo corrompido, idempotente.
  - Erros próprios: `PU404` não existe, `PU409` conflito, `PU422` inválido (ciclo, pai inexistente, nome vazio, evento de outra frente).
  - Pré-condições (bloco `DO`) recusam aplicar sem 001–004 com mensagem clara.
- `StorageAdapter` ganhou 4 operações atômicas (`salvarFrenteComEventos`, `salvarRegistroComCache`, `removerRegistroComCache`, `removerFrenteEmCascata`). `SupabaseAdapter` = 1 RPC cada, **sem fallback não atômico** (sem a 005 o erro é "banco desatualizado — aplique a 005"). Local/Memória usam `storage-atomico.ts` (funções puras, espelho TS do SQL) e o Local grava as 3 chaves com **reversão** se alguma falhar.
- `frente-ops.ts`/`hierarquia.ts`: mesmas assinaturas públicas e regras de domínio; cada operação decide o que mudar e entrega UMA chamada atômica. `registrarEvento`/`gravarEventos`/`recalcularÚltimoMovimento` removidos. `excluirRegistro` não lê mais nada.
- UI: sem mudança visual. Um conflito (`PU409`) aparece como mensagem pedindo para recarregar; não há reconciliação automática.
- Testes: `teste-atomico-comum.ts` (mesma suíte para memória, local e Supabase), `test-atomicidade.ts`, `test-pg.ts` + `teste-pg-cliente.ts` (PostgreSQL real), `test-consistencia.ts` reescrito (falha agora = nada muda, não "parcial"), e2e "falha parcial" substituído por 2 testes de reversão. `db-teste/shim-supabase.sql`. README atualizado. Dep. de dev: `pg`, `@types/pg`.

## 5. Testes e resultados

**A. Executados no ambiente de desenvolvimento, sem banco (resultado real):**
- `npm run typecheck` limpo · `npm run build` ok.
- `npm run test:dominio` (16 suites: motor, ops, histórico, estado, registro-query, hierarquia, portabilidade, ritmo, tendências, períodos, ui-cenarios, erros, supabase [contrato com SQL interpretado], leitura, consistência, atomicidade): **0 falhas**. `test:atomicidade` = 130 verificações (memória + local, incluindo reversão real de gravação que falha no meio; mutação sem reversão → 10 falhas, confirmando que o teste detecta).
- `npm run test:e2e` (Playwright 1.56, Chromium, build de produção, modo local): **24/24**.

**B. PostgreSQL REAL (16.15, local, bancos temporários) — `npm run test:pg`: 237 verificações, 0 falhas.** Mutação de teste (removido o conflito PU409 e a checagem de pai) → 16 falhas, confirmando sensibilidade. Cobre:
- migrations: schema v1 + 001–004 + 005 aplicam sem erro (**primeira execução real de 001–004 em Postgres**); instalação nova (`supabase-schema-atual.sql` + 005); 005 idempotente (3×); recusa sem 001 e sem 004.
- criação gera exatamente 1 evento; edição composta grava todos os eventos; hierarquia move com evento, recusa ciclo/auto-pai/pai inexistente.
- **Rollback real**: evento inválido (CHECK) e triggers que lançam exceção no meio (evento, cache da frente, exclusão de árvore) → frente, registro e eventos voltam ao estado anterior.
- `ultimo_movimento` em criar/editar data/editar "conta como movimento"/excluir/retroativo/sem movimento; cache corrompido é curado; valor do cliente ignorado.
- árvore: sem registros/eventos órfãos; contagens; idempotente; ciclo corrompido não trava.
- retry de resposta perdida (`ja_aplicada`, `ja_existia`, `ja_removido`) sem duplicar eventos/registros; conflito `PU409` preserva a alteração mais recente.
- isolamento entre dois usuários via RPC (editar/registrar/excluir/ser pai do que é do outro → recusado ou no-op; nenhuma linha alterada); `anon` sem EXECUTE; `SECURITY INVOKER`; `search_path` fixo; nada executável por `PUBLIC`.
- concorrência: 24 registros simultâneos (cache final correto, sem deadlock); 6 edições com a mesma base (1 aplicada, 5 conflitos); 5 criações idênticas simultâneas; 2 movimentos que formariam ciclo.
- `SupabaseAdapter` + `frente-ops` sobre o Postgres (nos dois schemas): mesma suíte da memória/local; paginação real com 2500 linhas; erros do Postgres viram `ErroPulse` legível; 1 RPC por operação; sem a 005, "banco desatualizado" e nada gravado.

**C. Relatado pela usuária (Supabase real):** ver §3. Nada da 005.

**D. NÃO validado (limites reais):**
- **Migration 005 no Supabase real** — não aplicada, não testada. `ClientePg` (teste) imita o supabase-js; **PostgREST/GoTrue/JWT reais não foram exercitados**: nomes/tipos de parâmetros RPC, retorno `jsonb`, exposição das funções (`notify pgrst, 'reload schema'` está na migration), `auth.uid()` real e o grant a `authenticated` precisam do smoke test do §7.
- App publicado com a 005 no navegador (e2e só usa o modo local). Safari/iOS/Firefox. Tempo real em rede.
- Importação (`importarPulse`): **continua não atômica** (parcial + `completar` em memória; sem UI). Não foi alterada nem declarada resolvida.

## 6. Migrações e ordem de aplicação (ação da usuária)

1. Estado atual do Supabase real: 001–004 aplicadas (§3). **005 pendente.**
2. **Aplicar a 005 ANTES de publicar esta versão do app.** O app antigo segue funcionando com a 005 aplicada (migration aditiva); o app novo recusa gravar sem ela.
3. Conferir no SQL Editor (esperado: 6 linhas; `prosecdef` = false; `anon_exec` = false; `auth_exec` = true):
   ```sql
   select p.proname, p.prosecdef,
          has_function_privilege('anon', p.oid, 'execute') as anon_exec,
          has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'pulse\_%' order by 1;
   ```
4. Instalação nova: `supabase-schema-atual.sql` + 005.
5. **Continua pendente (decisão da usuária):** relatório de conversão `optOutNegligência→pausada` com dados reais; só depois, migration de **remoção** das colunas legadas.

## 7. Próxima tarefa recomendada (não iniciada): validar a 005 no Supabase real

Critérios de aceitação (feitos pela usuária, com a conta real, após aplicar a 005 e publicar):
1. Consulta do §6 devolve o esperado.
2. Smoke test sem `[object Object]`: criar Frente → registrar → editar Frente (nome + condição) → mover para outra Frente → concluir → excluir registro → excluir Frente; recarregar entre os passos; histórico mostra os eventos certos, uma vez cada.
3. Duas abas: abrir a mesma Frente nas duas, editar na A, editar na B sem recarregar → B mostra a mensagem de conflito e a edição da A permanece.
4. Se algo falhar, copiar a mensagem (em modo dev traz código/detalhes) para ajustar o contrato.
Só então revisar este pacote e partir para a Fase B (sistema de registros), sem misturar.

## 8. Riscos e problemas conhecidos

- **Contrato PostgREST não verificado** (item D acima): é o maior risco residual deste pacote.
- Duas implementações da mesma regra (SQL e TS em `storage-atomico.ts`): paridade garantida só pelos testes compartilhados; mudar a regra exige mudar os dois.
- Frente criada **antes** sem evento de criação (dados legados) não ganha o evento ao ser "recriada" com o mesmo id (antes ganhava). Sem impacto no fluxo normal.
- Conflito (`PU409`) exige recarregar manualmente; edição perdida precisa ser refeita.
- Importação não atômica; `ErroParcial`/"Tentar completar" existe só para ela (sem UI hoje).
- Leituras em lote carregam as tabelas inteiras por render (paginadas de 1000); sem fila offline; escrita sem rede falha com mensagem.
- Tela de login e `manifest` do PWA ainda no tema claro antigo (fora do escopo).
- `datetime-local` interpretado no fuso do navegador.

## 9. Decisões técnicas

- Atomicidade na camada do `StorageAdapter`, regras de domínio em TS, SQL só para transação/concorrência/segurança.
- Sem coluna de versão: CAS pelo conteúdo "esperado" (campos controlados pelo app; `ultimo_movimento` excluído por ser derivado).
- Sem fallback não atômico quando a RPC falta: falha explícita é preferível a consistência silenciosamente quebrada.
- `SECURITY INVOKER` + RLS existente, em vez de DEFINER com verificação manual de dono.
- Testes em PostgreSQL real separados de `test:dominio` (que roda sem banco); `test:pg` sai com código 2 se não houver PostgreSQL (não finge sucesso).

## 10. Como rodar

`npm install` → `npm run typecheck` → `npm run test:dominio` → `npm run build` → `npm run test:e2e`. Com PostgreSQL local: `npm run test:pg` (README, "Testes com PostgreSQL real"). Pacote sem `node_modules`/`dist`/`.env*`.
