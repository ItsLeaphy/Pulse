import type { Frente, Registro, EventoEstrutural } from './types'
import type { ResultadoFrente, ResultadoRegistro, ResultadoRemoçãoRegistro, ResultadoExclusãoFrente } from './storage'
import { ErroPulse } from './erros'

// ============================================================
// MOTOR DAS OPERAÇÕES ATÔMICAS (adapters locais e de teste)
//
// Funções PURAS: recebem o conjunto de dados, devolvem o NOVO conjunto
// (ou lançam, sem ter mudado nada). Quem chama grava o resultado de
// uma vez só — por isso "ou tudo, ou nada" vale também no modo local.
//
// É o espelho em TypeScript das funções SQL de
// supabase-migration-005-operacoes-atomicas.sql (mesmas regras, mesmos
// códigos de erro, mesmas respostas). A paridade é verificada pela
// mesma bateria de testes rodando contra os dois (test-atomicidade.ts
// e test-pg.ts).
// ============================================================

export interface Dados {
  frentes: Frente[]
  registros: Registro[]
  eventos: EventoEstrutural[]
}

/** Códigos de erro das operações atômicas (iguais aos SQLSTATE da migration 005). */
export const CÓDIGO_NAO_ENCONTRADO = 'PU404'
export const CÓDIGO_CONFLITO = 'PU409'
export const CÓDIGO_INVÁLIDO = 'PU422'

function erro(operação: string, código: string, mensagem: string): ErroPulse {
  return new ErroPulse(operação, { mensagem, código }, false)
}

const MSG_FRENTE_ALTERADA =
  'Esta frente foi alterada em outro lugar (outra aba ou aparelho) depois que você a abriu. Recarregue a página e refaça a alteração.'
const MSG_REGISTRO_ALTERADO =
  'Este registro foi alterado em outro lugar depois que você o abriu. Recarregue a página e refaça a alteração.'

/** Só o que o app controla; `últimoMovimento` é derivado e fica de fora. */
function comparávelFrente(f: Frente): string {
  return JSON.stringify([
    f.nome,
    f.área,
    f.tipo,
    f.parentId ?? null,
    f.cicloVida,
    f.condição,
    f.cadênciaEsperada ?? null,
    f.contextoFoco ?? null,
    f.contextoBloqueio ?? null,
    f.pausaMotivo ?? null,
    f.pausaRetomadaEm ?? null,
    f.criadaEm
  ])
}

function comparávelRegistro(r: Registro): string {
  return JSON.stringify([r.frenteId, r.data, r.criadoEm, r.texto, r.contaComoMovimento, r.dadosExtra?.duraçãoMin ?? null])
}

/** Descendentes (filhos, netos...) sem tocar storage; protegido contra ciclo. */
export function descendentesDe(id: string, todas: Frente[], visitados: Set<string> = new Set([id])): string[] {
  const diretos = todas.filter((f) => f.parentId === id && !visitados.has(f.id)).map((f) => f.id)
  diretos.forEach((d) => visitados.add(d))
  let todos = [...diretos]
  for (const filhoId of diretos) {
    todos = todos.concat(descendentesDe(filhoId, todas, visitados))
  }
  return todos
}

/** Maior `data` entre os registros que contam como movimento, ou null. */
export function calcularÚltimoMovimento(registros: Registro[], frenteId: string): number | null {
  let max: number | null = null
  for (const r of registros) {
    if (r.frenteId === frenteId && r.contaComoMovimento && (max === null || r.data > max)) max = r.data
  }
  return max
}

function comCache(frentes: Frente[], registros: Registro[], frenteId: string): Frente[] {
  const um = calcularÚltimoMovimento(registros, frenteId)
  return frentes.map((f) => (f.id === frenteId && f.últimoMovimento !== um ? { ...f, últimoMovimento: um } : f))
}

// ------------------------------------------------------------
// Frente (+ eventos)
// ------------------------------------------------------------
export function aplicarSalvarFrente(
  d: Dados,
  frente: Frente,
  eventos: EventoEstrutural[],
  esperado: Frente | null,
  operação = 'salvar a frente'
): { dados: Dados; resultado: ResultadoFrente } {
  const nome = frente.nome.trim()
  if (nome === '') throw erro(operação, CÓDIGO_INVÁLIDO, 'Dê um nome para a frente.')
  if (eventos.some((e) => e.frenteId !== frente.id)) throw erro(operação, CÓDIGO_INVÁLIDO, 'Evento pertence a outra frente.')
  const novo: Frente = { ...frente, nome }
  const atual = d.frentes.find((f) => f.id === frente.id)

  const existeMãe = (id: string) => d.frentes.some((f) => f.id === id)
  const eventosNovos = () => {
    const ids = new Set(d.eventos.map((e) => e.id))
    return [...d.eventos, ...eventos.filter((e) => !ids.has(e.id))]
  }

  if (!atual) {
    if (esperado !== null) throw erro(operação, CÓDIGO_NAO_ENCONTRADO, 'Esta frente não existe mais (foi excluída em outro lugar).')
    if (novo.parentId !== null && !existeMãe(novo.parentId)) {
      throw erro(operação, CÓDIGO_INVÁLIDO, 'A frente-mãe não existe mais. Volte e escolha outra.')
    }
    const criada: Frente = { ...novo, últimoMovimento: null }
    return {
      dados: { ...d, frentes: [...d.frentes, criada], eventos: eventosNovos() },
      resultado: { status: 'criada', frente: criada }
    }
  }

  if (esperado === null) {
    // criação repetida (retry de resposta perdida): nunca sobrescreve
    return { dados: d, resultado: { status: 'ja_existia', frente: atual } }
  }

  if (comparávelFrente(atual) === comparávelFrente(novo)) {
    // já está assim: a transação original gravou também os eventos
    return { dados: d, resultado: { status: 'ja_aplicada', frente: atual } }
  }
  if (comparávelFrente(atual) !== comparávelFrente(esperado)) {
    throw erro(operação, CÓDIGO_CONFLITO, MSG_FRENTE_ALTERADA)
  }

  if (novo.parentId !== null && novo.parentId !== atual.parentId) {
    if (novo.parentId === novo.id) throw erro(operação, CÓDIGO_INVÁLIDO, 'Uma frente não pode ser filha de si mesma.')
    if (!existeMãe(novo.parentId)) throw erro(operação, CÓDIGO_INVÁLIDO, 'A frente-mãe não existe mais. Volte e escolha outra.')
    if (descendentesDe(novo.id, d.frentes).includes(novo.parentId)) {
      throw erro(
        operação,
        CÓDIGO_INVÁLIDO,
        'Não é possível mover uma frente para dentro de uma das suas próprias sub-frentes (criaria um ciclo).'
      )
    }
  }

  const aplicada: Frente = { ...novo, últimoMovimento: calcularÚltimoMovimento(d.registros, novo.id) }
  return {
    dados: { ...d, frentes: d.frentes.map((f) => (f.id === aplicada.id ? aplicada : f)), eventos: eventosNovos() },
    resultado: { status: 'aplicada', frente: aplicada }
  }
}

// ------------------------------------------------------------
// Registro (+ cache da frente)
// ------------------------------------------------------------
export function aplicarSalvarRegistro(
  d: Dados,
  registro: Registro,
  esperado: Registro | null,
  operação = 'salvar o registro'
): { dados: Dados; resultado: ResultadoRegistro } {
  if (!d.frentes.some((f) => f.id === registro.frenteId)) {
    throw erro(operação, CÓDIGO_NAO_ENCONTRADO, 'A frente deste registro não existe mais.')
  }
  const atual = d.registros.find((r) => r.id === registro.id)

  let registros = d.registros
  let status: ResultadoRegistro['status']
  let final: Registro

  if (!atual) {
    if (esperado !== null) throw erro(operação, CÓDIGO_NAO_ENCONTRADO, 'Este registro não existe mais (foi excluído em outro lugar).')
    registros = [...d.registros, registro]
    status = 'criado'
    final = registro
  } else if (esperado === null) {
    status = 'ja_existia'
    final = atual
  } else {
    if (atual.frenteId !== registro.frenteId) throw erro(operação, CÓDIGO_INVÁLIDO, 'Um registro não pode mudar de frente.')
    if (comparávelRegistro(atual) === comparávelRegistro(registro)) {
      status = 'ja_aplicado'
      final = atual
    } else if (comparávelRegistro(atual) === comparávelRegistro(esperado)) {
      registros = d.registros.map((r) => (r.id === registro.id ? registro : r))
      status = 'aplicado'
      final = registro
    } else {
      throw erro(operação, CÓDIGO_CONFLITO, MSG_REGISTRO_ALTERADO)
    }
  }

  // recalcula do zero (também "cura" um cache antigo divergente)
  const frentes = comCache(d.frentes, registros, registro.frenteId)
  return { dados: { ...d, frentes, registros }, resultado: { status, registro: final } }
}

export function aplicarRemoverRegistro(d: Dados, id: string): { dados: Dados; resultado: ResultadoRemoçãoRegistro } {
  const atual = d.registros.find((r) => r.id === id)
  if (!atual) return { dados: d, resultado: { status: 'ja_removido' } }
  const registros = d.registros.filter((r) => r.id !== id)
  return {
    dados: { ...d, registros, frentes: comCache(d.frentes, registros, atual.frenteId) },
    resultado: { status: 'removido' }
  }
}

// ------------------------------------------------------------
// Exclusão permanente em cascata
// ------------------------------------------------------------
export function aplicarRemoverFrenteEmCascata(d: Dados, id: string): { dados: Dados; resultado: ResultadoExclusãoFrente } {
  if (!d.frentes.some((f) => f.id === id)) {
    return { dados: d, resultado: { status: 'ja_removida', frentes: 0, registros: 0, eventos: 0 } }
  }
  const ids = new Set([id, ...descendentesDe(id, d.frentes)])
  const frentes = d.frentes.filter((f) => !ids.has(f.id))
  const registros = d.registros.filter((r) => !ids.has(r.frenteId))
  const eventos = d.eventos.filter((e) => !ids.has(e.frenteId))
  return {
    dados: { frentes, registros, eventos },
    resultado: {
      status: 'removida',
      frentes: d.frentes.length - frentes.length,
      registros: d.registros.length - registros.length,
      eventos: d.eventos.length - eventos.length
    }
  }
}
