import type { Frente, Registro, EventoEstrutural } from './types'
import {
  aplicarSalvarFrente,
  aplicarSalvarRegistro,
  aplicarRemoverRegistro,
  aplicarRemoverFrenteEmCascata,
  type Dados
} from './storage-atomico'

// ============================================================
// STORAGE ADAPTER
// Nenhuma outra parte do código deve chamar localStorage
// diretamente. Tudo passa por essa interface — trocar para um
// backend real no futuro é escrever uma nova classe, não
// reescrever a lógica de negócio.
// ============================================================

export interface ResultadoFrente {
  /** criada | ja_existia (criação repetida, nada sobrescrito) | aplicada | ja_aplicada (retry de resposta perdida) */
  status: 'criada' | 'ja_existia' | 'aplicada' | 'ja_aplicada'
  /** estado final persistido (últimoMovimento já derivado dos registros) */
  frente: Frente
}
export interface ResultadoRegistro {
  status: 'criado' | 'ja_existia' | 'aplicado' | 'ja_aplicado'
  registro: Registro
}
export interface ResultadoRemoçãoRegistro {
  status: 'removido' | 'ja_removido'
}
export interface ResultadoExclusãoFrente {
  status: 'removida' | 'ja_removida'
  frentes: number
  registros: number
  eventos: number
}

export interface StorageAdapter {
  getFrentes(): Promise<Frente[]>
  getFrente(id: string): Promise<Frente | undefined>
  salvarFrente(f: Frente): Promise<void>
  removerFrente(id: string): Promise<void>

  getRegistros(frenteId: string): Promise<Registro[]>
  /** Todos os registros de uma vez (leitura em lote — evita N consultas). */
  getTodosRegistros(): Promise<Registro[]>
  getRegistrosRecentes(limite: number): Promise<Registro[]>
  salvarRegistro(r: Registro): Promise<void>
  removerRegistro(id: string): Promise<void>

  getEventosEstruturais(frenteId: string): Promise<EventoEstrutural[]>
  /** Todos os eventos estruturais de uma vez (leitura em lote). */
  getTodosEventosEstruturais(): Promise<EventoEstrutural[]>
  salvarEventoEstrutural(e: EventoEstrutural): Promise<void>
  removerEventoEstrutural(id: string): Promise<void>

  // ----------------------------------------------------------
  // OPERAÇÕES ATÔMICAS — cada uma é TUDO-OU-NADA.
  // No Supabase são funções RPC (uma transação do Postgres, migration
  // 005); nos adapters local/memória, o resultado é calculado por
  // inteiro antes de gravar e a gravação é revertida se falhar.
  // As escritas simples acima (salvarFrente etc.) continuam existindo
  // para importação e testes, mas NÃO são o caminho das operações do
  // app: frente-ops.ts sempre passa por estas.
  // ----------------------------------------------------------

  /**
   * Cria (esperado = null) ou altera uma frente e grava, juntos, os
   * eventos estruturais da mudança. `esperado` é o estado que o chamador
   * leu antes de alterar: se outra pessoa/aba mudou a frente nesse meio
   * tempo, lança erro PU409 em vez de sobrescrever. Repetir a mesma
   * chamada (resposta perdida) é seguro: não regrava nem duplica eventos.
   * `frente.últimoMovimento` é ignorado — é sempre derivado dos registros.
   */
  salvarFrenteComEventos(frente: Frente, eventos: EventoEstrutural[], esperado: Frente | null): Promise<ResultadoFrente>
  /** Cria (esperado = null) ou edita um registro e recalcula o últimoMovimento da frente, juntos. */
  salvarRegistroComCache(registro: Registro, esperado: Registro | null): Promise<ResultadoRegistro>
  /** Exclui um registro e recalcula o últimoMovimento da frente, juntos. Idempotente. */
  removerRegistroComCache(id: string): Promise<ResultadoRemoçãoRegistro>
  /** Exclusão permanente: frente + descendentes + seus registros e eventos, juntos. Idempotente. */
  removerFrenteEmCascata(id: string): Promise<ResultadoExclusãoFrente>
}

const CHAVE_FRENTES = 'controle-pessoal:frentes'
const CHAVE_REGISTROS = 'controle-pessoal:registros'
const CHAVE_EVENTOS = 'controle-pessoal:eventos-estruturais'

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

  private lerEventos(): EventoEstrutural[] {
    const raw = localStorage.getItem(CHAVE_EVENTOS)
    return raw ? (JSON.parse(raw) as EventoEstrutural[]) : []
  }

  private escreverEventos(eventos: EventoEstrutural[]): void {
    localStorage.setItem(CHAVE_EVENTOS, JSON.stringify(eventos))
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

  async getTodosRegistros(): Promise<Registro[]> {
    return [...this.lerRegistros()].sort((a, b) => b.data - a.data || a.id.localeCompare(b.id))
  }

  async getRegistrosRecentes(limite: number): Promise<Registro[]> {
    return this.lerRegistros()
      .sort((a, b) => b.data - a.data)
      .slice(0, limite)
  }

  async salvarRegistro(r: Registro): Promise<void> {
    const registros = this.lerRegistros()
    const idx = registros.findIndex((x) => x.id === r.id)
    if (idx >= 0) registros[idx] = r
    else registros.push(r)
    this.escreverRegistros(registros)
  }

  async removerRegistro(id: string): Promise<void> {
    this.escreverRegistros(this.lerRegistros().filter((r) => r.id !== id))
  }

  async getEventosEstruturais(frenteId: string): Promise<EventoEstrutural[]> {
    return this.lerEventos()
      .filter((e) => e.frenteId === frenteId)
      .sort((a, b) => b.criadoEm - a.criadoEm)
  }

  async getTodosEventosEstruturais(): Promise<EventoEstrutural[]> {
    return [...this.lerEventos()].sort((a, b) => b.criadoEm - a.criadoEm || a.id.localeCompare(b.id))
  }

  async salvarEventoEstrutural(e: EventoEstrutural): Promise<void> {
    const eventos = this.lerEventos()
    const idx = eventos.findIndex((x) => x.id === e.id)
    if (idx >= 0) eventos[idx] = e
    else eventos.push(e)
    this.escreverEventos(eventos)
  }

  async removerEventoEstrutural(id: string): Promise<void> {
    this.escreverEventos(this.lerEventos().filter((e) => e.id !== id))
  }

  /**
   * Lê as três coleções, calcula o resultado inteiro em memória (função
   * pura) e só então grava. Se alguma gravação falhar (cota cheia, por
   * exemplo), restaura os textos anteriores das chaves já gravadas: o
   * armazenamento nunca fica com a frente nova e o evento antigo.
   */
  private transacao<R>(operar: (d: Dados) => { dados: Dados; resultado: R }): R {
    const antes = {
      frentes: localStorage.getItem(CHAVE_FRENTES),
      registros: localStorage.getItem(CHAVE_REGISTROS),
      eventos: localStorage.getItem(CHAVE_EVENTOS)
    }
    const d: Dados = { frentes: this.lerFrentes(), registros: this.lerRegistros(), eventos: this.lerEventos() }
    const { dados, resultado } = operar(d)

    const gravações: [string, string | null, unknown][] = [
      [CHAVE_FRENTES, antes.frentes, dados.frentes !== d.frentes ? dados.frentes : undefined],
      [CHAVE_REGISTROS, antes.registros, dados.registros !== d.registros ? dados.registros : undefined],
      [CHAVE_EVENTOS, antes.eventos, dados.eventos !== d.eventos ? dados.eventos : undefined]
    ]
    const feitas: [string, string | null][] = []
    try {
      for (const [chave, anterior, novo] of gravações) {
        if (novo === undefined) continue
        localStorage.setItem(chave, JSON.stringify(novo))
        feitas.push([chave, anterior])
      }
    } catch (err) {
      for (const [chave, anterior] of feitas.reverse()) {
        try {
          if (anterior === null) localStorage.removeItem(chave)
          else localStorage.setItem(chave, anterior)
        } catch {
          /* restaurar um valor menor que o atual não deve falhar; se falhar, nada mais a fazer */
        }
      }
      throw err
    }
    return resultado
  }

  async salvarFrenteComEventos(frente: Frente, eventos: EventoEstrutural[], esperado: Frente | null): Promise<ResultadoFrente> {
    return this.transacao((d) => aplicarSalvarFrente(d, frente, eventos, esperado))
  }
  async salvarRegistroComCache(registro: Registro, esperado: Registro | null): Promise<ResultadoRegistro> {
    return this.transacao((d) => aplicarSalvarRegistro(d, registro, esperado))
  }
  async removerRegistroComCache(id: string): Promise<ResultadoRemoçãoRegistro> {
    return this.transacao((d) => aplicarRemoverRegistro(d, id))
  }
  async removerFrenteEmCascata(id: string): Promise<ResultadoExclusãoFrente> {
    return this.transacao((d) => aplicarRemoverFrenteEmCascata(d, id))
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
  private eventos: EventoEstrutural[] = []

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

  async getTodosRegistros(): Promise<Registro[]> {
    return [...this.registros].sort((a, b) => b.data - a.data || a.id.localeCompare(b.id))
  }

  async getRegistrosRecentes(limite: number): Promise<Registro[]> {
    return [...this.registros].sort((a, b) => b.data - a.data).slice(0, limite)
  }

  async salvarRegistro(r: Registro): Promise<void> {
    const idx = this.registros.findIndex((x) => x.id === r.id)
    if (idx >= 0) this.registros[idx] = r
    else this.registros.push(r)
  }

  async removerRegistro(id: string): Promise<void> {
    this.registros = this.registros.filter((r) => r.id !== id)
  }

  async getEventosEstruturais(frenteId: string): Promise<EventoEstrutural[]> {
    return this.eventos
      .filter((e) => e.frenteId === frenteId)
      .sort((a, b) => b.criadoEm - a.criadoEm)
  }

  async getTodosEventosEstruturais(): Promise<EventoEstrutural[]> {
    return [...this.eventos].sort((a, b) => b.criadoEm - a.criadoEm || a.id.localeCompare(b.id))
  }

  async salvarEventoEstrutural(e: EventoEstrutural): Promise<void> {
    const idx = this.eventos.findIndex((x) => x.id === e.id)
    if (idx >= 0) this.eventos[idx] = e
    else this.eventos.push(e)
  }

  async removerEventoEstrutural(id: string): Promise<void> {
    this.eventos = this.eventos.filter((e) => e.id !== id)
  }

  /** Calcula tudo antes; só substitui o estado se a função pura não lançou. */
  private transacao<R>(operar: (d: Dados) => { dados: Dados; resultado: R }): R {
    const { dados, resultado } = operar({
      frentes: [...this.frentes.values()],
      registros: this.registros,
      eventos: this.eventos
    })
    this.frentes = new Map(dados.frentes.map((f) => [f.id, f]))
    this.registros = dados.registros
    this.eventos = dados.eventos
    return resultado
  }

  async salvarFrenteComEventos(frente: Frente, eventos: EventoEstrutural[], esperado: Frente | null): Promise<ResultadoFrente> {
    return this.transacao((d) => aplicarSalvarFrente(d, frente, eventos, esperado))
  }
  async salvarRegistroComCache(registro: Registro, esperado: Registro | null): Promise<ResultadoRegistro> {
    return this.transacao((d) => aplicarSalvarRegistro(d, registro, esperado))
  }
  async removerRegistroComCache(id: string): Promise<ResultadoRemoçãoRegistro> {
    return this.transacao((d) => aplicarRemoverRegistro(d, id))
  }
  async removerFrenteEmCascata(id: string): Promise<ResultadoExclusãoFrente> {
    return this.transacao((d) => aplicarRemoverFrenteEmCascata(d, id))
  }
}
