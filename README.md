# Pulse

Sistema pessoal de continuidade e percepção — não é agenda, nem lista de
tarefas. Responde "como estão as coisas da minha vida?" a partir de
evidências (registros) e do histórico estrutural.

> Documentos de referência: **`PULSE_PRODUCT_BRIEF.md`** (o que o Pulse é e
> não é, modelo, princípios) e **`PULSE_HANDOFF.md`** (estado técnico real,
> testes, migrações pendentes, próxima tarefa). Este README só cobre
> instalação e uso.

## Rodar localmente

```bash
npm install
npm run dev            # modo local (localStorage) se não houver .env.local
npm run typecheck
npm run build
npm run test:dominio   # 16 suites de domínio/contrato (tsx), sem banco
npm run test:e2e       # Playwright (builda e sobe o preview sozinho)
npm run test:pg        # PostgreSQL REAL: migrations 001–005, rollback, RLS, concorrência
```

`test:e2e` usa o Chromium indicado por `PLAYWRIGHT_BROWSERS_PATH`. Em uma
máquina sem ele: `npx playwright install chromium`.

### Testes com PostgreSQL real (`npm run test:pg`)

Precisa de um PostgreSQL 14+ acessível e de um **superusuário** de teste. O
teste cria bancos temporários `pulse_t_*` (com um shim mínimo do Supabase em
`db-teste/shim-supabase.sql`), aplica ali `supabase-schema*.sql` e as
migrations, e os remove no fim. **Nunca aponte para um banco com dados reais
nem para o Supabase.** Padrão: `postgres://pulse_test:pulse_test@127.0.0.1:5432/postgres`;
outro: `PULSE_TEST_PG_URL=...`. Sem PostgreSQL ele **não executa** e sai com
código 2 (não finge que passou). Exemplo (Debian/Ubuntu):

```bash
sudo pg_ctlcluster 16 main start
sudo -u postgres psql -c "create role pulse_test superuser login password 'pulse_test'"
```

Isto é PostgreSQL, **não** Supabase: não há PostgREST, GoTrue nem JWT reais.

## Supabase (sync entre dispositivos)

### Instalação NOVA (projeto Supabase vazio)

1. SQL Editor → rode `supabase-schema-atual.sql` e, em seguida, `supabase-migration-005-operacoes-atomicas.sql`.
2. Authentication → Users → Add user (conta única; não há cadastro público).
3. Project Settings → API → copie *Project URL* e a chave *anon public*.
4. Local: copie `.env.example` para `.env.local` e preencha. Produção: secrets
   `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` no GitHub Actions.

### Banco EXISTENTE (criado com o schema v1)

`supabase-schema.sql` é o schema **v1 legado** — não o use em instalações
novas. Para atualizar um banco existente, aplique no SQL Editor, **em ordem
e só as que ainda não foram aplicadas**:

1. `supabase-migration-001-aditiva.sql`
2. `supabase-migration-002-bloco2-aditiva.sql`
3. `supabase-migration-003-bloco5-aditiva.sql`
4. `supabase-migration-004-compat-adapter.sql` (relaxa NOT NULL das colunas
   legadas `estado`/`ultimo_toque`/`opt_out_negligencia`; sem isso, salvar
   qualquer Frente falha com erro 23502)

5. `supabase-migration-005-operacoes-atomicas.sql` (funções RPC transacionais:
   criar/editar/mover/excluir Frente e criar/editar/excluir Registro de forma
   atômica). **Aplique a 005 ANTES de publicar esta versão do app**: o app novo
   não grava sem ela (mostra "banco desatualizado"); o app antigo continua
   funcionando com ela aplicada. Em instalação nova, rode também a 005 depois
   de `supabase-schema-atual.sql`.

Nenhuma migration remove colunas ou dados. A remoção das colunas legadas
continua pendente (ver Handoff).

## Instalar no celular (PWA)

Após publicar com HTTPS: Android/Chrome → menu ⋮ → "Instalar aplicativo";
iPhone/Safari → Compartilhar → "Adicionar à Tela de Início".

## Estrutura (resumo)

- `src/types.ts` — modelo (Frente, Registro, EventoEstrutural, Sinal).
- `src/storage.ts`, `src/storage-supabase.ts` — `StorageAdapter` e implementações.
- `src/storage-leitura.ts` — instantâneo de leitura por render (evita N+1).
- `src/erros.ts` — normalização de erros e erros parciais.
- `src/frente-ops.ts`, `src/hierarquia.ts`, `src/portabilidade.ts` — operações de domínio.
- `src/signal.ts`, `estado.ts`, `historico.ts`, `ritmo.ts`, `tendencias.ts`, `periodos.ts`, `registro-query.ts` — leituras derivadas.
- `src/ui.ts`, `src/ui/` — interface (hash routing, sem framework).
- `e2e/` — testes de navegador (Playwright).
