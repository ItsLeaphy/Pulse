import { MemoryAdapter } from './storage'
import { criarFrente, criarRegistro } from './frente-ops'
import { obterRitmoObservado, sugerirCadência } from './ritmo'
import type { Frente } from './types'
import type { Período } from './historico'

// ============================================================
// TESTE: ritmo observado vs cadência + calibração — BLOCO 6
// Rode com: npm run test:ritmo
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

const período30dias: Período = { início: base, fim: base + 30 * dia }

console.log('=== PARTE 1: sem cadência (domínio) ===\n')

await novaFrente({ id: 'dom', nome: 'Domínio', tipo: 'domínio', cadênciaEsperada: null }, base)
let ritmo = await obterRitmoObservado(storage, 'dom', período30dias)
check(ritmo.classificação === 'evidência_insuficiente', `Sem cadência declarada: evidência_insuficiente, veio ${ritmo.classificação}`)
check(ritmo.cadênciaEsperada === null, 'cadênciaEsperada=null preservada na resposta')

console.log('\n=== PARTE 2: sem movimentos ===\n')

await novaFrente({ id: 'sem-mov', nome: 'Sem Movimento', tipo: 'projeto', cadênciaEsperada: 7 }, base)
ritmo = await obterRitmoObservado(storage, 'sem-mov', período30dias)
check(ritmo.classificação === 'evidência_insuficiente', `0 movimentos: evidência_insuficiente, veio ${ritmo.classificação}`)
check(ritmo.quantidadeMovimentos === 0, 'quantidadeMovimentos=0')
check(ritmo.intervaloMédioDias === null, 'intervaloMédioDias=null com 0 movimentos')

console.log('\n=== PARTE 3: 1 movimento (ainda insuficiente — precisa de 2 pra intervalo) ===\n')

await novaFrente({ id: 'um-mov', nome: 'Um Movimento', tipo: 'projeto', cadênciaEsperada: 7 }, base)
await criarRegistro(storage, { frenteId: 'um-mov', data: base + 5 * dia, texto: 'x', contaComoMovimento: true })
ritmo = await obterRitmoObservado(storage, 'um-mov', período30dias)
check(ritmo.classificação === 'evidência_insuficiente', `1 movimento: evidência_insuficiente, veio ${ritmo.classificação}`)
check(ritmo.quantidadeMovimentos === 1, 'quantidadeMovimentos=1')

console.log('\n=== PARTE 4: ritmo compatível ===\n')

await novaFrente({ id: 'compat', nome: 'Compatível', tipo: 'projeto', cadênciaEsperada: 7 }, base)
// movimentos a cada ~7 dias (0, 7, 14, 21, 28) — compatível com cadência=7
for (const offset of [0, 7, 14, 21, 28]) {
  await criarRegistro(storage, { frenteId: 'compat', data: base + offset * dia, texto: 'x', contaComoMovimento: true })
}
ritmo = await obterRitmoObservado(storage, 'compat', período30dias)
check(ritmo.classificação === 'ritmo_compatível', `Movimentos a cada 7d com cadência=7d: ritmo_compatível, veio ${ritmo.classificação} (intervalo=${ritmo.intervaloMédioDias})`)

console.log('\n=== PARTE 5: abaixo do esperado (intervalo real MAIOR que cadência) ===\n')

await novaFrente({ id: 'abaixo', nome: 'Abaixo', tipo: 'projeto', cadênciaEsperada: 5 }, base)
// movimentos a cada ~20 dias, cadência declarada=5 — bem menos frequente que o esperado
await criarRegistro(storage, { frenteId: 'abaixo', data: base, texto: 'x', contaComoMovimento: true })
await criarRegistro(storage, { frenteId: 'abaixo', data: base + 20 * dia, texto: 'x', contaComoMovimento: true })
ritmo = await obterRitmoObservado(storage, 'abaixo', período30dias)
check(ritmo.classificação === 'abaixo_do_esperado', `Intervalo real (20d) >> cadência (5d): abaixo_do_esperado, veio ${ritmo.classificação}`)

console.log('\n=== PARTE 6: acima do esperado (intervalo real MENOR que cadência) ===\n')

await novaFrente({ id: 'acima', nome: 'Acima', tipo: 'projeto', cadênciaEsperada: 20 }, base)
// movimentos a cada ~2 dias, cadência declarada=20 — muito mais frequente que o esperado
for (const offset of [0, 2, 4, 6, 8, 10]) {
  await criarRegistro(storage, { frenteId: 'acima', data: base + offset * dia, texto: 'x', contaComoMovimento: true })
}
ritmo = await obterRitmoObservado(storage, 'acima', período30dias)
check(ritmo.classificação === 'acima_do_esperado', `Intervalo real (2d) << cadência (20d): acima_do_esperado, veio ${ritmo.classificação}`)

console.log('\n=== PARTE 7: movimentos fora do período ===\n')

await novaFrente({ id: 'fora-periodo', nome: 'Fora Período', tipo: 'projeto', cadênciaEsperada: 7 }, base - 100 * dia)
// todos os movimentos ANTES do período consultado
await criarRegistro(storage, { frenteId: 'fora-periodo', data: base - 50 * dia, texto: 'x', contaComoMovimento: true })
await criarRegistro(storage, { frenteId: 'fora-periodo', data: base - 40 * dia, texto: 'x', contaComoMovimento: true })
ritmo = await obterRitmoObservado(storage, 'fora-periodo', período30dias)
check(
  ritmo.quantidadeMovimentos === 0,
  `Movimentos fora do período consultado não contam, veio quantidadeMovimentos=${ritmo.quantidadeMovimentos}`
)

console.log('\n=== PARTE 8: registros que não contam como movimento são ignorados ===\n')

await novaFrente({ id: 'so-obs', nome: 'Só Observações', tipo: 'projeto', cadênciaEsperada: 7 }, base)
await criarRegistro(storage, { frenteId: 'so-obs', data: base + 5 * dia, texto: 'nota', contaComoMovimento: false })
await criarRegistro(storage, { frenteId: 'so-obs', data: base + 10 * dia, texto: 'outra nota', contaComoMovimento: false })
ritmo = await obterRitmoObservado(storage, 'so-obs', período30dias)
check(
  ritmo.quantidadeMovimentos === 0,
  `Registros com contaComoMovimento=false não contam como movimento, veio quantidadeMovimentos=${ritmo.quantidadeMovimentos}`
)
check(ritmo.classificação === 'evidência_insuficiente', 'Só observações: evidência_insuficiente (0 movimentos reais)')

console.log('\n=== PARTE 9: calibração de cadência ===\n')

const calibCompat = await sugerirCadência(storage, 'compat', período30dias)
check(calibCompat.sugestão === 'compatível', `Frente com ritmo compatível: sugestão=compatível, veio ${calibCompat.sugestão}`)
check(calibCompat.evidência.length > 0, 'Sugestão compatível vem com evidência não-vazia')

const calibAlta = await sugerirCadência(storage, 'abaixo', período30dias)
check(
  calibAlta.sugestão === 'possivelmente_baixa',
  `Cadência declarada (5d) menor que o intervalo real (20d) — cadência está "apertada demais" → possivelmente_baixa, veio ${calibAlta.sugestão}`
)

const calibBaixa = await sugerirCadência(storage, 'acima', período30dias)
check(
  calibBaixa.sugestão === 'possivelmente_alta',
  `Cadência declarada (20d) maior que o intervalo real (2d) — cadência está "frouxa demais" → possivelmente_alta, veio ${calibBaixa.sugestão}`
)

const calibInsuf = await sugerirCadência(storage, 'sem-mov', período30dias)
check(calibInsuf.sugestão === 'evidência_insuficiente', `Sem movimentos: sugestão=evidência_insuficiente, veio ${calibInsuf.sugestão}`)
check(calibInsuf.evidência.length > 0, 'Mesmo evidência_insuficiente vem com explicação textual do motivo')

// nunca altera a cadência real
const frenteCompatAntes = (await storage.getFrente('compat'))!
await sugerirCadência(storage, 'compat', período30dias)
const frenteCompatDepois = (await storage.getFrente('compat'))!
check(
  frenteCompatAntes.cadênciaEsperada === frenteCompatDepois.cadênciaEsperada,
  'sugerirCadência NUNCA altera Frente.cadênciaEsperada — é só leitura/sugestão'
)

console.log(`\n${falhas === 0 ? '✅ Todos os testes de ritmo passaram' : `❌ ${falhas} teste(s) falharam`}`)
