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
npm run test:dominio   # 15 suites de domínio/contrato (tsx)
npm run test:e2e       # Playwright (builda e sobe o preview sozinho)
```

`test:e2e` usa o Chromium indicado por `PLAYWRIGHT_BROWSERS_PATH`. Em uma
máquina sem ele: `npx playwright install chromium`.

## Supabase (sync entre dispositivos)

### Instalação NOVA (projeto Supabase vazio)

1. SQL Editor → rode **somente** `supabase-schema-atual.sql`.
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
