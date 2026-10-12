import { MemoryAdapter, type StorageAdapter } from './storage'
import {
  criarFrente,
  criarRegistro,
  editarRegistro,
  excluirRegistro,
  editarFrente,
  mudarCondição,
  excluirFrenteComFilhos
} from './frente-ops'
import { moverFrente } from './hierarquia'
import { exportarPulse, importarPulse } from './portabilidade'
import { ErroParcial, ErroValidação } from './erros'
import type { Registro, EventoEstrutural } from './types'
import type { Frente } from './types'

// ============================================================
// TESTE: consistência de operações compostas sob falha injetada.
// As operações de frente/registro são ATÔMICAS (uma chamada de storage):
// se a chamada falha, NADA muda (operação "não iniciada"); se repetida,
// aplica uma vez. Só a IMPORTAÇÃO continua podendo ficar parcial (com
// `completar`) — está fora do escopo da atomicidade.
// Rode com: npm run test:consistencia
// ============================================================

let falhas = 0
function check(condição: boolean, mensagem: string): void {
  if (condição) console.log(`✅ ${mensagem}`)
  else {
    console.log(`❌ ${mensagem}`)
    falhas++
  }
}

/** Adapter que falha na N-ésima chamada de um método (e só nela). */
class Falhável implements StorageAdapter {
  chamadas: Record<string, number> = {}
  falhar: { método: string; n: number } | null = null
  constructor(public base: MemoryAdapter) {}
  private async passar<T>(método: string, fn: () => Promise<T>): Promise<T> {
    this.chamadas[método] = (this.chamadas[método] ?? 0) + 1
    if (this.falhar && this.falhar.método === método && this.falhar.n === this.chamadas[método]) {
      throw { code: 'PGRST000', message: `falha injetada em ${método}` } // objeto simples, como o PostgrestError
    }
    return fn()
  }
  getFrentes = () => this.passar('getFrentes', () => this.base.getFrentes())
  getFrente = (id: string) => this.passar('getFrente', () => this.base.getFrente(id))
  salvarFrente = (f: Frente) => this.passar('salvarFrente', () => this.base.salvarFrente(f))
  removerFrente = (id: string) => this.passar('removerFrente', () => this.base.removerFrente(id))
  getRegistros = (id: string) => this.passar('getRegistros', () => this.base.getRegistros(id))
  getTodosRegistros = () => this.passar('getTodosRegistros', () => this.base.getTodosRegistros())
  getRegistrosRecentes = (n: number) => this.passar('getRegistrosRecentes', () => this.base.getRegistrosRecentes(n))
  salvarRegistro = (r: Parameters<StorageAdapter['salvarRegistro']>[0]) => this.passar('salvarRegistro', () => this.base.salvarRegistro(r))
  removerRegistro = (id: string) => this.passar('removerRegistro', () => this.base.removerRegistro(id))
  getEventosEstruturais = (id: string) => this.passar('getEventosEstruturais', () => this.base.getEventosEstruturais(id))
  getTodosEventosEstruturais = () => this.passar('getTodosEventosEstruturais', () => this.base.getTodosEventosEstruturais())
  salvarEventoEstrutural = (e: Parameters<StorageAdapter['salvarEventoEstrutural']>[0]) =>
    this.passar('salvarEventoEstrutural', () => this.base.salvarEventoEstrutural(e))
  removerEventoEstrutural = (id: string) => this.passar('removerEventoEstrutural', () => this.base.removerEventoEstrutural(id))
  salvarFrenteComEventos = (f: Frente, e: EventoEstrutural[], esp: Frente | null) =>
    this.passar('salvarFrenteComEventos', () => this.base.salvarFrenteComEventos(f, e, esp))
  salvarRegistroComCache = (r: Registro, esp: Registro | null) =>
    this.passar('salvarRegistroComCache', () => this.base.salvarRegistroComCache(r, esp))
  removerRegistroComCache = (id: string) => this.passar('removerRegistroComCache', () => this.base.removerRegistroComCache(id))
  removerFrenteEmCascata = (id: string) => this.passar('removerFrenteEmCascata', () => this.base.removerFrenteEmCascata(id))
}

function novo(): { s: Falhável; mem: MemoryAdapter } {
  const mem = new MemoryAdapter()
  return { s: new Falhável(mem), mem }
}

const agora = 1_800_000_000_000
const DIA = 86_400_000

const base = (id: string, extra: Partial<Frente> = {}) => ({
  id,
  nome: id,
  área: 'work' as const,
  tipo: 'projeto' as const,
  parentId: null,
  cicloVida: 'ativa' as const,
  condição: 'normal' as const,
  cadênciaEsperada: 7,
  contextoFoco: null,
  contextoBloqueio: null,
  pausaMotivo: null,
  pausaRetomadaEm: null,
  criadaEm: agora - 10 * DIA,
  ...extra
})

async function captura(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
    return null
  } catch (e) {
    return e
  }
}

// ============ criarFrente: atômica ============
console.log('\n— criarFrente')
{
  const { s, mem } = novo()
  s.falhar = { método: 'salvarFrenteComEventos', n: 1 }
  const erro = await captura(() => criarFrente(s, base('f1')))
  check(erro !== null && !(erro instanceof ErroParcial), 'falha na operação atômica → erro TOTAL (não existe mais "parcial")')
  check((await mem.getFrentes()).length === 0 && (await mem.getTodosEventosEstruturais()).length === 0, 'estado: operação NÃO iniciada (nem frente nem evento)')
  await criarFrente(s, base('f1'))
  check((await mem.getFrentes()).length === 1, 'retry cria a frente')
  check((await mem.getEventosEstruturais('f1')).filter((e) => e.tipo === 'criação').length === 1, 'retry: exatamente 1 evento de criação')
  await criarFrente(s, base('f1'))
  check((await mem.getFrentes()).length === 1 && (await mem.getEventosEstruturais('f1')).length === 1, 'repetir de novo é idempotente (1 frente, 1 evento)')
}
{
  const { s } = novo()
  check((await captura(() => criarFrente(s, base('f4', { nome: '   ' })))) instanceof ErroValidação, 'nome vazio → ErroValidação')
  check((await captura(() => criarFrente(s, base('f5', { cadênciaEsperada: Number('abc') })))) instanceof ErroValidação, 'cadência NaN → ErroValidação')
  check((await captura(() => criarFrente(s, base('f6', { cadênciaEsperada: 0 })))) instanceof ErroValidação, 'cadência 0 → ErroValidação')
  check((await captura(() => criarFrente(s, base('f7', { parentId: 'inexistente' })))) instanceof ErroValidação, 'pai inexistente → ErroValidação')
  check(!s.chamadas.salvarFrenteComEventos, 'validação falha antes de qualquer gravação')
}

// ============ registros ============
console.log('\n— registros')
{
  const { s, mem } = novo()
  await criarFrente(s, base('r1'))
  s.falhar = { método: 'salvarRegistroComCache', n: 1 }
  const dados = { id: 'reg-1', criadoEm: agora, frenteId: 'r1', data: agora - DIA, texto: 'x', contaComoMovimento: true }
  const erro = await captura(() => criarRegistro(s, dados))
  check(erro !== null && !(erro instanceof ErroParcial), 'falha ao criar registro → erro total')
  check((await mem.getRegistros('r1')).length === 0 && (await mem.getFrente('r1'))?.últimoMovimento === null, 'nem o registro nem o cache mudaram')
  await criarRegistro(s, dados)
  await criarRegistro(s, dados)
  check((await mem.getRegistros('r1')).length === 1, 'retry (2×) com o mesmo id: 1 registro')
  check((await mem.getFrente('r1'))?.últimoMovimento === agora - DIA, 'cache correto')
}
{
  const { s, mem } = novo()
  await criarFrente(s, base('r2'))
  const r = await criarRegistro(s, { frenteId: 'r2', data: agora - 3 * DIA, texto: 'a', contaComoMovimento: true })
  s.chamadas = {}
  await editarRegistro(s, r.id, { texto: 'b' }, 'r2')
  check((s.chamadas.getFrentes ?? 0) === 0 && (s.chamadas.getTodosRegistros ?? 0) === 0, 'editarRegistro com frente conhecida: sem varredura global')
  s.chamadas = {}
  await excluirRegistro(s, r.id, 'r2')
  const leituras = Object.keys(s.chamadas).filter((m) => m.startsWith('get'))
  check(leituras.length === 0, 'excluirRegistro: NENHUMA leitura (o storage resolve a frente)')
  check((await mem.getFrente('r2'))?.últimoMovimento === null, 'cache recalculado após excluir o único movimento')

  const r2 = await criarRegistro(s, { frenteId: 'r2', data: agora, texto: 'c', contaComoMovimento: true })
  s.falhar = { método: 'removerRegistroComCache', n: (s.chamadas.removerRegistroComCache ?? 0) + 1 }
  const erro = await captura(() => excluirRegistro(s, r2.id))
  check(erro !== null && (await mem.getRegistros('r2')).length === 1 && (await mem.getFrente('r2'))?.últimoMovimento === agora, 'falha ao excluir: registro e cache intactos')
  await excluirRegistro(s, r2.id)
  check((await mem.getRegistros('r2')).length === 0 && (await mem.getFrente('r2'))?.últimoMovimento === null, 'retry exclui e recalcula')
}

// ============ mudar* ============
console.log('\n— mudarCondição')
{
  const { s, mem } = novo()
  await criarFrente(s, base('c1'))
  s.falhar = { método: 'salvarFrenteComEventos', n: (s.chamadas.salvarFrenteComEventos ?? 0) + 1 }
  const erro = await captura(() => mudarCondição(s, 'c1', 'bloqueada', agora))
  check(erro !== null && !(erro instanceof ErroParcial), 'falha → erro total')
  check((await mem.getFrente('c1'))?.condição === 'normal' && (await mem.getEventosEstruturais('c1')).length === 1, 'condição NÃO mudou e nenhum evento foi gravado')
  await mudarCondição(s, 'c1', 'bloqueada', agora)
  await mudarCondição(s, 'c1', 'bloqueada', agora)
  const evs = (await mem.getEventosEstruturais('c1')).filter((e) => e.tipo === 'condição_mudou')
  check((await mem.getFrente('c1'))?.condição === 'bloqueada' && evs.length === 1, 'retry aplica 1 vez; repetir a mesma mudança não gera evento extra')
}

// ============ editarFrente ============
console.log('\n— editarFrente')
{
  const { s, mem } = novo()
  await criarFrente(s, base('e1'))
  await editarFrente(s, 'e1', { nome: 'e1', área: 'work', tipo: 'projeto', cicloVida: 'concluída', condição: 'normal', cadênciaEsperada: 7, contextoFoco: null, contextoBloqueio: null }, agora)
  check((await mem.getFrente('e1'))?.cicloVida === 'concluída', 'conclui a frente')

  // REPRODUÇÃO do bug antigo: editar só o nome de uma frente concluída lançava erro (mudarCondição) depois de salvar parte
  const antes = (await mem.getEventosEstruturais('e1')).length
  const f = await editarFrente(s, 'e1', { nome: 'Novo nome', área: 'work', tipo: 'projeto', cicloVida: 'concluída', condição: 'bloqueada', cadênciaEsperada: 7, contextoFoco: 'foco', contextoBloqueio: null }, agora)
  check(f.nome === 'Novo nome' && f.contextoFoco === 'foco', 'editar nome/foco de frente CONCLUÍDA funciona')
  check(f.condição === 'normal', 'condição enviada para frente não-ativa é ignorada (fica normal), sem erro')
  check((await mem.getEventosEstruturais('e1')).length === antes, 'nenhum evento espúrio por edição de nome')

  const { s: s2, mem: m2 } = novo()
  await criarFrente(s2, base('e2', { condição: 'bloqueada' }))
  s2.chamadas = {}
  await editarFrente(s2, 'e2', { nome: 'e2', área: 'art', tipo: 'prática', cicloVida: 'arquivada', condição: 'pausada', cadênciaEsperada: 14, contextoFoco: null, contextoBloqueio: null }, agora)
  check((s2.chamadas.salvarFrenteComEventos ?? 0) === 1 && !s2.chamadas.salvarFrente && !s2.chamadas.salvarEventoEstrutural, 'edição composta usa 1 única operação atômica')
  const tipos = (await m2.getEventosEstruturais('e2')).map((e) => `${e.tipo}:${e.valorAnterior}>${e.valorNovo}`).sort()
  check(tipos.includes('ciclo_vida_mudou:ativa>arquivada') && tipos.includes('condição_mudou:bloqueada>normal') && tipos.includes('cadência_mudou:7>14'), 'eventos: ciclo, condição (→normal) e cadência')

  await editarFrente(s2, 'e2', { nome: 'e2', área: 'art', tipo: 'prática', cicloVida: 'ativa', condição: 'aguardando', cadênciaEsperada: 14, contextoFoco: null, contextoBloqueio: null }, agora + 1)
  check((await m2.getFrente('e2'))?.condição === 'aguardando', 'reativar já com condição "aguardando" funciona')
  s2.chamadas = {}
  await editarFrente(s2, 'e2', { nome: 'e2', área: 'art', tipo: 'prática', cicloVida: 'ativa', condição: 'aguardando', cadênciaEsperada: 14, contextoFoco: null, contextoBloqueio: null }, agora + 2)
  check((s2.chamadas.salvarFrenteComEventos ?? 0) === 0, 'formulário sem alterações não grava nada')
  check((await captura(() => editarFrente(s2, 'e2', { nome: '', área: 'art', tipo: 'prática', cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: 14, contextoFoco: null, contextoBloqueio: null }))) instanceof ErroValidação, 'nome vazio → ErroValidação')
  check((await captura(() => editarFrente(s2, 'e2', { nome: 'x', área: 'art', tipo: 'prática', cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: -3, contextoFoco: null, contextoBloqueio: null }))) instanceof ErroValidação, 'cadência negativa → ErroValidação')

  // falha na operação atômica: nem a frente nem os eventos
  const { s: s3, mem: m3 } = novo()
  await criarFrente(s3, base('e3'))
  s3.falhar = { método: 'salvarFrenteComEventos', n: (s3.chamadas.salvarFrenteComEventos ?? 0) + 1 }
  const erro = await captura(() => editarFrente(s3, 'e3', { nome: 'e3', área: 'work', tipo: 'projeto', cicloVida: 'ativa', condição: 'pausada', cadênciaEsperada: 30, contextoFoco: null, contextoBloqueio: null }, agora))
  check(erro !== null && !(erro instanceof ErroParcial), 'falha → erro total')
  check((await m3.getFrente('e3'))?.condição === 'normal' && (await m3.getFrente('e3'))?.cadênciaEsperada === 7 && (await m3.getEventosEstruturais('e3')).length === 1, 'NADA foi salvo: frente intacta, nenhum evento')
  await editarFrente(s3, 'e3', { nome: 'e3', área: 'work', tipo: 'projeto', cicloVida: 'ativa', condição: 'pausada', cadênciaEsperada: 30, contextoFoco: null, contextoBloqueio: null }, agora)
  check((await m3.getEventosEstruturais('e3')).filter((e) => e.tipo !== 'criação').length === 2, 'retry grava os 2 eventos (condição, cadência), sem duplicar')
}

// ============ moverFrente ============
console.log('\n— moverFrente')
{
  const { s, mem } = novo()
  await criarFrente(s, base('m-pai', { tipo: 'domínio', cadênciaEsperada: null }))
  await criarFrente(s, base('m-filha'))
  s.falhar = { método: 'salvarFrenteComEventos', n: (s.chamadas.salvarFrenteComEventos ?? 0) + 1 }
  const erro = await captura(() => moverFrente(s, 'm-filha', 'm-pai', agora))
  check(erro !== null && (await mem.getFrente('m-filha'))?.parentId === null, 'mover com falha: a frente NÃO fica movida sem o evento')
  await moverFrente(s, 'm-filha', 'm-pai', agora)
  check((await mem.getEventosEstruturais('m-filha')).filter((e) => e.tipo === 'hierarquia_mudou').length === 1, 'retry move com exatamente 1 evento')
}

// ============ excluirFrenteComFilhos ============
console.log('\n— excluirFrenteComFilhos')
{
  const { s, mem } = novo()
  await criarFrente(s, base('x-raiz', { tipo: 'domínio', cadênciaEsperada: null }))
  await criarFrente(s, base('x-filha', { parentId: 'x-raiz' }))
  await criarFrente(s, base('x-neta', { parentId: 'x-filha' }))
  for (const id of ['x-raiz', 'x-filha', 'x-neta']) {
    await criarRegistro(s, { frenteId: id, data: agora, texto: id, contaComoMovimento: true })
  }
  await criarFrente(s, base('x-outra'))
  await criarRegistro(s, { frenteId: 'x-outra', data: agora, texto: 'fica', contaComoMovimento: true })

  s.chamadas = {}
  s.falhar = { método: 'removerFrenteEmCascata', n: 1 }
  const erro = await captura(() => excluirFrenteComFilhos('x-raiz', s))
  check(erro !== null && !(erro instanceof ErroParcial), 'falha na exclusão → erro total (nada de "exclusão pela metade")')
  check((await mem.getFrentes()).length === 4 && (await mem.getTodosRegistros()).length === 4, 'a árvore inteira, com registros, continua lá')
  await excluirFrenteComFilhos('x-raiz', s)
  check(!(await mem.getFrentes()).some((f) => f.id.startsWith('x-') && f.id !== 'x-outra'), 'retry conclui a exclusão')
  check((await mem.getRegistros('x-outra')).length === 1, 'frente de fora da cascata intacta')
  check((await mem.getTodosRegistros()).every((r) => r.frenteId === 'x-outra'), 'nenhum registro órfão')
  check((await mem.getTodosEventosEstruturais()).every((e) => e.frenteId === 'x-outra'), 'nenhum evento órfão')
  check((await captura(() => excluirFrenteComFilhos('x-raiz', s))) === null, 'excluir de novo uma frente já excluída é no-op (idempotente)')
}
{
  // sem N+1: a exclusão de 21 frentes é UMA chamada, sem leituras
  const { s } = novo()
  await criarFrente(s, base('y-raiz', { tipo: 'domínio', cadênciaEsperada: null }))
  for (let i = 0; i < 20; i++) await criarFrente(s, base(`y-${i}`, { parentId: 'y-raiz' }))
  s.chamadas = {}
  await excluirFrenteComFilhos('y-raiz', s)
  const leituras = Object.keys(s.chamadas).filter((m) => m.startsWith('get')).length
  check(leituras === 0 && (s.chamadas.removerFrenteEmCascata ?? 0) === 1, 'exclusão de 21 frentes: 1 chamada atômica, 0 leituras')
}

// ============ importarPulse ============
console.log('\n— importarPulse')
{
  const origem = new MemoryAdapter()
  await criarFrente(origem, base('i-pai', { tipo: 'domínio', cadênciaEsperada: null }))
  await criarFrente(origem, base('i-filha', { parentId: 'i-pai' }))
  await criarRegistro(origem, { frenteId: 'i-filha', data: agora, texto: 'r', contaComoMovimento: true })
  const dados = await exportarPulse(origem, agora)

  // destino que exige pai antes do filho (FK) e falha no 2º registro/evento
  const { s, mem } = novo()
  const ordemFrentes: string[] = []
  const salvar = s.salvarFrente.bind(s)
  s.salvarFrente = async (f: Frente) => {
    if (f.parentId && !ordemFrentes.includes(f.parentId)) throw { code: '23503', message: 'FK violada: pai ainda não existe' }
    ordemFrentes.push(f.id)
    await salvar(f)
  }
  s.falhar = { método: 'salvarEventoEstrutural', n: 2 }
  const erro = await captura(() => importarPulse(s, dados))
  check(!(erro instanceof ErroParcial && /FK/.test(erro.message)), 'import grava pais antes dos filhos (FK respeitada)')
  check(erro instanceof ErroParcial, 'falha no meio do import → ErroParcial')
  check((await mem.getFrentes()).length === 2, 'frentes já gravadas permanecem')
  await (erro as ErroParcial).completar!()
  check((await mem.getTodosEventosEstruturais()).length === dados.eventosEstruturais.length, 'completar grava o que faltava')
  check((await mem.getFrentes()).length === 2 && (await mem.getTodosRegistros()).length === 1, 'sem duplicação após completar')
}

console.log(`\n${falhas === 0 ? '✅ Consistência: todos os testes passaram' : `❌ ${falhas} teste(s) falharam`}`)
if (falhas > 0) process.exit(1)
