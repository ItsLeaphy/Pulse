import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// AUXILIARES DOS TESTES COM POSTGRESQL REAL
//
// O que isto É: um PostgreSQL de verdade (transações, RLS, triggers,
// plpgsql, privilégios) com os arquivos .sql do repositório aplicados.
// O que isto NÃO é: o Supabase. Não há PostgREST nem GoTrue: o
// `ClientePg` abaixo imita só o que o SupabaseAdapter usa do
// supabase-js (from/select/eq/order/range/limit/maybeSingle/upsert/
// delete/rpc), executando cada requisição como o PostgREST faz — em UMA
// transação, com `set local role` e o claim `sub` do usuário. Por isso
// o que ele prova é o comportamento do Postgres + das funções SQL + do
// contrato do adapter; não prova a camada HTTP do Supabase.
// ============================================================

// bigint (int8) vem como string no driver; o PostgREST devolve número em JSON
pg.types.setTypeParser(20, (v) => Number(v))

export const URL_ADMIN_PADRÃO = 'postgres://pulse_test:pulse_test@127.0.0.1:5432/postgres'

export function urlAdmin(): string {
  return process.env.PULSE_TEST_PG_URL ?? URL_ADMIN_PADRÃO
}

/** Tenta conectar; devolve null (com o motivo) se não houver PostgreSQL. */
export async function conectarAdmin(): Promise<{ pool: pg.Pool } | { erro: string }> {
  const pool = new pg.Pool({ connectionString: urlAdmin(), max: 4, connectionTimeoutMillis: 3000 })
  try {
    await pool.query('select 1')
    return { pool }
  } catch (e) {
    await pool.end().catch(() => undefined)
    return { erro: e instanceof Error ? e.message || e.name : String(e) }
  }
}

function lerArquivo(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
}

export interface BancoDeTeste {
  nome: string
  pool: pg.Pool
  aplicar(arquivo: string): Promise<void>
  /** SQL arbitrário como superusuário (preparação/inspeção) */
  admin<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]>
  /** cria um usuário em auth.users e devolve o id */
  novoUsuário(): Promise<string>
  cliente(userId: string | null): ClientePg
  derrubar(): Promise<void>
}

/** Cria um banco novo (shim do Supabase + os arquivos .sql na ordem dada). */
export async function criarBanco(adminPool: pg.Pool, rótulo: string, arquivos: string[]): Promise<BancoDeTeste> {
  const nome = `pulse_t_${rótulo}_${process.pid}_${Date.now() % 100000}`
  await adminPool.query(`create database ${nome}`)
  const u = new URL(urlAdmin())
  u.pathname = `/${nome}`
  const pool = new pg.Pool({ connectionString: u.toString(), max: 8 })
  pool.on('error', () => undefined) // conexões ociosas encerradas ao derrubar o banco não são falha

  const banco: BancoDeTeste = {
    nome,
    pool,
    async aplicar(arquivo) {
      await pool.query(lerArquivo(arquivo))
    },
    async admin(sql, params) {
      return (await pool.query(sql, params as unknown[] | undefined)).rows
    },
    async novoUsuário() {
      const id = randomUUID()
      await pool.query('insert into auth.users (id) values ($1)', [id])
      return id
    },
    cliente(userId) {
      return new ClientePg(pool, userId)
    },
    async derrubar() {
      await pool.end().catch(() => undefined)
      await adminPool.query(`drop database if exists ${nome} with (force)`)
    }
  }
  try {
    await banco.aplicar('db-teste/shim-supabase.sql')
    for (const a of arquivos) await banco.aplicar(a)
  } catch (e) {
    await banco.derrubar()
    throw e
  }
  return banco
}

// ---------- cliente que imita o supabase-js sobre o pg ----------

export interface ErroPostgrest {
  code: string
  message: string
  details: string | null
  hint: string | null
}

type Resposta = { data: unknown; error: ErroPostgrest | null }

function comoPostgrest(e: unknown): ErroPostgrest {
  const x = e as { code?: string; message?: string; detail?: string; hint?: string }
  return { code: x.code ?? 'XX000', message: x.message ?? String(e), details: x.detail ?? null, hint: x.hint ?? null }
}

const TABELAS = new Set(['frentes', 'registros', 'eventos_estruturais'])
const IDENT = /^[a-z_][a-z_0-9]*$/

export class ClientePg {
  /** requisições por rótulo ("rpc:pulse_salvar_frente", "from:frentes") */
  chamadas: Record<string, number> = {}
  constructor(private pool: pg.Pool, public userId: string | null) {}

  /** UMA requisição = UMA transação, no papel e com o claim do usuário (como o PostgREST). */
  async requisição<T>(rótulo: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<{ data: T | null; error: ErroPostgrest | null }> {
    this.chamadas[rótulo] = (this.chamadas[rótulo] ?? 0) + 1
    const c = await this.pool.connect()
    try {
      await c.query('begin')
      await c.query(`set local role ${this.userId ? 'authenticated' : 'anon'}`)
      if (this.userId) {
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: this.userId, role: 'authenticated' })])
      }
      const data = await fn(c)
      await c.query('commit')
      return { data, error: null }
    } catch (e) {
      await c.query('rollback').catch(() => undefined)
      return { data: null, error: comoPostgrest(e) }
    } finally {
      c.release()
    }
  }

  /** SQL arbitrário como este usuário (para os testes de RLS/privilégios); lança o erro do Postgres. */
  async sql<T extends pg.QueryResultRow = pg.QueryResultRow>(texto: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.requisição('sql', async (c) => (await c.query(texto, params)).rows as T[])
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code })
    return r.data ?? []
  }

  from(tabela: string): ConsultaPg {
    if (!TABELAS.has(tabela)) throw new Error(`tabela fora da lista do teste: ${tabela}`)
    return new ConsultaPg(this, tabela)
  }

  rpc(nome: string, args: Record<string, unknown>): PromiseLike<Resposta> {
    if (!IDENT.test(nome)) throw new Error(`nome de função inválido: ${nome}`)
    const chaves = Object.keys(args)
    const marcas = chaves.map((k, i) => {
      if (!IDENT.test(k)) throw new Error(`parâmetro inválido: ${k}`)
      return `${k} => $${i + 1}::${k === 'p_id' ? 'uuid' : 'jsonb'}`
    })
    const valores = chaves.map((k) => {
      const v = args[k]
      return v === null || v === undefined ? null : k === 'p_id' ? String(v) : JSON.stringify(v)
    })
    const executar = () =>
      this.requisição(`rpc:${nome}`, async (c) => (await c.query(`select public.${nome}(${marcas.join(', ')}) as r`, valores)).rows[0]?.r)
    return { then: (res, rej) => executar().then(res, rej) } as PromiseLike<Resposta>
  }

  /** Para passar ao SupabaseAdapter. */
  comoSupabase(): SupabaseClient {
    return this as unknown as SupabaseClient
  }
}

class ConsultaPg implements PromiseLike<Resposta> {
  private op: 'select' | 'upsert' | 'delete' = 'select'
  private payload: Record<string, unknown> | null = null
  private filtros: [string, unknown][] = []
  private ordens: [string, boolean][] = []
  private faixa: [number, number] | null = null
  private teto: number | null = null
  private único = false

  constructor(private cliente: ClientePg, private tabela: string) {}

  select(_colunas?: string) {
    return this
  }
  upsert(l: Record<string, unknown>) {
    this.op = 'upsert'
    this.payload = JSON.parse(JSON.stringify(l)) as Record<string, unknown>
    return this
  }
  delete() {
    this.op = 'delete'
    return this
  }
  eq(coluna: string, valor: unknown) {
    this.filtros.push([coluna, valor])
    return this
  }
  order(coluna: string, opções: { ascending?: boolean } = {}) {
    this.ordens.push([coluna, opções.ascending !== false])
    return this
  }
  range(de: number, até: number) {
    this.faixa = [de, até]
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

  private ident(n: string): string {
    if (!IDENT.test(n)) throw new Error(`coluna inválida: ${n}`)
    return n
  }

  private async executar(): Promise<Resposta> {
    const t = `public.${this.tabela}`
    const params: unknown[] = []
    const onde = this.filtros.length
      ? ' where ' + this.filtros.map(([c, v]) => (params.push(v), `${this.ident(c)} = $${params.length}`)).join(' and ')
      : ''
    const r = await this.cliente.requisição(`from:${this.tabela}`, async (c) => {
      if (this.op === 'upsert') {
        const cols = Object.keys(this.payload!).map((k) => this.ident(k))
        const vals = cols.map((k) => this.payload![k] ?? null)
        const sets = cols.filter((k) => k !== 'id').map((k) => `${k} = excluded.${k}`)
        await c.query(
          `insert into ${t} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) on conflict (id) do update set ${sets.join(', ')}`,
          vals
        )
        return null
      }
      if (this.op === 'delete') {
        await c.query(`delete from ${t}${onde}`, params)
        return null
      }
      let sql = `select * from ${t}${onde}`
      if (this.ordens.length) sql += ' order by ' + this.ordens.map(([col, asc]) => `${this.ident(col)} ${asc ? 'asc' : 'desc'}`).join(', ')
      if (this.faixa) sql += ` limit ${this.faixa[1] - this.faixa[0] + 1} offset ${this.faixa[0]}`
      else if (this.teto !== null) sql += ` limit ${this.teto}`
      const { rows } = await c.query(sql, params)
      return this.único ? (rows[0] ?? null) : rows
    })
    return { data: r.data, error: r.error }
  }

  then<A = Resposta, B = never>(res?: ((v: Resposta) => A | PromiseLike<A>) | null, rej?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return this.executar().then(res, rej)
  }
}
