import { MemoryAdapter } from './storage'
import { criarFrente, criarRegistro, mudarCondição, mudarCicloVida, mudarCadência } from './frente-ops'
import { moverFrente } from './hierarquia'
import { compararPeríodos } from './periodos'
import type { Frente } from './types'
import type { Período } from './historico'

// ============================================================
// TESTE: comparação de períodos — BLOCO 6
// Rode com: npm run test:periodos
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

const períodoAnterior: Período = { início: base, fim: base + 10 * dia }
const períodoAtual: Período = { início: base + 10 * dia, fim: base + 20 * dia }

console.log('=== PARTE 1: períodos vazios ===\n')

await novaFrente({ id: 'vazia', nome: 'Vazia', tipo: 'projeto' }, base)
let comp = await compararPeríodos(storage, 'vazia', períodoAtual, períodoAnterior)
check(comp.quantidadeMovimentos.atual === 0 && comp.quantidadeMovimentos.anterior === 0, 'Dois períodos vazios: 0 movimentos em ambos')
check(comp.quantidadeMovimentos.diferença === 0, 'diferença=0 quando ambos são 0')
check(
  comp.frentesSemMovimentoEmNenhum.includes('vazia'),
  'Frente sem movimento em nenhum período aparece em frentesSemMovimentoEmNenhum'
)

console.log('\n=== PARTE 2: períodos com movimentos, frentes diferentes ===\n')

await novaFrente({ id: 'f1', nome: 'F1', tipo: 'projeto' }, base)
await novaFrente({ id: 'f2', nome: 'F2', tipo: 'projeto' }, base)
await novaFrente({ id: 'f3', nome: 'F3', tipo: 'projeto' }, base)

// f1: movimento só no período ANTERIOR ("parou")
await criarRegistro(storage, { frenteId: 'f1', data: base + 2 * dia, texto: 'x', contaComoMovimento: true })
// f2: movimento só no período ATUAL ("voltou a se mexer")
await criarRegistro(storage, { frenteId: 'f2', data: base + 15 * dia, texto: 'x', contaComoMovimento: true })
// f3: movimento em AMBOS os períodos
await criarRegistro(storage, { frenteId: 'f3', data: base + 3 * dia, texto: 'x', contaComoMovimento: true })
await criarRegistro(storage, { frenteId: 'f3', data: base + 17 * dia, texto: 'x', contaComoMovimento: true })

// escopo: domínio contendo f1, f2, f3
await novaFrente({ id: 'dom', nome: 'Domínio', tipo: 'domínio', cadênciaEsperada: null }, base)
await moverFrente(storage, 'f1', 'dom', base + 1 * dia)
await moverFrente(storage, 'f2', 'dom', base + 1 * dia)
await moverFrente(storage, 'f3', 'dom', base + 1 * dia)

comp = await compararPeríodos(storage, 'dom', períodoAtual, períodoAnterior)
check(comp.frentesComMovimentoApenasNoAnterior.includes('f1'), 'f1 (só no anterior) aparece em frentesComMovimentoApenasNoAnterior')
check(comp.frentesComMovimentoApenasNoAtual.includes('f2'), 'f2 (só no atual) aparece em frentesComMovimentoApenasNoAtual')
check(comp.frentesComMovimentoEmAmbos.includes('f3'), 'f3 (ambos) aparece em frentesComMovimentoEmAmbos')
check(
  comp.quantidadeMovimentos.atual === 2 && comp.quantidadeMovimentos.anterior === 2,
  `2 movimentos em cada período (f2+f3 no atual, f1+f3 no anterior), veio atual=${comp.quantidadeMovimentos.atual} anterior=${comp.quantidadeMovimentos.anterior}`
)

console.log('\n=== PARTE 3: mudanças de condição, ciclo de vida, hierarquia, cadência ===\n')

await mudarCondição(storage, 'f1', 'bloqueada', base + 12 * dia) // no período ATUAL
await mudarCicloVida(storage, 'f2', 'concluída', base + 4 * dia) // no período ANTERIOR
await mudarCadência(storage, 'f3', 14, base + 13 * dia) // no período ATUAL

const f4 = await novaFrente({ id: 'f4', nome: 'F4', tipo: 'projeto' }, base)
void f4
await moverFrente(storage, 'f4', 'dom', base + 5 * dia) // hierarquia_mudou no período ANTERIOR

comp = await compararPeríodos(storage, 'dom', períodoAtual, períodoAnterior)
check(comp.mudançasCondição.atual === 1 && comp.mudançasCondição.anterior === 0, `mudançasCondição: atual=1 anterior=0, veio atual=${comp.mudançasCondição.atual} anterior=${comp.mudançasCondição.anterior}`)
check(comp.mudançasCicloVida.atual === 0 && comp.mudançasCicloVida.anterior === 1, `mudançasCicloVida: atual=0 anterior=1, veio atual=${comp.mudançasCicloVida.atual} anterior=${comp.mudançasCicloVida.anterior}`)
check(comp.mudançasCadência.atual === 1 && comp.mudançasCadência.anterior === 0, `mudançasCadência: atual=1 anterior=0, veio atual=${comp.mudançasCadência.atual} anterior=${comp.mudançasCadência.anterior}`)
// f1, f2, f3 TAMBÉM foram movidas pro domínio em base+1dia (ver "PARTE 2"
// acima), que também cai dentro do período anterior [base, base+10dia) —
// então o total esperado é 4 (f1+f2+f3+f4), não só f4
check(
  comp.mudançasHierarquia.anterior === 4 && comp.mudançasHierarquia.atual === 0,
  `mudançasHierarquia: anterior=4 (f1,f2,f3,f4 movidas pro domínio em base+1dia, dentro do período anterior), atual=0, veio anterior=${comp.mudançasHierarquia.anterior} atual=${comp.mudançasHierarquia.atual}`
)

console.log('\n=== PARTE 4: determinismo ===\n')

const comp1 = await compararPeríodos(storage, 'dom', períodoAtual, períodoAnterior)
const comp2 = await compararPeríodos(storage, 'dom', períodoAtual, períodoAnterior)
check(
  JSON.stringify(comp1.quantidadeMovimentos) === JSON.stringify(comp2.quantidadeMovimentos) &&
    JSON.stringify(comp1.frentesComMovimentoEmAmbos) === JSON.stringify(comp2.frentesComMovimentoEmAmbos),
  'Chamadas repetidas com os mesmos dados/períodos produzem o mesmo resultado'
)

console.log(`\n${falhas === 0 ? '✅ Todos os testes de comparação de períodos passaram' : `❌ ${falhas} teste(s) falharam`}`)
