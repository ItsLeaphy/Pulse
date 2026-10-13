import type { StorageAdapter } from './storage'
import type { Frente, Registro, CicloVida, Condição, EventoEstrutural } from './types'
import { novoId } from './id'
import { ErroValidação } from './erros'
import { descendentesDe } from './storage-atomico'

// ============================================================
// OPERAÇÕES DE FRENTE E DE REGISTRO
// Lógica que coordena múltiplas chamadas de storage. Fica fora
// da UI (que só deve renderizar e delegar) e fora de storage.ts
// (que só deve ler/escrever uma linha por vez).
//
// Este é o único lugar que deve gerar EventoEstrutural. A UI nunca
// deve chamar storage.salvarRegistro / storage.salvarFrente
// diretamente para essas mutações — sempre por aqui.
//
// CONSISTÊNCIA: cada operação daqui decide o que mudar (regras de
// domínio, em TypeScript) e entrega ao storage UMA chamada atômica
// (salvarFrenteComEventos / salvarRegistroComCache /
// removerRegistroComCache / removerFrenteEmCascata). No Supabase isso é
// uma função RPC = uma transação do Postgres; nos adapters locais, um
// cálculo puro seguido de gravação com reversão. Resultado: nunca
// existe "frente salva sem o evento" nem "registro salvo sem o cache
// atualizado". Frente.últimoMovimento é recalculado pelo storage, a
// partir dos registros, dentro da mesma transação.
// ============================================================

/**
 * Exportada (não só interna a este arquivo) para que hierarquia.ts
 * também possa gerar EventoEstrutural sem duplicar esta função —
 * continua sendo a ÚNICA função que escreve na tabela de eventos em
 * todo o código; nenhum outro módulo deve chamar
 * storage.salvarEventoEstrutural diretamente.
 */
export function montarEvento(
  frenteId: string,
  tipo: EventoEstrutural['tipo'],
  valorAnterior: string | null,
  valorNovo: string | null,
  agora: number = Date.now()
): EventoEstrutural {
  return { id: novoId(), frenteId, tipo, valorAnterior, valorNovo, criadoEm: agora }
}

// ============================================================
// REGISTRO — Registro é a fonte de verdade; Frente.últimoMovimento
// é cache derivado. Toda mutação de registro passa por aqui, que
// sempre termina recalculando o cache a partir do storage real
// (não incrementalmente) — mais simples e impossível de divergir.
// ============================================================

/**
 * Cria um registro e recalcula o cache da frente associada.
 *
 * `data` = quando o fato aconteceu (controlada pelo chamador — pode
 * ser retroativa). `criadoEm` = quando o registro foi inserido no
 * sistema; default Date.now() quando o chamador não especifica
 * (caso comum: registro não-retroativo, onde as duas datas coincidem).
 * `criadoEm` nunca participa de últimoMovimento/sinal/histórico/
 * retrospectiva — é só proveniência.
 */
export async function criarRegistro(
  storage: StorageAdapter,
  dados: Omit<Registro, 'id' | 'criadoEm'> & { id?: string; criadoEm?: number }
): Promise<Registro> {
  const registro: Registro = {
    ...dados,
    id: dados.id ?? novoId(),
    criadoEm: dados.criadoEm ?? Date.now()
  }
  // idempotente por id: repetir (resposta perdida) não duplica nem sobrescreve
  const { registro: gravado } = await storage.salvarRegistroComCache(registro, null)
  return gravado
}

/**
 * Edita um registro existente e recalcula o cache — necessário
 * mesmo que só `texto` tenha mudado, porque não dá pra saber de
 * fora se `contaComoMovimento` ou `data` também mudaram sem
 * comparar; recalcular do zero é mais simples e sempre correto.
 */
export async function editarRegistro(
  storage: StorageAdapter,
  id: string,
  mudanças: Partial<Omit<Registro, 'id' | 'frenteId'>>,
  frenteIdConhecida?: string
): Promise<Registro> {
  const atual = await encontrarRegistro(storage, id, frenteIdConhecida)
  if (!atual) throw new Error(`Registro ${id} não encontrado`)

  const atualizado: Registro = { ...atual, ...mudanças }
  // `atual` é o estado que o chamador viu: se mudou em outro lugar, o storage recusa (conflito)
  const { registro } = await storage.salvarRegistroComCache(atualizado, atual)
  return registro
}

/**
 * Exclui um registro e recalcula o cache da frente associada (juntos,
 * numa operação atômica). Idempotente: registro que já não existe é
 * no-op. `frenteIdConhecida` é mantido por compatibilidade de contrato
 * e não é mais necessário: o storage sabe a frente do registro.
 */
export async function excluirRegistro(storage: StorageAdapter, id: string, _frenteIdConhecida?: string): Promise<void> {
  await storage.removerRegistroComCache(id)
}

/**
 * StorageAdapter não tem getRegistro(id). Com a frente conhecida (a UI
 * sempre sabe), lê só os registros dela; sem a dica, uma única leitura
 * em lote — nunca mais uma consulta por frente.
 */
async function encontrarRegistro(
  storage: StorageAdapter,
  id: string,
  frenteIdConhecida?: string
): Promise<Registro | undefined> {
  if (frenteIdConhecida) {
    const achado = (await storage.getRegistros(frenteIdConhecida)).find((r) => r.id === id)
    if (achado) return achado
  }
  return (await storage.getTodosRegistros()).find((r) => r.id === id)
}

// ============================================================
// FRENTE — criação e mudanças de dimensão de estado
// ============================================================

function validarCadência(c: number | null): void {
  if (c !== null && (!Number.isFinite(c) || c <= 0)) {
    throw new ErroValidação('A cadência precisa ser um número de dias maior que zero (ou ficar em branco).')
  }
}

/**
 * Cria uma frente nova e grava o evento de criação.
 *
 * Atômica e idempotente por id: repetir a chamada com o mesmo `id`
 * (resposta perdida) NÃO duplica a frente nem o evento de criação — se a
 * frente já existe, ela é preservada como está (não zera últimoMovimento
 * nem criadaEm).
 */
export async function criarFrente(
  storage: StorageAdapter,
  dados: Omit<Frente, 'criadaEm' | 'últimoMovimento'> & { criadaEm?: number }
): Promise<Frente> {
  if (dados.nome.trim() === '') throw new ErroValidação('Dê um nome para a frente.')
  validarCadência(dados.cadênciaEsperada)
  if (dados.parentId !== null && !(await storage.getFrente(dados.parentId))) {
    throw new ErroValidação('A frente-mãe não existe mais. Volte e escolha outra.')
  }

  const frente: Frente = { ...dados, criadaEm: dados.criadaEm ?? Date.now(), últimoMovimento: null }
  const evento = montarEvento(frente.id, 'criação', null, null, frente.criadaEm)
  // frente + evento de criação numa só transação. Idempotente por id:
  // se já existe (retry de resposta perdida), nada é sobrescrito e
  // nenhum evento extra é criado.
  const { frente: salva } = await storage.salvarFrenteComEventos(frente, [evento], null)
  return salva
}

/**
 * Atualiza ciclo de vida de uma frente, gerando o evento estrutural
 * correspondente quando o valor realmente muda.
 *
 * Invariantes da máquina de estados (decisão de produto fechada):
 * - cicloVida='concluída' ou 'arquivada' força condição='normal' —
 *   condição operacional não faz sentido para algo que já terminou;
 *   não se avalia mais bloqueio/espera/pausa de algo encerrado.
 * - reativar (concluída/arquivada → ativa) também força
 *   condição='normal' — NÃO restaura a condição anterior. O
 *   histórico de eventos já preserva qual era a condição antes de
 *   concluir/arquivar; "estava bloqueada antes de terminar" não
 *   deveria significar "continua bloqueada ao reabrir".
 * Se a mudança de condição embutida nessas regras também for uma
 * mudança real de valor, gera o evento 'condição_mudou' também,
 * além do 'ciclo_vida_mudou' — são duas mudanças reais acontecendo
 * juntas, cada uma com seu próprio evento.
 */
export async function mudarCicloVida(
  storage: StorageAdapter,
  frenteId: string,
  novoCicloVida: CicloVida,
  agora: number = Date.now()
): Promise<Frente> {
  const atual = await storage.getFrente(frenteId)
  if (!atual) throw new Error(`Frente ${frenteId} não encontrada`)
  if (atual.cicloVida === novoCicloVida) return atual

  // qualquer transição de cicloVida (incluindo reativação) força condição=normal
  const novaCondição: Condição = 'normal'
  const condiçãoMudou = atual.condição !== novaCondição

  const atualizada: Frente = { ...atual, cicloVida: novoCicloVida, condição: novaCondição }
  const eventos = [montarEvento(frenteId, 'ciclo_vida_mudou', atual.cicloVida, novoCicloVida, agora)]
  if (condiçãoMudou) {
    eventos.push(montarEvento(frenteId, 'condição_mudou', atual.condição, novaCondição, agora))
  }
  return (await storage.salvarFrenteComEventos(atualizada, eventos, atual)).frente
}

/**
 * Atualiza condição operacional de uma frente, gerando o evento
 * estrutural correspondente quando o valor realmente muda.
 *
 * Invariante: só é possível mudar condição enquanto cicloVida='ativa'.
 * Para concluída/arquivada a condição é sempre 'normal' e só muda
 * via mudarCicloVida (reativação) — chamar isso numa frente não-ativa
 * é erro de uso da operação, não um caso válido a tratar em silêncio.
 */
export async function mudarCondição(
  storage: StorageAdapter,
  frenteId: string,
  novaCondição: Condição,
  agora: number = Date.now()
): Promise<Frente> {
  const atual = await storage.getFrente(frenteId)
  if (!atual) throw new Error(`Frente ${frenteId} não encontrada`)
  if (atual.condição === novaCondição) return atual // sem mudança = sem erro, mesmo em frente não-ativa
  if (atual.cicloVida !== 'ativa') {
    throw new Error(
      `Frente ${frenteId} não está ativa (cicloVida=${atual.cicloVida}) — condição operacional não se aplica`
    )
  }

  const atualizada: Frente = { ...atual, condição: novaCondição }
  const eventos = [montarEvento(frenteId, 'condição_mudou', atual.condição, novaCondição, agora)]
  return (await storage.salvarFrenteComEventos(atualizada, eventos, atual)).frente
}

/**
 * Atualiza cadência esperada, gerando o evento estrutural
 * correspondente quando o valor realmente muda.
 */
export async function mudarCadência(
  storage: StorageAdapter,
  frenteId: string,
  novaCadência: number | null,
  agora: number = Date.now()
): Promise<Frente> {
  const atual = await storage.getFrente(frenteId)
  if (!atual) throw new Error(`Frente ${frenteId} não encontrada`)
  if (atual.cadênciaEsperada === novaCadência) return atual
  validarCadência(novaCadência)

  const atualizada: Frente = { ...atual, cadênciaEsperada: novaCadência }
  const eventos = [
    montarEvento(
      frenteId,
      'cadência_mudou',
      atual.cadênciaEsperada === null ? null : String(atual.cadênciaEsperada),
      novaCadência === null ? null : String(novaCadência),
      agora
    )
  ]
  return (await storage.salvarFrenteComEventos(atualizada, eventos, atual)).frente
}

/**
 * Edição de frente em UMA operação atômica (nome, área, tipo, contexto,
 * ciclo de vida, condição, cadência) + os eventos estruturais das
 * mudanças reais, tudo na mesma transação. Substitui a sequência
 * salvarFrente + mudarCicloVida + mudarCondição + mudarCadência (4+
 * gravações que podiam parar no meio e que falhavam em qualquer frente
 * concluída/arquivada).
 *
 * Mesmas invariantes de mudarCicloVida/mudarCondição: sair/entrar de
 * 'ativa' leva a condição a 'normal'; condição só vale em frente ativa
 * (para concluída/arquivada o campo de condição do formulário é
 * ignorado, não é erro).
 */
export interface EdiçãoFrente {
  nome: string
  área: Frente['área']
  tipo: Frente['tipo']
  cicloVida: CicloVida
  condição: Condição
  cadênciaEsperada: number | null
  contextoFoco: string | null
  contextoBloqueio: string | null
}

export async function editarFrente(
  storage: StorageAdapter,
  frenteId: string,
  edição: EdiçãoFrente,
  agora: number = Date.now()
): Promise<Frente> {
  const atual = await storage.getFrente(frenteId)
  if (!atual) throw new ErroValidação('Esta frente não existe mais.')
  const nome = edição.nome.trim()
  if (nome === '') throw new ErroValidação('Dê um nome para a frente.')
  validarCadência(edição.cadênciaEsperada)

  const cicloMudou = atual.cicloVida !== edição.cicloVida
  // condição após a regra de ciclo de vida (qualquer transição zera) e
  // depois a escolha do usuário, que só vale com a frente ativa
  const condiçãoApósCiclo: Condição = cicloMudou ? 'normal' : atual.condição
  const condiçãoFinal: Condição = edição.cicloVida === 'ativa' ? edição.condição : 'normal'

  const atualizada: Frente = {
    ...atual,
    nome,
    área: edição.área,
    tipo: edição.tipo,
    cicloVida: edição.cicloVida,
    condição: condiçãoFinal,
    cadênciaEsperada: edição.cadênciaEsperada,
    contextoFoco: edição.contextoFoco,
    contextoBloqueio: edição.contextoBloqueio
  }

  const eventos: EventoEstrutural[] = []
  if (cicloMudou) {
    eventos.push(montarEvento(frenteId, 'ciclo_vida_mudou', atual.cicloVida, edição.cicloVida, agora))
    if (atual.condição !== condiçãoApósCiclo) {
      eventos.push(montarEvento(frenteId, 'condição_mudou', atual.condição, condiçãoApósCiclo, agora))
    }
  }
  if (condiçãoApósCiclo !== condiçãoFinal) {
    eventos.push(montarEvento(frenteId, 'condição_mudou', condiçãoApósCiclo, condiçãoFinal, agora))
  }
  if (atual.cadênciaEsperada !== edição.cadênciaEsperada) {
    eventos.push(
      montarEvento(
        frenteId,
        'cadência_mudou',
        atual.cadênciaEsperada === null ? null : String(atual.cadênciaEsperada),
        edição.cadênciaEsperada === null ? null : String(edição.cadênciaEsperada),
        agora
      )
    )
  }

  const mudouAlgo = eventos.length > 0 || JSON.stringify(atual) !== JSON.stringify(atualizada)
  if (!mudouAlgo) return atual

  return (await storage.salvarFrenteComEventos(atualizada, eventos, atual)).frente
}

// ============================================================
// EXCLUSÃO EM CASCATA (destrutiva — ver nota no fim do arquivo)
// ============================================================

export { descendentesDe }

/** Todos os ids descendentes de uma frente — uma única leitura de frentes. */
export async function coletarDescendentes(id: string, storage: StorageAdapter): Promise<string[]> {
  return descendentesDe(id, await storage.getFrentes())
}

/**
 * Exclui uma frente, todos os seus descendentes e todos os registros
 * e eventos estruturais associados — numa única operação atômica
 * (no Supabase: função RPC / uma transação; nos adapters locais:
 * cálculo puro + gravação com reversão). Ou some tudo, ou nada muda:
 * não existe mais "exclusão pela metade". Idempotente: frente que já
 * não existe é no-op.
 *
 * Operação destrutiva separada — a 2.0 prioriza arquivar
 * (mudarCicloVida para 'arquivada') sobre excluir; esta função é só
 * para a exclusão permanente deliberada.
 */
export async function excluirFrenteComFilhos(id: string, storage: StorageAdapter): Promise<void> {
  await storage.removerFrenteEmCascata(id)
}
