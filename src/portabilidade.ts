import type { StorageAdapter } from './storage'
import type { Frente, Registro, EventoEstrutural } from './types'

// ============================================================
// PORTABILIDADE — BLOCO 5 (export/import)
//
// Trabalha inteiramente sobre o modelo de domínio (Frente,
// Registro, EventoEstrutural) via StorageAdapter — nunca toca
// Supabase, localStorage ou qualquer detalhe de sessão/credencial
// diretamente. O mesmo módulo funciona com qualquer adapter.
// ============================================================

export const VERSÃO_EXPORT_ATUAL = 1

export interface PulseExport {
  versão: number
  exportadoEm: number
  frentes: Frente[]
  registros: Registro[]
  eventosEstruturais: EventoEstrutural[]
}

/**
 * Exporta todo o estado do Pulse num objeto JSON-serializável
 * versionado. Não inclui: tokens, credenciais, dados de sessão do
 * Supabase (nada disso está no modelo de domínio pra começar, já
 * que StorageAdapter abstrai isso) e nenhum campo-cache
 * reconstruível (últimoMovimento não precisa ser listado à parte —
 * já é parte de Frente, e é recalculável a partir de Registro, mas
 * exportá-lo junto da frente é inofensivo: na importação ele é
 * recalculável, nunca é a fonte de verdade).
 *
 * Determinística para os mesmos dados: a única informação temporal
 * que não vem dos próprios dados é `exportadoEm`, que é inerente ao
 * ato de exportar (quando a exportação foi feita), não um dado do
 * Pulse em si — frentes/registros/eventos exportados são sempre os
 * mesmos para o mesmo storage, na mesma ordem (ordenados por id,
 * não pela ordem de retorno do storage).
 */
export async function exportarPulse(storage: StorageAdapter, agora: number = Date.now()): Promise<PulseExport> {
  const frentes = [...(await storage.getFrentes())].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const registros: Registro[] = []
  const eventosEstruturais: EventoEstrutural[] = []
  for (const f of frentes) {
    registros.push(...(await storage.getRegistros(f.id)))
    eventosEstruturais.push(...(await storage.getEventosEstruturais(f.id)))
  }
  registros.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  eventosEstruturais.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  return {
    versão: VERSÃO_EXPORT_ATUAL,
    exportadoEm: agora,
    frentes,
    registros,
    eventosEstruturais
  }
}

// ---- Importação ------------------------------------------------------

export interface ErroValidaçãoImport {
  campo: string
  mensagem: string
}

export class ErroImportPulse extends Error {
  constructor(public erros: ErroValidaçãoImport[]) {
    super(`Importação inválida: ${erros.length} erro(s) — ${erros.map((e) => e.mensagem).join('; ')}`)
    this.name = 'ErroImportPulse'
  }
}

const TIPOS_ÁREA = new Set(['work', 'life', 'art'])
const TIPOS_FRENTE = new Set(['projeto', 'prática', 'domínio'])
const TIPOS_CICLO_VIDA = new Set(['ativa', 'concluída', 'arquivada'])
const TIPOS_CONDIÇÃO = new Set(['normal', 'bloqueada', 'aguardando', 'pausada'])
const TIPOS_EVENTO = new Set(['criação', 'ciclo_vida_mudou', 'condição_mudou', 'cadência_mudou', 'hierarquia_mudou'])

function validarEstrutura(dados: unknown): ErroValidaçãoImport[] {
  const erros: ErroValidaçãoImport[] = []

  if (typeof dados !== 'object' || dados === null) {
    return [{ campo: 'raiz', mensagem: 'dados importados não são um objeto' }]
  }
  const d = dados as Record<string, unknown>

  if (typeof d.versão !== 'number') {
    erros.push({ campo: 'versão', mensagem: 'campo versão ausente ou não é número' })
  } else if (d.versão !== VERSÃO_EXPORT_ATUAL) {
    erros.push({
      campo: 'versão',
      mensagem: `versão ${d.versão} não suportada (esperada ${VERSÃO_EXPORT_ATUAL})`
    })
  }

  if (!Array.isArray(d.frentes)) {
    erros.push({ campo: 'frentes', mensagem: 'campo frentes ausente ou não é array' })
  }
  if (!Array.isArray(d.registros)) {
    erros.push({ campo: 'registros', mensagem: 'campo registros ausente ou não é array' })
  }
  if (!Array.isArray(d.eventosEstruturais)) {
    erros.push({ campo: 'eventosEstruturais', mensagem: 'campo eventosEstruturais ausente ou não é array' })
  }

  // se a estrutura básica já falhou, não vale a pena validar o conteúdo
  if (erros.length > 0) return erros

  const frentes = d.frentes as unknown[]
  const registros = d.registros as unknown[]
  const eventos = d.eventosEstruturais as unknown[]

  const idsFrentesVistos = new Set<string>()
  const idsFrentesVálidos = new Set<string>()

  frentes.forEach((item, i) => {
    if (typeof item !== 'object' || item === null) {
      erros.push({ campo: `frentes[${i}]`, mensagem: 'item não é um objeto' })
      return
    }
    const f = item as Record<string, unknown>

    if (typeof f.id !== 'string' || f.id === '') {
      erros.push({ campo: `frentes[${i}].id`, mensagem: 'id ausente ou inválido' })
      return
    }
    if (idsFrentesVistos.has(f.id)) {
      erros.push({ campo: `frentes[${i}].id`, mensagem: `id duplicado: ${f.id}` })
    }
    idsFrentesVistos.add(f.id)
    idsFrentesVálidos.add(f.id)

    if (typeof f.nome !== 'string') erros.push({ campo: `frentes[${i}].nome`, mensagem: 'nome inválido' })
    if (!TIPOS_ÁREA.has(f.área as string)) erros.push({ campo: `frentes[${i}].área`, mensagem: `área inválida: ${String(f.área)}` })
    if (!TIPOS_FRENTE.has(f.tipo as string)) erros.push({ campo: `frentes[${i}].tipo`, mensagem: `tipo inválido: ${String(f.tipo)}` })
    if (!TIPOS_CICLO_VIDA.has(f.cicloVida as string))
      erros.push({ campo: `frentes[${i}].cicloVida`, mensagem: `cicloVida inválido: ${String(f.cicloVida)}` })
    if (!TIPOS_CONDIÇÃO.has(f.condição as string))
      erros.push({ campo: `frentes[${i}].condição`, mensagem: `condição inválida: ${String(f.condição)}` })
    if (f.parentId !== null && typeof f.parentId !== 'string') {
      erros.push({ campo: `frentes[${i}].parentId`, mensagem: 'parentId deve ser string ou null' })
    }
    if (typeof f.criadaEm !== 'number') erros.push({ campo: `frentes[${i}].criadaEm`, mensagem: 'criadaEm inválido' })
  })

  // parentId precisa apontar pra uma frente que também está no
  // import (não necessariamente já existente no storage — isso é
  // checado depois, contra o storage real)
  frentes.forEach((item, i) => {
    const f = item as Record<string, unknown>
    if (f.parentId !== null && f.parentId !== undefined && !idsFrentesVálidos.has(f.parentId as string)) {
      erros.push({ campo: `frentes[${i}].parentId`, mensagem: `parentId ${String(f.parentId)} não corresponde a nenhuma frente no import` })
    }
  })

  // detecção de ciclo dentro do próprio import
  const parentPorId = new Map<string, string | null>()
  frentes.forEach((item) => {
    const f = item as Record<string, unknown>
    if (typeof f.id === 'string') parentPorId.set(f.id, (f.parentId as string | null) ?? null)
  })
  for (const id of idsFrentesVálidos) {
    const visitados = new Set<string>()
    let atual: string | null = id
    while (atual !== null) {
      if (visitados.has(atual)) {
        erros.push({ campo: 'frentes', mensagem: `ciclo detectado envolvendo a frente ${id}` })
        break
      }
      visitados.add(atual)
      atual = parentPorId.get(atual) ?? null
    }
  }

  const idsRegistrosVistos = new Set<string>()
  registros.forEach((item, i) => {
    if (typeof item !== 'object' || item === null) {
      erros.push({ campo: `registros[${i}]`, mensagem: 'item não é um objeto' })
      return
    }
    const r = item as Record<string, unknown>
    if (typeof r.id !== 'string' || r.id === '') {
      erros.push({ campo: `registros[${i}].id`, mensagem: 'id ausente ou inválido' })
      return
    }
    if (idsRegistrosVistos.has(r.id)) {
      erros.push({ campo: `registros[${i}].id`, mensagem: `id duplicado: ${r.id}` })
    }
    idsRegistrosVistos.add(r.id)

    if (typeof r.frenteId !== 'string' || !idsFrentesVálidos.has(r.frenteId)) {
      erros.push({ campo: `registros[${i}].frenteId`, mensagem: `frenteId ${String(r.frenteId)} não corresponde a nenhuma frente no import` })
    }
    if (typeof r.data !== 'number') erros.push({ campo: `registros[${i}].data`, mensagem: 'data inválida' })
    if (typeof r.criadoEm !== 'number') erros.push({ campo: `registros[${i}].criadoEm`, mensagem: 'criadoEm inválido' })
    if (typeof r.texto !== 'string') erros.push({ campo: `registros[${i}].texto`, mensagem: 'texto inválido' })
    if (typeof r.contaComoMovimento !== 'boolean')
      erros.push({ campo: `registros[${i}].contaComoMovimento`, mensagem: 'contaComoMovimento inválido' })
  })

  const idsEventosVistos = new Set<string>()
  eventos.forEach((item, i) => {
    if (typeof item !== 'object' || item === null) {
      erros.push({ campo: `eventosEstruturais[${i}]`, mensagem: 'item não é um objeto' })
      return
    }
    const e = item as Record<string, unknown>
    if (typeof e.id !== 'string' || e.id === '') {
      erros.push({ campo: `eventosEstruturais[${i}].id`, mensagem: 'id ausente ou inválido' })
      return
    }
    if (idsEventosVistos.has(e.id)) {
      erros.push({ campo: `eventosEstruturais[${i}].id`, mensagem: `id duplicado: ${e.id}` })
    }
    idsEventosVistos.add(e.id)

    if (typeof e.frenteId !== 'string' || !idsFrentesVálidos.has(e.frenteId)) {
      erros.push({ campo: `eventosEstruturais[${i}].frenteId`, mensagem: `frenteId ${String(e.frenteId)} não corresponde a nenhuma frente no import` })
    }
    if (!TIPOS_EVENTO.has(e.tipo as string)) erros.push({ campo: `eventosEstruturais[${i}].tipo`, mensagem: `tipo inválido: ${String(e.tipo)}` })
    if (typeof e.criadoEm !== 'number') erros.push({ campo: `eventosEstruturais[${i}].criadoEm`, mensagem: 'criadoEm inválido' })
  })

  return erros
}

/**
 * Importa um PulseExport. Validação completa (estrutura + tipos +
 * ids duplicados + parentId/frenteId órfãos + ciclos DENTRO do
 * import, e colisão de id contra o storage EXISTENTE) acontece
 * inteiramente ANTES de qualquer escrita — se qualquer coisa for
 * inválida, lança ErroImportPulse com a lista completa de problemas
 * e nada é gravado (sem estado parcialmente importado).
 *
 * Política de conflito: rejeita a importação inteira se qualquer id
 * (de frente, registro ou evento) já existir no storage de destino
 * — nunca faz merge silencioso nem sobrescreve. Estratégia de merge
 * fica para o futuro, fora de escopo deste bloco.
 */
export async function importarPulse(storage: StorageAdapter, dados: unknown): Promise<void> {
  const errosEstrutura = validarEstrutura(dados)
  if (errosEstrutura.length > 0) throw new ErroImportPulse(errosEstrutura)

  const pulseExport = dados as PulseExport

  // colisão contra dados JÁ EXISTENTES no storage de destino
  const errosColisão: ErroValidaçãoImport[] = []
  const frentesExistentes = await storage.getFrentes()
  const idsFrentesExistentes = new Set(frentesExistentes.map((f) => f.id))
  for (const f of pulseExport.frentes) {
    if (idsFrentesExistentes.has(f.id)) {
      errosColisão.push({ campo: 'frentes', mensagem: `frente ${f.id} já existe no destino` })
    }
  }
  // registros/eventos: checar colisão exigiria varrer todos os
  // registros/eventos de todas as frentes existentes — fazemos isso
  // só se não houver colisão de frente ainda (evita trabalho
  // desnecessário quando já sabemos que vai rejeitar)
  if (errosColisão.length === 0) {
    const idsRegistrosExistentes = new Set<string>()
    const idsEventosExistentes = new Set<string>()
    for (const f of frentesExistentes) {
      for (const r of await storage.getRegistros(f.id)) idsRegistrosExistentes.add(r.id)
      for (const e of await storage.getEventosEstruturais(f.id)) idsEventosExistentes.add(e.id)
    }
    for (const r of pulseExport.registros) {
      if (idsRegistrosExistentes.has(r.id)) {
        errosColisão.push({ campo: 'registros', mensagem: `registro ${r.id} já existe no destino` })
      }
    }
    for (const e of pulseExport.eventosEstruturais) {
      if (idsEventosExistentes.has(e.id)) {
        errosColisão.push({ campo: 'eventosEstruturais', mensagem: `evento ${e.id} já existe no destino` })
      }
    }
  }
  if (errosColisão.length > 0) throw new ErroImportPulse(errosColisão)

  // tudo validado — agora sim escreve. Frentes primeiro (registros/
  // eventos referenciam frenteId e precisam que a frente já exista
  // no storage de destino, para adapters que validam FK, ex. Supabase).
  for (const f of pulseExport.frentes) {
    await storage.salvarFrente(f)
  }
  for (const r of pulseExport.registros) {
    await storage.salvarRegistro(r)
  }
  for (const e of pulseExport.eventosEstruturais) {
    await storage.salvarEventoEstrutural(e)
  }
}
