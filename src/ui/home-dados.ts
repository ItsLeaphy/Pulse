import type { StorageAdapter } from '../storage'
import { obterRetrospectiva, type Período, type RetrospectivaMudança, type RetrospectivaMovimento, type RetrospectivaFrenteCriada } from '../historico'
import { obterFrentesEmAtenção, type FrenteEmAtenção } from '../estado'
import { calcularSinalAgregadoComCausas } from '../signal'

// ============================================================
// COMPOSIÇÃO DE DADOS DA HOME — camada de orquestração pura
//
// Não é um módulo de domínio novo: só combina chamadas que já
// existem (obterRetrospectiva, obterFrentesEmAtenção, causas de
// domínio) para responder às perguntas que a Home precisa
// responder. Nenhuma regra de sinal/condição/ritmo é decidida
// aqui — só agregação e leitura.
// ============================================================

/**
 * "Mudanças recentes" da Home: como não existe um nó-raiz universal
 * no modelo (frentes-raiz têm parentId=null, mas Retrospectiva
 * exige um escopo), rodamos obterRetrospectiva uma vez por
 * frente-raiz (cada chamada já inclui seus descendentes) e
 * concatenamos — cobre o universo inteiro sem introduzir uma
 * regra de agregação nova.
 */
export interface MudançasRecentes {
  movimentos: RetrospectivaMovimento[]
  mudanças: RetrospectivaMudança[] // ciclo de vida + condição + cadência + hierarquia, juntas
  frentesCriadas: RetrospectivaFrenteCriada[]
}

export async function obterMudançasRecentes(storage: StorageAdapter, período: Período): Promise<MudançasRecentes> {
  const raízes = (await storage.getFrentes()).filter((f) => f.parentId === null)

  const resultado: MudançasRecentes = { movimentos: [], mudanças: [], frentesCriadas: [] }

  for (const raiz of raízes) {
    const retro = await obterRetrospectiva(storage, raiz.id, período)
    resultado.movimentos.push(...retro.movimentos)
    resultado.mudanças.push(
      ...retro.mudançasCicloVida,
      ...retro.mudançasCondição,
      ...retro.mudançasCadência,
      ...retro.mudançasHierarquia
    )
    resultado.frentesCriadas.push(...retro.frentesCriadas)
  }

  resultado.movimentos.sort((a, b) => b.registro.data - a.registro.data)
  resultado.mudanças.sort((a, b) => b.evento.criadoEm - a.evento.criadoEm)
  resultado.frentesCriadas.sort((a, b) => b.evento.criadoEm - a.evento.criadoEm)

  return resultado
}

/** Frentes em atenção, já sem escopo (universo inteiro) — reexport
 * fino só para padronizar o import na UI junto com o resto deste
 * arquivo; a lógica inteira continua em estado.ts. */
export async function obterAtençãoGeral(storage: StorageAdapter, agora: number): Promise<FrenteEmAtenção[]> {
  return obterFrentesEmAtenção(storage, undefined, agora)
}

export interface DomínioComCausas {
  frenteId: string
  causas: string[]
}

/** Domínios de topo (raiz, tipo=domínio) cujo sinal agregado não é
 * null/no_ritmo — junto com as causas (frentes-folha responsáveis).
 * Usado pela Home pra "situações relevantes em domínios". */
export async function obterDomíniosComSinalRelevante(storage: StorageAdapter, agora: number): Promise<DomínioComCausas[]> {
  const domíniosRaiz = (await storage.getFrentes()).filter((f) => f.parentId === null && f.tipo === 'domínio')
  const resultado: DomínioComCausas[] = []
  for (const dom of domíniosRaiz) {
    const { sinal, causas } = await calcularSinalAgregadoComCausas(dom.id, storage, agora)
    if (sinal === 'esfriando' || sinal === 'fora_do_ritmo') {
      resultado.push({ frenteId: dom.id, causas })
    }
  }
  return resultado
}
