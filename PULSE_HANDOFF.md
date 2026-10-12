# PULSE — HANDOFF

Estado técnico **verificável** para quem continuar o projeto (inclusive em outra
conta/sessão). Propósito, modelo e princípios estão no `PULSE_PRODUCT_BRIEF.md`
— não repetidos aqui. Tudo abaixo foi conferido no código ou executado; o que
**não** foi validado está dito como tal.

## 1. Fase atual

**Fase A — Estabilização técnica: implementada e validada localmente. Não validada
contra o Supabase remoto de Dani** (sem acesso a ele neste ambiente).
Fases seguintes (3 e 4 do roadmap de UI) **não foram iniciadas**.

## 2. Git

- Repositório criado nesta sessão a partir do zip entregue (`Pulse-2.0-fase2-experiencia-central.zip`); **não tem remote** nem histórico anterior.
- Branch `fase-a-estabilizacao`:
  - `a67ecc5` — baseline: conteúdo exato do zip da Fase 2.
  - commits seguintes — Fase A (tudo é trabalho desta sessão; nada de terceiros foi commitado).
- `master` aponta para o baseline. Para ver o que mudou: `git diff a67ecc5..fase-a-estabilizacao`.
- Ao integrar ao repositório real (`github.com/ItsLeaphy/Pulse`), traga a branch ou aplique o diff; não há segredos no repositório (`.env*` ignorados; `.env.example` só tem placeholders).

## 3. Estado real do sistema

Funciona (verificado por testes, ver §6): modelo completo (Blocos 1–6), UI das Fases 1–2, operações de domínio, export/import (só em código, **sem UI**), erros normalizados, leitura única por render.

**Não existe na UI ainda:** reparenting, import/export, comparação de períodos, filtros avançados de busca, Weekly Update.

## 4. Problemas reportados × o que foi encontrado

| Relato | Evidência | Situação |
|---|---|---|
| `Algo deu errado: [object Object]` | **Reproduzido por leitura de código e por teste**: o `SupabaseAdapter` fazia `throw error` com o `PostgrestError` do Supabase (objeto simples, **não** `Error`) e `mostrarErro` usava `String(err)`. | Corrigido: `erros.ts` normaliza qualquer valor; adapter lança `ErroPulse` (código/mensagem/detalhes/dica); `test:erros` (44) e `test:supabase` (53) cobrem. |
| Falha ao salvar Frentes / persistência | **Reproduzido contra o schema documentado** (teste de contrato, não contra o banco real): em `supabase-schema.sql` v1, `estado` e `ultimo_toque` são `NOT NULL` sem default; o adapter não os escreve; o Postgres checa NOT NULL antes de resolver o upsert ⇒ **todo** `salvarFrente` falha (23502) em banco v1 + migrations 001–003. | Corrigido no contrato: `supabase-migration-004-compat-adapter.sql` (aditiva) + `supabase-schema-atual.sql` (instalação nova). **Precisa ser aplicada por Dani** (§7). |
| Erros ao selecionar/abrir Frentes | **Não reproduzido de forma independente.** Hipótese forte, consistente com o contrato: abrir Frente/Home lê `eventos_estruturais` e `registros.criado_em`; num banco sem as migrations 001/002 essas leituras falham (42P01/PGRST205/42703). Antes, o erro virava `[object Object]` e substituía a tela inteira. | Agora a mensagem diz "banco desatualizado — aplique as migrações" e só a área principal é afetada, com "Tentar de novo". A causa real no banco de Dani **só se confirma verificando quais migrations ele aplicou**. |
| Lentidão | **Reproduzido por contagem de leituras** (`test:leitura`): sinal agregado de 25 frentes = 135 leituras; Home de 25 frentes = 114 leituras (`getFrentes()` por nó, `getRegistros`/`getEventos` por frente, `encontrarRegistro` varrendo todas as frentes). | Corrigido: instantâneo por render (`storage-leitura.ts`) ⇒ Home = 3 leituras reais; leituras da tela em paralelo; exclusão = 3 leituras; `encontrarRegistro` usa a frente conhecida. Tempo real em rede **não foi medido**. |
| Operações compostas sem consistência | **Reproduzido** no código original (script contra o commit baseline): editar uma Frente concluída/arquivada salvava o nome e **depois lançava** "não está ativa" (`mudarCondição` checava o ciclo antes de comparar valores). | Corrigido: `editarFrente` (1 gravação + eventos), ver §5. |
| Usuário sem saber se concluiu | Handlers `void (async()=>{…})()` sem `try/catch` (rejeições não tratadas). | Corrigido: `executarAção` (botão desabilitado, "Salvando…", aviso de sucesso, erro ao lado da ação, formulário preservado). |
| Testes não provam ponta a ponta | Só havia scripts de domínio. | 23 testes Playwright em Chromium real (§6). |

## 5. Alterações (principais)

**Novos:** `src/erros.ts`, `src/storage-leitura.ts`, `src/test-erros.ts`, `src/test-storage-supabase.ts`, `src/test-leitura.ts`, `src/test-consistencia.ts`, `e2e/` (`fluxos.spec.ts`, `responsivo.spec.ts`, `helpers.ts`), `playwright.config.ts`, `supabase-schema-atual.sql`, `supabase-migration-004-compat-adapter.sql`, `PULSE_PRODUCT_BRIEF.md`, este arquivo.

**Alterados:** `src/storage.ts` (+`getTodosRegistros`, `getTodosEventosEstruturais` no contrato), `src/storage-supabase.ts` (erros estruturados, paginação 1000, leituras em lote), `src/frente-ops.ts`, `src/hierarquia.ts`, `src/portabilidade.ts`, `src/registro-query.ts`, `src/ui.ts`, `src/main.ts`, `src/style.css` (aviso/status/loading), `README.md` (reescrito), `package.json` (+scripts, `@playwright/test`, `@types/node`), `.gitignore`.

**Decisões técnicas:**
- **Consistência sem transação:** ordem de escrita = estado primeiro, evento depois. Se o evento falha, lança `ErroParcial` (diz o que foi salvo e o que falta) com `completar()` que regrava só o pendente; eventos têm id fixo ⇒ idempotente. Criar frente/registro é idempotente por id (a UI reutiliza o mesmo id/`criadoEm` nas repetições).
- **`editarFrente`** substitui salvar + `mudarCicloVida` + `mudarCondição` + `mudarCadência` (4+ gravações). Mesmas invariantes (concluída/arquivada ⇒ condição `normal`; condição só em frente ativa; condição enviada para frente não-ativa é ignorada, não é erro).
- `mudarCondição` agora compara valores **antes** de checar o ciclo (mesmo valor = no-op); mudar para valor diferente em frente não-ativa continua sendo erro.
- **Instantâneo de leitura por render** em vez de cache global: nunca serve dado velho entre telas; escrita via instantâneo invalida; leitura que falhou não é memorizada.
- Importação grava pais antes dos filhos (FK) e devolve `ErroParcial` com `completar`.
- Produção não expõe código/detalhes internos; em `import.meta.env.DEV` a mensagem inclui código/detalhes/dica; logs redigem JWT/apikey/Bearer.
- Render obsoleto (clique rápido + rede lenta) é descartado por contador de geração.

## 6. Testes

**Executados nesta sessão, todos passando:**

| Comando | Resultado |
|---|---|
| `npm run typecheck` | limpo |
| `npm run build` | ok (PWA gerado) |
| `npm run test:dominio` (15 suites: motor 18, ops 21, histórico 32, estado 45, registro-query 31, hierarquia 26, portabilidade 27, ritmo 21, tendências 20, períodos 13, ui-cenarios 25, erros 44, supabase 53, leitura 12, consistência 59) | 0 falhas |
| `npm run test:e2e` (Playwright 1.56, Chromium 141 do ambiente, build de produção) | **23/23** |

Cobertura e2e: Home vazia; criar/consultar/selecionar Frente e sub-frente; abrir Frente; registrar (incl. data retroativa); histórico; busca; editar/excluir registro; editar Frente concluída (regressão); excluir Frente; persistência após reload; Registrar global; Frente inexistente; falha de escrita (erro local, formulário preservado, retry sem duplicar); falha parcial + "Tentar completar"; falha de leitura + "Tentar de novo"; mobile 390×844 e 320×568, desktop 1280×800 (sem rolagem horizontal, controles dentro da tela, conteúdo final não coberto pela navegação, Home mostra atenção sem listar tudo).

**NÃO validado / limites:**
- Nada foi executado contra um **Supabase real**. O contrato adapter↔schema é verificado por um **interpretador SQL mínimo** (`test-storage-supabase.ts`) que **ignora blocos `DO $$`** (as precondições da 004 e a descoberta de constraint da 003 não são exercitadas). A migration 004 **nunca rodou em Postgres**.
- Os testes de navegador usam só o `LocalStorageAdapter`. O caminho Supabase no navegador (login, rede, RLS) **não** foi testado em browser.
- Só Chromium. Safari/iOS e Firefox não testados.
- Tempos reais de carregamento em rede não foram medidos (só contagem de leituras).
- Revisão visual feita por captura de tela em 390 px (Home e domínio); sem revisão estética profunda.

## 7. Migrações e configuração pendentes (ação de Dani)

1. Descobrir quais migrations o banco de Dani já tem. Verificação no SQL Editor:
   ```sql
   select column_name, is_nullable from information_schema.columns
   where table_schema='public' and table_name='frentes' order by ordinal_position;
   select to_regclass('public.eventos_estruturais');
   select column_name from information_schema.columns where table_name='registros' and column_name='criado_em';
   ```
2. Aplicar **em ordem** as que faltarem: 001 → 002 → 003 → **004**. (A 004 aborta com mensagem clara se alguma anterior faltar.) Instalação nova: apenas `supabase-schema-atual.sql`.
3. Depois da 004, conferir que `estado`, `ultimo_toque`, `opt_out_negligencia` aparecem com `is_nullable = YES`.
4. `supabase-schema.sql` é o **v1 legado** — não usar em instalação nova.
5. **Continua pendente** (decisão de Dani): relatório de conversão `optOutNegligência→pausada` com dados reais e, só depois, migration de **remoção** das colunas legadas.

## 8. Bugs e riscos conhecidos

- **`completar()` vive só em memória.** Se o usuário recarregar depois de um `ErroParcial`, o evento pendente de uma *mudança* (condição/cadência/ciclo/hierarquia) se perde (o estado da frente fica correto; falta a linha no histórico). Para *criação*, repetir `criarFrente` com o mesmo id repara. Solução real: função/RPC transacional no Postgres (pendente).
- **Leituras em lote carregam a tabela inteira** (paginadas de 1000 em 1000) a cada render. Adequado a uso pessoal; vira o próximo gargalo com dezenas de milhares de registros.
- Sem fila offline: escrita sem rede falha (com mensagem) em vez de ficar pendente.
- Duas abas editando a mesma frente: último a gravar vence.
- Importação não é atômica (parcial + `completar`); e re-importar após parcial é rejeitado por colisão de ids (use `completar`).
- Tela de login (`auth.ts`) mantém estilo inline antigo, fora do tema escuro; manifest PWA ainda declara `background_color #f5f2eb`/`theme_color #111111` (tema claro antigo). Não tocados (fora do escopo da Fase A).
- `datetime-local` é interpretado no fuso do navegador.

## 9. Limitações do ambiente de desenvolvimento

Sandbox sem acesso ao Supabase de Dani; rede de saída apenas por allowlist; Chromium vem pré-instalado (`PLAYWRIGHT_BROWSERS_PATH`), por isso o Playwright rodou sem baixar nada.

## 10. Como rodar

`npm install` → `npm run typecheck` → `npm run test:dominio` → `npm run build` → `npm run test:e2e` (builda e sobe `vite preview` na 4173 sozinho). Pacote de código sem `node_modules`/`dist`.

## 11. Próxima tarefa recomendada (não iniciada)

**Fase B — Validar contra o Supabase real e fechar atomicidade.** Critérios de aceitação:
1. Dani aplica 001–004 (ou schema atual) e as verificações do §7 retornam o esperado.
2. Smoke test manual com login real: criar Frente, registrar, editar Frente concluída, excluir registro, recarregar — sem erro; sem `[object Object]`.
3. Se aparecerem erros reais, o texto mostrado em modo DEV traz código/detalhes que permitem corrigir o contrato.
4. Funções SQL transacionais (RPC) para: criar frente+evento, mudar estado+eventos, mover frente+evento, excluir em cascata — adapter passa a usá-las; `ErroParcial` fica só como fallback.
5. Teste e2e de caminho Supabase com rede simulada (`page.route`) cobrindo erro 23502/401/rede.
Só depois: Fase 3 do roadmap (captura/estrutura/import-export na UI).
