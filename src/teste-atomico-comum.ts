import type { StorageAdapter } from './storage'
import type { Frente, Registro, EventoEstrutural } from './types'
import { ErroPulse } from './erros'
import {
  criarFrente,
  editarFrente,
  mudarCondição,
  mudarCadência,
  mudarCicloVida,
  criarRegistro,
  editarRegistro,
  excluirRegistro,
  excluirFrenteComFilhos
} from './frente-ops'
import { moverFrente } from './hierarquia'
import { novoId } from './id'

// ============================================================
// SUÍTE COMPARTILHADA DE ATOMICIDADE
// Os MESMOS cenários rodam contra cada implementação do StorageAdapter
// (memória, localStorage simulado e Supabase sobre PostgreSQL real),
// passando pelas operações reais do app (frente-ops / hierarquia).
// Prova que as três implementações têm o mesmo comportamento.
// ============================================================

export interface Ambiente {
  /** "aba" principal */
  storage: StorageAdapter
  /** outra aba/aparelho do MESMO usuário, sobre os mesmos dados */
  outraAba: StorageAdapter
}

export type Verificar = (condição: boolean, mensagem: string) => void

const agora = 1_800_000_000_000
const DIA = 86_400_000

export const frenteBase = (id: string, extra: Partial<Frente> = {}) => ({
  id,
  nome: 'Frente',
  área: 'work' as const,
  tipo: 'projeto' as const,
  parentId: null,
  cicloVida: 'ativa' as const,
  condição: 'normal' as const,
  cadênciaEsperada: 7,
  contextoFoco: null,
  contextoBloqueio: null,
  pausaMotivo: null,
  pausaRetomadaEm: null,
  criadaEm: agora - 10 * DIA,
  ...extra
})

export async function capturar(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
    return null
  } catch (e) {
    return e
  }
}

export function códigoDe(e: unknown): string | undefined {
  return e instanceof ErroPulse ? e.código : undefined
}

/** Conta chamadas por método (para provar "1 única operação atômica"). */
export function contar(s: StorageAdapter): { s: StorageAdapter; chamadas: Record<string, number> } {
  const chamadas: Record<string, number> = {}
  const proxy = new Proxy(s, {
    get(alvo, prop, receptor) {
      const v = Reflect.get(alvo, prop, receptor)
      if (typeof v !== 'function') return v
      return (...args: unknown[]) => {
        chamadas[String(prop)] = (chamadas[String(prop)] ?? 0) + 1
        return (v as (...a: unknown[]) => unknown).apply(alvo, args)
      }
    }
  })
  return { s: proxy, chamadas }
}

/** Storage que enxerga a frente/o registro como estavam num instante anterior (aba desatualizada). */
function comVistaAntiga(s: StorageAdapter, frente?: Frente, registros?: Registro[]): StorageAdapter {
  return new Proxy(s, {
    get(alvo, prop, receptor) {
      if (prop === 'getFrente' && frente) return async () => frente
      if (prop === 'getRegistros' && registros) return async () => registros
      if (prop === 'getTodosRegistros' && registros) return async () => registros
      return Reflect.get(alvo, prop, receptor)
    }
  })
}

const tiposEventos = (evs: EventoEstrutural[]) => evs.map((e) => `${e.tipo}:${e.valorAnterior}>${e.valorNovo}`).sort()

export async function suiteAtômica(rótulo: string, novo: () => Promise<Ambiente>, check: Verificar): Promise<void> {
  const R = (m: string) => `[${rótulo}] ${m}`

  // ---------- criar frente ----------
  console.log(`\n— ${rótulo}: criar frente`)
  {
    const { storage: s } = await novo()
    const id = novoId()
    const f = await criarFrente(s, frenteBase(id))
    check(f.id === id && (await s.getFrentes()).length === 1, R('criarFrente grava a frente'))
    const evs = await s.getEventosEstruturais(id)
    check(evs.length === 1 && evs[0]!.tipo === 'criação', R('criar uma Frente gera EXATAMENTE 1 evento de criação'))

    await criarFrente(s, frenteBase(id))
    check((await s.getFrentes()).length === 1 && (await s.getEventosEstruturais(id)).length === 1, R('repetir criarFrente (mesmo id): continua 1 frente e 1 evento'))
    await criarFrente(s, frenteBase(id, { nome: 'Outro nome' }))
    check((await s.getFrente(id))?.nome === 'Frente', R('criação repetida NÃO sobrescreve a frente existente'))

    const c = contar(s)
    await criarFrente(c.s, frenteBase(novoId()))
    check((c.chamadas.salvarFrenteComEventos ?? 0) === 1 && !c.chamadas.salvarFrente && !c.chamadas.salvarEventoEstrutural, R('criação = 1 única chamada atômica (nenhuma gravação solta)'))
  }

  // ---------- editar frente ----------
  console.log(`\n— ${rótulo}: editar frente`)
  {
    const { storage: s } = await novo()
    const id = novoId()
    await criarFrente(s, frenteBase(id, { condição: 'bloqueada' }))
    const c = contar(s)
    await editarFrente(
      c.s,
      id,
      { nome: 'Nova', área: 'art', tipo: 'prática', cicloVida: 'arquivada', condição: 'pausada', cadênciaEsperada: 14, contextoFoco: 'foco', contextoBloqueio: null },
      agora
    )
    check((c.chamadas.salvarFrenteComEventos ?? 0) === 1 && !c.chamadas.salvarFrente && !c.chamadas.salvarEventoEstrutural, R('edição composta = 1 única chamada atômica'))
    const f = (await s.getFrente(id))!
    check(f.nome === 'Nova' && f.cicloVida === 'arquivada' && f.condição === 'normal' && f.cadênciaEsperada === 14 && f.contextoFoco === 'foco', R('estado final coerente com as invariantes'))
    const t = tiposEventos((await s.getEventosEstruturais(id)).filter((e) => e.tipo !== 'criação'))
    check(
      t.length === 3 && t.includes('ciclo_vida_mudou:ativa>arquivada') && t.includes('condição_mudou:bloqueada>normal') && t.includes('cadência_mudou:7>14'),
      R('todos os eventos da edição foram gravados junto com a frente (ciclo, condição, cadência)')
    )

    // editar só o nome de uma frente concluída (regressão do bug original)
    await editarFrente(s, id, { nome: 'Outra', área: 'art', tipo: 'prática', cicloVida: 'concluída', condição: 'normal', cadênciaEsperada: 14, contextoFoco: null, contextoBloqueio: null }, agora + 1)
    const antes = (await s.getEventosEstruturais(id)).length
    await editarFrente(s, id, { nome: 'Só o nome', área: 'art', tipo: 'prática', cicloVida: 'concluída', condição: 'normal', cadênciaEsperada: 14, contextoFoco: null, contextoBloqueio: null }, agora + 2)
    check((await s.getFrente(id))?.nome === 'Só o nome' && (await s.getEventosEstruturais(id)).length === antes, R('renomear frente concluída funciona e não gera evento espúrio'))

    const c2 = contar(s)
    await editarFrente(c2.s, id, { nome: 'Só o nome', área: 'art', tipo: 'prática', cicloVida: 'concluída', condição: 'normal', cadênciaEsperada: 14, contextoFoco: null, contextoBloqueio: null }, agora + 3)
    check(!c2.chamadas.salvarFrenteComEventos, R('formulário sem alterações não grava nada'))
  }

  // ---------- mudar ciclo / condição / cadência ----------
  console.log(`\n— ${rótulo}: ciclo, condição e cadência`)
  {
    const { storage: s } = await novo()
    const id = novoId()
    await criarFrente(s, frenteBase(id))
    await mudarCondição(s, id, 'bloqueada', agora)
    await mudarCondição(s, id, 'bloqueada', agora + 1)
    await mudarCadência(s, id, 21, agora + 2)
    await mudarCicloVida(s, id, 'concluída', agora + 3)
    const t = tiposEventos((await s.getEventosEstruturais(id)).filter((e) => e.tipo !== 'criação'))
    check(
      t.length === 4 &&
        t.includes('condição_mudou:normal>bloqueada') &&
        t.includes('cadência_mudou:7>21') &&
        t.includes('ciclo_vida_mudou:ativa>concluída') &&
        t.includes('condição_mudou:bloqueada>normal'),
      R('cada mudança gera seus eventos; repetir a mesma condição não gera evento')
    )
    const f = (await s.getFrente(id))!
    check(f.cicloVida === 'concluída' && f.condição === 'normal' && f.cadênciaEsperada === 21, R('estado coerente após as mudanças'))
    check((await capturar(() => mudarCondição(s, id, 'pausada'))) !== null, R('mudar condição de frente concluída continua sendo erro'))
  }

  // ---------- hierarquia ----------
  console.log(`\n— ${rótulo}: hierarquia`)
  {
    const { storage: s } = await novo()
    const [pai, filha, neta] = [novoId(), novoId(), novoId()]
    await criarFrente(s, frenteBase(pai, { tipo: 'domínio', cadênciaEsperada: null }))
    await criarFrente(s, frenteBase(filha))
    await criarFrente(s, frenteBase(neta, { parentId: filha }))
    const c = contar(s)
    await moverFrente(c.s, filha, pai, agora)
    check((c.chamadas.salvarFrenteComEventos ?? 0) === 1 && !c.chamadas.salvarEventoEstrutural, R('mover = 1 única chamada atômica'))
    check((await s.getFrente(filha))?.parentId === pai, R('frente movida'))
    const ev = (await s.getEventosEstruturais(filha)).filter((e) => e.tipo === 'hierarquia_mudou')
    check(ev.length === 1 && ev[0]!.valorAnterior === null && ev[0]!.valorNovo === pai, R('mover não deixa a frente alterada sem o seu evento'))

    // o storage revalida ciclo/pai mesmo se o cliente não validou (concorrência)
    const f1 = (await s.getFrente(filha))!
    const eCiclo = await capturar(() => s.salvarFrenteComEventos({ ...f1, parentId: neta }, [], f1))
    check(códigoDe(eCiclo) === 'PU422', R('ciclo (pai = descendente) recusado pelo storage (PU422)'))
    const eSelf = await capturar(() => s.salvarFrenteComEventos({ ...f1, parentId: filha }, [], f1))
    check(códigoDe(eSelf) === 'PU422', R('frente como pai de si mesma recusada pelo storage (PU422)'))
    const eInex = await capturar(() => s.salvarFrenteComEventos({ ...f1, parentId: novoId() }, [], f1))
    check(códigoDe(eInex) === 'PU422', R('pai inexistente recusado pelo storage (PU422)'))
    check((await s.getFrente(filha))?.parentId === pai && (await s.getEventosEstruturais(filha)).filter((e) => e.tipo === 'hierarquia_mudou').length === 1, R('recusas não alteram nada'))
    const eEv = await capturar(() => s.salvarFrenteComEventos({ ...f1, nome: 'x' }, [{ id: novoId(), frenteId: pai, tipo: 'cadência_mudou', valorAnterior: null, valorNovo: '1', criadoEm: agora }], f1))
    check(códigoDe(eEv) === 'PU422' && (await s.getFrente(filha))?.nome === 'Frente', R('evento de outra frente recusado; nada gravado'))
    const eNome = await capturar(() => s.salvarFrenteComEventos({ ...f1, nome: '   ' }, [], f1))
    check(códigoDe(eNome) === 'PU422', R('nome em branco recusado pelo storage'))

    check((await capturar(() => moverFrente(s, pai, neta))) !== null && (await s.getFrente(pai))?.parentId === null, R('moverFrente (cliente) continua recusando ciclo (neta é descendente de pai)'))
    await moverFrente(s, filha, null, agora + 1)
    check((await s.getFrente(filha))?.parentId === null, R('mover para a raiz'))
  }

  // ---------- registros: cache ultimo_movimento ----------
  console.log(`\n— ${rótulo}: registros e último movimento`)
  {
    const { storage: s } = await novo()
    const id = novoId()
    await criarFrente(s, frenteBase(id))
    const um = async () => (await s.getFrente(id))?.últimoMovimento
    check((await um()) === null, R('frente nova: sem último movimento'))

    const c = contar(s)
    const r1 = await criarRegistro(c.s, { frenteId: id, data: agora - 5 * DIA, texto: 'a', contaComoMovimento: true })
    check((c.chamadas.salvarRegistroComCache ?? 0) === 1 && !c.chamadas.salvarRegistro && !c.chamadas.salvarFrente, R('criar registro = 1 única chamada atômica'))
    check((await um()) === agora - 5 * DIA, R('criar registro atualiza o último movimento'))

    const r2 = await criarRegistro(s, { frenteId: id, data: agora - 2 * DIA, texto: 'b', contaComoMovimento: true })
    check((await um()) === agora - 2 * DIA, R('registro mais recente avança o cache'))
    await criarRegistro(s, { frenteId: id, data: agora - 9 * DIA, texto: 'retroativo', contaComoMovimento: true })
    check((await um()) === agora - 2 * DIA, R('registro retroativo não recua o cache'))
    await criarRegistro(s, { frenteId: id, data: agora, texto: 'nota', contaComoMovimento: false })
    check((await um()) === agora - 2 * DIA, R('registro que não conta como movimento não altera o cache'))

    await editarRegistro(s, r2.id, { data: agora - 7 * DIA }, id)
    check((await um()) === agora - 5 * DIA, R('editar a data recalcula o cache'))
    await editarRegistro(s, r1.id, { contaComoMovimento: false }, id)
    check((await um()) === agora - 7 * DIA, R('editar "conta como movimento" recalcula o cache (maior movimento restante)'))

    await excluirRegistro(s, r2.id, id)
    check((await um()) === agora - 9 * DIA, R('excluir registro recalcula o cache'))
    const c2 = contar(s)
    await excluirRegistro(c2.s, r1.id, id)
    check((c2.chamadas.removerRegistroComCache ?? 0) === 1 && !c2.chamadas.removerRegistro && !c2.chamadas.salvarFrente, R('excluir registro = 1 única chamada atômica'))
    for (const r of (await s.getRegistros(id)).filter((x) => x.contaComoMovimento)) await excluirRegistro(s, r.id, id)
    check((await um()) === null, R('sem nenhum movimento: cache volta a null'))
    check((await capturar(() => excluirRegistro(s, novoId()))) === null, R('excluir registro inexistente é no-op'))

    const eSemFrente = await capturar(() => s.salvarRegistroComCache({ id: novoId(), frenteId: novoId(), data: agora, criadoEm: agora, texto: 'x', contaComoMovimento: true }, null))
    check(códigoDe(eSemFrente) === 'PU404', R('registro em frente inexistente → PU404, nada gravado'))
  }

  // ---------- retry após resposta incerta ----------
  console.log(`\n— ${rótulo}: retry (resposta perdida) sem duplicação`)
  {
    const { storage: s } = await novo()
    const id = novoId()
    const f0 = (await criarFrente(s, frenteBase(id)))
    const f1: Frente = { ...f0, condição: 'bloqueada' }
    const evId = novoId()
    const ev: EventoEstrutural = { id: evId, frenteId: id, tipo: 'condição_mudou', valorAnterior: 'normal', valorNovo: 'bloqueada', criadoEm: agora }
    const a = await s.salvarFrenteComEventos(f1, [ev], f0)
    const b = await s.salvarFrenteComEventos(f1, [ev], f0) // o cliente não viu a resposta e repete
    check(a.status === 'aplicada' && b.status === 'ja_aplicada', R('mesma chamada repetida: aplicada, depois ja_aplicada'))
    check((await s.getEventosEstruturais(id)).filter((e) => e.tipo === 'condição_mudou').length === 1, R('retry não duplica o evento'))
    // outra operação (ids de evento diferentes) que chega ao mesmo estado: também não duplica o histórico
    const c = await s.salvarFrenteComEventos(f1, [{ ...ev, id: novoId() }], f0)
    check(c.status === 'ja_aplicada' && (await s.getEventosEstruturais(id)).filter((e) => e.tipo === 'condição_mudou').length === 1, R('estado já alcançado: não grava eventos de novo'))

    const rg: Registro = { id: novoId(), frenteId: id, data: agora - DIA, criadoEm: agora, texto: 'x', contaComoMovimento: true }
    const r1 = await s.salvarRegistroComCache(rg, null)
    const r2 = await s.salvarRegistroComCache(rg, null)
    check(r1.status === 'criado' && r2.status === 'ja_existia' && (await s.getRegistros(id)).length === 1, R('criar registro repetido: 1 registro só'))
    const ed = { ...rg, texto: 'y' }
    const e1 = await s.salvarRegistroComCache(ed, rg)
    const e2 = await s.salvarRegistroComCache(ed, rg)
    check(e1.status === 'aplicado' && e2.status === 'ja_aplicado' && (await s.getRegistros(id))[0]!.texto === 'y', R('editar registro repetido: aplicado, depois ja_aplicado'))
    const x1 = await s.removerRegistroComCache(rg.id)
    const x2 = await s.removerRegistroComCache(rg.id)
    check(x1.status === 'removido' && x2.status === 'ja_removido', R('excluir registro repetido: removido, depois ja_removido'))
    const d1 = await s.removerFrenteEmCascata(id)
    const d2 = await s.removerFrenteEmCascata(id)
    check(d1.status === 'removida' && d2.status === 'ja_removida' && d2.frentes === 0, R('excluir frente repetido: removida, depois ja_removida'))
  }

  // ---------- conflito: não sobrescrever alteração mais recente ----------
  console.log(`\n— ${rótulo}: conflito de edição (aba desatualizada)`)
  {
    const { storage: a, outraAba: b } = await novo()
    const id = novoId()
    await criarFrente(a, frenteBase(id))
    const vistaDeB = (await b.getFrente(id))!
    await editarFrente(a, id, { nome: 'Alterado em A', área: 'work', tipo: 'projeto', cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: 7, contextoFoco: null, contextoBloqueio: null }, agora)
    const abaB = comVistaAntiga(b, vistaDeB)
    const erro = await capturar(() =>
      editarFrente(abaB, id, { nome: 'Alterado em B', área: 'work', tipo: 'projeto', cicloVida: 'ativa', condição: 'bloqueada', cadênciaEsperada: 7, contextoFoco: null, contextoBloqueio: null }, agora + 1)
    )
    check(códigoDe(erro) === 'PU409', R('edição com base desatualizada → conflito PU409'))
    const f = (await a.getFrente(id))!
    check(f.nome === 'Alterado em A' && f.condição === 'normal', R('a alteração mais recente NÃO foi sobrescrita'))
    check((await a.getEventosEstruturais(id)).filter((e) => e.tipo === 'condição_mudou').length === 0, R('o conflito não gravou eventos'))
    check(erro instanceof ErroPulse && erro.podeRepetir === false, R('conflito é marcado como não repetível (refazer a edição, não repetir a chamada)'))

    // recarregando (vista nova), a edição passa
    await editarFrente(b, id, { nome: 'Alterado em B', área: 'work', tipo: 'projeto', cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: 7, contextoFoco: null, contextoBloqueio: null }, agora + 2)
    check((await a.getFrente(id))?.nome === 'Alterado em B', R('depois de recarregar, a edição é aceita'))

    // registro
    const r = await criarRegistro(a, { frenteId: id, data: agora, texto: 'orig', contaComoMovimento: true })
    const vistaRegistroB = (await b.getRegistros(id))
    await editarRegistro(a, r.id, { texto: 'editado em A' }, id)
    const erroR = await capturar(() => editarRegistro(comVistaAntiga(b, undefined, vistaRegistroB), r.id, { texto: 'editado em B' }, id))
    check(códigoDe(erroR) === 'PU409' && (await a.getRegistros(id))[0]!.texto === 'editado em A', R('registro: edição desatualizada recusada, valor mais recente preservado'))

    // frente excluída em outra aba
    await excluirFrenteComFilhos(id, a)
    const abaB2 = comVistaAntiga(b, vistaDeB)
    const erroEx = await capturar(() => mudarCondição(abaB2, id, 'bloqueada'))
    check(códigoDe(erroEx) === 'PU404', R('editar frente excluída em outro lugar → PU404'))
  }

  // ---------- excluir árvore ----------
  console.log(`\n— ${rótulo}: excluir árvore de frentes`)
  {
    const { storage: s } = await novo()
    const [raiz, filha, neta, outra] = [novoId(), novoId(), novoId(), novoId()]
    await criarFrente(s, frenteBase(raiz, { tipo: 'domínio', cadênciaEsperada: null }))
    await criarFrente(s, frenteBase(filha, { parentId: raiz }))
    await criarFrente(s, frenteBase(neta, { parentId: filha }))
    await criarFrente(s, frenteBase(outra))
    for (const id of [raiz, filha, neta, outra]) {
      await criarRegistro(s, { frenteId: id, data: agora, texto: id, contaComoMovimento: true })
      await mudarCondição(s, id, 'aguardando', agora)
    }
    const c = contar(s)
    await excluirFrenteComFilhos(raiz, c.s)
    check((c.chamadas.removerFrenteEmCascata ?? 0) === 1 && !c.chamadas.removerFrente && !c.chamadas.removerRegistro && !c.chamadas.removerEventoEstrutural, R('excluir árvore = 1 única chamada atômica'))
    const frentes = await s.getFrentes()
    check(frentes.length === 1 && frentes[0]!.id === outra, R('raiz, filha e neta removidas; a outra frente permanece'))
    check((await s.getTodosRegistros()).every((r) => r.frenteId === outra) && (await s.getTodosRegistros()).length === 1, R('nenhum registro órfão'))
    check((await s.getTodosEventosEstruturais()).every((e) => e.frenteId === outra) && (await s.getTodosEventosEstruturais()).length === 2, R('nenhum evento órfão (restam só os da outra frente)'))
    check((await capturar(() => excluirFrenteComFilhos(raiz, s))) === null, R('excluir de novo é no-op'))
  }
}
