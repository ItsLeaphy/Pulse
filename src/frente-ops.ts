import type { StorageAdapter } from './storage'

// ============================================================
// OPERAÇÕES DE FRENTE
// Lógica que coordena múltiplas chamadas de storage. Fica fora
// da UI (que só deve renderizar e delegar) e fora de storage.ts
// (que só deve ler/escrever uma linha por vez).
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
 * associados. Funciona igual em qualquer adapter — não depende de
 * cascade delete do banco (o schema do Supabase até tem, mas o
 * localStorage não, então a lógica fica aqui pra ser idêntica nos dois).
 */
export async function excluirFrenteComFilhos(id: string, storage: StorageAdapter): Promise<void> {
  const descendentes = await coletarDescendentes(id, storage)
  const todosIds = [id, ...descendentes]

  for (const fid of todosIds) {
    const registros = await storage.getRegistros(fid)
    for (const r of registros) {
      await storage.removerRegistro(r.id)
    }
  }

  // exclui dos mais profundos pra raiz — mais seguro em bancos sem cascade
  for (const fid of [...todosIds].reverse()) {
    await storage.removerFrente(fid)
  }
}
