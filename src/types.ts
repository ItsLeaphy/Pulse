// ============================================================
// TIPOS FUNDAMENTAIS
// Toda outra parte do sistema (storage, sinal, UI futura) deve
// importar daqui. Nunca duplicar essas formas em outro arquivo.
// ============================================================

export type Área = 'work' | 'life' | 'art'

export type TipoFrente = 'projeto' | 'prática' | 'domínio'

export type EstadoFrente = 'ativa' | 'pausada_por_decisão' | 'arquivada'

/**
 * Frente: a unidade central do sistema.
 * parentId é recursivo — não há limite de profundidade no dado,
 * só na UI (que decide quanto expor de cada vez).
 */
export interface Frente {
  id: string
  nome: string
  área: Área
  tipo: TipoFrente
  parentId: string | null
  estado: EstadoFrente
  /** dias — cadência esperada de movimento real, definida por você */
  cadênciaEsperada: number
  /** timestamp (ms) — qualquer interação, incluindo toques triviais */
  últimoToque: number
  /** timestamp (ms) — só registros marcados como movimento real */
  últimoMovimento: number | null
  /** true = "hibernando", nunca deve gerar alerta de negligência */
  optOutNegligência: boolean
  criadaEm: number
}

/**
 * Registro: evento atômico de evidência.
 * dadosExtra varia pelo tipo da frente-alvo — ver ProgressoProjeto /
 * ProgressoPrática abaixo. Frentes-domínio não geram registros próprios.
 */
export interface Registro {
  id: string
  frenteId: string
  data: number // timestamp (ms)
  texto: string
  contaComoMovimento: boolean
  dadosExtra?: RegistroDadosPrática
}

export interface RegistroDadosPrática {
  duraçãoMin?: number
}

/** Progresso de frente-tipo-projeto: marcos com peso, % é sempre calculado */
export interface Marco {
  id: string
  nome: string
  peso: number // relativo aos outros marcos da mesma frente
  concluído: boolean
}

export interface ProgressoProjeto {
  tipo: 'projeto'
  marcos: Marco[]
}

/** Progresso de frente-tipo-prática: nunca em %, sempre volume + tendência + critérios subjetivos */
export interface CritérioPrática {
  nome: string // ex: "técnica", "repertório", "controle"
  nota: number // 1–5, atualizado manualmente de vez em quando
  atualizadoEm: number
}

export interface ProgressoPrática {
  tipo: 'prática'
  critérios: CritérioPrática[]
  // sessões e tempo total são DERIVADOS dos Registros dessa frente,
  // não armazenados aqui — ver signal.ts
}

/** Frente-domínio não tem progresso próprio — é rollup dos filhos */
export type Progresso = ProgressoProjeto | ProgressoPrática | null

/** Sinal: nunca editado manualmente. Sempre calculado a partir de últimoMovimento + cadência. */
export type Sinal = 'no_ritmo' | 'esfriando' | 'fora_do_ritmo' | 'hibernando'
