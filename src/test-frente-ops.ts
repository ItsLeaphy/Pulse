import { MemoryAdapter } from './storage'
import {
  excluirFrenteComFilhos,
  criarFrente,
  criarRegistro,
  editarRegistro,
  excluirRegistro,
  mudarCicloVida,
  mudarCondição
} from './frente-ops'
import type { Frente } from './types'

// ============================================================
// TESTE: operações de Registro (cache de últimoMovimento) +
// cascata de exclusão + geração/deduplicação de eventos.
// Rode com: npm run test:ops
// ============================================================

const agora = Date.now()
const dia = 1000 * 60 * 60 * 24
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

async function novaFrenteViaOp(id: string, nome: string, parentId: string | null): Promise<Frente> {
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
    criadaEm: agora
  })
}

console.log('=== PARTE 1: cache de últimoMovimento (fonte de verdade = Registro) ===\n')

await novaFrenteViaOp('p1', 'Projeto 1', null)

let f = (await storage.getFrente('p1'))!
check(f.últimoMovimento === null, 'Frente recém-criada: últimoMovimento=null (sem registros ainda)')

// registro 1: movimento, 3 dias atrás
const r1 = await criarRegistro(storage, {
  frenteId: 'p1',
  data: agora - 3 * dia,
  texto: 'primeiro movimento',
  contaComoMovimento: true
})
f = (await storage.getFrente('p1'))!
check(f.últimoMovimento === agora - 3 * dia, 'Após criar registro de movimento, últimoMovimento = data do registro')

// registro 2: movimento, hoje (mais recente)
const r2 = await criarRegistro(storage, {
  frenteId: 'p1',
  data: agora,
  texto: 'segundo movimento, mais recente',
  contaComoMovimento: true
})
f = (await storage.getFrente('p1'))!
check(f.últimoMovimento === agora, 'Novo registro mais recente atualiza últimoMovimento')

// --- cenário: excluir o registro que É o último movimento ---
await excluirRegistro(storage, r2.id)
f = (await storage.getFrente('p1'))!
check(
  f.últimoMovimento === agora - 3 * dia,
  'Excluir o registro do ÚLTIMO movimento recalcula para o próximo mais recente (r1), não fica com valor obsoleto'
)

// --- cenário: editar um registro para não contar mais como movimento ---
const r3 = await criarRegistro(storage, {
  frenteId: 'p1',
  data: agora - 1 * dia,
  texto: 'terceiro, vira o mais recente',
  contaComoMovimento: true
})
f = (await storage.getFrente('p1'))!
check(f.últimoMovimento === agora - 1 * dia, 'r3 (mais recente) é o novo últimoMovimento')

await editarRegistro(storage, r3.id, { contaComoMovimento: false })
f = (await storage.getFrente('p1'))!
check(
  f.últimoMovimento === agora - 3 * dia,
  'Editar o registro mais recente para contaComoMovimento=false volta últimoMovimento para r1 (3 dias atrás), não mantém o valor de r3'
)

// --- cenário: editar registro ANTIGO (não-movimento) para virar o movimento mais recente ---
const r4 = await criarRegistro(storage, {
  frenteId: 'p1',
  data: agora - 10 * dia,
  texto: 'registro antigo, só observação',
  contaComoMovimento: false
})
f = (await storage.getFrente('p1'))!
check(f.últimoMovimento === agora - 3 * dia, 'r4 não conta como movimento: últimoMovimento continua em r1')

await editarRegistro(storage, r4.id, { data: agora + 1 * dia, contaComoMovimento: true })
f = (await storage.getFrente('p1'))!
check(
  f.últimoMovimento === agora + 1 * dia,
  'Editar registro antigo (data + contaComoMovimento) pode fazê-lo virar o mais recente — recálculo pega isso'
)

// --- cenário: excluir registro que NÃO é o último movimento ---
f = (await storage.getFrente('p1'))!
const movimentoAntesDeExcluirNãoÚltimo = f.últimoMovimento
await excluirRegistro(storage, r1.id) // r1 não é o mais recente (r4 editado é)
f = (await storage.getFrente('p1'))!
check(
  f.últimoMovimento === movimentoAntesDeExcluirNãoÚltimo,
  'Excluir um registro que NÃO é o último movimento não muda últimoMovimento'
)

// --- cenário: excluir todos os registros de movimento → últimoMovimento volta a null ---
await excluirRegistro(storage, r4.id)
f = (await storage.getFrente('p1'))!
check(
  f.últimoMovimento === null,
  'Excluir o único registro de movimento restante volta últimoMovimento para null (não fica com lixo)'
)

console.log('\n=== PARTE 2: eventos estruturais — geração e deduplicação ===\n')

await novaFrenteViaOp('p2', 'Projeto 2', null)
const eventosP2Inicial = await storage.getEventosEstruturais('p2')
check(
  eventosP2Inicial.length === 1 && eventosP2Inicial[0]?.tipo === 'criação',
  'criarFrente gerou exatamente 1 evento de criação'
)

await mudarCondição(storage, 'p2', 'bloqueada')
await mudarCondição(storage, 'p2', 'bloqueada') // repetir com o MESMO valor
const eventosP2Depois = await storage.getEventosEstruturais('p2')
check(
  eventosP2Depois.filter((e) => e.tipo === 'condição_mudou').length === 1,
  'Chamar mudarCondição duas vezes com o mesmo valor gera só 1 evento (sem duplicar)'
)

console.log('\n=== PARTE 3: invariantes de ciclo de vida / condição ===\n')

await mudarCicloVida(storage, 'p2', 'concluída')
f = (await storage.getFrente('p2'))!
check(
  f.cicloVida === 'concluída' && f.condição === 'normal',
  'Concluir uma frente bloqueada força condição=normal'
)

let erroAoMudarCondiçãoDeFrenteConcluída = false
try {
  await mudarCondição(storage, 'p2', 'bloqueada')
} catch {
  erroAoMudarCondiçãoDeFrenteConcluída = true
}
check(
  erroAoMudarCondiçãoDeFrenteConcluída,
  'mudarCondição em frente não-ativa (concluída) lança erro em vez de aplicar silenciosamente'
)

await mudarCicloVida(storage, 'p2', 'ativa')
f = (await storage.getFrente('p2'))!
check(
  f.cicloVida === 'ativa' && f.condição === 'normal',
  'Reativar p2 (concluída → ativa) resulta em ativa+normal'
)

console.log('\n=== PARTE 4: exclusão em cascata (frentes + registros + eventos) ===\n')

await novaFrenteViaOp('raiz', 'Raiz', null)
await novaFrenteViaOp('filho', 'Filho', 'raiz')
await criarRegistro(storage, { frenteId: 'raiz', data: agora, texto: 'reg raiz', contaComoMovimento: true })
await criarRegistro(storage, { frenteId: 'filho', data: agora, texto: 'reg filho', contaComoMovimento: true })

await excluirFrenteComFilhos('raiz', storage)

const frentesRestantes = (await storage.getFrentes()).filter((x) => x.id === 'raiz' || x.id === 'filho')
check(frentesRestantes.length === 0, 'Raiz e Filho foram removidos')
check((await storage.getEventosEstruturais('raiz')).length === 0, 'Eventos da Raiz foram removidos')
check((await storage.getEventosEstruturais('filho')).length === 0, 'Eventos do Filho foram removidos')
check((await storage.getRegistros('raiz')).length === 0, 'Registros da Raiz foram removidos')
check((await storage.getRegistros('filho')).length === 0, 'Registros do Filho foram removidos')

console.log(`\n${falhas === 0 ? '✅ Todos os testes de operações passaram' : `❌ ${falhas} teste(s) falharam`}`)
