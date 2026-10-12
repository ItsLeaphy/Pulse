import type { Frente, Registro, EventoEstrutural } from './types'
import type { StorageAdapter } from './storage'

// ============================================================
// LEITURA COM MEMO POR RENDER
// Os módulos derivados (sinal, estado, histórico, retrospectiva,
// ritmo, tendência) pedem getFrentes()/getRegistros(id)/
// getEventosEstruturais(id) várias vezes — por nó da árvore, por
// frente, por período. Em Supabase cada chamada é uma ida à rede.
//
// Este wrapper dá a UMA renderização um "instantâneo de leitura":
// carrega frentes, registros e eventos no máximo uma vez cada (em
// lote) e responde todo o resto a partir da memória. Não é cache
// de longa duração: cada render cria o seu e o descarta, então
// nunca serve dado velho entre telas. Qualquer escrita feita
// através dele invalida tudo.
//
// Não altera nenhuma regra: as mesmas funções de domínio recebem
// um StorageAdapter com o mesmo contrato e a mesma ordenação.
// ============================================================

function ordemRegistros(a: Registro, b: Registro): number {
  return b.data - a.data || a.id.localeCompare(b.id)
}

function ordemEventos(a: EventoEstrutural, b: EventoEstrutural): number {
  return b.criadoEm - a.criadoEm || a.id.localeCompare(b.id)
}

export interface LeituraMemo extends StorageAdapter {
  /** quantas leituras ao adapter real foram feitas (diagnóstico/testes) */
  readonly leiturasReais: { frentes: number; registros: number; eventos: number }
}

export function comMemoDeLeitura(base: StorageAdapter): LeituraMemo {
  let frentes: Promise<Frente[]> | null = null
  let registros: Promise<Registro[]> | null = null
  let eventos: Promise<EventoEstrutural[]> | null = null
  const leiturasReais = { frentes: 0, registros: 0, eventos: 0 }

  // uma promessa rejeitada não pode ficar presa no memo — senão o
  // "tentar de novo" da UI repetiria a mesma falha para sempre
  function memo<T>(atual: Promise<T> | null, criar: () => Promise<T>, limpar: () => void): Promise<T> {
    if (atual) return atual
    const p = criar()
    p.catch(limpar)
    return p
  }

  const carregarFrentes = () => {
    frentes = memo(
      frentes,
      () => {
        leiturasReais.frentes++
        return base.getFrentes()
      },
      () => (frentes = null)
    )
    return frentes
  }
  const carregarRegistros = () => {
    registros = memo(
      registros,
      async () => {
        leiturasReais.registros++
        return [...(await base.getTodosRegistros())].sort(ordemRegistros)
      },
      () => (registros = null)
    )
    return registros
  }
  const carregarEventos = () => {
    eventos = memo(
      eventos,
      async () => {
        leiturasReais.eventos++
        return [...(await base.getTodosEventosEstruturais())].sort(ordemEventos)
      },
      () => (eventos = null)
    )
    return eventos
  }

  const invalidar = () => {
    frentes = null
    registros = null
    eventos = null
  }

  return {
    leiturasReais,
    getFrentes: () => carregarFrentes(),
    getFrente: async (id) => (await carregarFrentes()).find((f) => f.id === id),
    salvarFrente: async (f) => {
      invalidar()
      await base.salvarFrente(f)
    },
    removerFrente: async (id) => {
      invalidar()
      await base.removerFrente(id)
    },

    getRegistros: async (frenteId) => (await carregarRegistros()).filter((r) => r.frenteId === frenteId),
    getTodosRegistros: () => carregarRegistros(),
    getRegistrosRecentes: async (limite) => (await carregarRegistros()).slice(0, limite),
    salvarRegistro: async (r) => {
      invalidar()
      await base.salvarRegistro(r)
    },
    removerRegistro: async (id) => {
      invalidar()
      await base.removerRegistro(id)
    },

    getEventosEstruturais: async (frenteId) => (await carregarEventos()).filter((e) => e.frenteId === frenteId),
    getTodosEventosEstruturais: () => carregarEventos(),
    salvarEventoEstrutural: async (e) => {
      invalidar()
      await base.salvarEventoEstrutural(e)
    },
    removerEventoEstrutural: async (id) => {
      invalidar()
      await base.removerEventoEstrutural(id)
    },

    // operações atômicas: invalida antes E depois — se a resposta se
    // perder, o próximo render nunca serve dado anterior à tentativa
    salvarFrenteComEventos: async (f, e, esp) => {
      invalidar()
      try {
        return await base.salvarFrenteComEventos(f, e, esp)
      } finally {
        invalidar()
      }
    },
    salvarRegistroComCache: async (r, esp) => {
      invalidar()
      try {
        return await base.salvarRegistroComCache(r, esp)
      } finally {
        invalidar()
      }
    },
    removerRegistroComCache: async (id) => {
      invalidar()
      try {
        return await base.removerRegistroComCache(id)
      } finally {
        invalidar()
      }
    },
    removerFrenteEmCascata: async (id) => {
      invalidar()
      try {
        return await base.removerFrenteEmCascata(id)
      } finally {
        invalidar()
      }
    }
  }
}
