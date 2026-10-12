import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Frente, Registro, EventoEstrutural } from './types'
import type { StorageAdapter } from './storage'
import { normalizarErro } from './erros'

// ============================================================
// SUPABASE ADAPTER
// Mesma interface que LocalStorageAdapter — a UI e o motor de
// sinal não sabem (nem precisam saber) que os dados agora viajam
// pela rede. RLS no banco garante que cada usuário só vê as
// próprias linhas; user_id nunca aparece nos tipos da aplicação,
// só nesta camada de tradução.
//
// Pulse 2.0: lê/escreve as colunas novas (ciclo_vida, condicao,
// contexto_*, pausa_*) introduzidas pela migration 001. As colunas
// legadas (estado, opt_out_negligencia, ultimo_toque) NÃO são lidas
// nem escritas por este adapter; em bancos que as têm, elas precisam
// aceitar NULL (migration 004) — senão todo upsert falha com 23502.
// Contrato com o schema verificado em test-storage-supabase.ts.
//
// Erros: todo erro do Supabase (PostgrestError é um objeto simples,
// não um Error) é convertido em ErroPulse com a operação que falhou.
// ============================================================

interface FrenteRow {
  id: string
  nome: string
  area: string
  tipo: string
  parent_id: string | null
  ciclo_vida: string
  condicao: string
  cadencia_esperada: number | null
  ultimo_movimento: number | null
  contexto_foco: string | null
  contexto_bloqueio: string | null
  pausa_motivo: string | null
  pausa_retomada_em: number | null
  criada_em: number
}

interface RegistroRow {
  id: string
  frente_id: string
  data: number
  criado_em: number
  texto: string
  conta_como_movimento: boolean
  duracao_min: number | null
}

interface EventoEstruturalRow {
  id: string
  frente_id: string
  tipo: string
  valor_anterior: string | null
  valor_novo: string | null
  criado_em: number
}

function rowParaFrente(r: FrenteRow): Frente {
  return {
    id: r.id,
    nome: r.nome,
    área: r.area as Frente['área'],
    tipo: r.tipo as Frente['tipo'],
    parentId: r.parent_id,
    cicloVida: r.ciclo_vida as Frente['cicloVida'],
    condição: r.condicao as Frente['condição'],
    cadênciaEsperada: r.cadencia_esperada,
    últimoMovimento: r.ultimo_movimento,
    contextoFoco: r.contexto_foco,
    contextoBloqueio: r.contexto_bloqueio,
    pausaMotivo: r.pausa_motivo,
    pausaRetomadaEm: r.pausa_retomada_em,
    criadaEm: r.criada_em
  }
}

function frenteParaRow(f: Frente): Omit<FrenteRow, 'id'> & { id: string } {
  return {
    id: f.id,
    nome: f.nome,
    area: f.área,
    tipo: f.tipo,
    parent_id: f.parentId,
    ciclo_vida: f.cicloVida,
    condicao: f.condição,
    cadencia_esperada: f.cadênciaEsperada,
    ultimo_movimento: f.últimoMovimento,
    contexto_foco: f.contextoFoco,
    contexto_bloqueio: f.contextoBloqueio,
    pausa_motivo: f.pausaMotivo,
    pausa_retomada_em: f.pausaRetomadaEm,
    criada_em: f.criadaEm
  }
}

function rowParaRegistro(r: RegistroRow): Registro {
  return {
    id: r.id,
    frenteId: r.frente_id,
    data: r.data,
    criadoEm: r.criado_em,
    texto: r.texto,
    contaComoMovimento: r.conta_como_movimento,
    dadosExtra: r.duracao_min !== null ? { duraçãoMin: r.duracao_min } : undefined
  }
}

function registroParaRow(r: Registro): Omit<RegistroRow, 'id'> & { id: string } {
  return {
    id: r.id,
    frente_id: r.frenteId,
    data: r.data,
    criado_em: r.criadoEm,
    texto: r.texto,
    conta_como_movimento: r.contaComoMovimento,
    duracao_min: r.dadosExtra?.duraçãoMin ?? null
  }
}

function rowParaEvento(r: EventoEstruturalRow): EventoEstrutural {
  return {
    id: r.id,
    frenteId: r.frente_id,
    tipo: r.tipo as EventoEstrutural['tipo'],
    valorAnterior: r.valor_anterior,
    valorNovo: r.valor_novo,
    criadoEm: r.criado_em
  }
}

function eventoParaRow(e: EventoEstrutural): Omit<EventoEstruturalRow, 'id'> & { id: string } {
  return {
    id: e.id,
    frente_id: e.frenteId,
    tipo: e.tipo,
    valor_anterior: e.valorAnterior,
    valor_novo: e.valorNovo,
    criado_em: e.criadoEm
  }
}

/** Tamanho de página: o PostgREST do Supabase limita respostas a 1000
 * linhas por padrão e trunca SILENCIOSAMENTE — toda leitura de lista
 * pagina com range() até esgotar, para nunca devolver dados cortados. */
const PÁGINA = 1000

type RespostaLista = { data: unknown[] | null; error: unknown }
type RespostaItem = { data: unknown; error: unknown }
type RespostaEscrita = { error: unknown }

export class SupabaseAdapter implements StorageAdapter {
  constructor(private client: SupabaseClient) {}

  private async listar<T>(
    operação: string,
    pagina: (de: number, até: number) => PromiseLike<RespostaLista>
  ): Promise<T[]> {
    const tudo: T[] = []
    for (let de = 0; ; de += PÁGINA) {
      const { data, error } = await pagina(de, de + PÁGINA - 1)
      if (error) throw normalizarErro(error, operação)
      const lote = (data ?? []) as T[]
      tudo.push(...lote)
      if (lote.length < PÁGINA) return tudo
    }
  }

  private falhaDeEscrita(operação: string, r: RespostaEscrita): void {
    if (r.error) throw normalizarErro(r.error, operação)
  }

  async getFrentes(): Promise<Frente[]> {
    const rows = await this.listar<FrenteRow>('carregar as frentes', (a, b) =>
      this.client.from('frentes').select('*').order('id').range(a, b)
    )
    return rows.map(rowParaFrente)
  }

  async getFrente(id: string): Promise<Frente | undefined> {
    const { data, error } = (await this.client.from('frentes').select('*').eq('id', id).maybeSingle()) as RespostaItem
    if (error) throw normalizarErro(error, 'carregar a frente')
    return data ? rowParaFrente(data as FrenteRow) : undefined
  }

  async salvarFrente(f: Frente): Promise<void> {
    this.falhaDeEscrita('salvar a frente', await this.client.from('frentes').upsert(frenteParaRow(f)))
  }

  async removerFrente(id: string): Promise<void> {
    this.falhaDeEscrita('excluir a frente', await this.client.from('frentes').delete().eq('id', id))
  }

  async getRegistros(frenteId: string): Promise<Registro[]> {
    const rows = await this.listar<RegistroRow>('carregar os registros', (a, b) =>
      this.client
        .from('registros')
        .select('*')
        .eq('frente_id', frenteId)
        .order('data', { ascending: false })
        .order('id')
        .range(a, b)
    )
    return rows.map(rowParaRegistro)
  }

  async getTodosRegistros(): Promise<Registro[]> {
    const rows = await this.listar<RegistroRow>('carregar os registros', (a, b) =>
      this.client.from('registros').select('*').order('data', { ascending: false }).order('id').range(a, b)
    )
    return rows.map(rowParaRegistro)
  }

  async getRegistrosRecentes(limite: number): Promise<Registro[]> {
    const { data, error } = (await this.client
      .from('registros')
      .select('*')
      .order('data', { ascending: false })
      .order('id')
      .limit(limite)) as RespostaLista
    if (error) throw normalizarErro(error, 'carregar os registros recentes')
    return ((data ?? []) as RegistroRow[]).map(rowParaRegistro)
  }

  async salvarRegistro(r: Registro): Promise<void> {
    this.falhaDeEscrita('salvar o registro', await this.client.from('registros').upsert(registroParaRow(r)))
  }

  async removerRegistro(id: string): Promise<void> {
    this.falhaDeEscrita('excluir o registro', await this.client.from('registros').delete().eq('id', id))
  }

  async getEventosEstruturais(frenteId: string): Promise<EventoEstrutural[]> {
    const rows = await this.listar<EventoEstruturalRow>('carregar o histórico estrutural', (a, b) =>
      this.client
        .from('eventos_estruturais')
        .select('*')
        .eq('frente_id', frenteId)
        .order('criado_em', { ascending: false })
        .order('id')
        .range(a, b)
    )
    return rows.map(rowParaEvento)
  }

  async getTodosEventosEstruturais(): Promise<EventoEstrutural[]> {
    const rows = await this.listar<EventoEstruturalRow>('carregar o histórico estrutural', (a, b) =>
      this.client.from('eventos_estruturais').select('*').order('criado_em', { ascending: false }).order('id').range(a, b)
    )
    return rows.map(rowParaEvento)
  }

  async salvarEventoEstrutural(e: EventoEstrutural): Promise<void> {
    this.falhaDeEscrita(
      'salvar o evento estrutural',
      await this.client.from('eventos_estruturais').upsert(eventoParaRow(e))
    )
  }

  async removerEventoEstrutural(id: string): Promise<void> {
    this.falhaDeEscrita(
      'excluir o evento estrutural',
      await this.client.from('eventos_estruturais').delete().eq('id', id)
    )
  }
}

export function criarClienteSupabase(url: string, anonKey: string): SupabaseClient {
  return createClient(url, anonKey)
}
