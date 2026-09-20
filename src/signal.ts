import type { Frente, Sinal } from './types'
import type { StorageAdapter } from './storage'

// ============================================================
// MOTOR DE SINAL
// Isso é o coração do produto. Toda tela, toda cor, todo badge
// deriva do que essas funções retornam — nunca o contrário.
// ============================================================

const MS_POR_DIA = 1000 * 60 * 60 * 24

/**
 * Sinal de UMA frente (folha ou não), baseado só nos próprios
 * dados dela — sem olhar pra filhos. Uma frente-domínio pura
 * (sem registro próprio) não deveria chamar essa função direto;
 * use calcularSinalAgregado.
 */
export function calcularSinal(frente: Frente, agora: number = Date.now()): Sinal {
  if (frente.optOutNegligência) return 'hibernando'
  if (frente.estado === 'arquivada') return 'hibernando'
  if (frente.estado === 'pausada_por_decisão') return 'hibernando'

  if (frente.últimoMovimento === null) {
    // nunca teve movimento real registrado — trate como fora do ritmo
    // se já passou da cadência esperada desde a criação
    const diasDesdeaCriação = (agora - frente.criadaEm) / MS_POR_DIA
    return diasDesdeaCriação > frente.cadênciaEsperada ? 'fora_do_ritmo' : 'no_ritmo'
  }

  const diasDesdeMovimento = (agora - frente.últimoMovimento) / MS_POR_DIA
  const desvio = diasDesdeMovimento / frente.cadênciaEsperada

  if (desvio <= 1) return 'no_ritmo'
  if (desvio <= 2) return 'esfriando'
  return 'fora_do_ritmo'
}

const SEVERIDADE: Record<Sinal, number> = {
  hibernando: 0,
  no_ritmo: 1,
  esfriando: 2,
  fora_do_ritmo: 3
}

function piorSinal(sinais: Sinal[]): Sinal {
  if (sinais.length === 0) return 'no_ritmo'
  return sinais.reduce((pior, atual) =>
    SEVERIDADE[atual] > SEVERIDADE[pior] ? atual : pior
  )
}

/**
 * Sinal agregado — sobe a árvore recursivamente. Frente-domínio
 * herda o pior sinal entre os filhos (não a média): o objetivo
 * é que negligência num filho nunca fique escondida atrás de
 * outros filhos saudáveis.
 */
export function calcularSinalAgregado(
  frenteId: string,
  storage: StorageAdapter,
  agora: number = Date.now()
): Sinal {
  const frente = storage.getFrente(frenteId)
  if (!frente) throw new Error(`Frente ${frenteId} não encontrada`)

  const filhos = storage.getFrentes().filter((f) => f.parentId === frenteId)

  if (filhos.length === 0) {
    return calcularSinal(frente, agora)
  }

  const sinalPróprio = frente.tipo === 'domínio' ? null : calcularSinal(frente, agora)
  const sinaisFilhos = filhos.map((f) => calcularSinalAgregado(f.id, storage, agora))

  return piorSinal(sinalPróprio ? [sinalPróprio, ...sinaisFilhos] : sinaisFilhos)
}

/**
 * Registra um toque (qualquer interação) sem necessariamente
 * contar como movimento real — usado por exemplo quando você só
 * abre uma frente pra ler, sem registrar nada novo.
 */
export function registrarToque(frente: Frente, agora: number = Date.now()): Frente {
  return { ...frente, últimoToque: agora }
}

/**
 * Registra movimento real — atualiza tanto toque quanto movimento.
 * Só deve ser chamado quando um Registro com contaComoMovimento=true
 * é criado.
 */
export function registrarMovimento(frente: Frente, agora: number = Date.now()): Frente {
  return { ...frente, últimoToque: agora, últimoMovimento: agora }
}
