import type { Frente, Registro } from './types'

// ============================================================
// STORAGE ADAPTER
// Nenhuma outra parte do código deve chamar localStorage
// diretamente. Tudo passa por essa interface — trocar para um
// backend real no futuro é escrever uma nova classe, não
// reescrever a lógica de negócio.
// ============================================================

export interface StorageAdapter {
  getFrentes(): Frente[]
  getFrente(id: string): Frente | undefined
  salvarFrente(f: Frente): void
  removerFrente(id: string): void

  getRegistros(frenteId: string): Registro[]
  salvarRegistro(r: Registro): void
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

  getFrentes(): Frente[] {
    return this.lerFrentes()
  }

  getFrente(id: string): Frente | undefined {
    return this.lerFrentes().find((f) => f.id === id)
  }

  salvarFrente(f: Frente): void {
    const frentes = this.lerFrentes()
    const idx = frentes.findIndex((x) => x.id === f.id)
    if (idx >= 0) frentes[idx] = f
    else frentes.push(f)
    this.escreverFrentes(frentes)
  }

  removerFrente(id: string): void {
    this.escreverFrentes(this.lerFrentes().filter((f) => f.id !== id))
  }

  getRegistros(frenteId: string): Registro[] {
    return this.lerRegistros()
      .filter((r) => r.frenteId === frenteId)
      .sort((a, b) => b.data - a.data)
  }

  salvarRegistro(r: Registro): void {
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

  getFrentes(): Frente[] {
    return [...this.frentes.values()]
  }

  getFrente(id: string): Frente | undefined {
    return this.frentes.get(id)
  }

  salvarFrente(f: Frente): void {
    this.frentes.set(f.id, f)
  }

  removerFrente(id: string): void {
    this.frentes.delete(id)
  }

  getRegistros(frenteId: string): Registro[] {
    return this.registros
      .filter((r) => r.frenteId === frenteId)
      .sort((a, b) => b.data - a.data)
  }

  salvarRegistro(r: Registro): void {
    this.registros.push(r)
  }
}
