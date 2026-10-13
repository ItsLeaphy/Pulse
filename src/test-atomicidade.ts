import { LocalStorageAdapter, MemoryAdapter, type StorageAdapter } from './storage'
import { criarFrente, criarRegistro, editarFrente, mudarCondição, excluirFrenteComFilhos, excluirRegistro } from './frente-ops'
import { moverFrente } from './hierarquia'
import { novoId } from './id'
import { suiteAtômica, frenteBase, capturar, códigoDe, type Ambiente } from './teste-atomico-comum'

// ============================================================
// TESTE: operações atômicas nos adapters MEMÓRIA e LOCAL.
//  1. A mesma suíte compartilhada que roda contra o PostgreSQL real.
//  2. Reversão real no armazenamento local: se uma gravação falhar no
//     meio (cota cheia, por exemplo), as chaves já gravadas voltam ao
//     que eram — nunca "frente nova com evento antigo".
// Rode com: npm run test:atomicidade
// ============================================================

let falhas = 0
function check(condição: boolean, mensagem: string): void {
  if (condição) console.log(`✅ ${mensagem}`)
  else {
    console.log(`❌ ${mensagem}`)
    falhas++
  }
}

// localStorage simulado (Node não tem), com falha injetável por chave
class StorageFalso {
  dados = new Map<string, string>()
  falharAoGravar: string | null = null
  getItem(k: string): string | null {
    return this.dados.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    if (this.falharAoGravar && k.includes(this.falharAoGravar)) {
      const e = new Error('QuotaExceededError: cota cheia')
      e.name = 'QuotaExceededError'
      throw e
    }
    this.dados.set(k, String(v))
  }
  removeItem(k: string): void {
    this.dados.delete(k)
  }
}
const falso = new StorageFalso()
;(globalThis as unknown as { localStorage: StorageFalso }).localStorage = falso

await suiteAtômica(
  'memória',
  async (): Promise<Ambiente> => {
    const m = new MemoryAdapter()
    return { storage: m, outraAba: m }
  },
  check
)

await suiteAtômica(
  'local',
  async (): Promise<Ambiente> => {
    falso.dados.clear()
    falso.falharAoGravar = null
    const a = new LocalStorageAdapter()
    return { storage: a, outraAba: new LocalStorageAdapter() }
  },
  check
)

// ============ reversão no armazenamento local ============
console.log('\n— local: reversão quando uma gravação falha no meio')
const instantâneo = () => JSON.stringify([...falso.dados.entries()].sort())
{
  falso.dados.clear()
  falso.falharAoGravar = null
  const s: StorageAdapter = new LocalStorageAdapter()
  const id = novoId()
  await criarFrente(s, frenteBase(id))
  await criarRegistro(s, { frenteId: id, data: 1_000, texto: 'x', contaComoMovimento: true })
  const antes = instantâneo()

  // frente e registro gravam OK; a 3ª chave (eventos) falha
  falso.falharAoGravar = 'eventos'
  const erro = await capturar(() =>
    editarFrente(s, id, { nome: 'Novo', área: 'work', tipo: 'projeto', cicloVida: 'ativa', condição: 'pausada', cadênciaEsperada: 3, contextoFoco: null, contextoBloqueio: null }, 5)
  )
  check(erro !== null, 'edição cuja gravação de eventos falha → erro')
  check(instantâneo() === antes, 'REVERSÃO: o armazenamento ficou byte a byte como antes (frente não ficou alterada)')
  falso.falharAoGravar = null
  check((await s.getFrente(id))?.nome === 'Frente' && (await s.getEventosEstruturais(id)).length === 1, 'frente e eventos intactos')

  // retry depois que o problema some: aplica uma vez, sem duplicar
  await editarFrente(s, id, { nome: 'Novo', área: 'work', tipo: 'projeto', cicloVida: 'ativa', condição: 'pausada', cadênciaEsperada: 3, contextoFoco: null, contextoBloqueio: null }, 5)
  check((await s.getFrente(id))?.nome === 'Novo' && (await s.getEventosEstruturais(id)).length === 3, 'retry aplica a edição com os 2 eventos (condição, cadência)')

  // criar frente com falha na chave de eventos
  const antes2 = instantâneo()
  falso.falharAoGravar = 'eventos'
  const id2 = novoId()
  check((await capturar(() => criarFrente(s, frenteBase(id2)))) !== null, 'criar frente com falha em eventos → erro')
  check(instantâneo() === antes2 && (await s.getFrente(id2)) === undefined, 'REVERSÃO: a frente NÃO ficou criada sem o evento de criação')
  falso.falharAoGravar = null
  await criarFrente(s, frenteBase(id2))
  check((await s.getEventosEstruturais(id2)).length === 1, 'retry cria a frente com exatamente 1 evento')

  // registro: falha ao gravar a chave de frentes (cache) depois de gravar registros
  const antes3 = instantâneo()
  falso.falharAoGravar = 'frentes'
  const r = await capturar(() => criarRegistro(s, { frenteId: id, data: 9_999, texto: 'y', contaComoMovimento: true }))
  check(r !== null, 'registro com falha ao gravar o cache da frente → erro')
  check(instantâneo() === antes3 && (await s.getRegistros(id)).length === 1, 'REVERSÃO: o registro não ficou salvo sem o cache atualizado')
  falso.falharAoGravar = null

  // exclusão em cascata com falha no meio
  const raiz = novoId()
  const filha = novoId()
  await criarFrente(s, frenteBase(raiz, { tipo: 'domínio', cadênciaEsperada: null }))
  await criarFrente(s, frenteBase(filha, { parentId: raiz }))
  await criarRegistro(s, { frenteId: filha, data: 1, texto: 'z', contaComoMovimento: true })
  const antes4 = instantâneo()
  falso.falharAoGravar = 'eventos' // frentes e registros já teriam sido gravados
  check((await capturar(() => excluirFrenteComFilhos(raiz, s))) !== null, 'exclusão de árvore com falha no meio → erro')
  check(instantâneo() === antes4, 'REVERSÃO: a árvore continua inteira (nada de exclusão pela metade)')
  falso.falharAoGravar = null
  await excluirFrenteComFilhos(raiz, s)
  check((await s.getFrente(raiz)) === undefined && (await s.getFrente(filha)) === undefined, 'retry conclui a exclusão')

  // mover com falha
  const a = novoId()
  const b = novoId()
  await criarFrente(s, frenteBase(a, { tipo: 'domínio', cadênciaEsperada: null }))
  await criarFrente(s, frenteBase(b))
  const antes5 = instantâneo()
  falso.falharAoGravar = 'eventos'
  check((await capturar(() => moverFrente(s, b, a, 7))) !== null && instantâneo() === antes5, 'mover com falha: frente NÃO fica movida sem o evento (reversão)')
  falso.falharAoGravar = null
  await moverFrente(s, b, a, 7)
  check((await s.getFrente(b))?.parentId === a && (await s.getEventosEstruturais(b)).filter((e) => e.tipo === 'hierarquia_mudou').length === 1, 'retry move com 1 evento')

  // mudança de condição + exclusão de registro com falha
  const antes6 = instantâneo()
  falso.falharAoGravar = 'eventos'
  check((await capturar(() => mudarCondição(s, b, 'bloqueada', 8))) !== null && instantâneo() === antes6, 'mudar condição com falha: nada alterado')
  falso.falharAoGravar = null
  check(códigoDe(await capturar(() => mudarCondição(s, novoId(), 'bloqueada'))) === undefined, 'frente inexistente: erro de uso, sem escrita')
  const rr = await criarRegistro(s, { frenteId: b, data: 50, texto: 'k', contaComoMovimento: true })
  const antes7 = instantâneo()
  falso.falharAoGravar = 'frentes'
  check((await capturar(() => excluirRegistro(s, rr.id, b))) !== null && instantâneo() === antes7, 'excluir registro com falha ao gravar o cache: registro permanece (reversão)')
  falso.falharAoGravar = null
}

console.log(`\n${falhas === 0 ? '✅ Atomicidade (memória/local): todos os testes passaram' : `❌ ${falhas} teste(s) falharam`}`)
if (falhas > 0) process.exit(1)
