import type { StorageAdapter } from './storage'
import type { Período } from './historico'

// ============================================================
// RITMO OBSERVADO — BLOCO 6
//
// Compara o ritmo REAL de movimentos (derivado de Registro, nunca
// de texto) contra a cadência DECLARADA da frente, dentro de um
// período. Nunca altera cadênciaEsperada — isso é uma leitura,
// nunca uma escrita. Reaproveita Período de historico.ts (mesma
// semântica [início, fim)), nunca redefine.
// ============================================================

const MS_POR_DIA = 1000 * 60 * 60 * 24

export type ClassificaçãoRitmo = 'ritmo_compatível' | 'abaixo_do_esperado' | 'acima_do_esperado' | 'evidência_insuficiente'

export interface RitmoObservado {
  frenteId: string
  período: Período
  cadênciaEsperada: number | null
  /** quantidade de registros com contaComoMovimento=true dentro do
   * período — só esses contam como evidência de ritmo, conforme o
   * item 3 do Bloco 6 */
  quantidadeMovimentos: number
  /**
   * intervalo médio observado entre movimentos consecutivos dentro
   * do período, em dias. null se não houver pelo menos 2 movimentos
   * no período (1 movimento não dá intervalo nenhum pra medir).
   */
  intervaloMédioDias: number | null
  classificação: ClassificaçãoRitmo
}

/**
 * Calcula o ritmo observado de uma frente num período, comparado à
 * cadência que ela declara. Precisa de pelo menos 2 movimentos no
 * período pra ter um intervalo médio — com 0 ou 1 movimento, não há
 * "ritmo" observável, só presença ou ausência de atividade, então
 * classificação=evidência_insuficiente (não inventa comparação).
 * Frente sem cadenciaEsperada (domínio, tipicamente): também
 * evidência_insuficiente — não há "esperado" pra comparar.
 */
export async function obterRitmoObservado(
  storage: StorageAdapter,
  frenteId: string,
  período: Período
): Promise<RitmoObservado> {
  const frente = await storage.getFrente(frenteId)
  if (!frente) throw new Error(`Frente ${frenteId} não encontrada`)

  const registros = await storage.getRegistros(frenteId)
  const movimentos = registros
    .filter((r) => r.contaComoMovimento && r.data >= período.início && r.data < período.fim)
    .map((r) => r.data)
    .sort((a, b) => a - b)

  const base: Omit<RitmoObservado, 'classificação'> = {
    frenteId,
    período,
    cadênciaEsperada: frente.cadênciaEsperada,
    quantidadeMovimentos: movimentos.length,
    intervaloMédioDias: null
  }

  if (frente.cadênciaEsperada === null || movimentos.length < 2) {
    return { ...base, classificação: 'evidência_insuficiente' }
  }

  const intervalos: number[] = []
  for (let i = 1; i < movimentos.length; i++) {
    const atual = movimentos[i]
    const anterior = movimentos[i - 1]
    if (atual !== undefined && anterior !== undefined) {
      intervalos.push((atual - anterior) / MS_POR_DIA)
    }
  }
  const intervaloMédioDias = intervalos.reduce((a, b) => a + b, 0) / intervalos.length

  // tolerância: dentro de ±30% da cadência esperada conta como
  // compatível — evita que um desvio de meio dia classifique como
  // "acima"/"abaixo" por ruído irrelevante. 30% não é uma fórmula
  // de produtividade, é só uma margem de tolerância para "igual o
  // suficiente", análoga à margem já usada em signal.ts (desvio<=1
  // = no_ritmo).
  const razão = intervaloMédioDias / frente.cadênciaEsperada
  let classificação: ClassificaçãoRitmo
  if (razão >= 0.7 && razão <= 1.3) classificação = 'ritmo_compatível'
  else if (razão > 1.3) classificação = 'abaixo_do_esperado' // intervalo maior que o esperado = movimentando com menos frequência
  else classificação = 'acima_do_esperado' // intervalo menor = movimentando com mais frequência que o esperado

  return { ...base, intervaloMédioDias, classificação }
}

// ---- Calibração de cadência (sugestão, nunca alteração) --------------

export type SugestãoCadência = 'compatível' | 'possivelmente_alta' | 'possivelmente_baixa' | 'evidência_insuficiente'

export interface CalibraçãoCadência {
  frenteId: string
  período: Período
  cadênciaAtual: number | null
  intervaloMédioObservadoDias: number | null
  quantidadeMovimentos: number
  sugestão: SugestãoCadência
  /** evidência textual mínima justificando a sugestão — nunca uma
   * fórmula escondida, sempre os números que embasaram a conclusão */
  evidência: string[]
}

/**
 * Sugere (NUNCA altera) se a cadência declarada parece compatível
 * com o comportamento observado da própria frente no período. Não
 * existe "cadência ideal" universal — a sugestão é sempre relativa
 * ao histórico da própria frente, reaproveitando obterRitmoObservado
 * em vez de recalcular o intervalo médio de novo.
 *
 * "Alta demais" = cadência declarada é MAIOR que o intervalo real
 * (a frente é movimentada com mais frequência do que o declarado —
 * a cadência podia ser mais apertada). "Baixa demais" = o inverso.
 * Nomenclatura escolhida para bater com a leitura humana de
 * "cadência de 30 dias é alta/frouxa demais para algo que você mexe
 * a cada 5 dias".
 */
export async function sugerirCadência(storage: StorageAdapter, frenteId: string, período: Período): Promise<CalibraçãoCadência> {
  const ritmo = await obterRitmoObservado(storage, frenteId, período)

  const base: Omit<CalibraçãoCadência, 'sugestão' | 'evidência'> = {
    frenteId,
    período,
    cadênciaAtual: ritmo.cadênciaEsperada,
    intervaloMédioObservadoDias: ritmo.intervaloMédioDias,
    quantidadeMovimentos: ritmo.quantidadeMovimentos
  }

  if (ritmo.classificação === 'evidência_insuficiente' || ritmo.intervaloMédioDias === null || ritmo.cadênciaEsperada === null) {
    return {
      ...base,
      sugestão: 'evidência_insuficiente',
      evidência: [
        ritmo.cadênciaEsperada === null
          ? 'frente não declara cadência própria'
          : `apenas ${ritmo.quantidadeMovimentos} movimento(s) no período — mínimo de 2 necessário para calcular intervalo`
      ]
    }
  }

  const evidência = [
    `cadência declarada: ${ritmo.cadênciaEsperada} dia(s)`,
    `intervalo médio observado: ${ritmo.intervaloMédioDias.toFixed(1)} dia(s), com base em ${ritmo.quantidadeMovimentos} movimentos`
  ]

  if (ritmo.classificação === 'ritmo_compatível') {
    return { ...base, sugestão: 'compatível', evidência }
  }
  if (ritmo.classificação === 'abaixo_do_esperado') {
    // intervalo real MAIOR que a cadência declarada → cadência
    // declarada está "apertada demais" frente ao comportamento real
    return { ...base, sugestão: 'possivelmente_baixa', evidência }
  }
  // acima_do_esperado: intervalo real MENOR que a cadência declarada
  return { ...base, sugestão: 'possivelmente_alta', evidência }
}
