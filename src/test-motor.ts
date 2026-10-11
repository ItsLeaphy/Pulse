import { MemoryAdapter } from './storage'
import { calcularSinalAgregado, movementExpected } from './signal'
import { criarFrente, mudarCicloVida, mudarCondição } from './frente-ops'
import type { Frente } from './types'

// ============================================================
// TESTE MANUAL DO MOTOR — Bloco 1
// Cobre especificamente: Sinal|null, remoção de 'hibernando',
// concluída/arquivada → null, domínio vazio → null, condição≠normal
// → null, e reativação de concluída → ativa+normal.
// Rode com: npm run test:motor
// ============================================================

const agora = Date.now()
const dia = 1000 * 60 * 60 * 24
const storage = new MemoryAdapter()

function novaFrente(
  parcial: Partial<Frente> & Pick<Frente, 'id' | 'nome' | 'área' | 'tipo'>
): Frente {
  const f: Frente = {
    parentId: null,
    cicloVida: 'ativa',
    condição: 'normal',
    cadênciaEsperada: 7,
    últimoMovimento: agora,
    contextoFoco: null,
    contextoBloqueio: null,
    pausaMotivo: null,
    pausaRetomadaEm: null,
    criadaEm: agora - 90 * dia,
    ...parcial
  }
  storage.salvarFrente(f)
  return f
}

let falhas = 0
function check(condição: boolean, mensagem: string): void {
  if (condição) {
    console.log(`✅ ${mensagem}`)
  } else {
    console.log(`❌ ${mensagem}`)
    falhas++
  }
}

// --- árvore base: Darkline > Darkline Dev > Origens (saudável) + Projeto Fantasma (esquecido) ---
novaFrente({ id: 'darkline', nome: 'Darkline', área: 'work', tipo: 'domínio', cadênciaEsperada: null })
novaFrente({
  id: 'darkline-dev',
  nome: 'Darkline Dev',
  área: 'work',
  tipo: 'domínio',
  parentId: 'darkline',
  cadênciaEsperada: null
})
novaFrente({
  id: 'origens',
  nome: 'Origens',
  área: 'work',
  tipo: 'projeto',
  parentId: 'darkline-dev',
  cadênciaEsperada: 5,
  últimoMovimento: agora - 1 * dia
})
novaFrente({
  id: 'projeto-fantasma',
  nome: 'Projeto Fantasma',
  área: 'work',
  tipo: 'projeto',
  parentId: 'darkline-dev',
  cadênciaEsperada: 7,
  últimoMovimento: agora - 40 * dia
})

// --- domínio-folha vazio (sem filhos) ---
novaFrente({ id: 'escola', nome: 'Escola', área: 'work', tipo: 'domínio', cadênciaEsperada: null })

// --- condição ≠ normal: não deve ter sinal, não "hibernando" ---
novaFrente({
  id: 'financas',
  nome: 'Finanças',
  área: 'life',
  tipo: 'projeto',
  cadênciaEsperada: 30,
  condição: 'pausada',
  últimoMovimento: agora - 50 * dia
})
novaFrente({
  id: 'proposta-x',
  nome: 'Proposta X',
  área: 'work',
  tipo: 'projeto',
  cadênciaEsperada: 10,
  condição: 'aguardando',
  últimoMovimento: agora - 25 * dia
})
novaFrente({
  id: 'bloqueado-y',
  nome: 'Bloqueado Y',
  área: 'work',
  tipo: 'projeto',
  cadênciaEsperada: 10,
  condição: 'bloqueada',
  últimoMovimento: agora - 25 * dia
})

// --- ciclo de vida concluída/arquivada: sinal deve ser null, nunca calculado ---
novaFrente({
  id: 'concluido-z',
  nome: 'Concluído Z',
  área: 'work',
  tipo: 'projeto',
  cicloVida: 'concluída',
  cadênciaEsperada: 5,
  últimoMovimento: agora - 200 * dia
})
novaFrente({
  id: 'arquivado-w',
  nome: 'Arquivado W',
  área: 'work',
  tipo: 'projeto',
  cicloVida: 'arquivada',
  cadênciaEsperada: 5,
  últimoMovimento: agora - 200 * dia
})

console.log('--- Sinais individuais/agregados ---\n')
for (const id of [
  'darkline',
  'darkline-dev',
  'origens',
  'projeto-fantasma',
  'escola',
  'financas',
  'proposta-x',
  'bloqueado-y',
  'concluido-z',
  'arquivado-w'
]) {
  const frente = (await storage.getFrente(id))!
  const sinal = await calcularSinalAgregado(id, storage)
  console.log(`${frente.nome.padEnd(20)} → ${sinal === null ? 'null (sem sinal)' : sinal}`)
}

console.log('\n--- Verificações: rollup, domínio vazio, condição≠normal, ciclo de vida ---\n')

check((await calcularSinalAgregado('origens', storage)) === 'no_ritmo', 'Origens (movimento recente) está no_ritmo')
check(
  (await calcularSinalAgregado('projeto-fantasma', storage)) === 'fora_do_ritmo',
  'Projeto Fantasma (40 dias parado) está fora_do_ritmo'
)
check(
  (await calcularSinalAgregado('darkline-dev', storage)) === 'fora_do_ritmo',
  'Darkline Dev herdou o PIOR sinal (do Projeto Fantasma), não a média, não null'
)
check(
  (await calcularSinalAgregado('darkline', storage)) === 'fora_do_ritmo',
  'O alerta subiu a árvore até Darkline (raiz)'
)
check(
  (await calcularSinalAgregado('escola', storage)) === null,
  'Domínio sem filhos (Escola) → null, NÃO "no_ritmo"'
)
check(
  (await calcularSinalAgregado('financas', storage)) === null,
  'Condição=pausada (Finanças, 50 dias parado) → null, NÃO "hibernando"'
)
check(
  (await calcularSinalAgregado('proposta-x', storage)) === null,
  'Condição=aguardando (Proposta X) → null, NÃO "hibernando"'
)
check(
  (await calcularSinalAgregado('bloqueado-y', storage)) === null,
  'Condição=bloqueada (Bloqueado Y) → null, NÃO "hibernando"'
)
check(
  (await calcularSinalAgregado('concluido-z', storage)) === null,
  'Ciclo de vida=concluída (Concluído Z, 200 dias parado) → null, NÃO calcula ritmo'
)
check(
  (await calcularSinalAgregado('arquivado-w', storage)) === null,
  'Ciclo de vida=arquivada (Arquivado W, 200 dias parado) → null, NÃO calcula ritmo'
)

console.log('\n--- movementExpected ---\n')
check(
  movementExpected({ cicloVida: 'ativa', condição: 'normal' }) === true,
  'ativa+normal → espera movimento'
)
check(
  movementExpected({ cicloVida: 'ativa', condição: 'bloqueada' }) === false,
  'ativa+bloqueada → NÃO espera movimento'
)
check(
  movementExpected({ cicloVida: 'concluída', condição: 'normal' }) === false,
  'concluída+normal → NÃO espera movimento (ciclo de vida manda)'
)
check(
  movementExpected({ cicloVida: 'arquivada', condição: 'normal' }) === false,
  'arquivada+normal → NÃO espera movimento'
)

console.log('\n--- Reativação de frente concluída (regra de produto fechada) ---\n')

// frente concluída que tinha ficado com condição=bloqueada ANTES de concluir
await criarFrente(storage, {
  id: 'reativa-teste',
  nome: 'Reativa Teste',
  área: 'work',
  tipo: 'projeto',
  parentId: null,
  cicloVida: 'ativa',
  condição: 'normal',
  cadênciaEsperada: 7,
  contextoFoco: null,
  contextoBloqueio: null,
  pausaMotivo: null,
  pausaRetomadaEm: null
})
await mudarCondição(storage, 'reativa-teste', 'bloqueada')
await mudarCicloVida(storage, 'reativa-teste', 'concluída') // deve forçar condição=normal
let rf = (await storage.getFrente('reativa-teste'))!
check(rf.cicloVida === 'concluída' && rf.condição === 'normal', 'Ao concluir, condição foi forçada para normal (estava bloqueada)')

await mudarCicloVida(storage, 'reativa-teste', 'ativa') // reativar
rf = (await storage.getFrente('reativa-teste'))!
check(
  rf.cicloVida === 'ativa' && rf.condição === 'normal',
  'Reativação (concluída → ativa) resulta em ativa+normal, NÃO restaura bloqueada'
)

console.log('\n--- Ausência de hibernando/últimoToque no modelo de tipos ---\n')
check(
  !('últimoToque' in rf),
  'Frente não possui mais o campo últimoToque'
)
// @ts-expect-error — 'hibernando' não deve mais ser um valor válido de Sinal; se este
// comentário do TypeScript não for necessário (ou seja, se compilar sem erro), o build falha.
const sinalInválido: import('./types').Sinal = 'hibernando'
void sinalInválido

console.log(`\n${falhas === 0 ? '✅ Todos os testes do motor passaram' : `❌ ${falhas} teste(s) falharam`}`)
