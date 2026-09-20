import type { Frente, Registro } from './types'

// ============================================================
// STORAGE ADAPTER
// Nenhuma outra parte do código deve chamar localStorage
// diretamente. Tudo passa por essa interface — trocar para um
// backend real no futuro é escrever uma nova classe, não
// reescrever a lógica de negócio.
// ============================================================

export interface StorageAdapter {
  getFrentes(): Promise<Frente[]>
  getFrente(id: string): Promise<Frente | undefined>
  salvarFrente(f: Frente): Promise<void>
  removerFrente(id: string): Promise<void>

  getRegistros(frenteId: string): Promise<Registro[]>
  salvarRegistro(r: Registro): Promise<void>
}

const CHAVE_FRENTES = 'controle-pessoal:frentes'
const CHAVE_REGISTROS = 'controle-pessoal:registros'

export class LocalStorageAdapter implements StorageAdapter {
  private lerFrentes(): Frente[] {
    const raw = localStorage.getItem(CHAVE_FRENTES)
    return raw ? (JSON.parse(raw) as Frente[]) : []
  }

  private escreverFrentes(frentes: Frente[]): void {
    localStorage.setItem(CHAVE_FRENTES, JSON.stringify(frentes))
  }

  private lerRegistros(): Registro[] {
    const raw = localStorage.getItem(CHAVE_REGISTROS)
    return raw ? (JSON.parse(raw) as Registro[]) : []
  }

  private escreverRegistros(registros: Registro[]): void {
    localStorage.setItem(CHAVE_REGISTROS, JSON.stringify(registros))
  }

  async getFrentes(): Promise<Frente[]> {
    return this.lerFrentes()
  }

  async getFrente(id: string): Promise<Frente | undefined> {
    return this.lerFrentes().find((f) => f.id === id)
  }

  async salvarFrente(f: Frente): Promise<void> {
    const frentes = this.lerFrentes()
    const idx = frentes.findIndex((x) => x.id === f.id)
    if (idx >= 0) frentes[idx] = f
    else frentes.push(f)
    this.escreverFrentes(frentes)
  }

  async removerFrente(id: string): Promise<void> {
    this.escreverFrentes(this.lerFrentes().filter((f) => f.id !== id))
  }

  async getRegistros(frenteId: string): Promise<Registro[]> {
    return this.lerRegistros()
      .filter((r) => r.frenteId === frenteId)
      .sort((a, b) => b.data - a.data)
  }

  async salvarRegistro(r: Registro): Promise<void> {
    const registros = this.lerRegistros()
    registros.push(r)
    this.escreverRegistros(registros)
  }
}

/**
 * Implementação em memória — útil para testes (Node não tem
 * localStorage) e, no futuro, como base pra um MemoryAdapter
 * de desenvolvimento sem persistência.
 */
export class MemoryAdapter implements StorageAdapter {
  private frentes = new Map<string, Frente>()
  private registros: Registro[] = []

  async getFrentes(): Promise<Frente[]> {
    return [...this.frentes.values()]
  }

  async getFrente(id: string): Promise<Frente | undefined> {
    return this.frentes.get(id)
  }

  async salvarFrente(f: Frente): Promise<void> {
    this.frentes.set(f.id, f)
  }

  async removerFrente(id: string): Promise<void> {
    this.frentes.delete(id)
  }

  async getRegistros(frenteId: string): Promise<Registro[]> {
    return this.registros
      .filter((r) => r.frenteId === frenteId)
      .sort((a, b) => b.data - a.data)
  }

  async salvarRegistro(r: Registro): Promise<void> {
    this.registros.push(r)
  }
}
