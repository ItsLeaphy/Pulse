import type { StorageAdapter } from './storage'
import type { Área, Frente, TipoFrente } from './types'
import { calcularSinalAgregado, registrarMovimento, registrarToque } from './signal'
import { novoId } from './id'

// ============================================================
// UI — FASE 3
// Casca funcional, sem identidade visual. Objetivo: dá pra usar
// de verdade por alguns dias antes de qualquer decisão estética.
// A Fase 4 troca a aparência daqui sem tocar em storage.ts/signal.ts.
// ============================================================

const ÁREAS: Área[] = ['work', 'life', 'art']
const RÓTULO_ÁREA: Record<Área, string> = { work: 'WORK', life: 'LIFE', art: 'ART' }
const RÓTULO_SINAL: Record<string, string> = {
  no_ritmo: 'no ritmo',
  esfriando: 'esfriando',
  fora_do_ritmo: 'fora do ritmo',
  hibernando: 'hibernando'
}

let root: HTMLElement
let storageRef: StorageAdapter

export function renderApp(storage: StorageAdapter): void {
  storageRef = storage
  root = document.getElementById('app')!
  window.addEventListener('hashchange', rotear)
  rotear()
}

function rotear(): void {
  const hash = window.location.hash.replace('#', '') || '/'
  const partes = hash.split('/').filter(Boolean)

  if (partes.length === 0) {
    renderHome()
  } else if (partes[0] === 'frente' && partes[1]) {
    renderFrenteDetail(partes[1])
  } else {
    renderHome()
  }
}

function ir(hash: string): void {
  window.location.hash = hash
}

// ---------- HOME ----------

function renderHome(): void {
  const todasFrentes = storageRef.getFrentes()
  const raízesPorÁrea = (área: Área) =>
    todasFrentes.filter((f) => f.área === área && f.parentId === null)

  let html = `<h1>Controle Pessoal</h1>`
  html += `<p class="meta-row">O que está acontecendo com as coisas que fazem parte da minha vida.</p>`

  for (const área of ÁREAS) {
    const raízes = raízesPorÁrea(área)
    html += `<div class="área-título">${RÓTULO_ÁREA[área]} — ${raízes.length} frente(s)</div>`

    if (raízes.length === 0) {
      html += `<div class="vazio">Nenhuma frente ainda.</div>`
    }

    for (const frente of raízes) {
      const sinal = calcularSinalAgregado(frente.id, storageRef)
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

  html += renderFormNovaFrente(null)

  root.innerHTML = html
  ligarCliquesFrenteCard()
  ligarFormNovaFrente(null)
}

// ---------- DETALHE DE FRENTE ----------

function renderFrenteDetail(id: string): void {
  const frente = storageRef.getFrente(id)
  if (!frente) {
    renderHome()
    return
  }

  // abrir uma frente conta como toque, não como movimento real
  storageRef.salvarFrente(registrarToque(frente))

  const sinal = calcularSinalAgregado(frente.id, storageRef)
  const registros = storageRef.getRegistros(frente.id)
  const filhos = storageRef.getFrentes().filter((f) => f.parentId === frente.id)
  const pai = frente.parentId ? storageRef.getFrente(frente.parentId) : null

  let html = `<span class="voltar" id="voltar">← voltar</span>`
  if (pai) html += `<div class="meta-row">em ${escapeHtml(pai.nome)}</div>`

  html += `<h1>${escapeHtml(frente.nome)}</h1>`
  html += `
    <div class="meta-row">
      <span class="sinal sinal-${sinal}">${RÓTULO_SINAL[sinal]}</span>
      <span>tipo: ${frente.tipo}</span>
      <span>estado: ${frente.estado}</span>
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

  if (filhos.length > 0) {
    html += `<h3>Sub-frentes</h3>`
    for (const filho of filhos) {
      const sinalFilho = calcularSinalAgregado(filho.id, storageRef)
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
    html += `
      <div class="registro">
        <div class="registro-data">${formatarData(r.data)} ${r.contaComoMovimento ? '· movimento' : '· nota'}</div>
        <div>${escapeHtml(r.texto)}</div>
      </div>`
  }

  root.innerHTML = html

  document.getElementById('voltar')!.addEventListener('click', () => ir('/'))
  ligarCliquesFrenteCard()
  ligarFormNovaFrente(frente.id)

  document.getElementById('opt-out')!.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked
    const atual = storageRef.getFrente(frente.id)!
    storageRef.salvarFrente({ ...atual, optOutNegligência: checked })
    renderFrenteDetail(frente.id)
  })

  document.getElementById('form-registro')!.addEventListener('submit', (e) => {
    e.preventDefault()
    const texto = (document.getElementById('reg-texto') as HTMLTextAreaElement).value.trim()
    const contaComoMovimento = (document.getElementById('reg-conta') as HTMLInputElement).checked
    if (!texto) return

    storageRef.salvarRegistro({
      id: novoId(),
      frenteId: frente.id,
      data: Date.now(),
      texto,
      contaComoMovimento
    })

    const atual = storageRef.getFrente(frente.id)!
    const atualizada = contaComoMovimento ? registrarMovimento(atual) : registrarToque(atual)
    storageRef.salvarFrente(atualizada)

    renderFrenteDetail(frente.id)
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
    storageRef.salvarFrente(frente)

    if (parentId) {
      renderFrenteDetail(parentId)
    } else {
      renderHome()
    }
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

function formatarData(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
}

function escapeHtml(s: string): string {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}
