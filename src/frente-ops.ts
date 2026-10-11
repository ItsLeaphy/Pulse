import type { StorageAdapter } from './storage'
import type { Frente, Registro, CicloVida, Condição, EventoEstrutural } from './types'
import { novoId } from './id'

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
export async function registrarEvento(
  storage: StorageAdapter,
  frenteId: string,
  tipo: EventoEstrutural['tipo'],
  valorAnterior: string | null,
  valorNovo: string | null,
  agora: number = Date.now()
): Promise<void> {
  const evento: EventoEstrutural = {
    id: novoId(),
    frenteId,
    tipo,
    valorAnterior,
    valorNovo,
    criadoEm: agora
  }
  await storage.salvarEventoEstrutural(evento)
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
  await recalcularÚltimoMovimento(storage, registro.frenteId)
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
  mudanças: Partial<Omit<Registro, 'id' | 'frenteId'>>
): Promise<Registro> {
  const atual = await encontrarRegistro(storage, id)
  if (!atual) throw new Error(`Registro ${id} não encontrado`)

  const atualizado: Registro = { ...atual, ...mudanças }
  await storage.salvarRegistro(atualizado)
  await recalcularÚltimoMovimento(storage, atualizado.frenteId)
  return atualizado
}

/** Exclui um registro e recalcula o cache da frente associada. */
export async function excluirRegistro(storage: StorageAdapter, id: string): Promise<void> {
  const atual = await encontrarRegistro(storage, id)
  if (!atual) return // já não existe — nada a fazer

  await storage.removerRegistro(id)
  await recalcularÚltimoMovimento(storage, atual.frenteId)
}

/**
 * StorageAdapter não tem getRegistro(id) — só getRegistros(frenteId).
 * editarRegistro/excluirRegistro recebem só o id, então precisam
 * achar a frente dona do registro primeiro. Isso varre todas as
 * frentes; aceitável no volume de dados do Pulse (uso pessoal),
 * mas é o primeiro lugar a revisar se a escala crescer muito.
 */
async function encontrarRegistro(storage: StorageAdapter, id: string): Promise<Registro | undefined> {
  const frentes = await storage.getFrentes()
  for (const f of frentes) {
    const registros = await storage.getRegistros(f.id)
    const achado = registros.find((r) => r.id === id)
    if (achado) return achado
  }
  return undefined
}

// ============================================================
// FRENTE — criação e mudanças de dimensão de estado
// ============================================================

/**
 * Cria uma frente nova e já grava o evento de criação correspondente.
 */
export async function criarFrente(
  storage: StorageAdapter,
  dados: Omit<Frente, 'criadaEm' | 'últimoMovimento'> & { criadaEm?: number }
): Promise<Frente> {
  const agora = dados.criadaEm ?? Date.now()
  const frente: Frente = {
    ...dados,
    criadaEm: agora,
    últimoMovimento: null
  }
  await storage.salvarFrente(frente)
  await registrarEvento(storage, frente.id, 'criação', null, null, agora)
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
  await registrarEvento(storage, frenteId, 'ciclo_vida_mudou', atual.cicloVida, novoCicloVida, agora)
  if (condiçãoMudou) {
    await registrarEvento(storage, frenteId, 'condição_mudou', atual.condição, novaCondição, agora)
  }
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
  if (atual.cicloVida !== 'ativa') {
    throw new Error(
      `Frente ${frenteId} não está ativa (cicloVida=${atual.cicloVida}) — condição operacional não se aplica`
    )
  }
  if (atual.condição === novaCondição) return atual

  const atualizada: Frente = { ...atual, condição: novaCondição }
  await storage.salvarFrente(atualizada)
  await registrarEvento(storage, frenteId, 'condição_mudou', atual.condição, novaCondição, agora)
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

  const atualizada: Frente = { ...atual, cadênciaEsperada: novaCadência }
  await storage.salvarFrente(atualizada)
  await registrarEvento(
    storage,
    frenteId,
    'cadência_mudou',
    atual.cadênciaEsperada === null ? null : String(atual.cadênciaEsperada),
    novaCadência === null ? null : String(novaCadência),
    agora
  )
  return atualizada
}

// ============================================================
// EXCLUSÃO EM CASCATA (destrutiva — ver nota no fim do arquivo)
// ============================================================

/** Sobe a árvore recursivamente coletando todos os ids descendentes de uma frente. */
export async function coletarDescendentes(id: string, storage: StorageAdapter): Promise<string[]> {
  const todas = await storage.getFrentes()
  const diretos = todas.filter((f) => f.parentId === id).map((f) => f.id)

  let todos = [...diretos]
  for (const filhoId of diretos) {
    todos = todos.concat(await coletarDescendentes(filhoId, storage))
  }
  return todos
}

/**
 * Exclui uma frente, todos os seus descendentes e todos os registros
 * e eventos estruturais associados. Funciona igual em qualquer
 * adapter — não depende de cascade delete do banco.
 *
 * Esta continua sendo operação destrutiva separada — a 2.0 prioriza
 * arquivar (mudarCicloVida para 'arquivada') sobre excluir; esta
 * função é só para a exclusão permanente deliberada.
 */
export async function excluirFrenteComFilhos(id: string, storage: StorageAdapter): Promise<void> {
  const descendentes = await coletarDescendentes(id, storage)
  const todosIds = [id, ...descendentes]

  for (const fid of todosIds) {
    const registros = await storage.getRegistros(fid)
    for (const r of registros) {
      await storage.removerRegistro(r.id)
    }
    const eventos = await storage.getEventosEstruturais(fid)
    for (const e of eventos) {
      await storage.removerEventoEstrutural(e.id)
    }
  }

  // exclui dos mais profundos pra raiz — mais seguro em bancos sem cascade
  for (const fid of [...todosIds].reverse()) {
    await storage.removerFrente(fid)
  }
}
