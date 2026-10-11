import { MemoryAdapter } from './storage'
import { criarFrente, mudarCicloVida } from './frente-ops'
import { registrarGlobal, buscarRegistros } from './registro-query'
import { obterHistórico } from './historico'
import type { Frente } from './types'

// ============================================================
// TESTE: registro global + busca — BLOCO 4
// Rode com: npm run test:registro-query
// ============================================================

const dia = 1000 * 60 * 60 * 24
const base = new Date('2026-09-29T00:00:00Z').getTime()

const storage = new MemoryAdapter()

let falhas = 0
function check(condição: boolean, mensagem: string): void {
  if (condição) {
    console.log(`✅ ${mensagem}`)
  } else {
    console.log(`❌ ${mensagem}`)
    falhas++
  }
}

async function novaFrente(parcial: Partial<Frente> & Pick<Frente, 'id' | 'nome' | 'tipo'>, criadaEm: number) {
  return criarFrente(storage, {
    área: 'work',
    parentId: null,
    cicloVida: 'ativa',
    condição: 'normal',
    cadênciaEsperada: 7,
    contextoFoco: null,
    contextoBloqueio: null,
    pausaMotivo: null,
    pausaRetomadaEm: null,
    criadaEm,
    ...parcial
  })
}

console.log('=== PARTE 1: registro global ===\n')

await novaFrente({ id: 'origens', nome: 'Origens', tipo: 'projeto' }, base)

const antes = Date.now()
const r1 = await registrarGlobal(storage, { frenteId: 'origens', texto: 'corrigi login', contaComoMovimento: true })
const depois = Date.now()

check(r1.frenteId === 'origens', 'Registro global criado na frente correta')
check(r1.texto === 'corrigi login', 'Texto do registro global preservado')
check(r1.criadoEm >= antes && r1.criadoEm <= depois, 'criadoEm = momento real da chamada (próximo de Date.now())')
check(
  Math.abs(r1.data - r1.criadoEm) < 1000,
  'Quando `data` não é informada, data ≈ criadoEm (ambas ~agora)'
)

let frenteOrigens = (await storage.getFrente('origens'))!
check(frenteOrigens.últimoMovimento === r1.data, 'últimoMovimento da frente foi atualizado pelo registro global')

console.log('\n=== PARTE 2: registro em frente inexistente → erro explícito ===\n')

let erroLançado = false
try {
  await registrarGlobal(storage, { frenteId: 'nao-existe', texto: 'x', contaComoMovimento: true })
} catch {
  erroLançado = true
}
check(erroLançado, 'registrarGlobal em frente inexistente lança erro explícito (não grava silenciosamente)')

console.log('\n=== PARTE 3: registro retroativo + diferença data vs criadoEm ===\n')

const antesRetro = Date.now()
const r2 = await registrarGlobal(storage, {
  frenteId: 'origens',
  texto: 'esqueci de registrar isso de 5 dias atrás',
  contaComoMovimento: true,
  data: base - 5 * dia
})
check(r2.data === base - 5 * dia, 'data do registro retroativo é a informada pelo usuário')
check(r2.criadoEm >= antesRetro, 'criadoEm do registro retroativo continua sendo o momento real da chamada, não a data retroativa')
check(r2.data !== r2.criadoEm, 'data e criadoEm são claramente distintos num registro retroativo')

// esse retroativo é mais ANTIGO que o último movimento atual — não deve regredir últimoMovimento
frenteOrigens = (await storage.getFrente('origens'))!
check(
  frenteOrigens.últimoMovimento === r1.data,
  'Registro retroativo mais antigo que o último movimento NÃO regride últimoMovimento (recalculado corretamente via criarRegistro)'
)

console.log('\n=== PARTE 4: registro em frente concluída/arquivada respeita invariantes existentes ===\n')

await novaFrente({ id: 'concluida', nome: 'Concluída', tipo: 'projeto' }, base)
await mudarCicloVida(storage, 'concluida', 'concluída', base + 1 * dia)
const rConcluida = await registrarGlobal(storage, { frenteId: 'concluida', texto: 'nota após conclusão', contaComoMovimento: true })
check(rConcluida.frenteId === 'concluida', 'Registro em frente concluída é aceito (nenhuma invariante do Bloco 1 proíbe isso)')
const frenteConcluida = (await storage.getFrente('concluida'))!
check(frenteConcluida.cicloVida === 'concluída', 'Registrar não alterou o cicloVida da frente concluída')
check(frenteConcluida.condição === 'normal', 'Condição da frente concluída continua normal (invariante do Bloco 1 preservada)')

console.log('\n=== PARTE 5: busca — texto, frente, descendentes ===\n')

await novaFrente({ id: 'dom', nome: 'Domínio', tipo: 'domínio', cadênciaEsperada: null }, base)
await novaFrente({ id: 'dom-filho', nome: 'Filho do Domínio', tipo: 'projeto', parentId: 'dom' }, base)
await registrarGlobal(storage, { frenteId: 'dom-filho', texto: 'trabalho no filho', contaComoMovimento: true, data: base + 1 * dia })
await registrarGlobal(storage, { frenteId: 'dom', texto: 'decisão no domínio', contaComoMovimento: false, data: base + 2 * dia })

const buscaTexto = await buscarRegistros(storage, { texto: 'login' })
check(
  buscaTexto.length === 1 && buscaTexto[0]?.texto === 'corrigi login',
  `Busca por texto "login" encontra exatamente o registro certo, veio ${buscaTexto.length}`
)

const buscaTextoCaseInsensitive = await buscarRegistros(storage, { texto: 'LOGIN' })
check(buscaTextoCaseInsensitive.length === 1, 'Busca por texto é case-insensitive')

const buscaPorFrente = await buscarRegistros(storage, { frenteId: 'origens' })
check(buscaPorFrente.length === 2, `Busca por frente "origens" retorna só os 2 registros dela, veio ${buscaPorFrente.length}`)

const buscaComDescendentes = await buscarRegistros(storage, { frenteId: 'dom', incluirDescendentes: true })
check(
  buscaComDescendentes.length === 2,
  `Busca com incluirDescendentes=true em "dom" pega o próprio + o filho, veio ${buscaComDescendentes.length}`
)

const buscaSemDescendentes = await buscarRegistros(storage, { frenteId: 'dom', incluirDescendentes: false })
check(
  buscaSemDescendentes.length === 1,
  `Busca com incluirDescendentes=false em "dom" pega só o próprio, veio ${buscaSemDescendentes.length}`
)

console.log('\n=== PARTE 6: filtro por período [início, fim) ===\n')

// cenário isolado e determinístico: registros em datas fixas e conhecidas
const storagePeríodo = new MemoryAdapter()
await criarFrente(storagePeríodo, {
  id: 'per', nome: 'Período', área: 'work', tipo: 'projeto', parentId: null,
  cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: 7,
  contextoFoco: null, contextoBloqueio: null, pausaMotivo: null, pausaRetomadaEm: null,
  criadaEm: base
})
await registrarGlobal(storagePeríodo, { frenteId: 'per', texto: 'exatamente no início', contaComoMovimento: true, data: base })
await registrarGlobal(storagePeríodo, { frenteId: 'per', texto: 'exatamente no fim', contaComoMovimento: true, data: base + 1 * dia })

const buscaPeríodo = await buscarRegistros(storagePeríodo, { frenteId: 'per', início: base, fim: base + 1 * dia })
check(
  buscaPeríodo.length === 1 && buscaPeríodo[0]?.texto === 'exatamente no início',
  `Filtro [base, base+1dia) inclui o registro em \`base\` (início incluído) e exclui o que está em base+1dia (fim excluído), veio ${buscaPeríodo.length} registro(s)`
)

const buscaPeríodoVazio = await buscarRegistros(storage, { início: base - 1000 * dia, fim: base - 999 * dia })
check(buscaPeríodoVazio.length === 0, 'Filtro de período sem nenhum dado retorna array vazio, sem erro')

console.log('\n=== PARTE 7: limite, ordenação, empate determinístico ===\n')

const storageOrdem = new MemoryAdapter()
await criarFrente(storageOrdem, {
  id: 'ord', nome: 'Ordem', área: 'work', tipo: 'projeto', parentId: null,
  cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: 7,
  contextoFoco: null, contextoBloqueio: null, pausaMotivo: null, pausaRetomadaEm: null,
  criadaEm: base
})
// três registros com datas DIFERENTES, pra testar ordenação crescente/decrescente
await registrarGlobal(storageOrdem, { frenteId: 'ord', texto: 'A', contaComoMovimento: true, data: base + 1 * dia })
await registrarGlobal(storageOrdem, { frenteId: 'ord', texto: 'B', contaComoMovimento: true, data: base + 3 * dia })
await registrarGlobal(storageOrdem, { frenteId: 'ord', texto: 'C', contaComoMovimento: true, data: base + 2 * dia })

const decrescente = await buscarRegistros(storageOrdem, { frenteId: 'ord', ordem: 'decrescente' })
check(
  decrescente.map((r) => r.texto).join('') === 'BCA',
  `Ordem decrescente (mais recente primeiro): B,C,A — veio ${decrescente.map((r) => r.texto).join(',')}`
)

const crescente = await buscarRegistros(storageOrdem, { frenteId: 'ord', ordem: 'crescente' })
check(
  crescente.map((r) => r.texto).join('') === 'ACB',
  `Ordem crescente (mais antigo primeiro): A,C,B — veio ${crescente.map((r) => r.texto).join(',')}`
)

const limitado = await buscarRegistros(storageOrdem, { frenteId: 'ord', ordem: 'decrescente', limite: 2 })
check(limitado.length === 2 && limitado[0]?.texto === 'B', 'Limite=2 retorna só os 2 primeiros da ordenação (B, C)')

// empate exato em `data` — desempate determinístico por id
const storageEmpate = new MemoryAdapter()
await criarFrente(storageEmpate, {
  id: 'emp', nome: 'Empate', área: 'work', tipo: 'projeto', parentId: null,
  cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: 7,
  contextoFoco: null, contextoBloqueio: null, pausaMotivo: null, pausaRetomadaEm: null,
  criadaEm: base
})
const rEmpateX = await registrarGlobal(storageEmpate, { frenteId: 'emp', texto: 'X', contaComoMovimento: true, data: base })
const rEmpateY = await registrarGlobal(storageEmpate, { frenteId: 'emp', texto: 'Y', contaComoMovimento: true, data: base })

const buscaEmpate1 = await buscarRegistros(storageEmpate, { frenteId: 'emp' })
const buscaEmpate2 = await buscarRegistros(storageEmpate, { frenteId: 'emp' })
check(
  buscaEmpate1.map((r) => r.id).join(',') === buscaEmpate2.map((r) => r.id).join(','),
  'Dois registros com `data` EXATAMENTE igual: a ordem entre eles é a mesma em chamadas repetidas (desempate determinístico por id)'
)
const idsOrdenados = [rEmpateX.id, rEmpateY.id].sort()
check(
  buscaEmpate1.map((r) => r.id).join(',') === idsOrdenados.join(','),
  'Desempate de data igual segue ordem lexicográfica crescente de id, independente da ordem de inserção'
)

console.log('\n=== PARTE 8: histórico por frente (reaproveitando historico.ts, não duplicando) ===\n')

const histOrigens = await obterHistórico(storage, 'origens')
check(
  histOrigens.filter((i) => i.tipo === 'registro').length === 2,
  `Histórico de Origens tem os 2 registros (próprio), veio ${histOrigens.filter((i) => i.tipo === 'registro').length}`
)
check(
  histOrigens.some((i) => i.tipo === 'evento_estrutural'),
  'Histórico de Origens também inclui o evento de criação (mistura registro + evento estrutural)'
)

const histDomSemDescendentes = await obterHistórico(storage, 'dom')
const histDomComDescendentes = await obterHistórico(storage, 'dom', { incluirDescendentes: true })
check(
  histDomSemDescendentes.filter((i) => i.tipo === 'registro').length === 1,
  'Histórico do domínio SEM descendentes: só o registro próprio dele'
)
check(
  histDomComDescendentes.filter((i) => i.tipo === 'registro').length === 2,
  'Histórico do domínio COM descendentes: inclui o registro do filho também'
)

// distinção data vs criadoEm preservada no histórico (o item do histórico usa `data`, não criadoEm)
const itemHistóricoRetro = histOrigens.find((i) => i.tipo === 'registro' && i.registro.texto.includes('esqueci'))
check(
  itemHistóricoRetro !== undefined && itemHistóricoRetro.data === base - 5 * dia,
  'Item de histórico do registro retroativo usa `data` (acontecimento), não `criadoEm`'
)

console.log(`\n${falhas === 0 ? '✅ Todos os testes de registro/busca passaram' : `❌ ${falhas} teste(s) falharam`}`)
