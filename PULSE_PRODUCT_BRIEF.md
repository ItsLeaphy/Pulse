# PULSE — PRODUCT BRIEF

Documento permanente de produto. Descreve **o que o Pulse é**, o que não é,
o modelo e os princípios. Estado técnico, testes e pendências de execução
ficam em `PULSE_HANDOFF.md` (não repetidos aqui). Decisões marcadas
**[PENDENTE]** ainda não foram tomadas — não devem ser tratadas como definidas.

## 1. Propósito

O Pulse é uma ferramenta pessoal de **continuidade e percepção**. Pergunta
central:

> "Como estão as coisas da minha vida?"

e, a partir dela: como cada coisa está agora, o que aconteceu, o que mudou, o
que está andando, o que parou, o que está bloqueado ou aguardando, o que está
mudando ao longo do tempo e se há algum padrão a perceber.

Ele **observa, registra e torna compreensível** a continuidade da vida; não
controla nem gerencia o usuário. O usuário não alimenta métricas: registra
**acontecimentos**.

## 2. Problema

Três perdas, que o Pulse existe para reduzir:

1. **Continuidade** — saber que algo existe, mas não quando foi mexido de fato.
2. **Contexto** — lembrar o nome, mas não o estado, a decisão mais recente, onde parou.
3. **Visão geral** — com muitas frentes, não perceber quais avançam, quais param,
   quais estão sendo abandonadas sem querer.

## 3. Arquitetura conceitual

```
vida → frentes → acontecimentos → evidências → continuidade → estado → padrões → compreensão
```

- O **registro é evidência**; o **histórico é memória**; o **estado é
  interpretação derivada**; a **estrutura (hierarquia) dá contexto**; a
  **tendência mostra direção**; a **interface transforma isso em compreensão**,
  não em mais uma camada de gerenciamento.
- O sinal é só a camada de atenção; **a continuidade registrada é o produto**.

## 4. Entidades e distinções

| Conceito | O que é |
|---|---|
| **Frente** | Unidade fundamental: algo que existe na vida e tem continuidade própria. Não é tarefa ("Origens" é frente; "tela de login" é tarefa). Campos: nome, área (work/life/art), tipo, pai (`parentId`), ciclo de vida, condição, cadência esperada (ou nenhuma), contexto de foco/bloqueio, pausa (motivo/retomada), `criadaEm`, `últimoMovimento` (cache derivado). |
| **Registro** | Evidência: algo que aconteceu ou foi percebido. `data` = quando o acontecimento ocorreu; `criadoEm` = quando foi registrado (a UI nunca confunde nem deixa o usuário alterar `criadoEm`). `contaComoMovimento` indica se redefine o relógio de ritmo. |
| **Evento estrutural** | Mudança objetiva gerada **pelo sistema**, nunca escrita pelo usuário: criação, mudança de ciclo de vida, de condição, de cadência, de hierarquia. |
| **Sinal** | Leitura **derivada** de ritmo: `no_ritmo`, `esfriando`, `fora_do_ritmo`, ou `null` (não aplicável). Nunca editado manualmente. "Negligenciado" é a leitura de `fora_do_ritmo`, não um valor novo. |
| **Condição** | Situação operacional de uma frente ativa: `normal`, `bloqueada` (há impedimento a resolver), `aguardando` (depende de algo/alguém, sem ação interna), `pausada` (interrupção intencional). Não é "ruim"; nenhuma é negligência. |
| **Ciclo de vida** | `ativa`, `concluída`, `arquivada`. Concluída/arquivada tornam a condição `normal` e o sinal `null`. |

**Tipos de frente** (escolhidos manualmente, nunca inferidos): `projeto` (tem
escopo, pode terminar), `prática` (recorrente, sem fim), `domínio` (agrupa outras
frentes; **não tem cadência nem sinal próprios** — o sinal é o pior entre os
descendentes e as causas são preservadas, inclusive em empate; domínio vazio é
"sem sinal aplicável", nunca "no ritmo"). Domínios podem ter registros próprios,
mas eles não mascaram o rollup dos filhos.

**Três dimensões que não se misturam:** ciclo de vida × condição × sinal. O
sinal responde só "há movimento dentro do ritmo esperado?". O acoplamento entre
condição e sinal é um único booleano: `movementExpected` = ativa **e** normal.

## 5. Princípios invioláveis

1. **Registro é a fonte de verdade**; `últimoMovimento` é cache recalculado do zero a cada mutação de registro.
2. **Sem heurística de texto** para classificar registros; sem IA como fonte de dado. Qualquer inferência futura é auxiliar.
3. **Sem score**: nada de nota de vida, produtividade, ranking, % de aproveitamento, gamificação, streak.
4. **Sem prioridade como conceito central.** Destaque, se necessário, por escopo/domínio/relevância justificável — sem pontuação. **[PENDENTE: noção de relevância]**
5. **Eventos estruturais são gerados no momento da mudança**; histórico de estado nunca é reconstruído a partir de texto.
6. **Cadência é expectativa de atenção, não deadline.** O sistema pode sugerir calibração; **nunca** altera cadência, condição ou ciclo de vida sozinho.
7. **Arquivar antes de excluir.** Exclusão permanente existe, separada e claramente destrutiva.
8. **Derivado, explicável, reversível:** tudo calculado é determinístico (mesmos dados + mesma referência temporal = mesmo resultado) e mostra por quê.
9. **A interface não expõe a arquitetura.** Nada de telas "Sinal"/"EventoEstrutural"; o usuário lê "esfriando porque faz 12 dias sem movimento e a cadência é 7".
10. **Ausência de evidência é dita como tal** ("não há dados" ≠ "estável").
11. **Migrações sempre aditivas**; remoção de legado só após validação.
12. **Dados do usuário não dependem do Supabase**: export/import JSON versionado é parte do produto.

**O Pulse NÃO é:** gerenciador de tarefas, calendário, checklist, Kanban, ERP/CRM,
sistema de metas/OKR, dashboard de KPIs, habit tracker tradicional, sistema de
notificações agressivas, nem assistente que decide o que importa.

## 6. Arquitetura técnica (conforme o código)

- **TypeScript + Vite**, PWA (`vite-plugin-pwa`), roteamento por hash, sem framework de UI (HTML por template strings, `src/ui.ts`).
- **`StorageAdapter`** (interface assíncrona única): `LocalStorageAdapter` (modo local), `MemoryAdapter` (testes), `SupabaseAdapter` (produção; RLS; login único). Nenhum outro código toca `localStorage`/Supabase diretamente.
- **Camada de domínio** (sem UI): `frente-ops` (criar/editar/mudar estado/excluir; único gerador de eventos e único recalculador de `últimoMovimento`), `hierarquia` (mover com prevenção de ciclo), `portabilidade` (export/import validado), `signal` (motor de sinal), `estado`, `historico` (histórico unificado + retrospectiva), `registro-query` (registro global e busca), `ritmo`, `tendencias`, `periodos`.
- **Leitura por render:** `storage-leitura` cria um instantâneo em memória (frentes/registros/eventos lidos uma vez) por renderização.
- **Erros:** `erros.ts` normaliza qualquer valor lançado.
- **Consistência (decisão permanente):** toda operação composta de Frente/Registro (criar/editar/mover/excluir Frente com eventos; criar/editar/excluir Registro com recálculo de `últimoMovimento`; exclusão em cascata) é **uma única operação atômica do `StorageAdapter`** — tudo ou nada. No Supabase = função RPC (uma transação Postgres, `SECURITY INVOKER`, RLS preservada); no local/memória = cálculo puro + gravação com reversão. `últimoMovimento` é sempre derivado dos registros dentro da operação. Edição usa compare-and-swap (estado "esperado") para nunca sobrescrever alteração mais recente. As regras de domínio continuam em TypeScript (`frente-ops`); o SQL só garante atomicidade, concorrência e segurança.
- **UI:** Home (leitura editorial), Frentes (árvore), Frente (estado → histórico → ritmo/tendência → retrospectiva → editar), Registrar, Buscar. Tema escuro, mobile primeiro.

Detalhes verificáveis (arquivos, testes, bugs) estão no Handoff.

## 7. Roadmap

**Arquitetura funcional (Blocos 1–6): implementada.** Integridade do núcleo,
memória (histórico/retrospectiva), percepção de estado, captura/busca,
estrutura/portabilidade, padrões/tendências.

**Interface:**
- Fase 1 — fundação visual + shell: feita.
- Fase 2 — experiência central (Frentes, Frente, Home): feita.
- **Fase A — estabilização técnica: esta fase** (erros, contrato Supabase, consistência, desempenho, testes de navegador).
- Fase 3 — captura, busca e estrutura na UI: registro rápido, filtros, timeline, árvore, **reparenting, import/export na UI**, confirmações estruturais. *(não iniciada)*
- Fase 4 — padrões e retrospectiva na UI: ritmo, tendência, comparação de períodos, sugestão de cadência, confiança qualitativa; depois refinamento geral. *(não iniciada)*

**Adiado por decisão:** relações entre frentes (depende_de/financia/deriva_de), Weekly Update, classificação manual opcional de registros.

## 8. Decisões consolidadas

- Ciclo de vida, condição e sinal separados; bloqueada ≠ aguardando; nenhuma é penalizada pelo sinal.
- Sinal é `Sinal | null`; `hibernando` deixou de existir (o conceito é a condição `pausada`).
- `optOutNegligência` → `pausada`; `pausada_por_decisão` → `ativa` + `pausada`; Marco/Progresso removidos.
- Reativar (concluída/arquivada → ativa) leva a condição a `normal`; o histórico preserva a anterior.
- Eventos estruturais: criação, ciclo de vida, condição, cadência, hierarquia. Nem toda edição vira evento (ex.: renomear não gera).
- `últimoToque` removido do modelo (abrir uma frente não é evidência).
- Domínio sem cadência própria; pode ter registros próprios.
- Períodos são semiabertos `[início, fim)`; funções temporais recebem a referência de tempo explicitamente.
- Retrospectiva é dado estruturado; texto é só apresentação. Se existir Weekly Update, será dado estruturado + rascunho editável (não implementado).
- Navegação principal: **Home · Frentes · Registrar · Buscar**.
- Export/import: validação completa antes de escrever; rejeita colisão de ids; sem merge silencioso.

## 9. Questões abertas

- **[PENDENTE]** `condicao_contexto`: campo único para bloqueio/espera ou um por condição? (hoje há `contextoBloqueio` e `pausaMotivo`; "aguardando" não tem motivo próprio.)
- **[PENDENTE]** Relatório de conversão `optOutNegligência → pausada` sobre os **dados reais**: a remoção de `estado`/`opt_out_negligencia`/`ultimo_toque` depende de Dani validá-lo.
- **[PENDENTE]** Migration de remoção das colunas legadas (só após o item acima).
- **[PENDENTE]** Noção de "relevância" para destaque em Home/relatórios sem pontuação.
- **[PENDENTE]** Weekly Update: formato, escopo e edição antes de exportar (decidido só o princípio: dado estruturado primeiro, texto depois, editável).
- **[PENDENTE]** Relações entre frentes (adiadas).
- **[PENDENTE]** Classificação manual opcional de registros (o sistema não pode depender dela).
- **[PENDENTE]** Importação (`importarPulse`) ainda não é atômica (parcial + `completar` em memória); fora do escopo da atomicidade até hoje.
