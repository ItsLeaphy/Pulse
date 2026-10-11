import type { Frente, Sinal } from './types'
import type { StorageAdapter } from './storage'

// ============================================================
// MOTOR DE SINAL
// Isso é o coração do produto. Toda tela, toda cor, todo badge
// deriva do que essas funções retornam — nunca o contrário.
//
// Desacoplamento: este módulo NÃO conhece condição operacional
// diretamente. Ele só sabe calcular ritmo a partir de
// (últimoMovimento, cadência, movementExpected). Quem decide se
// existe expectativa de movimento é movementExpected() abaixo —
// a única ponte entre a máquina de estados e o motor de sinal.
//
// Bloco 1: Sinal agora é `Sinal | null`. null = "não há sinal
// aplicável" (frente concluída/arquivada, condição≠normal, ou
// domínio sem filhos) — nunca mais reaproveitado como um rótulo
// tipo 'hibernando'. Ver comentário em types.ts.
// ============================================================

const MS_POR_DIA = 1000 * 60 * 60 * 24

/**
 * Deriva se existe expectativa de movimento a partir do ciclo de
 * vida e da condição operacional da frente.
 */
export function movementExpected(frente: Pick<Frente, 'cicloVida' | 'condição'>): boolean {
  if (frente.cicloVida !== 'ativa') return false
  return frente.condição === 'normal'
}

/**
 * Sinal de UMA frente (folha ou não), baseado só nos próprios
 * dados dela — sem olhar pra filhos. Uma frente-domínio pura
 * (sem registro próprio, sem cadência) não deveria chamar essa
 * função direto; use calcularSinalAgregado.
 *
 * Retorna null sempre que não há expectativa de movimento — isso
 * cobre concluída/arquivada (via movementExpected) e condição
 * diferente de 'normal' (idem), sem distinguir rótulo nenhum
 * entre esses casos: "não avaliado" é "não avaliado".
 */
export function calcularSinal(
  frente: Pick<Frente, 'últimoMovimento' | 'cadênciaEsperada' | 'criadaEm'>,
  expectaMovimento: boolean,
  agora: number = Date.now()
): Sinal {
  if (!expectaMovimento) return null

  // domínio sem cadência própria não tem sinal individual — quem
  // chama com cadênciaEsperada=null deveria estar usando só o
  // rollup (calcularSinalAgregado); por segurança retorna null em
  // vez de fingir qualquer ritmo.
  if (frente.cadênciaEsperada === null) return null

  if (frente.últimoMovimento === null) {
    // nunca teve movimento real registrado — trate como fora do ritmo
    // se já passou da cadência esperada desde a criação
    const diasDesdeCriação = (agora - frente.criadaEm) / MS_POR_DIA
    return diasDesdeCriação > frente.cadênciaEsperada ? 'fora_do_ritmo' : 'no_ritmo'
  }

  const diasDesdeMovimento = (agora - frente.últimoMovimento) / MS_POR_DIA
  const desvio = diasDesdeMovimento / frente.cadênciaEsperada

  if (desvio <= 1) return 'no_ritmo'
  if (desvio <= 2) return 'esfriando'
  return 'fora_do_ritmo'
}

const SEVERIDADE: Record<Exclude<Sinal, null>, number> = {
  no_ritmo: 1,
  esfriando: 2,
  fora_do_ritmo: 3
}

/**
 * Pior sinal entre uma lista — ignora null (ausência de avaliação
 * não deveria "vencer" nem "perder" contra um sinal real: um filho
 * sem sinal aplicável simplesmente não participa da comparação).
 * Se TODOS os sinais forem null (ou a lista for vazia — domínio sem
 * filhos), o resultado é null: não existe dado pra agregar.
 */
function piorSinal(sinais: Sinal[]): Sinal {
  const comDado = sinais.filter((s): s is Exclude<Sinal, null> => s !== null)
  if (comDado.length === 0) return null
  return comDado.reduce((pior, atual) => (SEVERIDADE[atual] > SEVERIDADE[pior] ? atual : pior))
}

/**
 * Sinal agregado — sobe a árvore recursivamente. Frente-domínio
 * herda o pior sinal entre os filhos com dado (não a média, e
 * ignorando filhos sem sinal aplicável): o objetivo é que
 * negligência num filho nunca fique escondida atrás de outros
 * filhos saudáveis. Domínio NUNCA calcula sinal próprio (mesmo
 * tendo cadência e registros) — é sempre só rollup. Domínio sem
 * filhos → null (sem dado pra agregar, não "no_ritmo").
 */
export async function calcularSinalAgregado(
  frenteId: string,
  storage: StorageAdapter,
  agora: number = Date.now()
): Promise<Sinal> {
  const frente = await storage.getFrente(frenteId)
  if (!frente) throw new Error(`Frente ${frenteId} não encontrada`)

  const filhos = (await storage.getFrentes()).filter((f) => f.parentId === frenteId)

  if (filhos.length === 0) {
    if (frente.tipo === 'domínio') return null // domínio-folha vazio: sem dado, não "no_ritmo"
    return calcularSinal(frente, movementExpected(frente), agora)
  }

  const sinalPróprio =
    frente.tipo === 'domínio' ? null : calcularSinal(frente, movementExpected(frente), agora)
  const sinaisFilhos = await Promise.all(filhos.map((f) => calcularSinalAgregado(f.id, storage, agora)))

  return piorSinal(sinalPróprio !== null ? [sinalPróprio, ...sinaisFilhos] : sinaisFilhos)
}

/**
 * Registra movimento real — recalcula últimoMovimento a partir de
 * um timestamp já resolvido. Não é chamado diretamente pela UI;
 * existe para frente-ops.ts usar depois de recalcular o cache a
 * partir dos Registros (ver recalcularÚltimoMovimento).
 */
export function aplicarÚltimoMovimento(frente: Frente, timestamp: number | null): Frente {
  return { ...frente, últimoMovimento: timestamp }
}

/**
 * Sinal agregado de uma frente, junto com QUAIS frentes-folha (sem
 * filhos) determinaram esse pior sinal — usado pelo Bloco 3 para
 * domínios responderem não só "qual o pior sinal" mas "por quê".
 *
 * Reaproveita calcularSinal/movementExpected (não duplica a conta de
 * ritmo) e SEVERIDADE (não duplica a ordem de severidade) — só
 * adiciona o rastreamento de causas por cima do mesmo algoritmo de
 * calcularSinalAgregado. Em caso de empate (vários descendentes com
 * o mesmo pior sinal), TODOS são retidos como causas — determinístico
 * e completo, sem escolher arbitrariamente "um vencedor".
 */
export interface SinalComCausas {
  sinal: Sinal
  /** ids das frentes-folha (sem filhos, tipo≠domínio) cujo sinal
   * individual é igual ao pior sinal agregado. Vazio se sinal=null
   * ou se a frente consultada já é ela mesma uma folha. */
  causas: string[]
}

export async function calcularSinalAgregadoComCausas(
  frenteId: string,
  storage: StorageAdapter,
  agora: number = Date.now()
): Promise<SinalComCausas> {
  const frente = await storage.getFrente(frenteId)
  if (!frente) throw new Error(`Frente ${frenteId} não encontrada`)

  const filhos = (await storage.getFrentes()).filter((f) => f.parentId === frenteId)

  if (filhos.length === 0) {
    if (frente.tipo === 'domínio') return { sinal: null, causas: [] }
    const sinal = calcularSinal(frente, movementExpected(frente), agora)
    return { sinal, causas: [] } // folha não tem "causas" — ela É a causa, não aponta pra si
  }

  const sinalPróprio =
    frente.tipo === 'domínio' ? null : calcularSinal(frente, movementExpected(frente), agora)
  const subResultados = await Promise.all(filhos.map((f) => calcularSinalAgregadoComCausas(f.id, storage, agora)))

  const todosSinais = sinalPróprio !== null ? [sinalPróprio, ...subResultados.map((r) => r.sinal)] : subResultados.map((r) => r.sinal)
  const pior = piorSinal(todosSinais)

  if (pior === null) return { sinal: null, causas: [] }

  // causas: folhas cujo sinal individual bate com o pior, propagadas
  // de baixo pra cima. Se sinalPróprio (deste domínio, teoricamente
  // nunca acontece pois domínio não calcula sinal próprio — mas o
  // tipo permite, então tratamos por completude) igualar o pior, o
  // próprio id entraria; na prática frente.tipo==='domínio' sempre
  // faz sinalPróprio=null, então isso nunca dispara para domínios.
  const causas: string[] = []
  for (let i = 0; i < filhos.length; i++) {
    const sub = subResultados[i]
    if (!sub) continue
    if (sub.sinal === pior) {
      // se o filho é folha (causas vazias e ele não é domínio), ele
      // próprio é a causa; se é domínio, repassa as causas que ele
      // já identificou
      const filho = filhos[i]
      if (filho && filho.tipo !== 'domínio' && sub.causas.length === 0) {
        causas.push(filho.id)
      } else {
        causas.push(...sub.causas)
      }
    }
  }

  return { sinal: pior, causas }
}
