// ============================================================
// TRATAMENTO DE ERROS
// Qualquer coisa lançada (Error, PostgrestError do Supabase —
// que é um objeto simples, não um Error —, string, objeto
// arbitrário) vira um ErroPulse com mensagem legível. Nenhum
// caminho do app pode terminar em "[object Object]".
// ============================================================

export interface DetalhesErro {
  mensagem: string
  código?: string
  detalhes?: string
  dica?: string
}

/** Erro com contexto: qual operação falhou e os campos estruturados
 * que o Supabase devolve (code/message/details/hint). */
export class ErroPulse extends Error {
  readonly operação: string
  readonly código?: string
  readonly detalhes?: string
  readonly dica?: string
  /** true quando repetir a mesma operação é seguro (idempotente) */
  readonly podeRepetir: boolean

  constructor(operação: string, d: DetalhesErro, podeRepetir = true) {
    super(d.mensagem)
    this.name = 'ErroPulse'
    this.operação = operação
    this.código = d.código
    this.detalhes = d.detalhes
    this.dica = d.dica
    this.podeRepetir = podeRepetir
  }
}

/** Erro de validação de entrada — a mensagem já é para o usuário. */
export class ErroValidação extends Error {
  constructor(mensagem: string) {
    super(mensagem)
    this.name = 'ErroValidação'
  }
}

/**
 * Operação composta que parou no meio: parte foi gravada, parte não.
 * Nunca deve ser apresentada como "falhou tudo".
 * `completar` (se existir) grava só o que falta, de forma idempotente.
 */
export class ErroParcial extends Error {
  readonly operação: string
  readonly concluído: string[]
  readonly pendente: string[]
  readonly causa: DetalhesErro
  readonly completar?: () => Promise<void>

  constructor(
    operação: string,
    concluído: string[],
    pendente: string[],
    causa: unknown,
    completar?: () => Promise<void>
  ) {
    const c = extrairDetalhes(causa)
    super(
      `${operação}: parte concluída (${concluído.join(', ')}); não concluído: ${pendente.join(', ')}. ${c.mensagem}`
    )
    this.name = 'ErroParcial'
    this.operação = operação
    this.concluído = concluído
    this.pendente = pendente
    this.causa = c
    this.completar = completar
  }
}

function textoOuUndefined(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

/** Extrai mensagem/código/detalhes/dica de qualquer valor lançado. */
export function extrairDetalhes(err: unknown): DetalhesErro {
  if (err instanceof ErroPulse) {
    return { mensagem: err.message, código: err.código, detalhes: err.detalhes, dica: err.dica }
  }
  if (err instanceof Error) {
    const o = err as Error & { code?: unknown; details?: unknown; hint?: unknown }
    return {
      mensagem: err.message || err.name || 'Erro sem mensagem',
      código: textoOuUndefined(o.code),
      detalhes: textoOuUndefined(o.details),
      dica: textoOuUndefined(o.hint)
    }
  }
  if (typeof err === 'string') return { mensagem: err.trim() || 'Erro sem mensagem' }
  if (typeof err === 'object' && err !== null) {
    const o = err as Record<string, unknown>
    const mensagem =
      textoOuUndefined(o.message) ??
      textoOuUndefined(o.error_description) ??
      textoOuUndefined(o.msg) ??
      (typeof o.error === 'string' ? textoOuUndefined(o.error) : undefined) ??
      textoOuUndefined(o.statusText)
    const código = textoOuUndefined(o.code) ?? (typeof o.status === 'number' ? String(o.status) : undefined)
    if (mensagem) {
      return { mensagem, código, detalhes: textoOuUndefined(o.details), dica: textoOuUndefined(o.hint) }
    }
    try {
      const json = JSON.stringify(err)
      if (json && json !== '{}') return { mensagem: json.slice(0, 300), código }
    } catch {
      /* referência circular etc. — cai no fallback */
    }
  }
  return { mensagem: 'Erro desconhecido' }
}

/** Códigos Postgres/PostgREST que indicam banco incompatível com o app. */
const CÓDIGOS_SCHEMA = new Set([
  '23502',
  '23514',
  '42703',
  '42P01',
  'PGRST204',
  'PGRST205',
  'PGRST200',
  // função RPC inexistente: a migration 005 (operações atômicas) não foi aplicada
  'PGRST202',
  '42883'
])

/**
 * Erros definitivos das operações atômicas (migration 005): não existe,
 * conflito de edição, dados inválidos. Repetir a MESMA chamada não ajuda.
 */
const CÓDIGOS_DEFINITIVOS = new Set(['PU404', 'PU409', 'PU422'])

export function indicaSchemaIncompatível(d: DetalhesErro): boolean {
  return d.código !== undefined && CÓDIGOS_SCHEMA.has(d.código)
}

function ehErroDeRede(d: DetalhesErro): boolean {
  return /failed to fetch|networkerror|load failed|network request failed/i.test(d.mensagem)
}

function emDev(): boolean {
  try {
    return (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true
  } catch {
    return false
  }
}

/** Remove tokens/chaves que possam aparecer em mensagens de log. */
export function redigirSegredos(texto: string): string {
  return texto
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[jwt]')
    .replace(/bearer\s+[^\s"',}]+/gi, 'Bearer [oculto]')
    .replace(/(apikey|authorization|password|senha|token)(["':=\s]+)(?!\[oculto\]|Bearer)[^\s"',}]+/gi, '$1$2[oculto]')
}

/**
 * Normaliza qualquer valor lançado em um ErroPulse contextualizado
 * pela operação. Idempotente: normalizar um ErroPulse devolve ele mesmo.
 */
export function normalizarErro(err: unknown, operação: string, podeRepetir = true): ErroPulse {
  if (err instanceof ErroPulse) return err
  const d = extrairDetalhes(err)
  const definitivo = d.código !== undefined && CÓDIGOS_DEFINITIVOS.has(d.código)
  return new ErroPulse(operação, d, podeRepetir && !definitivo)
}

/**
 * Texto final para o usuário. Em produção não expõe código/detalhes
 * internos; em desenvolvimento acrescenta código, detalhes e dica.
 */
export function mensagemParaUsuário(err: unknown, operaçãoPadrão = 'concluir a operação', dev: boolean = emDev()): string {
  if (err instanceof ErroValidação) return err.message

  if (err instanceof ErroParcial) {
    const base = `Parte da operação foi salva (${err.concluído.join(', ')}), mas não foi concluído: ${err.pendente.join(', ')}.`
    const motivo = descreverMotivo(err.causa)
    const extra = err.completar ? ' Use "Tentar completar" — nada será duplicado.' : ''
    return `${base} ${motivo}${extra}${dev ? tecnico(err.causa) : ''}`
  }

  const operação = err instanceof ErroPulse ? err.operação : operaçãoPadrão
  const d = extrairDetalhes(err)
  return `Não foi possível ${operação}. ${descreverMotivo(d)}${dev ? tecnico(d) : ''}`
}

function descreverMotivo(d: DetalhesErro): string {
  if (indicaSchemaIncompatível(d)) {
    return 'O banco de dados parece desatualizado em relação a esta versão do app. Aplique as migrações pendentes, incluindo a 005 (veja PULSE_HANDOFF.md).'
  }
  if (d.código === '42501' || /row-level security|permission denied/i.test(d.mensagem)) {
    return 'Sem permissão para essa operação. Entre novamente na sua conta.'
  }
  if (d.código === 'PGRST301' || /jwt expired|invalid jwt/i.test(d.mensagem)) {
    return 'Sua sessão expirou. Recarregue a página e entre novamente.'
  }
  if (ehErroDeRede(d)) {
    return 'Sem conexão com o servidor. Verifique a internet e tente de novo.'
  }
  if (/quota|exceeded/i.test(d.mensagem)) {
    return 'O armazenamento local está cheio.'
  }
  return d.mensagem
}

function tecnico(d: DetalhesErro): string {
  const partes = [
    d.código ? `código ${d.código}` : null,
    d.mensagem ? `mensagem: ${d.mensagem}` : null,
    d.detalhes ? `detalhes: ${d.detalhes}` : null,
    d.dica ? `dica: ${d.dica}` : null
  ].filter((p): p is string => p !== null)
  return partes.length > 0 ? ` [${redigirSegredos(partes.join(' · '))}]` : ''
}

/** Log de diagnóstico: só em desenvolvimento, sempre sem segredos. */
export function registrarDiagnóstico(operação: string, err: unknown): void {
  if (!emDev()) return
  const d = extrairDetalhes(err)
  console.error(`[pulse] falha ao ${operação}`, {
    código: d.código,
    mensagem: redigirSegredos(d.mensagem),
    detalhes: d.detalhes ? redigirSegredos(d.detalhes) : undefined,
    dica: d.dica
  })
}
