import type { StorageAdapter } from './storage'
import type { Frente } from './types'
import { coletarDescendentes, montarEvento } from './frente-ops'

// ============================================================
// HIERARQUIA — BLOCO 5 (reparenting)
//
// Única função deste módulo: moverFrente. Reaproveita
// coletarDescendentes (frente-ops.ts) para a validação de ciclo —
// não reimplementa percurso de árvore — e registrarEvento
// (idem) para gerar o evento, mantendo a regra "só
// frente-ops.ts/hierarquia.ts escrevem EventoEstrutural".
// ============================================================

/**
 * Move uma frente para um novo pai (ou para a raiz, se novoParentId
 * for null). Única operação do código que deve alterar
 * Frente.parentId — qualquer outro lugar que precise mudar
 * hierarquia deve passar por aqui, para herdar a mesma validação e
 * geração de evento (item 5 do Bloco 5).
 *
 * Validações, nesta ordem:
 * 1. frente existe
 * 2. novoParentId, se não-null, existe
 * 3. novoParentId !== frenteId (não pode ser pai de si mesma)
 * 4. novoParentId não é um descendente de frenteId (preveniria ciclo)
 *
 * Mover para o MESMO pai atual é idempotente: retorna a frente sem
 * gerar evento nem erro — mesmo padrão já usado por
 * mudarCicloVida/mudarCondição/mudarCadência quando o valor não
 * muda (frente-ops.ts).
 *
 * Preserva todos os outros campos — não toca cicloVida, condição,
 * cadênciaEsperada, últimoMovimento, contexto, pausa. Não reordena
 * nem recalcula registros/eventos existentes: eles continuam
 * apontando pra mesma frenteId de sempre, e signal.ts/historico.ts
 * já resolvem a árvore (via storage.getFrentes().parentId) a cada
 * chamada — não há cache de hierarquia em lugar nenhum pra ficar
 * stale.
 */
export async function moverFrente(
  storage: StorageAdapter,
  frenteId: string,
  novoParentId: string | null,
  agora: number = Date.now()
): Promise<Frente> {
  const frente = await storage.getFrente(frenteId)
  if (!frente) throw new Error(`Frente ${frenteId} não encontrada`)

  if (frente.parentId === novoParentId) return frente // idempotente

  if (novoParentId !== null) {
    const novoParent = await storage.getFrente(novoParentId)
    if (!novoParent) throw new Error(`Novo pai ${novoParentId} não encontrado`)

    if (novoParentId === frenteId) {
      throw new Error(`Frente ${frenteId} não pode ser pai de si mesma`)
    }

    const descendentes = await coletarDescendentes(frenteId, storage)
    if (descendentes.includes(novoParentId)) {
      throw new Error(
        `Não é possível mover ${frenteId} para dentro de ${novoParentId}: isso criaria um ciclo (${novoParentId} é descendente de ${frenteId})`
      )
    }
  }

  const parentAnterior = frente.parentId
  const atualizada: Frente = { ...frente, parentId: novoParentId }
  // posição nova + evento de hierarquia na mesma transação; o storage
  // também revalida pai existente e ausência de ciclo (concorrência)
  const eventos = [montarEvento(frenteId, 'hierarquia_mudou', parentAnterior, novoParentId, agora)]
  return (await storage.salvarFrenteComEventos(atualizada, eventos, frente)).frente
}
