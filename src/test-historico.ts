import { MemoryAdapter } from './storage'
import { criarFrente, criarRegistro, editarRegistro, mudarCicloVida, mudarCondição, mudarCadência } from './frente-ops'
import { obterHistórico, obterRetrospectiva, formatarRetrospectiva, type Período } from './historico'

// ============================================================
// TESTE: histórico unificado + retrospectiva — BLOCO 2
// Rode com: npm run test:historico
// ============================================================

const dia = 1000 * 60 * 60 * 24
// base fixa (não Date.now()) para o teste ser 100% determinístico
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

async function novaFrente(id: string, nome: string, parentId: string | null, criadaEm: number) {
  return criarFrente(storage, {
    id,
    nome,
    área: 'work',
    tipo: parentId ? 'projeto' : 'domínio',
    parentId,
    cicloVida: 'ativa',
    condição: 'normal',
    cadênciaEsperada: 7,
    contextoFoco: null,
    contextoBloqueio: null,
    pausaMotivo: null,
    pausaRetomadaEm: null,
    criadaEm
  })
}

console.log('=== PARTE 1: histórico unificado (Registro + EventoEstrutural) ===\n')

await novaFrente('darkline', 'Darkline', null, base)
await novaFrente('origens', 'Origens', 'darkline', base + 1 * dia)

await criarRegistro(storage, { frenteId: 'origens', data: base + 2 * dia, texto: 'corrigi login', contaComoMovimento: true })
await mudarCondição(storage, 'origens', 'bloqueada', base + 3 * dia)
await criarRegistro(storage, { frenteId: 'origens', data: base + 4 * dia, texto: 'nota sem movimento', contaComoMovimento: false })

const histOrigens = await obterHistórico(storage, 'origens')
check(histOrigens.length === 4, `Histórico de Origens tem 4 itens (2 registros + criação + condição_mudou), veio ${histOrigens.length}`)
check(histOrigens.some((i) => i.tipo === 'registro'), 'Histórico contém itens tipo registro')
check(histOrigens.some((i) => i.tipo === 'evento_estrutural'), 'Histórico contém itens tipo evento_estrutural')

// ordenação cronológica (mais recente primeiro)
const datasDesc = histOrigens.map((i) => i.data)
const ordenadoCorretamente = datasDesc.every((d, idx) => idx === 0 || d <= (datasDesc[idx - 1] ?? d))
check(ordenadoCorretamente, 'Histórico está ordenado cronologicamente (mais recente primeiro)')

// histórico de frente sem descendentes (Origens não tem filhos) — já testado acima implicitamente,
// mas testa explicitamente que incluirDescendentes=true não muda nada quando não há filhos
const histOrigensComDescendentes = await obterHistórico(storage, 'origens', { incluirDescendentes: true })
check(
  histOrigensComDescendentes.length === histOrigens.length,
  'Frente sem descendentes: incluirDescendentes=true não adiciona nada a mais'
)

// histórico de domínio incluindo descendentes
const histDarklineSemDescendentes = await obterHistórico(storage, 'darkline')
const histDarklineComDescendentes = await obterHistórico(storage, 'darkline', { incluirDescendentes: true })
check(
  histDarklineSemDescendentes.length === 1, // só o evento de criação da própria Darkline
  'Histórico de Darkline SEM descendentes tem só o próprio evento de criação'
)
check(
  histDarklineComDescendentes.length === 1 + histOrigens.length,
  'Histórico de Darkline COM descendentes inclui o histórico de Origens (filha)'
)

console.log('\n=== PARTE 2: domínio com descendentes em múltiplos níveis ===\n')

await novaFrente('darkline-dev', 'Darkline Dev', 'darkline', base)
await novaFrente('sub-projeto', 'Sub Projeto', 'darkline-dev', base)
await criarRegistro(storage, { frenteId: 'sub-projeto', data: base + 5 * dia, texto: 'trabalho em sub-projeto', contaComoMovimento: true })

const histDarklineProfundo = await obterHistórico(storage, 'darkline', { incluirDescendentes: true })
check(
  histDarklineProfundo.some((i) => i.tipo === 'registro' && i.registro.frenteId === 'sub-projeto'),
  'Histórico de Darkline (com descendentes) alcança neto (darkline-dev > sub-projeto), não só filho direto'
)

console.log('\n=== PARTE 3: retrospectiva — período, classificação, determinismo ===\n')

// limpa estado e monta cenário controlado pra retrospectiva
const storage2 = new MemoryAdapter()
await criarFrente(storage2, {
  id: 'proj-a', nome: 'Projeto A', área: 'work', tipo: 'projeto', parentId: null,
  cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: 7,
  contextoFoco: null, contextoBloqueio: null, pausaMotivo: null, pausaRetomadaEm: null,
  criadaEm: base
})

const período: Período = { início: base + 1 * dia, fim: base + 8 * dia } // [dia1, dia8)

// eventos DENTRO do período
await criarRegistro(storage2, { frenteId: 'proj-a', data: base + 2 * dia, texto: 'movimento dentro', contaComoMovimento: true })
await mudarCondição(storage2, 'proj-a', 'bloqueada', base + 3 * dia)
await mudarCadência(storage2, 'proj-a', 14, base + 4 * dia)
await mudarCondição(storage2, 'proj-a', 'normal', base + 5 * dia)
await mudarCicloVida(storage2, 'proj-a', 'concluída', base + 6 * dia)

// eventos FORA do período (antes do início e no/depois do fim exato)
await criarFrente(storage2, {
  id: 'proj-b', nome: 'Projeto B', área: 'work', tipo: 'projeto', parentId: null,
  cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: 7,
  contextoFoco: null, contextoBloqueio: null, pausaMotivo: null, pausaRetomadaEm: null,
  criadaEm: base // ANTES do início do período (base+1dia)
})
await criarRegistro(storage2, { frenteId: 'proj-b', data: período.fim, texto: 'exatamente no limite final — deve ficar FORA', contaComoMovimento: true })
await criarRegistro(storage2, { frenteId: 'proj-b', data: base, texto: 'antes do período — deve ficar FORA', contaComoMovimento: true })

const retro = await obterRetrospectiva(storage2, 'proj-a', período)

check(retro.movimentos.length === 1, `Retrospectiva de proj-a tem 1 movimento dentro do período, veio ${retro.movimentos.length}`)
check(retro.mudançasCondição.length === 2, `2 mudanças de condição (bloqueada, depois normal), veio ${retro.mudançasCondição.length}`)
check(retro.mudançasCadência.length === 1, `1 mudança de cadência, veio ${retro.mudançasCadência.length}`)
check(retro.mudançasCicloVida.length === 1, `1 mudança de ciclo de vida, veio ${retro.mudançasCicloVida.length}`)
check(retro.frentesConcluídas.length === 1, 'proj-a aparece em frentesConcluídas (ciclo_vida_mudou → concluída)')
check(retro.frentesArquivadas.length === 0, 'Nenhuma frente arquivada neste cenário')
check(
  retro.frentesCriadas.length === 0,
  'Evento de criação de proj-a (em `base`, antes do período) NÃO aparece — está fora do escopo [início,fim)'
)

console.log('\n=== PARTE 4: limites temporais — semiaberto [início, fim) ===\n')

const retroB = await obterRetrospectiva(storage2, 'proj-b', período)
check(
  retroB.movimentos.length === 0,
  'Registro exatamente em `fim` (período.fim) fica DE FORA — limite final excluído'
)

const retroBAntes = await obterRetrospectiva(storage2, 'proj-b', { início: base, fim: base + 1 * dia })
check(
  retroBAntes.movimentos.length === 1,
  'Registro exatamente em `início` fica DENTRO — limite inicial incluído'
)

// períodos consecutivos não duplicam nem perdem o item na borda —
// cenário isolado, com UM único registro exatamente na fronteira
const storageFronteira = new MemoryAdapter()
await criarFrente(storageFronteira, {
  id: 'proj-fronteira', nome: 'Projeto Fronteira', área: 'work', tipo: 'projeto', parentId: null,
  cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: 7,
  contextoFoco: null, contextoBloqueio: null, pausaMotivo: null, pausaRetomadaEm: null,
  criadaEm: base
})
await criarRegistro(storageFronteira, { frenteId: 'proj-fronteira', data: período.fim, texto: 'exatamente na fronteira', contaComoMovimento: true })

const períodoA: Período = { início: base, fim: período.fim }
const períodoB: Período = { início: período.fim, fim: período.fim + 10 * dia }
const retroPA = await obterRetrospectiva(storageFronteira, 'proj-fronteira', períodoA)
const retroPB = await obterRetrospectiva(storageFronteira, 'proj-fronteira', períodoB)
check(
  retroPA.movimentos.length === 0 && retroPB.movimentos.length === 1,
  `Períodos consecutivos [base,fim) e [fim,fim+10d): registro exatamente em \`fim\` cai só no segundo período, sem duplicar nem sumir — período A teve ${retroPA.movimentos.length}, período B teve ${retroPB.movimentos.length}`
)

console.log('\n=== PARTE 5: retrospectiva vazia ===\n')

const retroVazia = await obterRetrospectiva(storage2, 'proj-a', { início: base - 100 * dia, fim: base - 50 * dia })
check(
  retroVazia.movimentos.length === 0 &&
    retroVazia.mudançasCicloVida.length === 0 &&
    retroVazia.mudançasCondição.length === 0 &&
    retroVazia.mudançasCadência.length === 0 &&
    retroVazia.frentesCriadas.length === 0,
  'Período sem nenhum dado produz retrospectiva com todas as seções vazias, sem erro'
)

console.log('\n=== PARTE 6: determinismo ===\n')

const retroDeNovo = await obterRetrospectiva(storage2, 'proj-a', período)
const igual =
  JSON.stringify(retro.movimentos.map((m) => m.registro.id)) ===
    JSON.stringify(retroDeNovo.movimentos.map((m) => m.registro.id)) &&
  JSON.stringify(retro.mudançasCondição.map((m) => m.evento.id)) ===
    JSON.stringify(retroDeNovo.mudançasCondição.map((m) => m.evento.id))
check(igual, 'Chamar obterRetrospectiva duas vezes com os mesmos dados produz o mesmo resultado (determinístico)')

console.log('\n=== PARTE 7: apresentação textual — sem seções vazias, sem heurística ===\n')

const texto = await formatarRetrospectiva(storage2, retro)
check(texto.includes('## Movimentos'), 'Texto inclui seção Movimentos (tem dado)')
check(texto.includes('## Mudanças'), 'Texto inclui seção Mudanças (tem dado)')
check(texto.includes('## Novas frentes') === false, 'Texto NÃO inclui seção "Novas frentes" (sem dado nesse período para proj-a)')
check(texto.includes('## Concluídas'), 'Texto inclui seção Concluídas (proj-a foi concluída no período)')
check(texto.includes('## Arquivadas') === false, 'Texto NÃO inclui seção "Arquivadas" (sem dado)')
check(
  !/decis[ãa]o|problema/i.test(texto),
  'Texto não contém nenhuma categoria heurística tipo "decisão"/"problema" — só o que os dados estruturados afirmam'
)

const textoVazio = await formatarRetrospectiva(storage2, retroVazia)
check(
  textoVazio.includes('Nenhuma atividade registrada'),
  'Retrospectiva vazia produz texto claro de "nenhuma atividade", não uma lista de seções vazias'
)

console.log('\n=== PARTE 8: registro retroativo altera últimoMovimento corretamente ===\n')

const storage3 = new MemoryAdapter()
await criarFrente(storage3, {
  id: 'retro-teste', nome: 'Retro Teste', área: 'work', tipo: 'projeto', parentId: null,
  cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: 7,
  contextoFoco: null, contextoBloqueio: null, pausaMotivo: null, pausaRetomadaEm: null,
  criadaEm: base
})
const rAtual = await criarRegistro(storage3, { frenteId: 'retro-teste', data: base + 10 * dia, texto: 'movimento atual', contaComoMovimento: true })
let fr = (await storage3.getFrente('retro-teste'))!
check(fr.últimoMovimento === base + 10 * dia, 'últimoMovimento = registro mais recente antes do retroativo')

// registro retroativo com data ANTERIOR ao mais recente — não deve mudar últimoMovimento
await criarRegistro(storage3, { frenteId: 'retro-teste', data: base + 2 * dia, texto: 'esqueci de registrar isso', contaComoMovimento: true, criadoEm: base + 10 * dia })
fr = (await storage3.getFrente('retro-teste'))!
check(
  fr.últimoMovimento === base + 10 * dia,
  'Registro retroativo com data ANTERIOR ao movimento mais recente NÃO muda últimoMovimento'
)

// registro retroativo com data POSTERIOR ao mais recente — deve recalcular e virar o novo último
await criarRegistro(storage3, { frenteId: 'retro-teste', data: base + 15 * dia, texto: 'retroativo mas na verdade é o mais recente', contaComoMovimento: true, criadoEm: base + 20 * dia })
fr = (await storage3.getFrente('retro-teste'))!
check(
  fr.últimoMovimento === base + 15 * dia,
  'Registro retroativo cuja `data` é a maior entre todos os registros de movimento VIRA o novo últimoMovimento (recálculo correto, não um simples "últimoMovimento = data do registro recém-criado")'
)

// editar o registro mais antigo pra uma data ainda mais recente também recalcula certo
await editarRegistro(storage3, rAtual.id, { data: base + 30 * dia })
fr = (await storage3.getFrente('retro-teste'))!
check(
  fr.últimoMovimento === base + 30 * dia,
  'Editar a `data` de um registro antigo para o futuro recalcula últimoMovimento corretamente'
)

console.log(`\n${falhas === 0 ? '✅ Todos os testes de histórico/retrospectiva passaram' : `❌ ${falhas} teste(s) falharam`}`)
