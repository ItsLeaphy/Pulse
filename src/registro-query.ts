import type { StorageAdapter } from './storage'
import type { Registro } from './types'
import { criarRegistro } from './frente-ops'
import { coletarDescendentes } from './frente-ops'

// ============================================================
// CAPTURA E RECUPERAÇÃO — BLOCO 4
//
// Duas responsabilidades neste módulo: (1) registro global, uma
// operação de domínio que não depende de já estar "dentro" de uma
// frente na UI; (2) busca de registros por filtros estruturados.
// Nenhuma das duas duplica criarRegistro, coletarDescendentes ou a
// lógica de histórico — todas reaproveitadas de frente-ops.ts.
// ============================================================

// ---- Registro global ------------------------------------------------

/**
 * Registra algo numa frente sem exigir que o chamador já tenha
 * navegado "para dentro" dela — é a mesma operação que criarRegistro,
 * mas validando explicitamente que a frente existe (criarRegistro
 * em si não valida isso, por compatibilidade com cenários de
 * migração onde pode fazer sentido não checar) e SEM expor um
 * parâmetro `criadoEm` ao chamador: aqui `criadoEm` é sempre
 * Date.now(), nunca escolhido pelo usuário — só `data` (quando o
 * fato aconteceu) é editável, podendo ser retroativa.
 *
 * Registro em frente concluída/arquivada não é bloqueado aqui — não
 * há invariante no Bloco 1-3 que proíba registrar texto numa frente
 * encerrada (só a MUDANÇA de ciclo de vida/condição tem invariantes;
 * um registro é só evidência, e evidência sobre algo já concluído é
 * válida, ex: "encontrei um bug nisso depois de já ter marcado como
 * concluído"). recalcularÚltimoMovimento (chamado dentro de
 * criarRegistro) atualiza o cache normalmente nesse caso também —
 * não há regra que proíba isso, e inventar uma agora seria escopo
 * novo não pedido neste bloco.
 */
export async function registrarGlobal(
  storage: StorageAdapter,
  dados: { frenteId: string; texto: string; contaComoMovimento: boolean; data?: number }
): Promise<Registro> {
  const frente = await storage.getFrente(dados.frenteId)
  if (!frente) {
    throw new Error(`Frente ${dados.frenteId} não encontrada — não é possível registrar`)
  }

  return criarRegistro(storage, {
    frenteId: dados.frenteId,
    texto: dados.texto,
    contaComoMovimento: dados.contaComoMovimento,
    data: dados.data ?? Date.now()
    // criadoEm propositalmente omitido — criarRegistro usa seu
    // próprio default (Date.now()); nunca repassamos escolha do
    // usuário pra esse campo.
  })
}

// ---- Busca de registros -----------------------------------------------

/**
 * Filtros estruturados — nunca strings mágicas. `texto` é correspondência
 * simples (substring, case-insensitive), não busca semântica. Intervalo
 * de `data` segue a mesma semântica semiaberta [início, fim) já usada em
 * historico.ts (Período) — reaproveitada aqui, não redefinida.
 */
export interface FiltroRegistros {
  frenteId?: string
  incluirDescendentes?: boolean
  texto?: string
  início?: number // inclusivo
  fim?: number // exclusivo
  limite?: number
  ordem?: 'crescente' | 'decrescente' // por `data`; default decrescente (mais recente primeiro)
}

function noIntervalo(data: number, início?: number, fim?: number): boolean {
  if (início !== undefined && data < início) return false
  if (fim !== undefined && data >= fim) return false
  return true
}

/**
 * Busca registros por filtros estruturados. Determinística: ordena
 * sempre por `data` e, em caso de empate exato, por `id` (ordem
 * lexicográfica) como critério de desempate estável — nunca depende
 * da ordem de retorno do storage.
 *
 * Filtro temporal (`início`/`fim`) é sempre sobre `data` (quando o
 * fato aconteceu), nunca `criadoEm` — coerente com o resto do
 * sistema (sinal, histórico, retrospectiva já usam `data`).
 */
export async function buscarRegistros(storage: StorageAdapter, filtros: FiltroRegistros = {}): Promise<Registro[]> {
  let ids: string[]
  if (filtros.frenteId) {
    ids = filtros.incluirDescendentes
      ? [filtros.frenteId, ...(await coletarDescendentes(filtros.frenteId, storage))]
      : [filtros.frenteId]
  } else {
    ids = (await storage.getFrentes()).map((f) => f.id)
  }

  let resultado: Registro[] = []
  for (const id of ids) {
    const registros = await storage.getRegistros(id)
    resultado = resultado.concat(registros)
  }

  if (filtros.texto !== undefined) {
    const buscaLower = filtros.texto.toLowerCase()
    resultado = resultado.filter((r) => r.texto.toLowerCase().includes(buscaLower))
  }

  if (filtros.início !== undefined || filtros.fim !== undefined) {
    resultado = resultado.filter((r) => noIntervalo(r.data, filtros.início, filtros.fim))
  }

  const direção = filtros.ordem === 'crescente' ? 1 : -1
  resultado.sort((a, b) => {
    const porData = (a.data - b.data) * direção
    if (porData !== 0) return porData
    // empate exato em `data`: desempate estável por id, sempre na
    // mesma direção (não depende de `ordem` escolhida pelo chamador
    // — o desempate em si é sempre crescente por id, só o critério
    // principal (`data`) é que inverte)
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  if (filtros.limite !== undefined) {
    resultado = resultado.slice(0, filtros.limite)
  }

  return resultado
}
