import type { StorageAdapter } from './storage'
import type { Período, Retrospectiva } from './historico'
import { obterRetrospectiva } from './historico'
import { coletarDescendentes } from './frente-ops'

// ============================================================
// COMPARAÇÃO DE PERÍODOS — BLOCO 6
//
// Compara dois períodos de um escopo usando as mesmas evidências
// já estruturadas por obterRetrospectiva (historico.ts) — não
// reimplementa filtro de período nem agregação de eventos, só
// calcula duas retrospectivas e compara seus totais. Resultado é
// estrutura, nunca score nem string.
// ============================================================

export interface ComparaçãoPeríodos {
  escopoFrenteId: string
  períodoAtual: Período
  períodoAnterior: Período
  retrospectivaAtual: Retrospectiva
  retrospectivaAnterior: Retrospectiva

  quantidadeMovimentos: { atual: number; anterior: number; diferença: number }
  /** ids de frentes (descendentes do escopo, incluindo ele mesmo)
   * que tiveram pelo menos 1 movimento no período atual mas NÃO no
   * anterior — "voltaram a se mexer" */
  frentesComMovimentoApenasNoAtual: string[]
  /** o inverso: tinham movimento no anterior, não tiveram no atual —
   * "pararam" */
  frentesComMovimentoApenasNoAnterior: string[]
  /** tiveram movimento nos dois períodos */
  frentesComMovimentoEmAmbos: string[]
  /** não tiveram movimento em nenhum dos dois — presentes na árvore
   * do escopo mas sem evidência em nenhum dos dois períodos */
  frentesSemMovimentoEmNenhum: string[]

  mudançasCondição: { atual: number; anterior: number }
  mudançasCicloVida: { atual: number; anterior: number }
  mudançasHierarquia: { atual: number; anterior: number }
  mudançasCadência: { atual: number; anterior: number }
}

/**
 * Compara dois períodos de um escopo (frente ou domínio, com
 * descendentes). Não calcula nenhum score — cada métrica fica como
 * contagem bruta de cada lado, com `diferença` só no caso de
 * movimentos (as outras, o chamador soma/subtrai se quiser, mas não
 * impomos uma interpretação de "melhor/pior" aqui: menos mudanças de
 * condição não é necessariamente "melhor", por exemplo).
 *
 * Determinística: usa só obterRetrospectiva, que já é determinística
 * dado storage+período; não lê relógio.
 */
export async function compararPeríodos(
  storage: StorageAdapter,
  escopoFrenteId: string,
  períodoAtual: Período,
  períodoAnterior: Período
): Promise<ComparaçãoPeríodos> {
  const retrospectivaAtual = await obterRetrospectiva(storage, escopoFrenteId, períodoAtual)
  const retrospectivaAnterior = await obterRetrospectiva(storage, escopoFrenteId, períodoAnterior)

  const idsEscopo = [escopoFrenteId, ...(await coletarDescendentes(escopoFrenteId, storage))]

  const frentesComMovimentoAtual = new Set(retrospectivaAtual.movimentos.map((m) => m.frenteId))
  const frentesComMovimentoAnterior = new Set(retrospectivaAnterior.movimentos.map((m) => m.frenteId))

  const apenasNoAtual: string[] = []
  const apenasNoAnterior: string[] = []
  const emAmbos: string[] = []
  const semMovimentoEmNenhum: string[] = []

  for (const id of idsEscopo) {
    const noAtual = frentesComMovimentoAtual.has(id)
    const noAnterior = frentesComMovimentoAnterior.has(id)
    if (noAtual && noAnterior) emAmbos.push(id)
    else if (noAtual && !noAnterior) apenasNoAtual.push(id)
    else if (!noAtual && noAnterior) apenasNoAnterior.push(id)
    else semMovimentoEmNenhum.push(id)
  }

  return {
    escopoFrenteId,
    períodoAtual,
    períodoAnterior,
    retrospectivaAtual,
    retrospectivaAnterior,
    quantidadeMovimentos: {
      atual: retrospectivaAtual.movimentos.length,
      anterior: retrospectivaAnterior.movimentos.length,
      diferença: retrospectivaAtual.movimentos.length - retrospectivaAnterior.movimentos.length
    },
    frentesComMovimentoApenasNoAtual: apenasNoAtual,
    frentesComMovimentoApenasNoAnterior: apenasNoAnterior,
    frentesComMovimentoEmAmbos: emAmbos,
    frentesSemMovimentoEmNenhum: semMovimentoEmNenhum,
    mudançasCondição: {
      atual: retrospectivaAtual.mudançasCondição.length,
      anterior: retrospectivaAnterior.mudançasCondição.length
    },
    mudançasCicloVida: {
      atual: retrospectivaAtual.mudançasCicloVida.length,
      anterior: retrospectivaAnterior.mudançasCicloVida.length
    },
    mudançasHierarquia: {
      atual: retrospectivaAtual.mudançasHierarquia.length,
      anterior: retrospectivaAnterior.mudançasHierarquia.length
    },
    mudançasCadência: {
      atual: retrospectivaAtual.mudançasCadência.length,
      anterior: retrospectivaAnterior.mudançasCadência.length
    }
  }
}
