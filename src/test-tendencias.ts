import { MemoryAdapter } from './storage'
import { criarFrente, criarRegistro, mudarCondição, mudarCicloVida } from './frente-ops'
import { obterTendênciaFrente, obterTendênciaDomínio } from './tendencias'
import type { Frente } from './types'
import type { Período } from './historico'

// ============================================================
// TESTE: tendências — BLOCO 6
// Rode com: npm run test:tendencias
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

const período40dias: Período = { início: base, fim: base + 40 * dia } // meio = base+20dia

console.log('=== PARTE 1: melhorando ===\n')

await novaFrente({ id: 'melhorando', nome: 'Melhorando', tipo: 'projeto' }, base)
// primeira metade [0,20): 1 movimento; segunda metade [20,40): 5 movimentos
await criarRegistro(storage, { frenteId: 'melhorando', data: base + 1 * dia, texto: 'x', contaComoMovimento: true })
for (const offset of [21, 24, 27, 30, 33]) {
  await criarRegistro(storage, { frenteId: 'melhorando', data: base + offset * dia, texto: 'x', contaComoMovimento: true })
}
let t = await obterTendênciaFrente(storage, 'melhorando', período40dias)
check(t.tendência === 'melhorando', `1 movimento na 1ª metade, 5 na 2ª: melhorando, veio ${t.tendência}`)
check(t.movimentosPrimeiraMetade === 1 && t.movimentosSegundaMetade === 5, 'contagens por metade corretas')

console.log('\n=== PARTE 2: piorando ===\n')

await novaFrente({ id: 'piorando', nome: 'Piorando', tipo: 'projeto' }, base)
for (const offset of [1, 4, 7, 10, 13]) {
  await criarRegistro(storage, { frenteId: 'piorando', data: base + offset * dia, texto: 'x', contaComoMovimento: true })
}
await criarRegistro(storage, { frenteId: 'piorando', data: base + 25 * dia, texto: 'x', contaComoMovimento: true })
t = await obterTendênciaFrente(storage, 'piorando', período40dias)
check(t.tendência === 'piorando', `5 movimentos na 1ª metade, 1 na 2ª: piorando, veio ${t.tendência}`)

console.log('\n=== PARTE 3: estável ===\n')

await novaFrente({ id: 'estavel', nome: 'Estável', tipo: 'projeto' }, base)
for (const offset of [2, 8, 15]) {
  await criarRegistro(storage, { frenteId: 'estavel', data: base + offset * dia, texto: 'x', contaComoMovimento: true })
}
for (const offset of [22, 29, 36]) {
  await criarRegistro(storage, { frenteId: 'estavel', data: base + offset * dia, texto: 'x', contaComoMovimento: true })
}
t = await obterTendênciaFrente(storage, 'estavel', período40dias)
check(t.tendência === 'estável', `3 movimentos em cada metade: estável, veio ${t.tendência}`)

console.log('\n=== PARTE 4: evidência insuficiente ===\n')

await novaFrente({ id: 'sem-dado', nome: 'Sem Dado', tipo: 'projeto' }, base)
t = await obterTendênciaFrente(storage, 'sem-dado', período40dias)
check(t.tendência === 'insuficiente_evidência', `0 movimentos: insuficiente_evidência, veio ${t.tendência}`)
check(t.confiança === 'insuficiente', 'confiança também insuficiente')

await novaFrente({ id: 'um-so', nome: 'Um Só', tipo: 'projeto' }, base)
await criarRegistro(storage, { frenteId: 'um-so', data: base + 5 * dia, texto: 'x', contaComoMovimento: true })
t = await obterTendênciaFrente(storage, 'um-so', período40dias)
check(t.tendência === 'insuficiente_evidência', `1 movimento no total: insuficiente_evidência, veio ${t.tendência}`)

console.log('\n=== PARTE 5: referência temporal fixa / determinismo ===\n')

const t1 = await obterTendênciaFrente(storage, 'melhorando', período40dias)
const t2 = await obterTendênciaFrente(storage, 'melhorando', período40dias)
check(
  JSON.stringify(t1) === JSON.stringify(t2),
  'Mesma frente, mesmo período: resultado idêntico em chamadas repetidas (determinístico)'
)

console.log('\n=== PARTE 6: empate/ambiguidade (diferença pequena = estável, não melhorando/piorando por ruído) ===\n')

await novaFrente({ id: 'quase-empate', nome: 'Quase Empate', tipo: 'projeto' }, base)
// 2 na primeira metade, 3 na segunda — diferença=1, dentro da margem de "estável"
await criarRegistro(storage, { frenteId: 'quase-empate', data: base + 2 * dia, texto: 'x', contaComoMovimento: true })
await criarRegistro(storage, { frenteId: 'quase-empate', data: base + 10 * dia, texto: 'x', contaComoMovimento: true })
await criarRegistro(storage, { frenteId: 'quase-empate', data: base + 22 * dia, texto: 'x', contaComoMovimento: true })
await criarRegistro(storage, { frenteId: 'quase-empate', data: base + 28 * dia, texto: 'x', contaComoMovimento: true })
await criarRegistro(storage, { frenteId: 'quase-empate', data: base + 35 * dia, texto: 'x', contaComoMovimento: true })
t = await obterTendênciaFrente(storage, 'quase-empate', período40dias)
check(
  t.tendência === 'estável',
  `Diferença de 1 movimento entre metades (2 vs 3) é tratada como estável, não piorando/melhorando por ruído mínimo — veio ${t.tendência}`
)

console.log('\n=== PARTE 7: tendência de domínio — descendentes em estados diferentes ===\n')

await novaFrente({ id: 'dom-misto', nome: 'Domínio Misto', tipo: 'domínio', cadênciaEsperada: null }, base)
await novaFrente({ id: 'dom-misto-melhora', nome: 'Melhora', tipo: 'projeto', parentId: 'dom-misto' }, base)
await criarRegistro(storage, { frenteId: 'dom-misto-melhora', data: base + 1 * dia, texto: 'x', contaComoMovimento: true })
for (const offset of [21, 24, 27, 30]) {
  await criarRegistro(storage, { frenteId: 'dom-misto-melhora', data: base + offset * dia, texto: 'x', contaComoMovimento: true })
}
await novaFrente({ id: 'dom-misto-piora', nome: 'Piora', tipo: 'projeto', parentId: 'dom-misto' }, base)
for (const offset of [1, 4, 7, 10]) {
  await criarRegistro(storage, { frenteId: 'dom-misto-piora', data: base + offset * dia, texto: 'x', contaComoMovimento: true })
}
await criarRegistro(storage, { frenteId: 'dom-misto-piora', data: base + 25 * dia, texto: 'x', contaComoMovimento: true })
await novaFrente({ id: 'dom-misto-parado', nome: 'Parado', tipo: 'projeto', parentId: 'dom-misto' }, base)

const tendDomMisto = await obterTendênciaDomínio(storage, 'dom-misto', período40dias)
check(
  tendDomMisto.descendentesMelhorando.some((d) => d.frenteId === 'dom-misto-melhora'),
  'Domínio misto: "Melhora" aparece em descendentesMelhorando'
)
check(
  tendDomMisto.descendentesPiorando.some((d) => d.frenteId === 'dom-misto-piora'),
  'Domínio misto: "Piora" aparece em descendentesPiorando'
)
check(
  tendDomMisto.descendentesSemEvidência.some((d) => d.frenteId === 'dom-misto-parado'),
  'Domínio misto: "Parado" (0 movimentos) aparece em descendentesSemEvidência'
)
check(
  !tendDomMisto.descendentesMelhorando.some((d) => d.frenteId === 'dom-misto-piora') &&
    !tendDomMisto.descendentesPiorando.some((d) => d.frenteId === 'dom-misto-melhora'),
  'Nenhum descendente aparece em categoria errada'
)

console.log('\n=== PARTE 8: domínio não reduz ao pior filho (preserva panorama completo) ===\n')

check(
  tendDomMisto.descendentesMelhorando.length + tendDomMisto.descendentesPiorando.length + tendDomMisto.descendentesSemEvidência.length === 3,
  'Todos os 3 descendentes aparecem em alguma categoria — nenhum "resumido" ou descartado'
)

console.log('\n=== PARTE 9: mudanças estruturais no domínio ===\n')

await mudarCondição(storage, 'dom-misto-piora', 'bloqueada', base + 15 * dia)
await mudarCicloVida(storage, 'dom-misto-parado', 'concluída', base + 18 * dia)

const tendComMudanças = await obterTendênciaDomínio(storage, 'dom-misto', período40dias)
check(
  tendComMudanças.mudançasEstruturais.some((m) => m.frenteId === 'dom-misto-piora' && m.tipo === 'condição_mudou'),
  'Mudança de condição de um descendente aparece em mudançasEstruturais'
)
check(
  tendComMudanças.mudançasEstruturais.some((m) => m.frenteId === 'dom-misto-parado' && m.tipo === 'ciclo_vida_mudou'),
  'Mudança de ciclo de vida de um descendente aparece em mudançasEstruturais'
)
check(
  !tendComMudanças.mudançasEstruturais.some((m) => m.tipo === 'criação'),
  'Eventos de criação NÃO aparecem em mudançasEstruturais (só mudanças, não o nascimento)'
)

console.log('\n=== PARTE 10: domínio sem filhos / domínio sem cadência ===\n')

await novaFrente({ id: 'dom-vazio', nome: 'Domínio Vazio', tipo: 'domínio', cadênciaEsperada: null }, base)
const tendVazio = await obterTendênciaDomínio(storage, 'dom-vazio', período40dias)
check(
  tendVazio.descendentesMelhorando.length === 0 &&
    tendVazio.descendentesEstáveis.length === 0 &&
    tendVazio.descendentesPiorando.length === 0 &&
    tendVazio.descendentesSemEvidência.length === 0,
  'Domínio sem filhos: todas as categorias vazias, sem erro'
)

// domínio NUNCA é tratado como se tivesse ritmo próprio, mesmo que
// alguém tente (hipoteticamente) dar cadência a ele — obterTendênciaDomínio
// nem chama obterTendênciaFrente para o próprio domínio, só para os filhos
check(
  !tendDomMisto.descendentesMelhorando.some((d) => d.frenteId === 'dom-misto') &&
    !tendDomMisto.descendentesPiorando.some((d) => d.frenteId === 'dom-misto') &&
    !tendDomMisto.descendentesEstáveis.some((d) => d.frenteId === 'dom-misto') &&
    !tendDomMisto.descendentesSemEvidência.some((d) => d.frenteId === 'dom-misto'),
  'O próprio domínio NUNCA aparece como item com tendência individual — só seus filhos'
)

console.log(`\n${falhas === 0 ? '✅ Todos os testes de tendências passaram' : `❌ ${falhas} teste(s) falharam`}`)
