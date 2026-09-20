import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Frente, Registro } from './types'
import type { StorageAdapter } from './storage'

// ============================================================
// SUPABASE ADAPTER
// Mesma interface que LocalStorageAdapter — a UI e o motor de
// sinal não sabem (nem precisam saber) que os dados agora viajam
// pela rede. RLS no banco garante que cada usuário só vê as
// próprias linhas; user_id nunca aparece nos tipos da aplicação,
// só nesta camada de tradução.
// ============================================================

interface FrenteRow {
  id: string
  nome: string
  area: string
  tipo: string
  parent_id: string | null
  estado: string
  cadencia_esperada: number
  ultimo_toque: number
  ultimo_movimento: number | null
  opt_out_negligencia: boolean
  criada_em: number
}

interface RegistroRow {
  id: string
  frente_id: string
  data: number
  texto: string
  conta_como_movimento: boolean
  duracao_min: number | null
}

function rowParaFrente(r: FrenteRow): Frente {
  return {
    id: r.id,
    nome: r.nome,
    área: r.area as Frente['área'],
    tipo: r.tipo as Frente['tipo'],
    parentId: r.parent_id,
    estado: r.estado as Frente['estado'],
    cadênciaEsperada: r.cadencia_esperada,
    últimoToque: r.ultimo_toque,
    últimoMovimento: r.ultimo_movimento,
    optOutNegligência: r.opt_out_negligencia,
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
    estado: f.estado,
    cadencia_esperada: f.cadênciaEsperada,
    ultimo_toque: f.últimoToque,
    ultimo_movimento: f.últimoMovimento,
    opt_out_negligencia: f.optOutNegligência,
    criada_em: f.criadaEm
  }
}

function rowParaRegistro(r: RegistroRow): Registro {
  return {
    id: r.id,
    frenteId: r.frente_id,
    data: r.data,
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
    texto: r.texto,
    conta_como_movimento: r.contaComoMovimento,
    duracao_min: r.dadosExtra?.duraçãoMin ?? null
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

  async salvarRegistro(r: Registro): Promise<void> {
    const { error } = await this.client.from('registros').upsert(registroParaRow(r))
    if (error) throw error
  }
}

export function criarClienteSupabase(url: string, anonKey: string): SupabaseClient {
  return createClient(url, anonKey)
}
