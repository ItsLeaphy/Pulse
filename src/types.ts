// ============================================================
// TIPOS — PULSE 2.0 (proposta, não aplicada ainda)
// Mantém os nomes em português já usados no código (Área,
// TipoFrente etc.) para minimizar o diff de migração.
// ============================================================

export type Área = 'work' | 'life' | 'art'

export type TipoFrente = 'projeto' | 'prática' | 'domínio'

/** Ciclo de vida: o que a frente É em termos de existência/conclusão. */
export type CicloVida = 'ativa' | 'concluída' | 'arquivada'

/**
 * Condição operacional: o que está acontecendo com a frente AGORA,
 * enquanto ela está ativa. Só é significativa quando cicloVida='ativa';
 * ao concluir/arquivar, o último valor fica preservado no histórico de
 * eventos, mas deixa de ser avaliado pelo motor de sinal.
 */
export type Condição = 'normal' | 'bloqueada' | 'aguardando' | 'pausada'

/**
 * Sinal: nunca editado manualmente — sempre calculado a partir de
 * último movimento + cadência + expectativa de movimento (ver signal.ts).
 *
 * `null` significa "não há sinal aplicável" — não é um estado ruim,
 * é ausência de avaliação de ritmo. Isso cobre: frente concluída ou
 * arquivada (ciclo de vida encerrado, não é mais avaliada), frente
 * com condição diferente de 'normal' (bloqueada/aguardando/pausada —
 * não se espera movimento, então não há "ritmo" pra medir) e domínio
 * sem nenhum filho (não há dado nenhum pra agregar). Bloco 1 removeu
 * 'hibernando' — era usado pra todos esses casos ao mesmo tempo,
 * misturando "pausei de propósito" com "isso já acabou" com "não há
 * dado"; null distingue ausência de avaliação de qualquer rótulo.
 */
export type Sinal = 'no_ritmo' | 'esfriando' | 'fora_do_ritmo' | null

export interface Frente {
  id: string
  nome: string
  área: Área
  tipo: TipoFrente
  parentId: string | null

  cicloVida: CicloVida
  condição: Condição

  /** dias — nullable: domínio tende a não ter cadência própria
   * (sinal dele é sempre rollup dos filhos, nunca calculado direto) */
  cadênciaEsperada: number | null

  /**
   * timestamp (ms), cache derivado — NUNCA escrito diretamente.
   * Fonte de verdade é Registro: últimoMovimento = maior `data` entre
   * os registros desta frente com contaComoMovimento=true, ou null se
   * nenhum existir. Recalculado em toda mutação de registro por
   * recalcularÚltimoMovimento() em frente-ops.ts — nunca pela UI.
   */
  últimoMovimento: number | null

  /** Contexto — descreve a situação atual sem virar checklist */
  contextoFoco: string | null
  contextoBloqueio: string | null // só tem sentido preenchido quando condição='bloqueada'
  pausaMotivo: string | null // só tem sentido quando condição='pausada'
  pausaRetomadaEm: number | null // timestamp (ms), opcional, quando condição='pausada'

  criadaEm: number
}

export interface Registro {
  id: string
  frenteId: string
  /**
   * timestamp (ms) — QUANDO O FATO ACONTECEU. É esta data (não
   * `criadoEm`) que participa de últimoMovimento, sinal, histórico e
   * retrospectiva. Editável pelo usuário no momento da criação ou
   * depois, para permitir registro retroativo ("esqueci de registrar
   * o que fiz anteontem").
   */
  data: number
  /**
   * timestamp (ms) — quando o registro foi efetivamente inserido no
   * sistema. Nunca editado pelo usuário, nunca usado em cálculo de
   * sinal/histórico/retrospectiva — é só proveniência (bloco 2).
   * Default = mesma data de criação quando o registro não é retroativo.
   */
  criadoEm: number
  texto: string
  contaComoMovimento: boolean
  dadosExtra?: RegistroDadosPrática
}

export interface RegistroDadosPrática {
  duraçãoMin?: number
}

// ============================================================
// EVENTO ESTRUTURAL — novo na 2.0
// Gerado pelo sistema, nunca escrito manualmente pelo usuário.
// Tabela única, diferenciada por `tipo`. Fonte de verdade para
// qualquer visão retrospectiva que precise narrar "o que mudou".
// ============================================================

export type TipoEventoEstrutural =
  | 'criação'
  | 'ciclo_vida_mudou'
  | 'condição_mudou'
  | 'cadência_mudou'
  | 'hierarquia_mudou'

export interface EventoEstrutural {
  id: string
  frenteId: string
  tipo: TipoEventoEstrutural
  /** string para caber qualquer um dos enums/números acima — nunca
   * interpretado pelo motor de sinal, só consultado por quem lê histórico */
  valorAnterior: string | null
  valorNovo: string | null
  criadoEm: number
}

// ============================================================
// REMOVIDO (legado, sem uso real no código):
// Marco, ProgressoProjeto, ProgressoPrática, Progresso, EstadoFrente
// (removidos na 2.0 inicial)
// Frente.optOutNegligência (campo antigo mantido no BANCO até a
// migration 002 de remoção — ver supabase-migration-001-aditiva.sql
// — mas não lido/escrito por este código desde a 2.0 inicial)
// Frente.últimoToque, registrarToque() (removidos no Bloco 1 —
// não participavam de nenhum cálculo, só geravam escrita a cada
// abertura de frente sem representar evidência real)
// Sinal='hibernando' (removido no Bloco 1 — ver comentário em Sinal
// acima; substituído por null)
// ============================================================
