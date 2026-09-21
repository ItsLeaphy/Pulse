import { MemoryAdapter } from './storage'
import { excluirFrenteComFilhos } from './frente-ops'
import { novoId } from './id'
import type { Frente } from './types'

// ============================================================
// TESTE: exclusão em cascata
// Isso é destrutivo e irreversível na UI real, então precisa de
// prova, não só leitura do código. Roda com: npm run test:ops
// ============================================================

const agora = Date.now()
const storage = new MemoryAdapter()

function novaFrente(id: string, nome: string, parentId: string | null): Frente {
  const f: Frente = {
    id,
    nome,
    área: 'work',
    tipo: parentId ? 'projeto' : 'domínio',
    parentId,
    estado: 'ativa',
    cadênciaEsperada: 7,
    últimoToque: agora,
    últimoMovimento: agora,
    optOutNegligência: false,
    criadaEm: agora
  }
  storage.salvarFrente(f)
  return f
}

// Darkline > Darkline Dev > Origens (e outro filho direto de Darkline Dev)
novaFrente('darkline', 'Darkline', null)
novaFrente('darkline-dev', 'Darkline Dev', 'darkline')
novaFrente('origens', 'Origens', 'darkline-dev')
novaFrente('outro-projeto', 'Outro Projeto', 'darkline-dev')

// registros espalhados pela árvore inteira
for (const frenteId of ['darkline', 'darkline-dev', 'origens', 'outro-projeto']) {
  storage.salvarRegistro({
    id: novoId(),
    frenteId,
    data: agora,
    texto: `registro de teste em ${frenteId}`,
    contaComoMovimento: true
  })
}

console.log('--- Antes da exclusão ---')
console.log('Frentes:', (await storage.getFrentes()).length, '(esperado: 4)')

await excluirFrenteComFilhos('darkline', storage)

console.log('\n--- Depois de excluir "darkline" (raiz) ---')
const frentesRestantes = await storage.getFrentes()
console.log('Frentes restantes:', frentesRestantes.length)
console.log(
  frentesRestantes.length === 0
    ? '✅ Darkline e toda a árvore (Dev, Origens, Outro Projeto) foram removidos'
    : `❌ Esperava 0 frentes restantes, sobraram ${frentesRestantes.length}: ${frentesRestantes.map((f) => f.nome).join(', ')}`
)

let totalRegistrosOrfaos = 0
for (const frenteId of ['darkline', 'darkline-dev', 'origens', 'outro-projeto']) {
  totalRegistrosOrfaos += (await storage.getRegistros(frenteId)).length
}
console.log(
  totalRegistrosOrfaos === 0
    ? '✅ Nenhum registro órfão sobrou de nenhuma frente da árvore'
    : `❌ Sobraram ${totalRegistrosOrfaos} registros órfãos`
)
