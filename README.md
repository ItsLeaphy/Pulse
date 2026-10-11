# Pulse

Painel de estado da vida — não é agenda, não é lista de tarefas. Responde
"o que está acontecendo com as coisas que fazem parte da minha vida",
não "o que eu preciso fazer hoje".

## Estado atual: Fase 1, 2 e 3 completas + PWA + sync via Supabase

Motor testado, casca funcional, instalável como app no celular, e
sincronizando entre dispositivos via Supabase quando configurado. Sem
configuração, o app cai automaticamente pro modo local (localStorage) —
bom pra desenvolver sem depender de rede.

## Como rodar localmente

```bash
npm install
npm run dev          # abre o app no navegador (localhost)
npm run typecheck    # confere que os tipos batem
npm run test:motor   # roda o teste com dados de exemplo
npm run build        # gera versão de produção em dist/
```

## Configurar o Supabase (sync entre PC e celular)

1. Crie uma conta em [supabase.com](https://supabase.com) e um projeto novo (grátis).
2. No painel do projeto, vá em **SQL Editor** e rode o conteúdo de
   `supabase-schema.sql` (na raiz deste repo) — isso cria as tabelas
   `frentes` e `registros` já com RLS (row-level security) ativado,
   garantindo que só você enxerga seus próprios dados mesmo com o
   repositório público.
3. Vá em **Authentication → Users → Add user** e crie seu próprio
   usuário (email + senha). Não existe tela de cadastro público no
   app de propósito — é uma conta só, a sua.
4. Vá em **Project Settings → API** e copie a **Project URL** e a
   chave **anon public** (não a `service_role`, essa nunca deve sair
   do painel).
5. Localmente: copie `.env.example` pra `.env.local` e cole os dois
   valores.
6. No GitHub, vá em **Settings → Secrets and variables → Actions** e
   crie dois secrets: `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`
   (mesmos valores do passo 4). Isso é o que permite a Action de
   deploy buildar com o Supabase habilitado em produção.
7. `npm run dev` local e o site publicado agora pedem login (a mesma
   conta que você criou no passo 3) e sincronizam os mesmos dados.

A chave anon é segura de expor publicamente — é assim que o Supabase
funciona. Quem protege os dados é a RLS do passo 2, não o segredo da
chave.

## Instalar no celular

Depois de publicado com HTTPS (GitHub Pages já serve assim), abra o
link no celular:
- **Android/Chrome**: vai aparecer um banner "Instalar app" sozinho,
  ou use o menu ⋮ → "Instalar aplicativo".
- **iPhone/Safari**: toque em Compartilhar → "Adicionar à Tela de
  Início".

Em ambos os casos ele abre em tela cheia, sem barra de navegador,
como um app de verdade.

## Estrutura

- `src/types.ts` — fonte única da verdade. Frente, Registro, Sinal,
  os três formatos de Progresso. Tudo mais importa daqui.
- `src/storage.ts` — `StorageAdapter` (interface, agora assíncrona) +
  `LocalStorageAdapter` (modo offline) + `MemoryAdapter` (testes).
  Nenhuma outra parte do código deve chamar `localStorage` diretamente.
- `src/storage-supabase.ts` — `SupabaseAdapter`, segunda implementação
  da mesma interface, agora contra Postgres via Supabase. Prova viva de
  que trocar de storage é escrever uma classe nova, não reescrever a
  lógica de negócio.
- `src/auth.ts` — tela de login mínima (email/senha via Supabase Auth),
  exigida só quando o Supabase está configurado.
- `src/signal.ts` — o coração do produto. `calcularSinal` avalia uma
  frente sozinha; `calcularSinalAgregado` sobe a árvore recursivamente,
  herdando o **pior** sinal entre os filhos (não a média) — assim um
  projeto esquecido nunca fica escondido atrás de outros saudáveis.
- `src/test-motor.ts` — teste manual com dados representativos
  (Darkline > Darkline Dev > Origens, Violino, Escola, Finanças).
- `src/id.ts` — gerador de id, isolado num único lugar.
- `src/ui.ts` — router por hash + toda a renderização da Fase 3.
  Home lista frentes-raiz por área com sinal; clicar entra na frente
  e mostra sub-frentes, formulário de registro e histórico. Sem CSS
  além do essencial pra leitura — a Fase 4 troca a aparência aqui
  sem tocar em `storage.ts` ou `signal.ts`.
- `src/main.ts` — ponto de entrada, instancia `LocalStorageAdapter`
  e monta a UI.

## Decisões já travadas (não reabrir sem motivo forte)

- **TypeScript com build (Vite)** desde o início — erro de tipo aparece
  escrevendo código, não em produção três semanas depois.
- **Tipo de frente** (`projeto` / `prática` / `domínio`) é escolhido
  manualmente na criação — o sistema não infere sozinho.
- **Aninhamento recursivo sem limite no dado**, mas a UI deve expor no
  máximo 2 níveis por vez (pai + filho direto) para não virar árvore
  de pastas.
- **Sinal nunca é editado manualmente.** Só existe hibernando (opt-out
  explícito), no_ritmo, esfriando, fora_do_ritmo — calculados, nunca
  digitados.
- **Progresso tem três motores diferentes por tipo** — nunca uma
  porcentagem genérica sem marcos definidos por trás.

## Próximas fases

- **Fase 4** — identidade visual (DNA do Protocolo Toji: tipografia,
  textura, grid invisível, dark mode) aplicada em cima da casca que
  já funciona.
- **Fase 5** — home inteligente: mostra só desvios do padrão, não
  todas as frentes. Progresso (marcos pra projeto, critérios pra
  prática) também entra aqui — a Fase 3 ainda não tem UI pra isso.
- **Fase 6** — responsivo, PWA, polimento.

## Notas pra continuidade entre sessões

Este projeto não roda dentro do Claude — sem Claude Code, cada conversa
nova começa sem acesso aos arquivos daqui. Pra continuar depois: suba
isso num repositório no GitHub e cole a URL na próxima conversa (o
ambiente consegue clonar github.com diretamente); o push de volta
continua manual, do seu lado.
