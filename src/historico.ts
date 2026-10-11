import type { StorageAdapter } from './storage'
import type { Registro, EventoEstrutural, Frente } from './types'
import { coletarDescendentes } from './frente-ops'

// ============================================================
// HISTÓRICO E RETROSPECTIVA — BLOCO 2 ("Memória")
//
// Este módulo só LÊ. Nada aqui persiste dado novo — Registro e
// EventoEstrutural continuam sendo as duas únicas fontes de
// verdade; tudo que este arquivo produz é uma visão derivada
// delas, recalculada a cada chamada. Isso é intencional: histórico
// e retrospectiva precisam ser determinísticos (mesmos dados +
// mesmo período = mesmo resultado), o que só é garantido se nada
// aqui for cacheado como novo estado persistido.
// ============================================================

// ---- Histórico unificado --------------------------------------

export interface ItemHistóricoRegistro {
  tipo: 'registro'
  data: number
  registro: Registro
}

export interface ItemHistóricoEvento {
  tipo: 'evento_estrutural'
  data: number
  evento: EventoEstrutural
}

export type ItemHistórico = ItemHistóricoRegistro | ItemHistóricoEvento

/**
 * Histórico de uma frente: Registro + EventoEstrutural combinados,
 * ordenados cronologicamente (mais recente primeiro). Cada item
 * mantém sua forma original — não vira texto aqui, isso é trabalho
 * da camada de apresentação (ver formatarRetrospectiva).
 *
 * `incluirDescendentes=true` (domínio) agrega o histórico de toda a
 * subárvore. A hierarquia é resolvida pela árvore ATUAL — reparenting
 * ainda não existe, então não há ambiguidade de "qual era o pai
 * quando o evento aconteceu" a resolver aqui.
 */
export async function obterHistórico(
  storage: StorageAdapter,
  frenteId: string,
  opções: { incluirDescendentes?: boolean } = {}
): Promise<ItemHistórico[]> {
  const ids = opções.incluirDescendentes
    ? [frenteId, ...(await coletarDescendentes(frenteId, storage))]
    : [frenteId]

  const itens: ItemHistórico[] = []
  for (const id of ids) {
    const registros = await storage.getRegistros(id)
    for (const r of registros) {
      itens.push({ tipo: 'registro', data: r.data, registro: r })
    }
    const eventos = await storage.getEventosEstruturais(id)
    for (const e of eventos) {
      itens.push({ tipo: 'evento_estrutural', data: e.criadoEm, evento: e })
    }
  }

  // mais recente primeiro; empate exato em `data` desempatado por id
  // do item (registro.id ou evento.id) para ordem determinística,
  // nunca dependente da ordem de retorno do storage (Bloco 4)
  return itens.sort((a, b) => {
    const porData = b.data - a.data
    if (porData !== 0) return porData
    const idA = a.tipo === 'registro' ? a.registro.id : a.evento.id
    const idB = b.tipo === 'registro' ? b.registro.id : b.evento.id
    return idA < idB ? -1 : idA > idB ? 1 : 0
  })
}

// ---- Retrospectiva ----------------------------------------------

/**
 * Período semiaberto [início, fim) — início incluído, fim excluído.
 * Isso garante que dois períodos consecutivos (ex: semana 1 =
 * [seg, seg seguinte), semana 2 = [seg seguinte, outro seg)) nunca
 * duplicam nem perdem um item que caia exatamente na borda.
 */
export interface Período {
  início: number
  fim: number
}

function noPeríodo(data: number, período: Período): boolean {
  return data >= período.início && data < período.fim
}

export interface RetrospectivaMovimento {
  registro: Registro
  frenteId: string
}

export interface RetrospectivaMudança {
  frenteId: string
  evento: EventoEstrutural
}

export interface RetrospectivaFrenteCriada {
  frenteId: string
  evento: EventoEstrutural
}

export interface Retrospectiva {
  escopoFrenteId: string
  período: Período
  movimentos: RetrospectivaMovimento[]
  mudançasCicloVida: RetrospectivaMudança[]
  mudançasCondição: RetrospectivaMudança[]
  mudançasCadência: RetrospectivaMudança[]
  mudançasHierarquia: RetrospectivaMudança[]
  frentesCriadas: RetrospectivaFrenteCriada[]
  frentesConcluídas: RetrospectivaMudança[] // subconjunto de mudançasCicloVida onde valorNovo='concluída'
  frentesArquivadas: RetrospectivaMudança[] // subconjunto de mudançasCicloVida onde valorNovo='arquivada'
}

/**
 * Retrospectiva determinística de um escopo (frente ou domínio,
 * incluindo descendentes) num período. Só classifica o que os dados
 * estruturados (Registro.contaComoMovimento, EventoEstrutural.tipo/
 * valorNovo) já afirmam — nenhuma heurística de texto, nenhuma
 * categoria tipo "decisão"/"problema" inventada aqui. Mesmos dados +
 * mesmo período sempre produzem o mesmo resultado: a função não lê
 * relógio nem estado externo além do que storage retorna.
 */
export async function obterRetrospectiva(
  storage: StorageAdapter,
  escopoFrenteId: string,
  período: Período
): Promise<Retrospectiva> {
  const ids = [escopoFrenteId, ...(await coletarDescendentes(escopoFrenteId, storage))]

  const retro: Retrospectiva = {
    escopoFrenteId,
    período,
    movimentos: [],
    mudançasCicloVida: [],
    mudançasCondição: [],
    mudançasCadência: [],
    mudançasHierarquia: [],
    frentesCriadas: [],
    frentesConcluídas: [],
    frentesArquivadas: []
  }

  for (const frenteId of ids) {
    const registros = await storage.getRegistros(frenteId)
    for (const r of registros) {
      if (r.contaComoMovimento && noPeríodo(r.data, período)) {
        retro.movimentos.push({ registro: r, frenteId })
      }
    }

    const eventos = await storage.getEventosEstruturais(frenteId)
    for (const e of eventos) {
      if (!noPeríodo(e.criadoEm, período)) continue

      switch (e.tipo) {
        case 'criação':
          retro.frentesCriadas.push({ frenteId, evento: e })
          break
        case 'ciclo_vida_mudou':
          retro.mudançasCicloVida.push({ frenteId, evento: e })
          if (e.valorNovo === 'concluída') retro.frentesConcluídas.push({ frenteId, evento: e })
          if (e.valorNovo === 'arquivada') retro.frentesArquivadas.push({ frenteId, evento: e })
          break
        case 'condição_mudou':
          retro.mudançasCondição.push({ frenteId, evento: e })
          break
        case 'cadência_mudou':
          retro.mudançasCadência.push({ frenteId, evento: e })
          break
        case 'hierarquia_mudou':
          retro.mudançasHierarquia.push({ frenteId, evento: e })
          break
      }
    }
  }

  // ordena cada seção cronologicamente (mais antigo primeiro) para
  // leitura e determinismo — Promise.all acima não garante ordem de
  // chegada entre frentes diferentes
  retro.movimentos.sort((a, b) => a.registro.data - b.registro.data)
  retro.mudançasCicloVida.sort((a, b) => a.evento.criadoEm - b.evento.criadoEm)
  retro.mudançasCondição.sort((a, b) => a.evento.criadoEm - b.evento.criadoEm)
  retro.mudançasCadência.sort((a, b) => a.evento.criadoEm - b.evento.criadoEm)
  retro.mudançasHierarquia.sort((a, b) => a.evento.criadoEm - b.evento.criadoEm)
  retro.frentesCriadas.sort((a, b) => a.evento.criadoEm - b.evento.criadoEm)
  retro.frentesConcluídas.sort((a, b) => a.evento.criadoEm - b.evento.criadoEm)
  retro.frentesArquivadas.sort((a, b) => a.evento.criadoEm - b.evento.criadoEm)

  return retro
}

// ---- Apresentação (texto) ----------------------------------------
// Camada separada por design: consome só a estrutura de Retrospectiva,
// nunca toca storage. Determinística, sem IA. Omite seções vazias.

function formatarData(timestamp: number): string {
  const d = new Date(timestamp)
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
}

async function nomeFrente(storage: StorageAdapter, cache: Map<string, Frente>, id: string): Promise<string> {
  if (!cache.has(id)) {
    const f = await storage.getFrente(id)
    if (f) cache.set(id, f)
  }
  return cache.get(id)?.nome ?? '(frente removida)'
}

/**
 * Transforma uma Retrospectiva em texto Markdown legível. Recebe
 * storage só para resolver nomes de frente a partir de id (não para
 * buscar dado novo — toda a lógica de "o que aconteceu" já está
 * decidida em `retro`). Omite qualquer seção sem itens.
 */
export async function formatarRetrospectiva(storage: StorageAdapter, retro: Retrospectiva): Promise<string> {
  const cache = new Map<string, Frente>()
  const linhas: string[] = []

  const escopo = await nomeFrente(storage, cache, retro.escopoFrenteId)
  linhas.push(`# ${escopo}`)
  linhas.push(`Período: ${formatarData(retro.período.início)} → ${formatarData(retro.período.fim)}`)
  linhas.push('')

  if (retro.movimentos.length > 0) {
    linhas.push('## Movimentos')
    for (const m of retro.movimentos) {
      const nome = await nomeFrente(storage, cache, m.frenteId)
      linhas.push(`- [${formatarData(m.registro.data)}] ${nome}: ${m.registro.texto}`)
    }
    linhas.push('')
  }

  const temMudanças =
    retro.mudançasCicloVida.length > 0 ||
    retro.mudançasCondição.length > 0 ||
    retro.mudançasCadência.length > 0 ||
    retro.mudançasHierarquia.length > 0
  if (temMudanças) {
    linhas.push('## Mudanças')
    for (const m of retro.mudançasCicloVida) {
      const nome = await nomeFrente(storage, cache, m.frenteId)
      linhas.push(`- [${formatarData(m.evento.criadoEm)}] ${nome} — ciclo de vida: ${m.evento.valorAnterior} → ${m.evento.valorNovo}`)
    }
    for (const m of retro.mudançasCondição) {
      const nome = await nomeFrente(storage, cache, m.frenteId)
      linhas.push(`- [${formatarData(m.evento.criadoEm)}] ${nome} — condição: ${m.evento.valorAnterior} → ${m.evento.valorNovo}`)
    }
    for (const m of retro.mudançasCadência) {
      const nome = await nomeFrente(storage, cache, m.frenteId)
      linhas.push(
        `- [${formatarData(m.evento.criadoEm)}] ${nome} — cadência: ${m.evento.valorAnterior ?? '—'} → ${m.evento.valorNovo ?? '—'}`
      )
    }
    for (const m of retro.mudançasHierarquia) {
      const nome = await nomeFrente(storage, cache, m.frenteId)
      const nomeAnterior = m.evento.valorAnterior ? await nomeFrente(storage, cache, m.evento.valorAnterior) : 'raiz'
      const nomeNovo = m.evento.valorNovo ? await nomeFrente(storage, cache, m.evento.valorNovo) : 'raiz'
      linhas.push(`- [${formatarData(m.evento.criadoEm)}] ${nome} — movida: ${nomeAnterior} → ${nomeNovo}`)
    }
    linhas.push('')
  }

  if (retro.frentesCriadas.length > 0) {
    linhas.push('## Novas frentes')
    for (const m of retro.frentesCriadas) {
      const nome = await nomeFrente(storage, cache, m.frenteId)
      linhas.push(`- [${formatarData(m.evento.criadoEm)}] ${nome}`)
    }
    linhas.push('')
  }

  if (retro.frentesConcluídas.length > 0) {
    linhas.push('## Concluídas')
    for (const m of retro.frentesConcluídas) {
      const nome = await nomeFrente(storage, cache, m.frenteId)
      linhas.push(`- [${formatarData(m.evento.criadoEm)}] ${nome}`)
    }
    linhas.push('')
  }

  if (retro.frentesArquivadas.length > 0) {
    linhas.push('## Arquivadas')
    for (const m of retro.frentesArquivadas) {
      const nome = await nomeFrente(storage, cache, m.frenteId)
      linhas.push(`- [${formatarData(m.evento.criadoEm)}] ${nome}`)
    }
    linhas.push('')
  }

  if (
    retro.movimentos.length === 0 &&
    !temMudanças &&
    retro.frentesCriadas.length === 0 &&
    retro.frentesConcluídas.length === 0 &&
    retro.frentesArquivadas.length === 0
  ) {
    // nota: temMudanças já cobre mudançasHierarquia (ver acima)
    linhas.push('_Nenhuma atividade registrada neste período._')
  }

  return linhas.join('\n').trimEnd()
}
