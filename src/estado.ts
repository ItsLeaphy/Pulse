import type { StorageAdapter } from './storage'
import type { Frente, CicloVida, Condição, Sinal } from './types'
import { calcularSinalAgregado, calcularSinalAgregadoComCausas } from './signal'
import { coletarDescendentes } from './frente-ops'

// ============================================================
// ESTADO DERIVADO — BLOCO 3 ("Percepção")
//
// Tudo aqui é LEITURA. Nenhuma função deste módulo persiste nada
// novo — é uma camada de síntese por cima de signal.ts e dos
// dados crus de storage, pensada pra UI (ainda não escrita neste
// bloco) consumir sem precisar remontar essa lógica sozinha.
//
// Não duplica: usa calcularSinalAgregado/calcularSinalAgregadoComCausas
// de signal.ts para sinal, e EventoEstrutural crus de storage para
// duração de condição — nunca recalcula ritmo nem reimplementa a
// comparação de severidade.
// ============================================================

const MS_POR_DIA = 1000 * 60 * 60 * 24

// ---- Duração da condição atual -----------------------------------

/**
 * Há quanto tempo a condição atual está vigente, segundo o último
 * evento `condição_mudou` registrado (ou `criação`, se a frente
 * nunca mudou de condição desde que foi criada — a condição inicial
 * também "começou" em algum momento, e criação é esse momento).
 *
 * Retorna `null` quando não há evento suficiente pra afirmar isso
 * com confiança (ex: frente migrada de um modelo anterior sem
 * histórico de condição) — nunca inventa uma data.
 */
export interface DuraçãoCondição {
  desde: number // timestamp do evento que estabeleceu a condição atual
  dias: number
}

export async function obterDuraçãoCondição(
  storage: StorageAdapter,
  frenteId: string,
  agora: number = Date.now()
): Promise<DuraçãoCondição | null> {
  const eventos = await storage.getEventosEstruturais(frenteId)

  // o evento condição_mudou mais recente marca quando a condição
  // ATUAL começou a valer
  const mudançasCondição = eventos
    .filter((e) => e.tipo === 'condição_mudou')
    .sort((a, b) => b.criadoEm - a.criadoEm)

  let desde: number | null = mudançasCondição[0]?.criadoEm ?? null

  // se nunca mudou de condição, a condição atual é a condição
  // inicial — "desde" é o momento de criação, se esse evento existir
  if (desde === null) {
    const criação = eventos.find((e) => e.tipo === 'criação')
    desde = criação?.criadoEm ?? null
  }

  if (desde === null) return null // sem evento suficiente — não inventa data

  return { desde, dias: (agora - desde) / MS_POR_DIA }
}

// ---- Pausa ----------------------------------------------------------

export type LeituraPausa =
  | { tipo: 'sem_pausa' }
  | { tipo: 'pausa_sem_data' }
  | { tipo: 'pausa_com_data_futura'; retomadaEm: number; diasRestantes: number }
  | { tipo: 'pausa_vencida'; retomadaEm: number; diasVencida: number }

/**
 * Lê pausaRetomadaEm sem jamais alterar a condição ou gerar evento —
 * só classifica o que já está lá. Pausa vencida é só sinalizada,
 * nunca convertida automaticamente para 'normal' (decisão de produto
 * já fechada antes do Bloco 3, reforçada aqui).
 */
export function obterLeituraPausa(
  frente: Pick<Frente, 'condição' | 'pausaRetomadaEm'>,
  agora: number = Date.now()
): LeituraPausa {
  if (frente.condição !== 'pausada') return { tipo: 'sem_pausa' }
  if (frente.pausaRetomadaEm === null) return { tipo: 'pausa_sem_data' }

  const diffDias = (frente.pausaRetomadaEm - agora) / MS_POR_DIA
  if (diffDias >= 0) {
    return { tipo: 'pausa_com_data_futura', retomadaEm: frente.pausaRetomadaEm, diasRestantes: diffDias }
  }
  return { tipo: 'pausa_vencida', retomadaEm: frente.pausaRetomadaEm, diasVencida: -diffDias }
}

// ---- Movimento --------------------------------------------------------

export type LeituraMovimento =
  | { tipo: 'sem_movimento_esperado' } // condição/ciclo de vida não espera movimento
  | { tipo: 'nunca_movimentou' } // movimento esperado, mas nunca houve registro de movimento
  | { tipo: 'movimentou'; últimoMovimento: number; diasDesde: number }

/**
 * Distingue "não há movimento esperado" (por causa da condição ou
 * ciclo de vida — não é um problema) de "movimento era esperado mas
 * não aconteceu" (nunca houve, ou há N dias). Usa Frente.últimoMovimento
 * (cache já mantido pelo Bloco 1) como valor — mas esse cache já É
 * derivado de Registro.data, nunca de criadoEm, desde que foi criado
 * em frente-ops.ts; não há necessidade de revalidar aqui a cada
 * leitura (isso duplicaria recalcularÚltimoMovimento sem necessidade).
 */
export function obterLeituraMovimento(
  frente: Pick<Frente, 'cicloVida' | 'condição' | 'últimoMovimento'>,
  movementExpected: boolean,
  agora: number = Date.now()
): LeituraMovimento {
  if (!movementExpected) return { tipo: 'sem_movimento_esperado' }
  if (frente.últimoMovimento === null) return { tipo: 'nunca_movimentou' }
  return {
    tipo: 'movimentou',
    últimoMovimento: frente.últimoMovimento,
    diasDesde: (agora - frente.últimoMovimento) / MS_POR_DIA
  }
}

// ---- Estado agregado de uma frente -----------------------------------

export interface CausaDomínio {
  frenteId: string
  sinal: Exclude<Sinal, null>
}

export interface EstadoFrente {
  frenteId: string
  cicloVida: CicloVida
  condição: Condição
  sinal: Sinal
  cadênciaEsperada: number | null
  movimento: LeituraMovimento
  duraçãoCondição: DuraçãoCondição | null
  pausa: LeituraPausa
  /** só preenchido para domínios: quais frentes-folha determinam o
   * pior sinal agregado. Vazio para frentes não-domínio ou quando
   * sinal=null. */
  causasDomínio: string[]
}

/**
 * Visão derivada e completa do estado atual de uma frente — reúne
 * o que já existe em signal.ts, historico.ts (indiretamente, via
 * EventoEstrutural) e os campos crus da Frente, sem reimplementar
 * nenhuma regra já decidida nesses módulos.
 */
export async function obterEstadoFrente(
  storage: StorageAdapter,
  frenteId: string,
  agora: number = Date.now()
): Promise<EstadoFrente> {
  const frente = await storage.getFrente(frenteId)
  if (!frente) throw new Error(`Frente ${frenteId} não encontrada`)

  const { sinal, causas } = await calcularSinalAgregadoComCausas(frenteId, storage, agora)
  const expectaMovimento = frente.cicloVida === 'ativa' && frente.condição === 'normal'

  return {
    frenteId,
    cicloVida: frente.cicloVida,
    condição: frente.condição,
    sinal,
    cadênciaEsperada: frente.cadênciaEsperada,
    movimento: obterLeituraMovimento(frente, expectaMovimento, agora),
    duraçãoCondição: await obterDuraçãoCondição(storage, frenteId, agora),
    pausa: obterLeituraPausa(frente, agora),
    causasDomínio: frente.tipo === 'domínio' ? causas : []
  }
}

// ---- Lista de atenção --------------------------------------------------

export type MotivoAtenção =
  | { tipo: 'sinal'; sinal: 'esfriando' | 'fora_do_ritmo' }
  | { tipo: 'condição'; condição: 'bloqueada' | 'aguardando' }
  | { tipo: 'pausa_vencida'; diasVencida: number }

export interface FrenteEmAtenção {
  frenteId: string
  motivos: MotivoAtenção[]
}

/**
 * Frentes que merecem atenção agora — sem pontuação, sem ranquear.
 * Critérios são explícitos e cada motivo fica preservado em
 * estrutura (uma frente pode ter mais de um motivo simultâneo, ex:
 * sinal esfriando E pausa vencida ao mesmo tempo — isso não
 * acontece na prática hoje porque sinal=null quando pausada, mas o
 * tipo permite múltiplos motivos por design, caso o modelo evolua).
 *
 * NUNCA inclui concluída/arquivada — "merecer atenção" não se aplica
 * a algo que já terminou.
 *
 * `escopo` opcional restringe a uma frente e seus descendentes;
 * sem escopo, percorre todas as frentes do storage.
 */
export async function obterFrentesEmAtenção(
  storage: StorageAdapter,
  escopo?: string,
  agora: number = Date.now()
): Promise<FrenteEmAtenção[]> {
  const ids = escopo ? [escopo, ...(await coletarDescendentes(escopo, storage))] : (await storage.getFrentes()).map((f) => f.id)

  const resultado: FrenteEmAtenção[] = []

  for (const id of ids) {
    const frente = await storage.getFrente(id)
    if (!frente) continue
    if (frente.cicloVida !== 'ativa') continue // nunca concluída/arquivada

    const motivos: MotivoAtenção[] = []

    // sinal: só avalia sinal PRÓPRIO da frente (não agregado), para
    // não fazer um domínio aparecer na lista por causa de um filho —
    // o filho já vai aparecer na lista por si só
    if (frente.tipo !== 'domínio') {
      const sinalPróprio = (await calcularSinalAgregado(id, storage, agora))
      if (sinalPróprio === 'esfriando' || sinalPróprio === 'fora_do_ritmo') {
        motivos.push({ tipo: 'sinal', sinal: sinalPróprio })
      }
    }

    if (frente.condição === 'bloqueada' || frente.condição === 'aguardando') {
      motivos.push({ tipo: 'condição', condição: frente.condição })
    }

    const pausa = obterLeituraPausa(frente, agora)
    if (pausa.tipo === 'pausa_vencida') {
      motivos.push({ tipo: 'pausa_vencida', diasVencida: pausa.diasVencida })
    }

    if (motivos.length > 0) {
      resultado.push({ frenteId: id, motivos })
    }
  }

  return resultado
}
