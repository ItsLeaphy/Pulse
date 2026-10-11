import type { StorageAdapter } from './storage'
import type { Período } from './historico'
import { obterRitmoObservado } from './ritmo'

// ============================================================
// TENDÊNCIAS — BLOCO 6
//
// Tendência de uma frente ao longo de um período: compara a
// PRIMEIRA metade do período com a SEGUNDA metade, usando só
// contagem de movimentos reais (Registro.contaComoMovimento) —
// nunca lê texto, nunca interpreta semântica. Reaproveita
// obterRitmoObservado (ritmo.ts) para cada metade, não duplica a
// lógica de contar/filtrar registros.
// ============================================================

export type Tendência = 'melhorando' | 'estável' | 'piorando' | 'insuficiente_evidência'
export type Confiança = 'insuficiente' | 'limitada' | 'moderada' | 'forte'

export interface TendênciaFrente {
  frenteId: string
  período: Período
  tendência: Tendência
  confiança: Confiança
  evidência: string[]
  movimentosPrimeiraMetade: number
  movimentosSegundaMetade: number
}

function metades(período: Período): [Período, Período] {
  const meio = período.início + (período.fim - período.início) / 2
  return [
    { início: período.início, fim: meio },
    { início: meio, fim: período.fim }
  ]
}

/**
 * Confiança deriva só da QUANTIDADE de movimentos observados nas
 * duas metades somadas — nunca uma fórmula de produtividade. Mais
 * evidência = mais confiança na leitura de tendência, como qualquer
 * comparação estatística simples. Limiares são arredondados e
 * conservadores (poucos dados = "insuficiente"/"limitada" mesmo que
 * a diferença pareça grande).
 */
function classificarConfiança(totalMovimentos: number): Confiança {
  if (totalMovimentos < 2) return 'insuficiente'
  if (totalMovimentos < 4) return 'limitada'
  if (totalMovimentos < 8) return 'moderada'
  return 'forte'
}

/**
 * Tendência de uma frente INDIVIDUAL (não-domínio) num período,
 * comparando quantidade de movimentos na primeira vs segunda metade
 * do período. `referencia` nunca é lido aqui como Date.now() — o
 * período já define os limites, não há necessidade de "agora" para
 * esta função (diferente de signal.ts, que compara contra o
 * presente; aqui comparamos duas metades do passado entre si).
 *
 * - 0 ou 1 movimento no total → insuficiente_evidência (não dá pra
 *   comparar nada com menos de 2 pontos de dado)
 * - segunda metade tem mais movimentos que a primeira (diferença
 *   >1, para evitar empate por 1 unidade de ruído) → melhorando
 * - segunda metade tem menos → piorando
 * - diferença <=1 → estável
 */
export async function obterTendênciaFrente(
  storage: StorageAdapter,
  frenteId: string,
  período: Período
): Promise<TendênciaFrente> {
  const [primeiraMetade, segundaMetade] = metades(período)

  const ritmoPrimeira = await obterRitmoObservado(storage, frenteId, primeiraMetade)
  const ritmoSegunda = await obterRitmoObservado(storage, frenteId, segundaMetade)

  const m1 = ritmoPrimeira.quantidadeMovimentos
  const m2 = ritmoSegunda.quantidadeMovimentos
  const total = m1 + m2

  const base = {
    frenteId,
    período,
    movimentosPrimeiraMetade: m1,
    movimentosSegundaMetade: m2
  }

  if (total < 2) {
    return {
      ...base,
      tendência: 'insuficiente_evidência',
      confiança: 'insuficiente',
      evidência: [`apenas ${total} movimento(s) no período inteiro — mínimo de 2 necessário para comparar`]
    }
  }

  const diferença = m2 - m1
  const evidência = [
    `primeira metade do período: ${m1} movimento(s)`,
    `segunda metade do período: ${m2} movimento(s)`
  ]

  let tendência: Tendência
  if (Math.abs(diferença) <= 1) {
    tendência = 'estável'
  } else if (diferença > 1) {
    tendência = 'melhorando'
  } else {
    tendência = 'piorando'
  }

  return { ...base, tendência, confiança: classificarConfiança(total), evidência }
}

// ---- Tendência de domínios ---------------------------------------------

export interface TendênciaDescendente {
  frenteId: string
  tendência: TendênciaFrente
}

export interface MudançaEstruturalNoDomínio {
  frenteId: string
  tipo: string
  criadoEm: number
}

export interface TendênciaDomínio {
  domínioId: string
  período: Período
  /** só frentes-folha (tipo≠domínio) descendentes diretos ou
   * indiretos — domínio não tem ritmo próprio (sem cadência), então
   * não entra nesta lista como se tivesse tendência individual */
  descendentesMelhorando: TendênciaDescendente[]
  descendentesEstáveis: TendênciaDescendente[]
  descendentesPiorando: TendênciaDescendente[]
  descendentesSemEvidência: TendênciaDescendente[]
  /** eventos estruturais (exceto registro de movimento) ocorridos no
   * período em qualquer descendente — dá contexto do que mudou na
   * estrutura, sem reduzir isso a "pior filho" */
  mudançasEstruturais: MudançaEstruturalNoDomínio[]
}

/**
 * Tendência de um domínio: avalia CADA descendente-folha
 * individualmente (reaproveitando obterTendênciaFrente, não
 * duplicando a lógica de comparação de metades) e agrupa por
 * categoria — nunca reduz ao "pior filho" como signal.ts faz para
 * sinal (aqui o objetivo é outro: mostrar o panorama, não só o
 * alarme mais grave). Domínio sem cadência própria nunca aparece
 * como se tivesse tendência individual seguida — só os descendentes
 * contam.
 */
export async function obterTendênciaDomínio(
  storage: StorageAdapter,
  domínioId: string,
  período: Período
): Promise<TendênciaDomínio> {
  const todasFrentes = await storage.getFrentes()
  const descendentesDiretos = todasFrentes.filter((f) => f.parentId === domínioId)

  const resultado: TendênciaDomínio = {
    domínioId,
    período,
    descendentesMelhorando: [],
    descendentesEstáveis: [],
    descendentesPiorando: [],
    descendentesSemEvidência: [],
    mudançasEstruturais: []
  }

  for (const filho of descendentesDiretos) {
    if (filho.tipo === 'domínio') {
      // domínio aninhado: desce recursivamente e incorpora os
      // resultados dos netos — não avalia o domínio em si
      const subResultado = await obterTendênciaDomínio(storage, filho.id, período)
      resultado.descendentesMelhorando.push(...subResultado.descendentesMelhorando)
      resultado.descendentesEstáveis.push(...subResultado.descendentesEstáveis)
      resultado.descendentesPiorando.push(...subResultado.descendentesPiorando)
      resultado.descendentesSemEvidência.push(...subResultado.descendentesSemEvidência)
      resultado.mudançasEstruturais.push(...subResultado.mudançasEstruturais)
    } else {
      const tendência = await obterTendênciaFrente(storage, filho.id, período)
      const item: TendênciaDescendente = { frenteId: filho.id, tendência }
      if (tendência.tendência === 'melhorando') resultado.descendentesMelhorando.push(item)
      else if (tendência.tendência === 'estável') resultado.descendentesEstáveis.push(item)
      else if (tendência.tendência === 'piorando') resultado.descendentesPiorando.push(item)
      else resultado.descendentesSemEvidência.push(item)
    }

    const eventos = await storage.getEventosEstruturais(filho.id)
    for (const e of eventos) {
      if (e.criadoEm >= período.início && e.criadoEm < período.fim && e.tipo !== 'criação') {
        resultado.mudançasEstruturais.push({ frenteId: filho.id, tipo: e.tipo, criadoEm: e.criadoEm })
      }
    }
  }

  resultado.mudançasEstruturais.sort((a, b) => a.criadoEm - b.criadoEm)

  return resultado
}
