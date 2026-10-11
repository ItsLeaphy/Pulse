import { MemoryAdapter } from './storage'
import { criarFrente, criarRegistro } from './frente-ops'
import { calcularSinalAgregado } from './signal'
import { moverFrente } from './hierarquia'
import type { Frente } from './types'

// ============================================================
// TESTE: reparenting — BLOCO 5
// Rode com: npm run test:hierarquia
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
    contextoFoco: 'foco original',
    contextoBloqueio: null,
    pausaMotivo: null,
    pausaRetomadaEm: null,
    criadaEm,
    ...parcial
  })
}

console.log('=== PARTE 1: movimentos básicos de hierarquia ===\n')

await novaFrente({ id: 'dom-a', nome: 'Domínio A', tipo: 'domínio', cadênciaEsperada: null }, base)
await novaFrente({ id: 'dom-b', nome: 'Domínio B', tipo: 'domínio', cadênciaEsperada: null }, base)
await novaFrente({ id: 'proj-1', nome: 'Projeto 1', tipo: 'projeto' }, base)

// raiz → domínio
let p1 = await moverFrente(storage, 'proj-1', 'dom-a', base + 1 * dia)
check(p1.parentId === 'dom-a', 'raiz → domínio: parentId atualizado')

// domínio → outro domínio
p1 = await moverFrente(storage, 'proj-1', 'dom-b', base + 2 * dia)
check(p1.parentId === 'dom-b', 'domínio → outro domínio: parentId atualizado')

// domínio → raiz
p1 = await moverFrente(storage, 'proj-1', null, base + 3 * dia)
check(p1.parentId === null, 'domínio → raiz: parentId=null')

console.log('\n=== PARTE 2: validações de erro ===\n')

let erro = false
try {
  await moverFrente(storage, 'proj-1', 'pai-inexistente')
} catch {
  erro = true
}
check(erro, 'pai inexistente: lança erro')

erro = false
try {
  await moverFrente(storage, 'proj-1', 'proj-1')
} catch {
  erro = true
}
check(erro, 'própria frente como pai: lança erro')

// descendente como pai (ciclo direto)
await novaFrente({ id: 'pai-x', nome: 'Pai X', tipo: 'domínio', cadênciaEsperada: null }, base)
await novaFrente({ id: 'filho-x', nome: 'Filho X', tipo: 'projeto', parentId: 'pai-x' }, base)
erro = false
try {
  await moverFrente(storage, 'pai-x', 'filho-x')
} catch {
  erro = true
}
check(erro, 'descendente direto como pai: lança erro')

// ciclo indireto: neto como pai do avô
await novaFrente({ id: 'avo', nome: 'Avô', tipo: 'domínio', cadênciaEsperada: null }, base)
await novaFrente({ id: 'pai-meio', nome: 'Pai Meio', tipo: 'domínio', parentId: 'avo', cadênciaEsperada: null }, base)
await novaFrente({ id: 'neto', nome: 'Neto', tipo: 'projeto', parentId: 'pai-meio' }, base)
erro = false
try {
  await moverFrente(storage, 'avo', 'neto')
} catch {
  erro = true
}
check(erro, 'ciclo indireto (neto como pai do avô): lança erro')

// mesma hierarquia (idempotente)
const p1AntesIdempotente = (await storage.getFrente('proj-1'))!
const p1Idempotente = await moverFrente(storage, 'proj-1', p1AntesIdempotente.parentId)
check(
  p1Idempotente.parentId === p1AntesIdempotente.parentId,
  'mover para o mesmo pai atual: idempotente, sem erro'
)
const eventosAntesEDepois = (await storage.getEventosEstruturais('proj-1')).filter((e) => e.tipo === 'hierarquia_mudou')
check(
  eventosAntesEDepois.length === 3, // raiz→dom-a, dom-a→dom-b, dom-b→raiz (3 mudanças reais até aqui)
  `mover para o mesmo pai NÃO gera evento adicional, veio ${eventosAntesEDepois.length} eventos de hierarquia_mudou`
)

console.log('\n=== PARTE 3: preservação de outros campos ===\n')

const antesDaMudança = (await storage.getFrente('proj-1'))!
await moverFrente(storage, 'proj-1', 'dom-a', base + 10 * dia)
const depoisDaMudança = (await storage.getFrente('proj-1'))!

check(depoisDaMudança.nome === antesDaMudança.nome, 'nome preservado')
check(depoisDaMudança.cicloVida === antesDaMudança.cicloVida, 'cicloVida preservado')
check(depoisDaMudança.condição === antesDaMudança.condição, 'condição preservada')
check(depoisDaMudança.cadênciaEsperada === antesDaMudança.cadênciaEsperada, 'cadênciaEsperada preservada')
check(depoisDaMudança.contextoFoco === antesDaMudança.contextoFoco, 'contextoFoco preservado')
check(depoisDaMudança.criadaEm === antesDaMudança.criadaEm, 'criadaEm preservado')

console.log('\n=== PARTE 4: evento hierarquia_mudou — valores e exclusividade ===\n')

const eventosProj1 = (await storage.getEventosEstruturais('proj-1')).filter((e) => e.tipo === 'hierarquia_mudou')
const últimoEvento = eventosProj1[0] // mais recente primeiro
check(últimoEvento !== undefined, 'evento hierarquia_mudou foi gerado')
if (últimoEvento) {
  check(últimoEvento.valorNovo === 'dom-a', `valorNovo correto (dom-a), veio ${últimoEvento.valorNovo}`)
  check(últimoEvento.valorAnterior === null, `valorAnterior correto (null, estava na raiz), veio ${últimoEvento.valorAnterior}`)
  check(últimoEvento.frenteId === 'proj-1', 'frenteId do evento é a frente movida, não o pai')
}

console.log('\n=== PARTE 5: sinais individuais preservados, agregação muda ===\n')

const storageSinal = new MemoryAdapter()
await criarFrente(storageSinal, {
  id: 'dom-saudavel', nome: 'Domínio Saudável', área: 'work', tipo: 'domínio', parentId: null,
  cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: null,
  contextoFoco: null, contextoBloqueio: null, pausaMotivo: null, pausaRetomadaEm: null, criadaEm: base
})
await criarFrente(storageSinal, {
  id: 'dom-doente', nome: 'Domínio Doente', área: 'work', tipo: 'domínio', parentId: null,
  cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: null,
  contextoFoco: null, contextoBloqueio: null, pausaMotivo: null, pausaRetomadaEm: null, criadaEm: base
})
await criarFrente(storageSinal, {
  id: 'proj-movivel', nome: 'Projeto Móvel', área: 'work', tipo: 'projeto', parentId: 'dom-saudavel',
  cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: 5,
  contextoFoco: null, contextoBloqueio: null, pausaMotivo: null, pausaRetomadaEm: null, criadaEm: base
})
// outro projeto negligenciado dentro de dom-doente, pra esse domínio já ter sinal ruim
await criarFrente(storageSinal, {
  id: 'proj-negligenciado', nome: 'Projeto Negligenciado', área: 'work', tipo: 'projeto', parentId: 'dom-doente',
  cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: 5,
  contextoFoco: null, contextoBloqueio: null, pausaMotivo: null, pausaRetomadaEm: null, criadaEm: base
})
await criarRegistro(storageSinal, { frenteId: 'proj-negligenciado', data: base - 50 * dia, texto: 'abandonado', contaComoMovimento: true })
await criarRegistro(storageSinal, { frenteId: 'proj-movivel', data: base - 1 * dia, texto: 'trabalhado ontem', contaComoMovimento: true })

const referência = base
const sinalProjMóvelAntes = await calcularSinalAgregado('proj-movivel', storageSinal, referência)
const sinalDomSaudávelAntes = await calcularSinalAgregado('dom-saudavel', storageSinal, referência)
const sinalDomDoenteAntes = await calcularSinalAgregado('dom-doente', storageSinal, referência)

check(sinalProjMóvelAntes === 'no_ritmo', `Projeto Móvel começa no_ritmo, veio ${sinalProjMóvelAntes}`)
check(sinalDomSaudávelAntes === 'no_ritmo', `Domínio Saudável começa no_ritmo (só tem o projeto móvel saudável), veio ${sinalDomSaudávelAntes}`)
check(sinalDomDoenteAntes === 'fora_do_ritmo', `Domínio Doente começa fora_do_ritmo (tem o negligenciado), veio ${sinalDomDoenteAntes}`)

await moverFrente(storageSinal, 'proj-movivel', 'dom-doente', base + 1 * dia)

const sinalProjMóvelDepois = await calcularSinalAgregado('proj-movivel', storageSinal, referência)
const sinalDomSaudávelDepois = await calcularSinalAgregado('dom-saudavel', storageSinal, referência)
const sinalDomDoenteDepois = await calcularSinalAgregado('dom-doente', storageSinal, referência)

check(
  sinalProjMóvelDepois === 'no_ritmo',
  `Sinal INDIVIDUAL do Projeto Móvel não muda com o reparenting (continua no_ritmo), veio ${sinalProjMóvelDepois}`
)
check(
  sinalDomSaudávelDepois === null,
  `Domínio antigo (dom-saudavel) deixa de considerar a frente movida: agora sem filhos, sinal=null, veio ${sinalDomSaudávelDepois}`
)
check(
  sinalDomDoenteDepois === 'fora_do_ritmo',
  `Domínio novo (dom-doente) continua fora_do_ritmo (ainda tem o negligenciado, agora também tem o móvel saudável — pior sinal prevalece), veio ${sinalDomDoenteDepois}`
)

console.log(`\n${falhas === 0 ? '✅ Todos os testes de hierarquia passaram' : `❌ ${falhas} teste(s) falharam`}`)
