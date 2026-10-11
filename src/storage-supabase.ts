import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Frente, Registro, EventoEstrutural } from './types'
import type { StorageAdapter } from './storage'

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
// antigas (estado, opt_out_negligencia) continuam existindo no
// banco até a migration 002, mas este adapter não as lê nem
// escreve mais — elas ficam congeladas com o último valor migrado.
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

export class SupabaseAdapter implements StorageAdapter {
  constructor(private client: SupabaseClient) {}

  async getFrentes(): Promise<Frente[]> {
    const { data, error } = await this.client.from('frentes').select('*')
    if (error) throw error
    return (data as FrenteRow[]).map(rowParaFrente)
  }

  async getFrente(id: string): Promise<Frente | undefined> {
    const { data, error } = await this.client.from('frentes').select('*').eq('id', id).maybeSingle()
    if (error) throw error
    return data ? rowParaFrente(data as FrenteRow) : undefined
  }

  async salvarFrente(f: Frente): Promise<void> {
    const { error } = await this.client.from('frentes').upsert(frenteParaRow(f))
    if (error) throw error
  }

  async removerFrente(id: string): Promise<void> {
    const { error } = await this.client.from('frentes').delete().eq('id', id)
    if (error) throw error
  }

  async getRegistros(frenteId: string): Promise<Registro[]> {
    const { data, error } = await this.client
      .from('registros')
      .select('*')
      .eq('frente_id', frenteId)
      .order('data', { ascending: false })
    if (error) throw error
    return (data as RegistroRow[]).map(rowParaRegistro)
  }

  async getRegistrosRecentes(limite: number): Promise<Registro[]> {
    const { data, error } = await this.client
      .from('registros')
      .select('*')
      .order('data', { ascending: false })
      .limit(limite)
    if (error) throw error
    return (data as RegistroRow[]).map(rowParaRegistro)
  }

  async salvarRegistro(r: Registro): Promise<void> {
    const { error } = await this.client.from('registros').upsert(registroParaRow(r))
    if (error) throw error
  }

  async removerRegistro(id: string): Promise<void> {
    const { error } = await this.client.from('registros').delete().eq('id', id)
    if (error) throw error
  }

  async getEventosEstruturais(frenteId: string): Promise<EventoEstrutural[]> {
    const { data, error } = await this.client
      .from('eventos_estruturais')
      .select('*')
      .eq('frente_id', frenteId)
      .order('criado_em', { ascending: false })
    if (error) throw error
    return (data as EventoEstruturalRow[]).map(rowParaEvento)
  }

  async salvarEventoEstrutural(e: EventoEstrutural): Promise<void> {
    const { error } = await this.client.from('eventos_estruturais').upsert(eventoParaRow(e))
    if (error) throw error
  }

  async removerEventoEstrutural(id: string): Promise<void> {
    const { error } = await this.client.from('eventos_estruturais').delete().eq('id', id)
    if (error) throw error
  }
}

export function criarClienteSupabase(url: string, anonKey: string): SupabaseClient {
  return createClient(url, anonKey)
}
