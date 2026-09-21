import type { StorageAdapter } from './storage'
import type { Área, EstadoFrente, Frente, TipoFrente } from './types'
import { calcularSinalAgregado, registrarMovimento, registrarToque } from './signal'
import { excluirFrenteComFilhos } from './frente-ops'
import { novoId } from './id'

// ============================================================
// UI — FASE 3 (+ storage assíncrono, feed de recentes, CRUD completo)
// Casca funcional, sem identidade visual. A Fase 4 troca a
// aparência daqui sem tocar em storage.ts/signal.ts/frente-ops.ts.
// ============================================================

const ÁREAS: Área[] = ['work', 'life', 'art']
const RÓTULO_ÁREA: Record<Área, string> = { work: 'WORK', life: 'LIFE', art: 'ART' }
const RÓTULO_SINAL: Record<string, string> = {
  no_ritmo: 'no ritmo',
  esfriando: 'esfriando',
  fora_do_ritmo: 'fora do ritmo',
  hibernando: 'hibernando'
}
const RÓTULO_ESTADO: Record<EstadoFrente, string> = {
  ativa: 'Ativa',
  pausada_por_decisão: 'Pausada por decisão',
  arquivada: 'Arquivada'
}

let root: HTMLElement
let storageRef: StorageAdapter

/** id do registro em edição inline no momento — null quando nenhum está aberto */
let editandoRegistroId: string | null = null

export function renderApp(storage: StorageAdapter): void {
  storageRef = storage
  root = document.getElementById('app')!
  window.addEventListener('hashchange', () => {
    rotear().catch(mostrarErro)
  })
  rotear().catch(mostrarErro)
}

function mostrarErro(err: unknown): void {
  console.error(err)
  root.innerHTML = `<p style="color:#a12a2a">Erro: ${err instanceof Error ? err.message : String(err)}</p>`
}

async function rotear(): Promise<void> {
  const hash = window.location.hash.replace('#', '') || '/'
  const partes = hash.split('/').filter(Boolean)

  if (partes.length === 0) {
    await renderHome()
  } else if (partes[0] === 'frente' && partes[1]) {
    await renderFrenteDetail(partes[1])
  } else {
    await renderHome()
  }
}

function ir(hash: string): void {
  editandoRegistroId = null
  window.location.hash = hash
}

// ---------- HOME ----------

async function renderHome(): Promise<void> {
  const todasFrentes = await storageRef.getFrentes()
  const raízesPorÁrea = (área: Área) => todasFrentes.filter((f) => f.área === área && f.parentId === null)

  let html = `<h1>Pulse</h1>`
  html += `<p class="meta-row">O que está acontecendo com as coisas que fazem parte da minha vida.</p>`

  for (const área of ÁREAS) {
    const raízes = raízesPorÁrea(área)
    html += `<div class="área-título">${RÓTULO_ÁREA[área]} — ${raízes.length} frente(s)</div>`

    if (raízes.length === 0) {
      html += `<div class="vazio">Nenhuma frente ainda.</div>`
    }

    for (const frente of raízes) {
      const sinal = await calcularSinalAgregado(frente.id, storageRef)
      const filhos = todasFrentes.filter((f) => f.parentId === frente.id)
      html += `
        <div class="frente-card" data-id="${frente.id}">
          <div>
            <strong>${escapeHtml(frente.nome)}</strong>
            ${filhos.length > 0 ? `<span class="meta-row" style="display:inline">· ${filhos.length} sub-frente(s)</span>` : ''}
          </div>
          <span class="sinal sinal-${sinal}">${RÓTULO_SINAL[sinal]}</span>
        </div>`
    }
  }

  html += `<div class="área-título">MOVIMENTOS RECENTES</div>`
  const recentes = await storageRef.getRegistrosRecentes(8)
  if (recentes.length === 0) {
    html += `<div class="vazio">Nenhum movimento registrado ainda.</div>`
  }
  for (const r of recentes) {
    const frenteDoRegistro = todasFrentes.find((f) => f.id === r.frenteId)
    const nomeFrente = frenteDoRegistro ? frenteDoRegistro.nome : '(frente removida)'
    html += `
      <div class="registro" data-id="${r.frenteId}" style="cursor:pointer">
        <div class="registro-data">${formatarData(r.data)} · ${escapeHtml(nomeFrente)} ${r.contaComoMovimento ? '· movimento' : '· nota'}</div>
        <div>${escapeHtml(r.texto)}</div>
      </div>`
  }

  html += renderFormNovaFrente(null)

  root.innerHTML = html
  ligarCliquesFrenteCard()
  ligarCliquesRegistroRecente()
  ligarFormNovaFrente(null)
}

// ---------- DETALHE DE FRENTE ----------

async function renderFrenteDetail(id: string): Promise<void> {
  const frente = await storageRef.getFrente(id)
  if (!frente) {
    await renderHome()
    return
  }

  // abrir uma frente conta como toque, não como movimento real
  await storageRef.salvarFrente(registrarToque(frente))

  const sinal = await calcularSinalAgregado(frente.id, storageRef)
  const registros = await storageRef.getRegistros(frente.id)
  const todasFrentes = await storageRef.getFrentes()
  const filhos = todasFrentes.filter((f) => f.parentId === frente.id)
  const pai = frente.parentId ? await storageRef.getFrente(frente.parentId) : null

  let html = `<span class="voltar" id="voltar">← voltar</span>`
  if (pai) html += `<div class="meta-row">em ${escapeHtml(pai.nome)}</div>`

  html += `<h1>${escapeHtml(frente.nome)}</h1>`
  html += `
    <div class="meta-row">
      <span class="sinal sinal-${sinal}">${RÓTULO_SINAL[sinal]}</span>
      <span>tipo: ${frente.tipo}</span>
      <span>estado: ${RÓTULO_ESTADO[frente.estado]}</span>
      <span>cadência: ${frente.cadênciaEsperada}d</span>
      <span>último movimento: ${frente.últimoMovimento ? formatarData(frente.últimoMovimento) : 'nunca'}</span>
    </div>
  `

  html += `
    <label>
      <input type="checkbox" id="opt-out" ${frente.optOutNegligência ? 'checked' : ''} />
      hibernando (não avisar sobre negligência)
    </label>
  `

  // ---- editar frente ----
  html += `
    <h3>Editar frente</h3>
    <form id="form-editar-frente">
      <label>Nome</label>
      <input type="text" id="ef-nome" value="${escapeHtml(frente.nome)}" required />

      <label>Área</label>
      <select id="ef-área">
        <option value="work" ${frente.área === 'work' ? 'selected' : ''}>Work</option>
        <option value="life" ${frente.área === 'life' ? 'selected' : ''}>Life</option>
        <option value="art" ${frente.área === 'art' ? 'selected' : ''}>Art</option>
      </select>

      <label>Tipo</label>
      <select id="ef-tipo">
        <option value="projeto" ${frente.tipo === 'projeto' ? 'selected' : ''}>Projeto</option>
        <option value="prática" ${frente.tipo === 'prática' ? 'selected' : ''}>Prática</option>
        <option value="domínio" ${frente.tipo === 'domínio' ? 'selected' : ''}>Domínio</option>
      </select>

      <label>Estado</label>
      <select id="ef-estado">
        <option value="ativa" ${frente.estado === 'ativa' ? 'selected' : ''}>Ativa</option>
        <option value="pausada_por_decisão" ${frente.estado === 'pausada_por_decisão' ? 'selected' : ''}>Pausada por decisão</option>
        <option value="arquivada" ${frente.estado === 'arquivada' ? 'selected' : ''}>Arquivada</option>
      </select>

      <label>Cadência esperada (dias entre movimentos)</label>
      <input type="number" id="ef-cadência" value="${frente.cadênciaEsperada}" min="1" required />

      <button type="submit">Salvar alterações</button>
    </form>
  `

  if (filhos.length > 0) {
    html += `<h3>Sub-frentes</h3>`
    for (const filho of filhos) {
      const sinalFilho = await calcularSinalAgregado(filho.id, storageRef)
      html += `
        <div class="frente-card" data-id="${filho.id}">
          <strong>${escapeHtml(filho.nome)}</strong>
          <span class="sinal sinal-${sinalFilho}">${RÓTULO_SINAL[sinalFilho]}</span>
        </div>`
    }
  }

  html += renderFormNovaFrente(frente.id, 'Adicionar sub-frente')

  html += `<h3>Registrar movimento</h3>`
  html += `
    <form id="form-registro">
      <label>O que aconteceu?</label>
      <textarea id="reg-texto" rows="2" required></textarea>
      <label><input type="checkbox" id="reg-conta" checked /> conta como movimento real (reseta o relógio de negligência)</label>
      <button type="submit">Salvar registro</button>
    </form>
  `

  html += `<h3>Histórico</h3>`
  if (registros.length === 0) {
    html += `<div class="vazio">Nenhum registro ainda.</div>`
  }
  for (const r of registros) {
    if (r.id === editandoRegistroId) {
      html += `
        <div class="registro">
          <form class="form-editar-registro" data-id="${r.id}">
            <textarea class="er-texto" rows="2">${escapeHtml(r.texto)}</textarea>
            <label><input type="checkbox" class="er-conta" ${r.contaComoMovimento ? 'checked' : ''} /> conta como movimento</label>
            <button type="submit">Salvar</button>
            <button type="button" class="er-cancelar">Cancelar</button>
          </form>
        </div>`
    } else {
      html += `
        <div class="registro">
          <div class="registro-data">${formatarData(r.data)} ${r.contaComoMovimento ? '· movimento' : '· nota'}</div>
          <div>${escapeHtml(r.texto)}</div>
          <div class="meta-row">
            <span class="acao-editar-registro" data-id="${r.id}" style="cursor:pointer;text-decoration:underline">editar</span>
            <span class="acao-excluir-registro" data-id="${r.id}" style="cursor:pointer;text-decoration:underline">excluir</span>
          </div>
        </div>`
    }
  }

  // ---- excluir frente (por último, é destrutivo) ----
  const avisoFilhos = filhos.length > 0 ? ` e ${filhos.length} sub-frente(s)` : ''
  html += `
    <h3>Zona de risco</h3>
    <button id="btn-excluir-frente" type="button" style="background:#a12a2a">
      Excluir "${escapeHtml(frente.nome)}"${avisoFilhos}
    </button>
  `

  root.innerHTML = html

  document.getElementById('voltar')!.addEventListener('click', () => ir('/'))
  ligarCliquesFrenteCard()
  ligarFormNovaFrente(frente.id)

  document.getElementById('opt-out')!.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked
    void (async () => {
      const atual = await storageRef.getFrente(frente.id)
      if (!atual) return
      await storageRef.salvarFrente({ ...atual, optOutNegligência: checked })
      await renderFrenteDetail(frente.id)
    })()
  })

  document.getElementById('form-editar-frente')!.addEventListener('submit', (e) => {
    e.preventDefault()
    const nome = (document.getElementById('ef-nome') as HTMLInputElement).value.trim()
    const área = (document.getElementById('ef-área') as HTMLSelectElement).value as Área
    const tipo = (document.getElementById('ef-tipo') as HTMLSelectElement).value as TipoFrente
    const estado = (document.getElementById('ef-estado') as HTMLSelectElement).value as EstadoFrente
    const cadênciaEsperada = Number((document.getElementById('ef-cadência') as HTMLInputElement).value)
    if (!nome) return

    void (async () => {
      const atual = await storageRef.getFrente(frente.id)
      if (!atual) return
      await storageRef.salvarFrente({ ...atual, nome, área, tipo, estado, cadênciaEsperada })
      await renderFrenteDetail(frente.id)
    })()
  })

  document.getElementById('form-registro')!.addEventListener('submit', (e) => {
    e.preventDefault()
    const texto = (document.getElementById('reg-texto') as HTMLTextAreaElement).value.trim()
    const contaComoMovimento = (document.getElementById('reg-conta') as HTMLInputElement).checked
    if (!texto) return

    void (async () => {
      await storageRef.salvarRegistro({
        id: novoId(),
        frenteId: frente.id,
        data: Date.now(),
        texto,
        contaComoMovimento
      })

      const atual = await storageRef.getFrente(frente.id)
      if (atual) {
        const atualizada = contaComoMovimento ? registrarMovimento(atual) : registrarToque(atual)
        await storageRef.salvarFrente(atualizada)
      }

      await renderFrenteDetail(frente.id)
    })()
  })

  // ---- ações de registro: editar / excluir ----
  document.querySelectorAll<HTMLElement>('.acao-editar-registro').forEach((el) => {
    el.addEventListener('click', () => {
      editandoRegistroId = el.dataset.id!
      void renderFrenteDetail(frente.id)
    })
  })

  document.querySelectorAll<HTMLElement>('.acao-excluir-registro').forEach((el) => {
    el.addEventListener('click', () => {
      if (!confirm('Excluir este registro? Não dá pra desfazer.')) return
      void (async () => {
        await storageRef.removerRegistro(el.dataset.id!)
        await renderFrenteDetail(frente.id)
      })()
    })
  })

  document.querySelectorAll<HTMLFormElement>('.form-editar-registro').forEach((form) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const idRegistro = form.dataset.id!
      const texto = (form.querySelector('.er-texto') as HTMLTextAreaElement).value.trim()
      const contaComoMovimento = (form.querySelector('.er-conta') as HTMLInputElement).checked
      if (!texto) return

      void (async () => {
        const todos = await storageRef.getRegistros(frente.id)
        const alvo = todos.find((r) => r.id === idRegistro)
        if (!alvo) return
        await storageRef.salvarRegistro({ ...alvo, texto, contaComoMovimento })
        editandoRegistroId = null
        await renderFrenteDetail(frente.id)
      })()
    })

    form.querySelector('.er-cancelar')!.addEventListener('click', () => {
      editandoRegistroId = null
      void renderFrenteDetail(frente.id)
    })
  })

  // ---- excluir frente ----
  document.getElementById('btn-excluir-frente')!.addEventListener('click', () => {
    const aviso =
      filhos.length > 0
        ? `Isso vai apagar "${frente.nome}", suas ${filhos.length} sub-frente(s) e todos os registros associados. Não dá pra desfazer. Confirma?`
        : `Isso vai apagar "${frente.nome}" e todos os seus registros. Não dá pra desfazer. Confirma?`
    if (!confirm(aviso)) return

    void (async () => {
      await excluirFrenteComFilhos(frente.id, storageRef)
      ir(pai ? `/frente/${pai.id}` : '/')
    })()
  })
}

// ---------- FORM: NOVA FRENTE ----------

function renderFormNovaFrente(parentId: string | null, título = 'Nova frente'): string {
  return `
    <h3>${título}</h3>
    <form id="form-nova-frente" data-parent="${parentId ?? ''}">
      <label>Nome</label>
      <input type="text" id="nf-nome" required />

      <label>Área</label>
      <select id="nf-área">
        <option value="work">Work</option>
        <option value="life">Life</option>
        <option value="art">Art</option>
      </select>

      <label>Tipo</label>
      <select id="nf-tipo">
        <option value="projeto">Projeto (tem escopo, pode terminar)</option>
        <option value="prática">Prática (recorrente, sem fim)</option>
        <option value="domínio">Domínio (agrupa outras frentes)</option>
      </select>

      <label>Cadência esperada (dias entre movimentos)</label>
      <input type="number" id="nf-cadência" value="7" min="1" required />

      <button type="submit">Criar</button>
    </form>
  `
}

function ligarFormNovaFrente(parentId: string | null): void {
  const form = document.getElementById('form-nova-frente') as HTMLFormElement | null
  if (!form) return

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const nome = (document.getElementById('nf-nome') as HTMLInputElement).value.trim()
    const área = (document.getElementById('nf-área') as HTMLSelectElement).value as Área
    const tipo = (document.getElementById('nf-tipo') as HTMLSelectElement).value as TipoFrente
    const cadênciaEsperada = Number((document.getElementById('nf-cadência') as HTMLInputElement).value)
    if (!nome) return

    const agora = Date.now()
    const frente: Frente = {
      id: novoId(),
      nome,
      área,
      tipo,
      parentId,
      estado: 'ativa',
      cadênciaEsperada,
      últimoToque: agora,
      últimoMovimento: null,
      optOutNegligência: false,
      criadaEm: agora
    }

    void (async () => {
      await storageRef.salvarFrente(frente)
      if (parentId) {
        await renderFrenteDetail(parentId)
      } else {
        await renderHome()
      }
    })()
  })
}

// ---------- HELPERS ----------

function ligarCliquesFrenteCard(): void {
  document.querySelectorAll<HTMLElement>('.frente-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.dataset.id!
      ir(`/frente/${id}`)
    })
  })
}

function ligarCliquesRegistroRecente(): void {
  document.querySelectorAll<HTMLElement>('.registro[data-id]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.id!
      ir(`/frente/${id}`)
    })
  })
}

function formatarData(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
}

function escapeHtml(s: string): string {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}
