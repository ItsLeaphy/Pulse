import type { StorageAdapter } from './storage'
import type { Frente, Registro, CicloVida, Condição, EventoEstrutural } from './types'
import { novoId } from './id'
import { ErroParcial, ErroValidação, normalizarErro } from './erros'

// ============================================================
// OPERAÇÕES DE FRENTE E DE REGISTRO
// Lógica que coordena múltiplas chamadas de storage. Fica fora
// da UI (que só deve renderizar e delegar) e fora de storage.ts
// (que só deve ler/escrever uma linha por vez).
//
// Este é o único lugar que deve gerar EventoEstrutural e o único
// lugar que deve recalcular Frente.últimoMovimento. A UI nunca
// deve chamar storage.salvarRegistro / storage.salvarFrente
// diretamente para essas mutações — sempre por aqui, ou o cache
// de últimoMovimento e os eventos ficam inconsistentes.
// ============================================================

/**
 * Exportada (não só interna a este arquivo) para que hierarquia.ts
 * também possa gerar EventoEstrutural sem duplicar esta função —
 * continua sendo a ÚNICA função que escreve na tabela de eventos em
 * todo o código; nenhum outro módulo deve chamar
 * storage.salvarEventoEstrutural diretamente.
 */
export function montarEvento(
  frenteId: string,
  tipo: EventoEstrutural['tipo'],
  valorAnterior: string | null,
  valorNovo: string | null,
  agora: number = Date.now()
): EventoEstrutural {
  return { id: novoId(), frenteId, tipo, valorAnterior, valorNovo, criadoEm: agora }
}

export async function registrarEvento(
  storage: StorageAdapter,
  frenteId: string,
  tipo: EventoEstrutural['tipo'],
  valorAnterior: string | null,
  valorNovo: string | null,
  agora: number = Date.now()
): Promise<void> {
  await storage.salvarEventoEstrutural(montarEvento(frenteId, tipo, valorAnterior, valorNovo, agora))
}

/**
 * Grava eventos já montados DEPOIS de a mudança de estado ter sido
 * salva. Se algum falhar, a mudança de estado já está no banco — não é
 * uma falha total. Lança ErroParcial com `completar`, que grava só os
 * eventos que faltam. Os eventos têm ids fixos (montados antes), então
 * repetir `completar` é idempotente (upsert por id): nunca duplica.
 */
export async function gravarEventos(
  storage: StorageAdapter,
  operação: string,
  concluído: string[],
  eventos: EventoEstrutural[]
): Promise<void> {
  const faltam = [...eventos]
  while (faltam.length > 0) {
    const próximo = faltam[0]!
    try {
      await storage.salvarEventoEstrutural(próximo)
    } catch (err) {
      throw new ErroParcial(
        operação,
        concluído,
        ['registro da mudança no histórico'],
        err,
        () => gravarEventos(storage, operação, concluído, faltam)
      )
    }
    faltam.shift()
  }
}

// ============================================================
// REGISTRO — Registro é a fonte de verdade; Frente.últimoMovimento
// é cache derivado. Toda mutação de registro passa por aqui, que
// sempre termina recalculando o cache a partir do storage real
// (não incrementalmente) — mais simples e impossível de divergir.
// ============================================================

/**
 * Recalcula e persiste Frente.últimoMovimento a partir dos
 * Registros reais desta frente: é a maior `data` entre os
 * registros com contaComoMovimento=true, ou null se não houver
 * nenhum. Chamada ao final de criar/editar/excluir registro —
 * nunca incrementa o valor "na mão", sempre deriva do zero pra
 * nunca poder divergir da fonte de verdade.
 */
async function recalcularÚltimoMovimento(storage: StorageAdapter, frenteId: string): Promise<void> {
  const frente = await storage.getFrente(frenteId)
  if (!frente) return // frente pode já ter sido excluída — nada a recalcular

  const registros = await storage.getRegistros(frenteId)
  const movimentos = registros.filter((r) => r.contaComoMovimento).map((r) => r.data)
  const últimoMovimento = movimentos.length > 0 ? Math.max(...movimentos) : null

  if (frente.últimoMovimento !== últimoMovimento) {
    await storage.salvarFrente({ ...frente, últimoMovimento })
  }
}

/**
 * O registro (fonte de verdade) já foi gravado; se só o recálculo do
 * cache falhar, isso é parcial — e reparável: o recálculo parte do
 * zero, então repetir `completar` (ou qualquer próxima mutação de
 * registro dessa frente) corrige.
 */
async function atualizarCacheOuParcial(storage: StorageAdapter, operação: string, frenteId: string): Promise<void> {
  try {
    await recalcularÚltimoMovimento(storage, frenteId)
  } catch (err) {
    throw new ErroParcial(operação, ['registro gravado'], ['atualização do último movimento'], err, () =>
      recalcularÚltimoMovimento(storage, frenteId)
    )
  }
}

/**
 * Cria um registro e recalcula o cache da frente associada.
 *
 * `data` = quando o fato aconteceu (controlada pelo chamador — pode
 * ser retroativa). `criadoEm` = quando o registro foi inserido no
 * sistema; default Date.now() quando o chamador não especifica
 * (caso comum: registro não-retroativo, onde as duas datas coincidem).
 * `criadoEm` nunca participa de últimoMovimento/sinal/histórico/
 * retrospectiva — é só proveniência.
 */
export async function criarRegistro(
  storage: StorageAdapter,
  dados: Omit<Registro, 'id' | 'criadoEm'> & { id?: string; criadoEm?: number }
): Promise<Registro> {
  const registro: Registro = {
    ...dados,
    id: dados.id ?? novoId(),
    criadoEm: dados.criadoEm ?? Date.now()
  }
  await storage.salvarRegistro(registro)
  await atualizarCacheOuParcial(storage, 'Registrar', registro.frenteId)
  return registro
}

/**
 * Edita um registro existente e recalcula o cache — necessário
 * mesmo que só `texto` tenha mudado, porque não dá pra saber de
 * fora se `contaComoMovimento` ou `data` também mudaram sem
 * comparar; recalcular do zero é mais simples e sempre correto.
 */
export async function editarRegistro(
  storage: StorageAdapter,
  id: string,
  mudanças: Partial<Omit<Registro, 'id' | 'frenteId'>>,
  frenteIdConhecida?: string
): Promise<Registro> {
  const atual = await encontrarRegistro(storage, id, frenteIdConhecida)
  if (!atual) throw new Error(`Registro ${id} não encontrado`)

  const atualizado: Registro = { ...atual, ...mudanças }
  await storage.salvarRegistro(atualizado)
  await atualizarCacheOuParcial(storage, 'Editar registro', atualizado.frenteId)
  return atualizado
}

/** Exclui um registro e recalcula o cache da frente associada. */
export async function excluirRegistro(storage: StorageAdapter, id: string, frenteIdConhecida?: string): Promise<void> {
  const atual = await encontrarRegistro(storage, id, frenteIdConhecida)
  if (!atual) return // já não existe — nada a fazer

  await storage.removerRegistro(id)
  await atualizarCacheOuParcial(storage, 'Excluir registro', atual.frenteId)
}

/**
 * StorageAdapter não tem getRegistro(id). Com a frente conhecida (a UI
 * sempre sabe), lê só os registros dela; sem a dica, uma única leitura
 * em lote — nunca mais uma consulta por frente.
 */
async function encontrarRegistro(
  storage: StorageAdapter,
  id: string,
  frenteIdConhecida?: string
): Promise<Registro | undefined> {
  if (frenteIdConhecida) {
    const achado = (await storage.getRegistros(frenteIdConhecida)).find((r) => r.id === id)
    if (achado) return achado
  }
  return (await storage.getTodosRegistros()).find((r) => r.id === id)
}

// ============================================================
// FRENTE — criação e mudanças de dimensão de estado
// ============================================================

function validarCadência(c: number | null): void {
  if (c !== null && (!Number.isFinite(c) || c <= 0)) {
    throw new ErroValidação('A cadência precisa ser um número de dias maior que zero (ou ficar em branco).')
  }
}

/**
 * Cria uma frente nova e grava o evento de criação.
 *
 * Idempotente por id: repetir a chamada com o mesmo `id` (retry depois
 * de falha parcial) NÃO duplica a frente nem o evento de criação — se a
 * frente já existe, ela é preservada como está (não zera últimoMovimento
 * nem criadaEm) e só o que falta é gravado.
 */
export async function criarFrente(
  storage: StorageAdapter,
  dados: Omit<Frente, 'criadaEm' | 'últimoMovimento'> & { criadaEm?: number }
): Promise<Frente> {
  if (dados.nome.trim() === '') throw new ErroValidação('Dê um nome para a frente.')
  validarCadência(dados.cadênciaEsperada)
  if (dados.parentId !== null && !(await storage.getFrente(dados.parentId))) {
    throw new ErroValidação('A frente-mãe não existe mais. Volte e escolha outra.')
  }

  const existente = await storage.getFrente(dados.id)
  const agora = dados.criadaEm ?? Date.now()
  const frente: Frente = existente ?? { ...dados, criadaEm: agora, últimoMovimento: null }
  if (!existente) await storage.salvarFrente(frente)

  const eventos = await storage.getEventosEstruturais(frente.id)
  if (!eventos.some((e) => e.tipo === 'criação')) {
    await gravarEventos(storage, 'Criar frente', ['frente criada'], [
      montarEvento(frente.id, 'criação', null, null, frente.criadaEm)
    ])
  }
  return frente
}

/**
 * Atualiza ciclo de vida de uma frente, gerando o evento estrutural
 * correspondente quando o valor realmente muda.
 *
 * Invariantes da máquina de estados (decisão de produto fechada):
 * - cicloVida='concluída' ou 'arquivada' força condição='normal' —
 *   condição operacional não faz sentido para algo que já terminou;
 *   não se avalia mais bloqueio/espera/pausa de algo encerrado.
 * - reativar (concluída/arquivada → ativa) também força
 *   condição='normal' — NÃO restaura a condição anterior. O
 *   histórico de eventos já preserva qual era a condição antes de
 *   concluir/arquivar; "estava bloqueada antes de terminar" não
 *   deveria significar "continua bloqueada ao reabrir".
 * Se a mudança de condição embutida nessas regras também for uma
 * mudança real de valor, gera o evento 'condição_mudou' também,
 * além do 'ciclo_vida_mudou' — são duas mudanças reais acontecendo
 * juntas, cada uma com seu próprio evento.
 */
export async function mudarCicloVida(
  storage: StorageAdapter,
  frenteId: string,
  novoCicloVida: CicloVida,
  agora: number = Date.now()
): Promise<Frente> {
  const atual = await storage.getFrente(frenteId)
  if (!atual) throw new Error(`Frente ${frenteId} não encontrada`)
  if (atual.cicloVida === novoCicloVida) return atual

  // qualquer transição de cicloVida (incluindo reativação) força condição=normal
  const novaCondição: Condição = 'normal'
  const condiçãoMudou = atual.condição !== novaCondição

  const atualizada: Frente = { ...atual, cicloVida: novoCicloVida, condição: novaCondição }
  await storage.salvarFrente(atualizada)
  const eventos = [montarEvento(frenteId, 'ciclo_vida_mudou', atual.cicloVida, novoCicloVida, agora)]
  if (condiçãoMudou) {
    eventos.push(montarEvento(frenteId, 'condição_mudou', atual.condição, novaCondição, agora))
  }
  await gravarEventos(storage, 'Mudar ciclo de vida', ['mudança de ciclo de vida'], eventos)
  return atualizada
}

/**
 * Atualiza condição operacional de uma frente, gerando o evento
 * estrutural correspondente quando o valor realmente muda.
 *
 * Invariante: só é possível mudar condição enquanto cicloVida='ativa'.
 * Para concluída/arquivada a condição é sempre 'normal' e só muda
 * via mudarCicloVida (reativação) — chamar isso numa frente não-ativa
 * é erro de uso da operação, não um caso válido a tratar em silêncio.
 */
export async function mudarCondição(
  storage: StorageAdapter,
  frenteId: string,
  novaCondição: Condição,
  agora: number = Date.now()
): Promise<Frente> {
  const atual = await storage.getFrente(frenteId)
  if (!atual) throw new Error(`Frente ${frenteId} não encontrada`)
  if (atual.condição === novaCondição) return atual // sem mudança = sem erro, mesmo em frente não-ativa
  if (atual.cicloVida !== 'ativa') {
    throw new Error(
      `Frente ${frenteId} não está ativa (cicloVida=${atual.cicloVida}) — condição operacional não se aplica`
    )
  }

  const atualizada: Frente = { ...atual, condição: novaCondição }
  await storage.salvarFrente(atualizada)
  await gravarEventos(storage, 'Mudar condição', ['mudança de condição'], [
    montarEvento(frenteId, 'condição_mudou', atual.condição, novaCondição, agora)
  ])
  return atualizada
}

/**
 * Atualiza cadência esperada, gerando o evento estrutural
 * correspondente quando o valor realmente muda.
 */
export async function mudarCadência(
  storage: StorageAdapter,
  frenteId: string,
  novaCadência: number | null,
  agora: number = Date.now()
): Promise<Frente> {
  const atual = await storage.getFrente(frenteId)
  if (!atual) throw new Error(`Frente ${frenteId} não encontrada`)
  if (atual.cadênciaEsperada === novaCadência) return atual
  validarCadência(novaCadência)

  const atualizada: Frente = { ...atual, cadênciaEsperada: novaCadência }
  await storage.salvarFrente(atualizada)
  await gravarEventos(storage, 'Mudar cadência', ['mudança de cadência'], [
    montarEvento(
      frenteId,
      'cadência_mudou',
      atual.cadênciaEsperada === null ? null : String(atual.cadênciaEsperada),
      novaCadência === null ? null : String(novaCadência),
      agora
    )
  ])
  return atualizada
}

/**
 * Edição de frente em UMA gravação da linha (nome, área, tipo, contexto,
 * ciclo de vida, condição, cadência) + os eventos estruturais das
 * mudanças reais. Substitui a sequência salvarFrente + mudarCicloVida +
 * mudarCondição + mudarCadência (4+ gravações que podiam parar no meio
 * e que falhavam em qualquer frente concluída/arquivada).
 *
 * Mesmas invariantes de mudarCicloVida/mudarCondição: sair/entrar de
 * 'ativa' leva a condição a 'normal'; condição só vale em frente ativa
 * (para concluída/arquivada o campo de condição do formulário é
 * ignorado, não é erro).
 */
export interface EdiçãoFrente {
  nome: string
  área: Frente['área']
  tipo: Frente['tipo']
  cicloVida: CicloVida
  condição: Condição
  cadênciaEsperada: number | null
  contextoFoco: string | null
  contextoBloqueio: string | null
}

export async function editarFrente(
  storage: StorageAdapter,
  frenteId: string,
  edição: EdiçãoFrente,
  agora: number = Date.now()
): Promise<Frente> {
  const atual = await storage.getFrente(frenteId)
  if (!atual) throw new ErroValidação('Esta frente não existe mais.')
  const nome = edição.nome.trim()
  if (nome === '') throw new ErroValidação('Dê um nome para a frente.')
  validarCadência(edição.cadênciaEsperada)

  const cicloMudou = atual.cicloVida !== edição.cicloVida
  // condição após a regra de ciclo de vida (qualquer transição zera) e
  // depois a escolha do usuário, que só vale com a frente ativa
  const condiçãoApósCiclo: Condição = cicloMudou ? 'normal' : atual.condição
  const condiçãoFinal: Condição = edição.cicloVida === 'ativa' ? edição.condição : 'normal'

  const atualizada: Frente = {
    ...atual,
    nome,
    área: edição.área,
    tipo: edição.tipo,
    cicloVida: edição.cicloVida,
    condição: condiçãoFinal,
    cadênciaEsperada: edição.cadênciaEsperada,
    contextoFoco: edição.contextoFoco,
    contextoBloqueio: edição.contextoBloqueio
  }

  const eventos: EventoEstrutural[] = []
  if (cicloMudou) {
    eventos.push(montarEvento(frenteId, 'ciclo_vida_mudou', atual.cicloVida, edição.cicloVida, agora))
    if (atual.condição !== condiçãoApósCiclo) {
      eventos.push(montarEvento(frenteId, 'condição_mudou', atual.condição, condiçãoApósCiclo, agora))
    }
  }
  if (condiçãoApósCiclo !== condiçãoFinal) {
    eventos.push(montarEvento(frenteId, 'condição_mudou', condiçãoApósCiclo, condiçãoFinal, agora))
  }
  if (atual.cadênciaEsperada !== edição.cadênciaEsperada) {
    eventos.push(
      montarEvento(
        frenteId,
        'cadência_mudou',
        atual.cadênciaEsperada === null ? null : String(atual.cadênciaEsperada),
        edição.cadênciaEsperada === null ? null : String(edição.cadênciaEsperada),
        agora
      )
    )
  }

  const mudouAlgo = eventos.length > 0 || JSON.stringify(atual) !== JSON.stringify(atualizada)
  if (!mudouAlgo) return atual

  await storage.salvarFrente(atualizada)
  await gravarEventos(storage, 'Editar frente', ['alterações da frente salvas'], eventos)
  return atualizada
}

// ============================================================
// EXCLUSÃO EM CASCATA (destrutiva — ver nota no fim do arquivo)
// ============================================================

/**
 * Descendentes (filhos, netos...) a partir de uma lista de frentes já
 * carregada — sem tocar o storage. Mesma ordem de sempre (diretos,
 * depois os de cada direto) e protegida contra ciclo em dado corrompido.
 */
export function descendentesDe(id: string, todas: Frente[], visitados: Set<string> = new Set([id])): string[] {
  const diretos = todas.filter((f) => f.parentId === id && !visitados.has(f.id)).map((f) => f.id)
  diretos.forEach((d) => visitados.add(d))
  let todos = [...diretos]
  for (const filhoId of diretos) {
    todos = todos.concat(descendentesDe(filhoId, todas, visitados))
  }
  return todos
}

/** Todos os ids descendentes de uma frente — uma única leitura de frentes. */
export async function coletarDescendentes(id: string, storage: StorageAdapter): Promise<string[]> {
  return descendentesDe(id, await storage.getFrentes())
}

/**
 * Exclui uma frente, todos os seus descendentes e todos os registros
 * e eventos estruturais associados. Funciona igual em qualquer
 * adapter — não depende de cascade delete do banco.
 *
 * Esta continua sendo operação destrutiva separada — a 2.0 prioriza
 * arquivar (mudarCicloVida para 'arquivada') sobre excluir; esta
 * função é só para a exclusão permanente deliberada.
 *
 * Ordem: registros e eventos primeiro, frentes por último (das mais
 * profundas para a raiz). Se parar no meio, a frente-raiz ainda existe
 * e repetir a operação continua de onde parou (remoções são
 * idempotentes) — daí o ErroParcial com `completar`. Sem a frente
 * (já excluída), não faz nada.
 */
export async function excluirFrenteComFilhos(id: string, storage: StorageAdapter): Promise<void> {
  const frentes = await storage.getFrentes()
  if (!frentes.some((f) => f.id === id)) return

  const todosIds = [id, ...descendentesDe(id, frentes)]
  const conjunto = new Set(todosIds)
  const registros = (await storage.getTodosRegistros()).filter((r) => conjunto.has(r.frenteId))
  const eventos = (await storage.getTodosEventosEstruturais()).filter((e) => conjunto.has(e.frenteId))

  let removidos = 0
  const resumo = () => (removidos === 0 ? ['nada removido ainda'] : [`${removidos} item(ns) já removido(s)`])
  try {
    const trabalhos: (() => Promise<void>)[] = [
      ...registros.map((r) => () => storage.removerRegistro(r.id)),
      ...eventos.map((e) => () => storage.removerEventoEstrutural(e.id))
    ]
    const LOTE = 8
    for (let i = 0; i < trabalhos.length; i += LOTE) {
      await Promise.all(trabalhos.slice(i, i + LOTE).map((t) => t()))
      removidos += Math.min(LOTE, trabalhos.length - i)
    }
    for (const fid of [...todosIds].reverse()) {
      await storage.removerFrente(fid)
      removidos++
    }
  } catch (err) {
    throw new ErroParcial(
      'Excluir frente',
      resumo(),
      ['o restante da exclusão'],
      normalizarErro(err, 'excluir a frente'),
      () => excluirFrenteComFilhos(id, storage)
    )
  }
}
