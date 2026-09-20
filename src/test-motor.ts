import { MemoryAdapter } from './storage'
import { calcularSinalAgregado, registrarMovimento } from './signal'
import type { Frente } from './types'

// ============================================================
// TESTE MANUAL DO MOTOR — Fase 1
// Objetivo único: provar que a árvore recursiva e o rollup por
// pior-caso se comportam como esperado, ANTES de escrever HTML.
// Rode com: npm run test:motor
// ============================================================

const agora = Date.now()
const dia = 1000 * 60 * 60 * 24
const storage = new MemoryAdapter()

function novaFrente(parcial: Partial<Frente> & Pick<Frente, 'id' | 'nome' | 'área' | 'tipo'>): Frente {
  const f: Frente = {
    parentId: null,
    estado: 'ativa',
    cadênciaEsperada: 7,
    últimoToque: agora,
    últimoMovimento: agora,
    optOutNegligência: false,
    criadaEm: agora - 90 * dia,
    ...parcial
  }
  storage.salvarFrente(f)
  return f
}

// Darkline (domínio) > Darkline Dev (domínio) > Origens (projeto, saudável)
novaFrente({ id: 'darkline', nome: 'Darkline', área: 'work', tipo: 'domínio' })
novaFrente({ id: 'darkline-dev', nome: 'Darkline Dev', área: 'work', tipo: 'domínio', parentId: 'darkline' })
novaFrente({
  id: 'origens',
  nome: 'Origens',
  área: 'work',
  tipo: 'projeto',
  parentId: 'darkline-dev',
  cadênciaEsperada: 5,
  últimoMovimento: agora - 1 * dia // movimento recente
})

// Um projeto-fantasma dentro de Darkline Dev, esquecido há 40 dias
novaFrente({
  id: 'projeto-fantasma',
  nome: 'Projeto Fantasma',
  área: 'work',
  tipo: 'projeto',
  parentId: 'darkline-dev',
  cadênciaEsperada: 7,
  últimoMovimento: agora - 40 * dia
})

// Violino: prática, cadência de 3 dias, atualizado ontem — deve estar no ritmo
novaFrente({
  id: 'violino',
  nome: 'Violino',
  área: 'art',
  tipo: 'prática',
  cadênciaEsperada: 3,
  últimoMovimento: agora - 1 * dia
})

// Escola: domínio dentro de WORK, sem frentes-filha ainda
novaFrente({ id: 'escola', nome: 'Escola', área: 'work', tipo: 'domínio', cadênciaEsperada: 14 })

// Finanças: domínio-folha (sem filhos), pausado deliberadamente — não deve alarmar
novaFrente({
  id: 'financas',
  nome: 'Finanças',
  área: 'life',
  tipo: 'domínio',
  cadênciaEsperada: 30,
  optOutNegligência: true,
  últimoMovimento: agora - 50 * dia
})

console.log('--- Sinais individuais/agregados ---\n')

const testes = ['darkline', 'darkline-dev', 'origens', 'projeto-fantasma', 'violino', 'escola', 'financas']

for (const id of testes) {
  const frente = storage.getFrente(id)!
  const sinal = calcularSinalAgregado(id, storage)
  console.log(`${frente.nome.padEnd(20)} → ${sinal}`)
}

console.log('\n--- Verificações esperadas ---\n')

const sinalDarkline = calcularSinalAgregado('darkline', storage)
const sinalDev = calcularSinalAgregado('darkline-dev', storage)
const sinalOrigens = calcularSinalAgregado('origens', storage)
const sinalFantasma = calcularSinalAgregado('projeto-fantasma', storage)
const sinalFinancas = calcularSinalAgregado('financas', storage)

console.log(
  sinalOrigens === 'no_ritmo'
    ? '✅ Origens (movimento recente) está no_ritmo'
    : `❌ Origens deveria estar no_ritmo, veio ${sinalOrigens}`
)

console.log(
  sinalFantasma === 'fora_do_ritmo'
    ? '✅ Projeto Fantasma (40 dias parado) está fora_do_ritmo'
    : `❌ Projeto Fantasma deveria estar fora_do_ritmo, veio ${sinalFantasma}`
)

console.log(
  sinalDev === 'fora_do_ritmo'
    ? '✅ Darkline Dev herdou o PIOR sinal (do Projeto Fantasma), não a média'
    : `❌ Darkline Dev deveria herdar fora_do_ritmo, veio ${sinalDev}`
)

console.log(
  sinalDarkline === 'fora_do_ritmo'
    ? '✅ O alerta subiu a árvore até Darkline (raiz), mesmo com Origens saudável'
    : `❌ Darkline (raiz) deveria herdar fora_do_ritmo, veio ${sinalDarkline}`
)

console.log(
  sinalFinancas === 'hibernando'
    ? '✅ Finanças (opt-out) NÃO alarma mesmo com 50 dias parado'
    : `❌ Finanças deveria estar hibernando, veio ${sinalFinancas}`
)

console.log('\n--- Teste de registrarMovimento ---\n')

let violino = storage.getFrente('violino')!
console.log('Antes:', new Date(violino.últimoMovimento!).toISOString())
violino = registrarMovimento(violino)
storage.salvarFrente(violino)
console.log('Depois:', new Date(violino.últimoMovimento!).toISOString())
console.log(
  Math.abs(violino.últimoMovimento! - agora) < 1000
    ? '✅ registrarMovimento atualizou últimoMovimento corretamente'
    : '❌ registrarMovimento não atualizou como esperado'
)
