# Pulse

Painel de estado da vida — não é agenda, não é lista de tarefas. Responde
"o que está acontecendo com as coisas que fazem parte da minha vida",
não "o que eu preciso fazer hoje".

## Estado atual: Fase 1, 2 e 3 completas

Motor testado (Fase 1/2) + casca funcional (Fase 3): dá pra criar frentes,
sub-frentes, registrar movimentos e ver o sinal calculado, tudo persistido
em localStorage. Zero identidade visual ainda — isso é a Fase 4.

## Como rodar

```bash
npm install
npm run dev          # abre o app de verdade no navegador (localhost)
npm run typecheck    # confere que os tipos batem
npm run test:motor   # roda o teste com dados de exemplo (Darkline, Violino, etc)
npm run build        # gera versão de produção em dist/
```

Abra `npm run dev`, crie suas frentes reais (Darkline, Darkline Dev,
Origens, Violino, Escola, etc — com as cadências que fizerem sentido pra
cada uma) e use por alguns dias antes de pensar em identidade visual.
Esse uso real é o que valida se a arquitetura aguenta, não teoria.

## Estrutura

- `src/types.ts` — fonte única da verdade. Frente, Registro, Sinal,
  os três formatos de Progresso. Tudo mais importa daqui.
- `src/storage.ts` — `StorageAdapter` (interface) + `LocalStorageAdapter`
  (produção) + `MemoryAdapter` (testes). Nenhuma outra parte do código
  deve chamar `localStorage` diretamente — trocar de storage no futuro
  (ex: sincronização real) é escrever uma nova classe, não reescrever
  a lógica.
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
