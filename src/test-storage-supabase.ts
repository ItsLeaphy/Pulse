import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabaseAdapter } from './storage-supabase'
import { ErroPulse, mensagemParaUsuário } from './erros'
import type { Frente, Registro, EventoEstrutural } from './types'

// ============================================================
// TESTE DE CONTRATO: SupabaseAdapter × schema SQL documentado.
//
// NÃO fala com um Supabase real (não há acesso ao banco remoto neste
// ambiente). Em vez disso:
//  1. interpreta os arquivos .sql do repositório (create table / alter
//     table ... add column / alter column ... drop|set not null /
//     add constraint ... check) e monta o schema resultante;
//  2. executa o adapter contra um cliente simulado que aplica as
//     regras desse schema (coluna inexistente, NOT NULL sem default,
//     CHECK, limite de 1000 linhas por resposta) e devolve erros
//     no formato do PostgrestError (objeto simples, não Error).
//
// Prova que o contrato adapter↔schema é coerente; NÃO prova que o
// banco remoto do usuário está nesse estado (isso depende de ele ter
// aplicado as migrations — ver PULSE_HANDOFF.md).
// Rode com: npm run test:supabase
// ============================================================

let falhas = 0
function check(condição: boolean, mensagem: string): void {
  if (condição) console.log(`✅ ${mensagem}`)
  else {
    console.log(`❌ ${mensagem}`)
    falhas++
  }
}

// ---------- mini-interpretador de SQL ----------

interface Coluna {
  notNull: boolean
  temDefault: boolean
  permitidos?: Set<string>
}
type Schema = Map<string, Map<string, Coluna>> // tabela -> coluna -> definição

function lerSql(arquivo: string): string {
  return readFileSync(new URL(`../${arquivo}`, import.meta.url), 'utf8')
}

function limparSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/do\s+\$\$[\s\S]*?\$\$\s*;/gi, '') // blocos DO (precondições/descoberta de constraint) não são interpretados
}

function dividirTopo(texto: string, sep = ','): string[] {
  const partes: string[] = []
  let prof = 0
  let aspas = false
  let atual = ''
  for (const ch of texto) {
    if (ch === "'") aspas = !aspas
    if (!aspas && ch === '(') prof++
    if (!aspas && ch === ')') prof--
    if (!aspas && prof === 0 && ch === sep) {
      partes.push(atual)
      atual = ''
    } else atual += ch
  }
  if (atual.trim()) partes.push(atual)
  return partes.map((p) => p.trim()).filter(Boolean)
}

function permitidosDe(texto: string, coluna: string): Set<string> | undefined {
  const m = new RegExp(`check\\s*\\(\\s*${coluna}\\s+in\\s*\\(([^)]*)\\)\\s*\\)`, 'i').exec(texto)
  if (!m) return undefined
  return new Set(Array.from(m[1]!.matchAll(/'([^']*)'/g)).map((x) => x[1]!))
}

function definirColuna(def: string): [string, Coluna] | null {
  if (/^(constraint|primary key|unique|foreign|check)\b/i.test(def)) return null
  const nome = def.split(/\s+/)[0]!.replace(/"/g, '')
  return [
    nome,
    {
      notNull: /\bnot null\b/i.test(def) || /\bprimary key\b/i.test(def),
      temDefault: /\bdefault\b/i.test(def),
      permitidos: permitidosDe(def, nome)
    }
  ]
}

function aplicarSql(schema: Schema, sqlBruto: string): void {
  for (const stmt of limparSql(sqlBruto).split(';').map((s) => s.trim()).filter(Boolean)) {
    let m = /^create table (?:if not exists )?public\.(\w+)\s*\(([\s\S]*)\)$/i.exec(stmt)
    if (m) {
      const tabela = m[1]!
      if (schema.has(tabela)) continue
      const colunas = new Map<string, Coluna>()
      for (const def of dividirTopo(m[2]!)) {
        const c = definirColuna(def)
        if (c) colunas.set(c[0], c[1])
      }
      schema.set(tabela, colunas)
      continue
    }
    m = /^alter table public\.(\w+)\s+([\s\S]+)$/i.exec(stmt)
    if (m) {
      const colunas = schema.get(m[1]!)
      if (!colunas) throw new Error(`SQL altera tabela inexistente: ${m[1]}`)
      for (const cl of dividirTopo(m[2]!)) {
        let x = /^add column (?:if not exists )?([\s\S]+)$/i.exec(cl)
        if (x) {
          const c = definirColuna(x[1]!)
          if (c) colunas.set(c[0], c[1])
          continue
        }
        x = /^alter column (\w+) drop not null$/i.exec(cl)
        if (x) {
          const c = colunas.get(x[1]!)
          if (!c) throw new Error(`drop not null em coluna inexistente: ${x[1]}`)
          c.notNull = false
          continue
        }
        x = /^alter column (\w+) set not null$/i.exec(cl)
        if (x) {
          const c = colunas.get(x[1]!)
          if (!c) throw new Error(`set not null em coluna inexistente: ${x[1]}`)
          c.notNull = true
          continue
        }
        x = /^alter column (\w+) set default [\s\S]+$/i.exec(cl)
        if (x) {
          const c = colunas.get(x[1]!)
          if (!c) throw new Error(`set default em coluna inexistente: ${x[1]}`)
          c.temDefault = true
          continue
        }
        x = /^add constraint\s+\w+\s+(check\s*\(\s*(\w+)\s+in[\s\S]*\))$/i.exec(cl)
        if (x) {
          const c = colunas.get(x[2]!)
          if (c) c.permitidos = permitidosDe(x[1]!, x[2]!)
          continue
        }
        // enable row level security etc.: sem efeito no contrato de colunas
      }
    }
  }
}

function montarSchema(arquivos: string[]): Schema {
  const schema: Schema = new Map()
  for (const a of arquivos) aplicarSql(schema, lerSql(a))
  return schema
}

// ---------- cliente Supabase simulado ----------

type Linha = Record<string, unknown>
interface ErroPostgrest {
  code: string
  message: string
  details: string | null
  hint: string | null
}

const LIMITE_PADRÃO = 1000

class BancoFalso {
  linhas = new Map<string, Linha[]>()
  requisições = 0
  constructor(public schema: Schema) {}

  validar(tabela: string, linha: Linha): ErroPostgrest | null {
    const cols = this.schema.get(tabela)
    if (!cols) {
      return { code: '42P01', message: `relation "public.${tabela}" does not exist`, details: null, hint: null }
    }
    for (const k of Object.keys(linha)) {
      if (!cols.has(k)) {
        return {
          code: 'PGRST204',
          message: `Could not find the '${k}' column of '${tabela}' in the schema cache`,
          details: null,
          hint: null
        }
      }
    }
    for (const [nome, c] of cols) {
      if (nome === 'user_id') continue // default auth.uid() no schema real
      const v = linha[nome]
      if ((v === undefined || v === null) && c.notNull && !c.temDefault) {
        return {
          code: '23502',
          message: `null value in column "${nome}" of relation "${tabela}" violates not-null constraint`,
          details: 'Failing row contains (...).',
          hint: null
        }
      }
      if (typeof v === 'string' && c.permitidos && !c.permitidos.has(v)) {
        return {
          code: '23514',
          message: `new row for relation "${tabela}" violates check constraint "${tabela}_${nome}_check"`,
          details: null,
          hint: null
        }
      }
    }
    return null
  }
}

class Consulta {
  private op: 'select' | 'upsert' | 'delete' = 'select'
  private payload: Linha | null = null
  private filtros: [string, unknown][] = []
  private ordens: [string, boolean][] = []
  private faixa: [number, number] | null = null
  private teto: number | null = null
  private único = false

  constructor(private banco: BancoFalso, private tabela: string) {}

  select(_cols?: string) {
    return this
  }
  upsert(l: Linha) {
    this.op = 'upsert'
    this.payload = JSON.parse(JSON.stringify(l)) as Linha // undefined some, como no fetch real
    return this
  }
  delete() {
    this.op = 'delete'
    return this
  }
  eq(c: string, v: unknown) {
    this.filtros.push([c, v])
    return this
  }
  order(c: string, o?: { ascending?: boolean }) {
    this.ordens.push([c, o?.ascending !== false])
    return this
  }
  range(a: number, b: number) {
    this.faixa = [a, b]
    return this
  }
  limit(n: number) {
    this.teto = n
    return this
  }
  maybeSingle() {
    this.único = true
    return this
  }

  then<T>(res: (v: { data: unknown; error: ErroPostgrest | null }) => T, rej?: (e: unknown) => T) {
    return Promise.resolve(this.executar()).then(res, rej)
  }

  private executar(): { data: unknown; error: ErroPostgrest | null } {
    this.banco.requisições++
    const { tabela } = this
    const cols = this.banco.schema.get(tabela)
    if (!cols) {
      return { data: null, error: { code: '42P01', message: `relation "public.${tabela}" does not exist`, details: null, hint: null } }
    }
    const linhas = this.banco.linhas.get(tabela) ?? []
    this.banco.linhas.set(tabela, linhas)

    if (this.op === 'upsert') {
      const erro = this.banco.validar(tabela, this.payload!)
      if (erro) return { data: null, error: erro }
      const i = linhas.findIndex((l) => l.id === this.payload!.id)
      if (i >= 0) linhas[i] = { ...linhas[i], ...this.payload }
      else linhas.push({ ...this.payload })
      return { data: null, error: null }
    }

    for (const [c] of this.filtros) {
      if (!cols.has(c)) {
        return { data: null, error: { code: '42703', message: `column ${tabela}.${c} does not exist`, details: null, hint: null } }
      }
    }
    const casam = linhas.filter((l) => this.filtros.every(([c, v]) => l[c] === v))

    if (this.op === 'delete') {
      this.banco.linhas.set(tabela, linhas.filter((l) => !casam.includes(l)))
      return { data: null, error: null }
    }

    const ordenadas = [...casam].sort((a, b) => {
      for (const [c, asc] of this.ordens) {
        const x = a[c] as number | string
        const y = b[c] as number | string
        if (x < y) return asc ? -1 : 1
        if (x > y) return asc ? 1 : -1
      }
      return 0
    })
    // PostgREST: sem range, a resposta é cortada em max-rows (1000) SEM erro
    let fatia = this.faixa ? ordenadas.slice(this.faixa[0], this.faixa[1] + 1) : ordenadas.slice(0, LIMITE_PADRÃO)
    if (this.teto !== null) fatia = fatia.slice(0, this.teto)
    if (this.único) return { data: fatia[0] ?? null, error: null }
    return { data: fatia, error: null }
  }
}

function clienteFalso(banco: BancoFalso): SupabaseClient {
  return { from: (t: string) => new Consulta(banco, t) } as unknown as SupabaseClient
}

// ---------- dados de exemplo ----------

const frente: Frente = {
  id: 'f1',
  nome: 'Origens',
  área: 'work',
  tipo: 'projeto',
  parentId: null,
  cicloVida: 'ativa',
  condição: 'pausada',
  cadênciaEsperada: null,
  últimoMovimento: 1700000000000,
  contextoFoco: 'foco',
  contextoBloqueio: null,
  pausaMotivo: 'férias',
  pausaRetomadaEm: 1700500000000,
  criadaEm: 1690000000000
}
const registro: Registro = {
  id: 'r1',
  frenteId: 'f1',
  data: 1700000000000,
  criadoEm: 1700000100000,
  texto: 'algo',
  contaComoMovimento: true,
  dadosExtra: { duraçãoMin: 30 }
}
const evento: EventoEstrutural = {
  id: 'e1',
  frenteId: 'f1',
  tipo: 'hierarquia_mudou',
  valorAnterior: null,
  valorNovo: 'f0',
  criadoEm: 1700000200000
}

async function ciclo(banco: BancoFalso): Promise<SupabaseAdapter> {
  const a = new SupabaseAdapter(clienteFalso(banco))
  await a.salvarFrente(frente)
  await a.salvarRegistro(registro)
  await a.salvarEventoEstrutural(evento)
  return a
}

const V1 = 'supabase-schema.sql'
const MIGS_001_003 = ['supabase-migration-001-aditiva.sql', 'supabase-migration-002-bloco2-aditiva.sql', 'supabase-migration-003-bloco5-aditiva.sql']
const M004 = 'supabase-migration-004-compat-adapter.sql'

// ============ A. instalação nova (schema atual) ============
console.log('\n— A. instalação nova: supabase-schema-atual.sql')
{
  const banco = new BancoFalso(montarSchema(['supabase-schema-atual.sql']))
  const a = await ciclo(banco)
  check(true, 'salvar frente, registro e evento (incl. hierarquia_mudou) é aceito pelo schema atual')
  check(JSON.stringify(await a.getFrente('f1')) === JSON.stringify(frente), 'frente: ida e volta sem perda')
  check(JSON.stringify((await a.getRegistros('f1'))[0]) === JSON.stringify(registro), 'registro: ida e volta sem perda (data ≠ criadoEm, duração)')
  check(JSON.stringify((await a.getEventosEstruturais('f1'))[0]) === JSON.stringify(evento), 'evento: ida e volta sem perda')
  const colunasFrentes = [...banco.schema.get('frentes')!.keys()]
  check(
    !['estado', 'ultimo_toque', 'opt_out_negligencia'].some((c) => colunasFrentes.includes(c)),
    'schema atual não carrega colunas legadas'
  )
  await a.salvarFrente({ ...frente, cadênciaEsperada: 7 })
  check((await a.getFrente('f1'))?.cadênciaEsperada === 7, 'upsert por id atualiza (não duplica)')
  check((await a.getFrentes()).length === 1, 'ainda 1 frente depois do upsert')
}

// ============ B. REPRODUÇÃO: v1 + 001–003 (sem 004) ============
console.log('\n— B. banco legado v1 + migrations 001–003, SEM a 004 (reprodução do bug)')
{
  const schema = montarSchema([V1, ...MIGS_001_003])
  const colsFrentes = schema.get('frentes')!
  check(colsFrentes.get('estado')!.notNull && !colsFrentes.get('estado')!.temDefault, 'estado continua NOT NULL sem default após 001–003')
  check(colsFrentes.get('ultimo_toque')!.notNull && !colsFrentes.get('ultimo_toque')!.temDefault, 'ultimo_toque continua NOT NULL sem default após 001–003')
  const banco = new BancoFalso(schema)
  const a = new SupabaseAdapter(clienteFalso(banco))
  let erro: unknown
  try {
    await a.salvarFrente(frente)
  } catch (e) {
    erro = e
  }
  check(erro instanceof ErroPulse, 'salvarFrente lança ErroPulse (não o objeto cru do PostgREST)')
  const ep = erro as ErroPulse
  check(ep?.código === '23502', 'código 23502 (NOT NULL) preservado')
  check(/estado|ultimo_toque/.test(ep?.message ?? ''), 'mensagem identifica a coluna')
  const texto = mensagemParaUsuário(erro, 'salvar a frente', false)
  check(!texto.includes('[object Object]'), 'mensagem ao usuário nunca é "[object Object]"')
  check(/migra/i.test(texto) && !texto.includes('23502'), 'em produção: orienta aplicar migrações, sem expor código interno')
  check(mensagemParaUsuário(erro, 'salvar a frente', true).includes('23502'), 'em desenvolvimento: inclui o código técnico')
}

// ============ C. v1 + 001–003 + 004 ============
console.log('\n— C. atualização completa: v1 + 001 + 002 + 003 + 004')
{
  const schema = montarSchema([V1, ...MIGS_001_003, M004])
  const banco = new BancoFalso(schema)
  const a = await ciclo(banco)
  check(JSON.stringify(await a.getFrente('f1')) === JSON.stringify(frente), 'frente salva e lida corretamente após a 004')
  const colsFrentes = schema.get('frentes')!
  check(colsFrentes.has('estado') && colsFrentes.has('ultimo_toque') && colsFrentes.has('opt_out_negligencia'), '004 não removeu colunas legadas (não destrutiva)')
  check(!colsFrentes.get('estado')!.notNull && !colsFrentes.get('ultimo_toque')!.notNull, '004 relaxou NOT NULL das colunas legadas')
}

// ============ D. banco sem a migration 003 (sem hierarquia_mudou) ============
console.log('\n— D. banco sem a migration 003')
{
  const schema = montarSchema([V1, MIGS_001_003[0]!, MIGS_001_003[1]!, M004])
  const banco = new BancoFalso(schema)
  const a = new SupabaseAdapter(clienteFalso(banco))
  await a.salvarFrente(frente)
  let erro: unknown
  try {
    await a.salvarEventoEstrutural(evento)
  } catch (e) {
    erro = e
  }
  check((erro as ErroPulse)?.código === '23514', 'evento hierarquia_mudou sem a 003 → CHECK 23514 como ErroPulse')
  check(/migra/i.test(mensagemParaUsuário(erro, 'mover', false)), 'mensagem orienta aplicar migrações')
}

// ============ E. paginação ============
console.log('\n— E. leitura de listas > 1000 linhas')
{
  const banco = new BancoFalso(montarSchema(['supabase-schema-atual.sql']))
  const a = new SupabaseAdapter(clienteFalso(banco))
  await a.salvarFrente(frente)
  const linhas: Linha[] = []
  for (let i = 0; i < 2500; i++) {
    linhas.push({
      id: `r${String(i).padStart(5, '0')}`,
      frente_id: 'f1',
      data: 1700000000000 + i,
      criado_em: 1700000000000 + i,
      texto: `t${i}`,
      conta_como_movimento: true,
      duracao_min: null
    })
  }
  banco.linhas.set('registros', linhas)
  banco.requisições = 0
  const todos = await a.getTodosRegistros()
  check(todos.length === 2500, 'getTodosRegistros devolve as 2500 linhas (sem corte silencioso em 1000)')
  check(banco.requisições === 3, 'usou 3 requisições paginadas')
  check((await a.getRegistros('f1')).length === 2500, 'getRegistros(frente) também pagina')
  check(new Set(todos.map((r) => r.id)).size === 2500, 'sem linhas duplicadas entre páginas')
  check(todos[0]!.data > todos[todos.length - 1]!.data, 'ordem por data decrescente mantida')
  check((await a.getRegistrosRecentes(6)).length === 6, 'getRegistrosRecentes respeita o limite')
}

// ============ F. erros estruturados em todas as operações ============
console.log('\n— F. erros estruturados do Supabase em todas as operações')
{
  const erroEstruturado = { code: '42501', message: 'new row violates row-level security policy for table "frentes"', details: 'detalhe x', hint: 'dica y' }
  const cliente = {
    from: () => {
      const q: Record<string, unknown> = {}
      for (const m of ['select', 'upsert', 'delete', 'eq', 'order', 'range', 'limit', 'maybeSingle']) q[m] = () => q
      q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: erroEstruturado }).then(res)
      return q
    }
  } as unknown as SupabaseClient
  const a = new SupabaseAdapter(cliente)
  const operações: [string, () => Promise<unknown>][] = [
    ['getFrentes', () => a.getFrentes()],
    ['getFrente', () => a.getFrente('x')],
    ['salvarFrente', () => a.salvarFrente(frente)],
    ['removerFrente', () => a.removerFrente('x')],
    ['getRegistros', () => a.getRegistros('x')],
    ['getTodosRegistros', () => a.getTodosRegistros()],
    ['getRegistrosRecentes', () => a.getRegistrosRecentes(3)],
    ['salvarRegistro', () => a.salvarRegistro(registro)],
    ['removerRegistro', () => a.removerRegistro('x')],
    ['getEventosEstruturais', () => a.getEventosEstruturais('x')],
    ['getTodosEventosEstruturais', () => a.getTodosEventosEstruturais()],
    ['salvarEventoEstrutural', () => a.salvarEventoEstrutural(evento)],
    ['removerEventoEstrutural', () => a.removerEventoEstrutural('x')]
  ]
  for (const [nome, fn] of operações) {
    let erro: unknown
    try {
      await fn()
    } catch (e) {
      erro = e
    }
    const ep = erro as ErroPulse
    check(
      erro instanceof Error && ep.código === '42501' && ep.detalhes === 'detalhe x' && ep.dica === 'dica y' && ep.operação !== '',
      `${nome}: lança Error com código/detalhes/dica e operação ("${ep?.operação}")`
    )
    check(!mensagemParaUsuário(erro, nome, true).includes('[object Object]'), `${nome}: mensagem legível`)
  }
}

console.log(`\n${falhas === 0 ? '✅ Contrato do adapter Supabase coerente com o schema documentado' : `❌ ${falhas} teste(s) falharam`}`)
