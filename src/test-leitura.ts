import { MemoryAdapter, type StorageAdapter } from './storage'
import { comMemoDeLeitura } from './storage-leitura'
import { calcularSinalAgregado, calcularSinalAgregadoComCausas } from './signal'
import { obterEstadoFrente, obterFrentesEmAtenção } from './estado'
import { obterRetrospectiva } from './historico'
import { obterMudançasRecentes } from './ui/home-dados'
import { criarFrente, criarRegistro } from './frente-ops'

// ============================================================
// TESTE: leitura única por render (memo) — elimina N+1 sem mudar
// nenhum resultado. Rode com: npm run test:leitura
// ============================================================

let falhas = 0
function check(condição: boolean, mensagem: string): void {
  if (condição) console.log(`✅ ${mensagem}`)
  else {
    console.log(`❌ ${mensagem}`)
    falhas++
  }
}

/** Adapter que conta cada leitura que "iria à rede". */
class Contador implements StorageAdapter {
  leituras = 0
  falharLeituras = false
  constructor(private base: StorageAdapter) {}
  private async l<T>(fn: () => Promise<T>): Promise<T> {
    this.leituras++
    if (this.falharLeituras) throw new Error('rede caiu')
    return fn()
  }
  getFrentes = () => this.l(() => this.base.getFrentes())
  getFrente = (id: string) => this.l(() => this.base.getFrente(id))
  salvarFrente = (f: Parameters<StorageAdapter['salvarFrente']>[0]) => this.base.salvarFrente(f)
  removerFrente = (id: string) => this.base.removerFrente(id)
  getRegistros = (id: string) => this.l(() => this.base.getRegistros(id))
  getTodosRegistros = () => this.l(() => this.base.getTodosRegistros())
  getRegistrosRecentes = (n: number) => this.l(() => this.base.getRegistrosRecentes(n))
  salvarRegistro = (r: Parameters<StorageAdapter['salvarRegistro']>[0]) => this.base.salvarRegistro(r)
  removerRegistro = (id: string) => this.base.removerRegistro(id)
  getEventosEstruturais = (id: string) => this.l(() => this.base.getEventosEstruturais(id))
  getTodosEventosEstruturais = () => this.l(() => this.base.getTodosEventosEstruturais())
  salvarEventoEstrutural = (e: Parameters<StorageAdapter['salvarEventoEstrutural']>[0]) => this.base.salvarEventoEstrutural(e)
  removerEventoEstrutural = (id: string) => this.base.removerEventoEstrutural(id)
}

const DIA = 86_400_000
const agora = 1_800_000_000_000
const mem = new MemoryAdapter()

// árvore: raiz(domínio) → 6 domínios-filho → cada um com 3 projetos = 25 frentes
async function nova(id: string, parentId: string | null, tipo: 'domínio' | 'projeto', cad: number | null): Promise<void> {
  await criarFrente(mem, {
    id,
    nome: id,
    área: 'work',
    tipo,
    parentId,
    cicloVida: 'ativa',
    condição: 'normal',
    cadênciaEsperada: cad,
    contextoFoco: null,
    contextoBloqueio: null,
    pausaMotivo: null,
    pausaRetomadaEm: null,
    criadaEm: agora - 60 * DIA
  })
}
await nova('raiz', null, 'domínio', null)
for (let d = 0; d < 6; d++) {
  await nova(`dom${d}`, 'raiz', 'domínio', null)
  for (let p = 0; p < 3; p++) {
    const id = `p${d}-${p}`
    await nova(id, `dom${d}`, 'projeto', 7)
    await criarRegistro(mem, { frenteId: id, data: agora - (p * 6 + d) * DIA, texto: `reg ${id}`, contaComoMovimento: true })
  }
}
const nFrentes = (await mem.getFrentes()).length

// ---- sem memo: N+1 (reprodução)
const semMemo = new Contador(mem)
for (const f of await semMemo.getFrentes()) await calcularSinalAgregado(f.id, semMemo, agora)
check(semMemo.leituras > nFrentes * 3, `sem memo: ${semMemo.leituras} leituras para sinal de ${nFrentes} frentes (N+1 reproduzido)`)

// ---- com memo: constante
const base = new Contador(mem)
const m = comMemoDeLeitura(base)
const sinaisMemo: Record<string, unknown> = {}
for (const f of await m.getFrentes()) sinaisMemo[f.id] = await calcularSinalAgregado(f.id, m, agora)
check(base.leituras === 1, `com memo: sinal de todas as frentes usa ${base.leituras} leitura (frentes)`)

// resultados idênticos ao caminho sem memo
let iguais = true
for (const f of await mem.getFrentes()) {
  if ((await calcularSinalAgregado(f.id, mem, agora)) !== sinaisMemo[f.id]) iguais = false
}
check(iguais, 'sinal agregado com memo == sem memo, para todas as frentes')

const c1 = JSON.stringify(await calcularSinalAgregadoComCausas('raiz', mem, agora))
const c2 = JSON.stringify(await calcularSinalAgregadoComCausas('raiz', m, agora))
check(c1 === c2, 'causas de domínio idênticas com e sem memo')

// ---- Home inteira: 3 leituras (frentes, registros, eventos)
const baseHome = new Contador(mem)
const mh = comMemoDeLeitura(baseHome)
const período = { início: agora - 7 * DIA, fim: agora + 1 }
await Promise.all([
  obterFrentesEmAtenção(mh, undefined, agora),
  obterMudançasRecentes(mh, período),
  mh.getRegistrosRecentes(6),
  calcularSinalAgregadoComCausas('raiz', mh, agora)
])
check(baseHome.leituras === 3, `Home inteira: ${baseHome.leituras} leituras reais (frentes + registros + eventos)`)
check(mh.leiturasReais.frentes === 1 && mh.leiturasReais.registros === 1 && mh.leiturasReais.eventos === 1, 'cada tabela é lida no máximo uma vez, mesmo com chamadas concorrentes')

const homeSem = new Contador(mem)
await obterFrentesEmAtenção(homeSem, undefined, agora)
await obterMudançasRecentes(homeSem, período)
check(homeSem.leituras > 30, `sem memo a mesma Home faz ${homeSem.leituras} leituras`)

// resultados da retrospectiva iguais
const r1 = JSON.stringify(await obterRetrospectiva(mem, 'raiz', { início: agora - 30 * DIA, fim: agora + 1 }))
const r2 = JSON.stringify(await obterRetrospectiva(m, 'raiz', { início: agora - 30 * DIA, fim: agora + 1 }))
check(r1 === r2, 'retrospectiva idêntica com e sem memo')

// ---- Frente individual
const baseF = new Contador(mem)
const mf = comMemoDeLeitura(baseF)
await obterEstadoFrente(mf, 'dom0', agora)
await obterEstadoFrente(mf, 'p0-0', agora)
check(baseF.leituras <= 3, `estado de duas frentes: ${baseF.leituras} leituras`)

// ---- invalidação por escrita
const baseW = new Contador(mem)
const mw = comMemoDeLeitura(baseW)
const antes = (await mw.getRegistros('p0-0')).length
await mw.salvarRegistro({ id: 'novo-r', frenteId: 'p0-0', data: agora, criadoEm: agora, texto: 'x', contaComoMovimento: false })
const depois = (await mw.getRegistros('p0-0')).length
check(depois === antes + 1, 'escrita feita pelo memo invalida o instantâneo (não serve dado velho)')

// ---- falha não fica presa no memo (retry funciona)
const baseR = new Contador(mem)
const mr = comMemoDeLeitura(baseR)
baseR.falharLeituras = true
let falhou = false
try {
  await mr.getFrentes()
} catch {
  falhou = true
}
baseR.falharLeituras = false
const ok = (await mr.getFrentes()).length
check(falhou && ok === nFrentes, 'leitura que falhou não é memorizada: tentar de novo funciona')

console.log(`\n${falhas === 0 ? '✅ Leitura com memo: todos os testes passaram' : `❌ ${falhas} teste(s) falharam`}`)
