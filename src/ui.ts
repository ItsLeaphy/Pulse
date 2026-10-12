import type { StorageAdapter } from './storage'
import type { Área, CicloVida, Condição, TipoFrente, Frente } from './types'
import { calcularSinalAgregado } from './signal'
import {
  excluirFrenteComFilhos,
  criarFrente,
  criarRegistro,
  editarRegistro,
  excluirRegistro,
  editarFrente
} from './frente-ops'
import { ErroParcial, mensagemParaUsuário, registrarDiagnóstico } from './erros'
import { comMemoDeLeitura } from './storage-leitura'
import { registrarGlobal, buscarRegistros, type FiltroRegistros } from './registro-query'
import { obterHistórico, obterRetrospectiva, formatarRetrospectiva, type Período } from './historico'
import { obterEstadoFrente } from './estado'
import { obterRitmoObservado, sugerirCadência } from './ritmo'
import { obterTendênciaFrente } from './tendencias'
import { novoId } from './id'
import {
  rotuloSinal,
  classeSinal,
  rotuloCondição,
  rotuloCicloVida,
  fraseMovimento,
  frasePausa,
  fraseDuraçãoCondição,
  fraseEvento,
  fraseClassificaçãoRitmo,
  fraseSugestãoCadência,
  rotuloTendência,
  rotuloConfiança,
  formatarData,
  escapeHtml
} from './ui/traducao'
import { obterMudançasRecentes, obterAtençãoGeral, obterDomíniosComSinalRelevante } from './ui/home-dados'

// ============================================================
// UI — FASE 2: experiência central (Home editorial + Frentes + Frente)
// Shell/linguagem visual vêm da Fase 1 (style.css). Esta fase dá
// significado a essa linguagem consumindo estado.ts/ritmo.ts/
// tendencias.ts/historico.ts — nenhuma regra de domínio é
// recriada aqui, só composição e tradução para leitura humana.
// ============================================================

const ÁREAS: Área[] = ['work', 'life', 'art']
const RÓTULO_ÁREA: Record<Área, string> = { work: 'Work', life: 'Life', art: 'Art' }
const DIA_MS = 1000 * 60 * 60 * 24

let storageRef: StorageAdapter
let mainEl: HTMLElement
/** Cada navegação/recarga incrementa; um render antigo que termina
 * depois de um novo (rede lenta + clique rápido) é descartado em vez
 * de sobrescrever a tela atual. */
let geração = 0
/** Chaves de idempotência de formulários: o id (e criadoEm) gerados na
 * primeira tentativa são reutilizados nas repetições, então um retry
 * depois de falha parcial regrava a MESMA linha em vez de duplicar. */
const chavesForm = new Map<string, { id: string; criadoEm: number }>()
let editandoRegistroId: string | null = null
/** ids de frente expandidos na tela de Frentes (árvore) — estado de
 * UI pura, nunca persistido, perdido ao navegar pra outra rota */
let expandidos = new Set<string>()

const ITENS_NAV: { rota: string; rotulo: string; raiz: boolean }[] = [
  { rota: '/', rotulo: 'Home', raiz: true },
  { rota: '/frentes', rotulo: 'Frentes', raiz: false },
  { rota: '/registrar', rotulo: 'Registrar', raiz: false },
  { rota: '/buscar', rotulo: 'Buscar', raiz: false }
]

export function renderApp(storage: StorageAdapter): void {
  storageRef = storage

  const app = document.getElementById('app')!
  app.innerHTML = `
    <div class="shell">
      <header class="shell-header">
        <a href="#/" class="marca">Pulse</a>
        <nav class="nav-desktop" id="nav-desktop"></nav>
      </header>
      <main class="shell-main" id="main"></main>
      <nav class="nav-mobile" id="nav-mobile"></nav>
      <div id="aviso" class="aviso" role="status" aria-live="polite"></div>
    </div>
  `
  mainEl = document.getElementById('main')!

  window.addEventListener('hashchange', () => {
    void rotear()
  })
  // rede de segurança: nenhuma promessa rejeitada some em silêncio
  window.addEventListener('unhandledrejection', (e) => {
    registrarDiagnóstico('executar uma ação', e.reason)
    avisar(mensagemParaUsuário(e.reason, 'concluir a ação'), true)
  })
  void rotear()
}

// ---------- AVISOS, CARGA E ERROS ----------

let timerAviso: ReturnType<typeof setTimeout> | undefined
function avisar(texto: string, erro = false): void {
  const el = document.getElementById('aviso')
  if (!el) return
  el.textContent = texto
  el.className = `aviso aviso-visivel${erro ? ' aviso-erro' : ''}`
  if (timerAviso) clearTimeout(timerAviso)
  timerAviso = setTimeout(() => {
    el.className = 'aviso'
  }, erro ? 8000 : 3000)
}

/** Pinta só se esta renderização ainda é a vigente. */
function pintar(g: number, html: string): boolean {
  if (g !== geração) return false
  mainEl.innerHTML = html
  mainEl.removeAttribute('aria-busy')
  return true
}

function chaveForm(nome: string): { id: string; criadoEm: number } {
  let c = chavesForm.get(nome)
  if (!c) {
    c = { id: novoId(), criadoEm: Date.now() }
    chavesForm.set(nome, c)
  }
  return c
}

const HTML_STATUS = `<div class="status-form" data-status aria-live="polite"></div>`

function mostrarStatus(el: Element | null, err: unknown, operação: string, aoCompletar?: () => void): void {
  if (!el) {
    avisar(mensagemParaUsuário(err, operação), true)
    return
  }
  const parcial = err instanceof ErroParcial && err.completar ? err : null
  el.innerHTML = `<div class="erro" role="alert">${escapeHtml(mensagemParaUsuário(err, operação))}${
    parcial ? ` <button type="button" data-completar>Tentar completar</button>` : ''
  }</div>`
  if (parcial) {
    el.querySelector('[data-completar]')!.addEventListener('click', () => {
      void executarAção({
        operação,
        status: el,
        tentar: parcial.completar!,
        sucesso: 'Concluído.',
        aoConcluir: aoCompletar ?? recarregar
      })
    })
  }
}

interface OpçõesAção {
  operação: string
  status: Element | null
  botão?: HTMLButtonElement | null
  tentar: () => Promise<unknown>
  aoConcluir: () => Promise<void> | void
  sucesso?: string
}

/** Executa uma ação de escrita com feedback: desabilita o botão
 * (sem duplo envio), mostra "Salvando…", e em falha mantém o
 * formulário preenchido e mostra o erro AO LADO da ação — a tela
 * nunca é substituída por causa de uma ação que falhou. */
async function executarAção(o: OpçõesAção): Promise<boolean> {
  const botão = o.botão ?? null
  const textoOriginal = botão?.textContent ?? ''
  if (botão) {
    botão.disabled = true
    botão.textContent = 'Salvando…'
  }
  if (o.status) o.status.innerHTML = ''
  try {
    await o.tentar()
  } catch (err) {
    registrarDiagnóstico(o.operação, err)
    mostrarStatus(o.status, err, o.operação, () => void o.aoConcluir())
    if (botão) {
      botão.disabled = false
      botão.textContent = textoOriginal
    }
    return false
  }
  if (botão) {
    botão.disabled = false
    botão.textContent = textoOriginal
  }
  if (o.sucesso) avisar(o.sucesso)
  try {
    await o.aoConcluir()
  } catch (err) {
    mostrarErroDeCarga(err, 'atualizar a tela')
  }
  return true
}

function rotaAtual(): string {
  return window.location.hash.replace('#', '') || '/'
}

function renderNav(): void {
  const atual = rotaAtual()
  const partes = atual.split('/').filter(Boolean)
  // /frente/:id também acende "Frentes" na nav, por ser parte dessa seção
  const rotaBase = partes[0] === 'frente' ? '/frentes' : '/' + (partes[0] ?? '')

  const linksNav = (classe: string) =>
    ITENS_NAV.map((item) => {
      const ativo = item.raiz ? atual === '/' : rotaBase === item.rota
      return `<a href="#${item.rota}" class="${classe}${ativo ? ' ativo' : ''}">${item.rotulo}</a>`
    }).join('')

  document.getElementById('nav-desktop')!.innerHTML = linksNav('')
  document.getElementById('nav-mobile')!.innerHTML = linksNav('')
}

function mostrarErroDeCarga(err: unknown, operação: string): void {
  registrarDiagnóstico(operação, err)
  mainEl.removeAttribute('aria-busy')
  mainEl.innerHTML = `
    <div class="erro" role="alert">
      <p>${escapeHtml(mensagemParaUsuário(err, operação))}</p>
      <div class="meta-row">
        <button type="button" id="btn-tentar-de-novo">Tentar de novo</button>
        <a href="#/">Ir para a Home</a>
      </div>
    </div>`
  document.getElementById('btn-tentar-de-novo')!.addEventListener('click', () => void recarregar())
}

function operaçãoDaRota(partes: string[]): string {
  if (partes.length === 0) return 'carregar a Home'
  if (partes[0] === 'frentes') return 'carregar as frentes'
  if (partes[0] === 'frente') return 'abrir a frente'
  if (partes[0] === 'registrar') return 'abrir o registro'
  if (partes[0] === 'buscar') return 'abrir a busca'
  return 'carregar a Home'
}

/** Re-renderiza a rota atual com dados novos, sem placeholder de
 * "carregando" (evita piscar depois de salvar). */
async function recarregar(): Promise<void> {
  await rotear(true)
}

async function rotear(silencioso = false): Promise<void> {
  const hash = rotaAtual()
  const partes = hash.split('/').filter(Boolean)
  const g = ++geração

  renderNav()
  mainEl.setAttribute('aria-busy', 'true')

  // "Carregando…" só aparece se a leitura demorar (rede), sem piscar
  // em leituras rápidas nem sobrescrever a tela ao recarregar após salvar
  const timerCarga = silencioso
    ? undefined
    : setTimeout(() => {
        if (g === geração) mainEl.innerHTML = `<div class="carregando" role="status">Carregando…</div>`
      }, 150)

  try {
    if (partes.length === 0) {
      await renderHome()
    } else if (partes[0] === 'frentes') {
      await renderFrentes()
    } else if (partes[0] === 'frente' && partes[1]) {
      await renderFrenteDetail(partes[1])
    } else if (partes[0] === 'registrar') {
      await renderRegistrarGlobal()
    } else if (partes[0] === 'buscar') {
      await renderBuscar()
    } else {
      await renderHome()
    }
  } catch (err) {
    if (g === geração) mostrarErroDeCarga(err, operaçãoDaRota(partes))
  } finally {
    if (timerCarga) clearTimeout(timerCarga)
  }

  if (g === geração) renderNav()
}

function ir(hash: string): void {
  editandoRegistroId = null
  window.location.hash = hash
}

// ============================================================
// HOME — leitura editorial, não dashboard. Cada seção só aparece
// se tiver conteúdo real; nenhuma seção "0 encontrados".
// ============================================================

async function renderHome(): Promise<void> {
  const g = geração
  const s = comMemoDeLeitura(storageRef)
  const agora = Date.now()
  const todasFrentes = await s.getFrentes()

  let html = `<h1>Pulse</h1>`

  if (todasFrentes.length === 0) {
    html += `<p class="subtitulo">Nenhuma frente ainda — comece criando a primeira.</p>`
    html += `<div class="acoes-rapidas"><a href="#/frentes" class="acao-rapida">Criar frente</a></div>`
    pintar(g, html)
    return
  }

  // as quatro leituras são independentes e compartilham o mesmo
  // instantâneo (frentes/registros/eventos carregados uma vez só)
  const período7d: Período = { início: agora - 7 * DIA_MS, fim: agora + 1 }
  const [emAtenção, domíniosRelevantes, mudançasRecentes, recentes] = await Promise.all([
    obterAtençãoGeral(s, agora),
    obterDomíniosComSinalRelevante(s, agora),
    obterMudançasRecentes(s, período7d),
    s.getRegistrosRecentes(6)
  ])

  // ---- 1. frentes em atenção (bloqueios, esperas, esfriando, fora do ritmo, pausa vencida) ----
  if (emAtenção.length > 0) {
    html += `<div class="secao-titulo">Merece atenção</div><div class="lista">`
    for (const item of emAtenção.slice(0, 8)) {
      const frente = todasFrentes.find((f) => f.id === item.frenteId)
      if (!frente) continue
      html += `
        <div class="item" data-id="${frente.id}">
          <div class="item-principal">
            <span class="item-titulo">${escapeHtml(frente.nome)}</span>
            <span class="item-sub">${item.motivos.map((m) => motivoAtençãoTexto(m)).join(' · ')}</span>
          </div>
        </div>`
    }
    html += `</div>`
  }

  // ---- 2. situações relevantes em domínios (com causa) ----
  if (domíniosRelevantes.length > 0) {
    html += `<div class="secao-titulo">Domínios</div><div class="lista">`
    for (const d of domíniosRelevantes) {
      const dom = todasFrentes.find((f) => f.id === d.frenteId)
      if (!dom) continue
      const nomesCausas = d.causas
        .map((id) => todasFrentes.find((f) => f.id === id)?.nome)
        .filter((n): n is string => Boolean(n))
      html += `
        <div class="item" data-id="${dom.id}">
          <div class="item-principal">
            <span class="item-titulo">${escapeHtml(dom.nome)}</span>
            <span class="item-sub">${nomesCausas.length > 0 ? 'Por causa de: ' + nomesCausas.map(escapeHtml).join(', ') : ''}</span>
          </div>
        </div>`
    }
    html += `</div>`
  }

  // ---- 3. mudanças recentes (últimos 7 dias) ----
  const totalMudanças = mudançasRecentes.mudanças.length + mudançasRecentes.frentesCriadas.length
  if (totalMudanças > 0) {
    html += `<div class="secao-titulo">Mudanças recentes</div><div class="lista">`
    const nomePorId = (id: string | null) => (id ? todasFrentes.find((f) => f.id === id)?.nome ?? '(frente removida)' : 'raiz')
    const itensOrdenados = [
      ...mudançasRecentes.mudanças.map((m) => ({ frenteId: m.frenteId, criadoEm: m.evento.criadoEm, texto: fraseEvento(m.evento, nomePorId) })),
      ...mudançasRecentes.frentesCriadas.map((m) => ({ frenteId: m.frenteId, criadoEm: m.evento.criadoEm, texto: fraseEvento(m.evento, nomePorId) }))
    ].sort((a, b) => b.criadoEm - a.criadoEm)
    for (const item of itensOrdenados.slice(0, 6)) {
      const frente = todasFrentes.find((f) => f.id === item.frenteId)
      html += `
        <div class="item" data-id="${item.frenteId}">
          <div class="item-principal">
            <span class="item-titulo">${escapeHtml(item.texto)}</span>
            <span class="item-sub">${frente ? escapeHtml(frente.nome) : ''} · ${formatarData(item.criadoEm)}</span>
          </div>
        </div>`
    }
    html += `</div>`
  }

  // ---- 4. movimentos recentes ----
  if (recentes.length > 0) {
    html += `<div class="secao-titulo">Movimentos recentes</div><div class="lista">`
    for (const r of recentes) {
      const frenteDoRegistro = todasFrentes.find((f) => f.id === r.frenteId)
      html += `
        <div class="item" data-id="${r.frenteId}">
          <div class="item-principal">
            <span class="item-titulo">${escapeHtml(r.texto)}</span>
            <span class="item-sub">${formatarData(r.data)} · ${frenteDoRegistro ? escapeHtml(frenteDoRegistro.nome) : '(frente removida)'}</span>
          </div>
        </div>`
    }
    html += `</div>`
  }

  html += `
    <hr class="separador" />
    <div class="acoes-rapidas">
      <a href="#/registrar" class="acao-rapida">Registrar</a>
      <a href="#/frentes" class="acao-rapida">Ver frentes</a>
    </div>
  `

  if (!pintar(g, html)) return
  ligarCliquesItem()
}

function motivoAtençãoTexto(m: { tipo: string; sinal?: string; condição?: Condição; diasVencida?: number }): string {
  if (m.tipo === 'sinal' && m.sinal) return rotuloSinal(m.sinal as 'esfriando' | 'fora_do_ritmo')
  if (m.tipo === 'condição' && m.condição) return rotuloCondição(m.condição)
  if (m.tipo === 'pausa_vencida' && m.diasVencida !== undefined) return `Pausa vencida há ${Math.round(m.diasVencida)} dia(s)`
  return ''
}

// ============================================================
// FRENTES — árvore navegável, expansão progressiva
// ============================================================

async function renderFrentes(): Promise<void> {
  const g = geração
  const s = comMemoDeLeitura(storageRef)
  const todasFrentes = await s.getFrentes()
  const raízesPorÁrea = (área: Área) => todasFrentes.filter((f) => f.área === área && f.parentId === null)

  let html = `<h1>Frentes</h1>`
  html += `<p class="subtitulo">A estrutura das coisas que compõem sua vida.</p>`

  for (const área of ÁREAS) {
    const raízes = raízesPorÁrea(área)
    if (raízes.length === 0) continue
    html += `<div class="secao-titulo">${RÓTULO_ÁREA[área]}</div>`
    html += `<div class="lista">`
    for (const frente of raízes) {
      html += await renderNóÁrvore(frente, todasFrentes, 0, s)
    }
    html += `</div>`
  }

  if (todasFrentes.filter((f) => f.parentId === null).length === 0) {
    html += `<div class="vazio">Nenhuma frente ainda.</div>`
  }

  html += renderFormNovaFrente(null)

  if (!pintar(g, html)) return
  ligarCliquesItem()
  ligarExpansãoÁrvore()
  ligarFormNovaFrente(null)
}

async function renderNóÁrvore(
  frente: Frente,
  todasFrentes: Frente[],
  profundidade: number,
  leitura: StorageAdapter
): Promise<string> {
  const sinal = await calcularSinalAgregado(frente.id, leitura)
  const filhos = todasFrentes.filter((f) => f.parentId === frente.id)
  const expandido = expandidos.has(frente.id)
  const indentação = profundidade > 0 ? `style="padding-left:${16 + profundidade * 20}px"` : ''

  let html = `
    <div class="item" data-id="${frente.id}" ${indentação}>
      <div class="item-principal">
        <span class="item-titulo">
          ${filhos.length > 0 ? `<a href="javascript:void(0)" class="expandir" data-expandir="${frente.id}">${expandido ? '▾' : '▸'}</a> ` : ''}
          ${escapeHtml(frente.nome)}
        </span>
        <span class="item-sub">${frente.condição !== 'normal' ? rotuloCondição(frente.condição) : frente.tipo}</span>
      </div>
      ${badgeSinal(sinal)}
    </div>`

  if (expandido) {
    for (const filho of filhos) {
      html += await renderNóÁrvore(filho, todasFrentes, profundidade + 1, leitura)
    }
  }

  return html
}

function ligarExpansãoÁrvore(): void {
  document.querySelectorAll<HTMLElement>('[data-expandir]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      const id = el.dataset.expandir!
      if (expandidos.has(id)) expandidos.delete(id)
      else expandidos.add(id)
      void recarregar()
    })
  })
}

// ============================================================
// DETALHE DE FRENTE
// "Agora" → sub-frentes → registrar → histórico → ritmo/tendência
// → retrospectiva → editar → zona de risco
// ============================================================

async function renderFrenteDetail(id: string): Promise<void> {
  const g = geração
  const s = comMemoDeLeitura(storageRef)
  const frente = await s.getFrente(id)
  if (!frente) {
    pintar(
      g,
      `<a href="#/frentes" class="voltar">← frentes</a><div class="vazio">Esta frente não existe (ou foi excluída).</div>`
    )
    return
  }

  const agora = Date.now()
  const período30d: Período = { início: agora - 30 * DIA_MS, fim: agora + 1 }
  // leituras independentes em paralelo, sobre o mesmo instantâneo
  const [estado, todasFrentes, histórico, ritmoHtml] = await Promise.all([
    obterEstadoFrente(s, id, agora),
    s.getFrentes(),
    obterHistórico(s, frente.id),
    renderRitmoETendência(frente, período30d, agora, s)
  ])
  const filhos = todasFrentes.filter((f) => f.parentId === frente.id)
  const pai = frente.parentId ? (todasFrentes.find((f) => f.id === frente.parentId) ?? null) : null
  const temRegistros = histórico.some((i) => i.tipo === 'registro')
  const sinaisFilhos = await Promise.all(filhos.map((f) => calcularSinalAgregado(f.id, s)))

  let html = `<a href="#/frentes" class="voltar">← frentes</a>`
  if (pai) html += `<div class="meta-row"><a href="#/frente/${pai.id}">${escapeHtml(pai.nome)}</a></div>`

  html += `<h1>${escapeHtml(frente.nome)}</h1>`

  // ---- "agora": leitura, não ficha técnica ----
  html += `<div class="meta-row">`
  html += badgeSinal(estado.sinal)
  if (frente.condição !== 'normal') html += badgeCondição(frente.condição)
  if (frente.cicloVida !== 'ativa') html += `<span>${rotuloCicloVida(frente.cicloVida)}</span>`
  html += `</div>`

  html += `<p class="subtitulo">${escapeHtml(fraseMovimento(estado.movimento))}</p>`

  const fraseCadência =
    frente.cadênciaEsperada !== null ? `Cadência declarada de ${frente.cadênciaEsperada} dia(s)` : null
  const fraseDuração = fraseDuraçãoCondição(frente.condição, estado.duraçãoCondição)
  const frasePausaTexto = frasePausa(estado.pausa)
  const linhasContexto = [fraseCadência, fraseDuração, frasePausaTexto].filter((l): l is string => Boolean(l))
  if (linhasContexto.length > 0) {
    html += `<p class="subtitulo">${linhasContexto.map(escapeHtml).join(' · ')}</p>`
  }

  if (frente.contextoFoco || (frente.condição === 'bloqueada' && frente.contextoBloqueio)) {
    html += `<div class="meta-row">`
    if (frente.contextoFoco) html += `<span>Foco: ${escapeHtml(frente.contextoFoco)}</span>`
    if (frente.condição === 'bloqueada' && frente.contextoBloqueio) {
      html += `<span>Bloqueio: ${escapeHtml(frente.contextoBloqueio)}</span>`
    }
    html += `</div>`
  }

  // ---- causas, se domínio com sinal relevante ----
  if (frente.tipo === 'domínio' && estado.causasDomínio.length > 0) {
    const nomesCausas = estado.causasDomínio
      .map((cid) => todasFrentes.find((f) => f.id === cid)?.nome)
      .filter((n): n is string => Boolean(n))
    if (nomesCausas.length > 0) {
      html += `<p class="subtitulo">Por causa de: ${nomesCausas.map(escapeHtml).join(', ')}</p>`
    }
  }

  // ---- sub-frentes ----
  if (filhos.length > 0) {
    html += `<h3>Sub-frentes</h3><div class="lista">`
    filhos.forEach((filho, i) => {
      html += `
        <div class="item" data-id="${filho.id}">
          <span class="item-titulo">${escapeHtml(filho.nome)}</span>
          ${badgeSinal(sinaisFilhos[i] ?? null)}
        </div>`
    })
    html += `</div>`
  }

  // ---- registrar ----
  html += `<h3>Registrar</h3>`
  html += `
    <form id="form-registro">
      <label>O que aconteceu?
        <textarea id="reg-texto" rows="2" required></textarea>
      </label>
      <label>Quando aconteceu? (deixe em branco para agora)
        <input type="datetime-local" id="reg-data" />
      </label>
      <label><input type="checkbox" id="reg-conta" checked /> Conta como movimento</label>
      <button type="submit">Salvar</button>
      ${HTML_STATUS}
    </form>
  `

  // ---- histórico, traduzido ----
  html += `<h3>Histórico</h3><div id="status-historico" class="status-form" aria-live="polite"></div>`
  if (!temRegistros && histórico.length === 0) {
    html += `<div class="vazio">Nenhum registro ainda.</div>`
  } else {
    if (!temRegistros) html += `<div class="vazio">Nenhum registro ainda.</div>`
    const nomePorId = (nid: string | null) => (nid ? todasFrentes.find((f) => f.id === nid)?.nome ?? '(frente removida)' : 'raiz')
    for (const item of histórico) {
      if (item.tipo === 'registro') {
        const r = item.registro
        if (r.id === editandoRegistroId) {
          html += `
            <div class="registro">
              <form class="form-editar-registro" data-id="${r.id}">
                <label><textarea class="er-texto" rows="2">${escapeHtml(r.texto)}</textarea></label>
                <label><input type="checkbox" class="er-conta" ${r.contaComoMovimento ? 'checked' : ''} /> Conta como movimento</label>
                <div class="meta-row">
                  <button type="submit">Salvar</button>
                  <button type="button" class="er-cancelar">Cancelar</button>
                </div>
                ${HTML_STATUS}
              </form>
            </div>`
        } else {
          html += `
            <div class="registro">
              <div class="registro-data">${formatarData(r.data)}${r.contaComoMovimento ? '' : ' · observação'}</div>
              <div class="registro-texto${r.contaComoMovimento ? '' : ' registro-observacao'}">${escapeHtml(r.texto)}</div>
              <div class="meta-row">
                <a href="javascript:void(0)" class="acao-editar-registro" data-id="${r.id}">editar</a>
                <a href="javascript:void(0)" class="acao-excluir-registro" data-id="${r.id}">excluir</a>
              </div>
            </div>`
        }
      } else {
        html += `
          <div class="registro">
            <div class="registro-data">${formatarData(item.evento.criadoEm)}</div>
            <div class="registro-texto registro-observacao">${escapeHtml(fraseEvento(item.evento, nomePorId))}</div>
          </div>`
      }
    }
  }

  // ---- ritmo e tendência, só quando há evidência ----
  if (ritmoHtml) html += ritmoHtml

  // ---- retrospectiva ----
  html += `<h3>Retrospectiva</h3>`
  html += `
    <form id="form-retrospectiva">
      <label>Período
        <select id="retro-período">
          <option value="7">Últimos 7 dias</option>
          <option value="30">Últimos 30 dias</option>
          <option value="90">Últimos 90 dias</option>
        </select>
      </label>
      <button type="submit">Ver retrospectiva</button>
    </form>
    <div id="retro-resultado" aria-live="polite"></div>
  `

  html += renderFormNovaFrente(frente.id, 'Adicionar sub-frente')

  // ---- editar ----
  html += renderFormEditarFrente(frente)

  // ---- zona de risco ----
  const avisoFilhos = filhos.length > 0 ? ` e ${filhos.length} sub-frente(s)` : ''
  html += `<h3>Zona de risco</h3>`
  html += `<button id="btn-excluir-frente" type="button" class="botao-perigo">Excluir "${escapeHtml(frente.nome)}"${avisoFilhos}</button>`
  html += `<div id="status-excluir" class="status-form" aria-live="polite"></div>`

  if (!pintar(g, html)) return

  ligarCliquesItem()
  ligarFormNovaFrente(frente.id)
  ligarFormEditarFrente(frente)
  ligarFormRegistro(frente)
  ligarAçõesRegistro(frente)
  ligarFormRetrospectiva(frente)
  ligarExclusãoFrente(frente, filhos.length, pai)
}

/** Ritmo observado + tendência — só renderiza algo quando há
 * evidência real (nunca "evidência insuficiente" ocupando espaço
 * sem necessidade: se não há cadência declarada e menos de 2
 * movimentos, a seção inteira some). */
async function renderRitmoETendência(
  frente: Frente,
  período: Período,
  agora: number,
  leitura: StorageAdapter
): Promise<string | null> {
  if (frente.tipo === 'domínio') return null // domínio não tem ritmo próprio

  const [ritmo, tendência] = await Promise.all([
    obterRitmoObservado(leitura, frente.id, período),
    obterTendênciaFrente(leitura, frente.id, período)
  ])

  if (ritmo.classificação === 'evidência_insuficiente' && tendência.tendência === 'insuficiente_evidência') {
    return null
  }

  let html = `<h3>Ritmo</h3>`
  if (ritmo.classificação !== 'evidência_insuficiente' && ritmo.intervaloMédioDias !== null) {
    html += `<p class="subtitulo">Ritmo observado: aproximadamente ${Math.round(ritmo.intervaloMédioDias)} dia(s) entre movimentos — ${escapeHtml(fraseClassificaçãoRitmo(ritmo.classificação))}</p>`

    const calibração = await sugerirCadência(leitura, frente.id, período)
    if (calibração.sugestão !== 'compatível' && calibração.sugestão !== 'evidência_insuficiente') {
      html += `<p class="subtitulo">${escapeHtml(fraseSugestãoCadência(calibração.sugestão))}</p>`
    }
  }

  if (tendência.tendência !== 'insuficiente_evidência') {
    html += `<p class="subtitulo">Tendência: ${escapeHtml(rotuloTendência(tendência.tendência))} <span class="item-sub">(${escapeHtml(rotuloConfiança(tendência.confiança))})</span></p>`
  }

  void agora
  return html
}

function renderFormEditarFrente(frente: Frente): string {
  return `
    <h3>Editar frente</h3>
    <form id="form-editar-frente">
      <label>Nome
        <input type="text" id="ef-nome" value="${escapeHtml(frente.nome)}" required />
      </label>
      <label>Área
        <select id="ef-área">
          <option value="work" ${frente.área === 'work' ? 'selected' : ''}>Work</option>
          <option value="life" ${frente.área === 'life' ? 'selected' : ''}>Life</option>
          <option value="art" ${frente.área === 'art' ? 'selected' : ''}>Art</option>
        </select>
      </label>
      <label>Tipo
        <select id="ef-tipo">
          <option value="projeto" ${frente.tipo === 'projeto' ? 'selected' : ''}>Projeto</option>
          <option value="prática" ${frente.tipo === 'prática' ? 'selected' : ''}>Prática</option>
          <option value="domínio" ${frente.tipo === 'domínio' ? 'selected' : ''}>Domínio</option>
        </select>
      </label>
      <label>Ciclo de vida
        <select id="ef-ciclo-vida">
          <option value="ativa" ${frente.cicloVida === 'ativa' ? 'selected' : ''}>Ativa</option>
          <option value="concluída" ${frente.cicloVida === 'concluída' ? 'selected' : ''}>Concluída</option>
          <option value="arquivada" ${frente.cicloVida === 'arquivada' ? 'selected' : ''}>Arquivada</option>
        </select>
      </label>
      <label>Condição
        <select id="ef-condição">
          <option value="normal" ${frente.condição === 'normal' ? 'selected' : ''}>Normal</option>
          <option value="bloqueada" ${frente.condição === 'bloqueada' ? 'selected' : ''}>Bloqueada</option>
          <option value="aguardando" ${frente.condição === 'aguardando' ? 'selected' : ''}>Aguardando</option>
          <option value="pausada" ${frente.condição === 'pausada' ? 'selected' : ''}>Pausada</option>
        </select>
      </label>
      <label>Cadência esperada em dias (em branco para domínio sem cadência própria)
        <input type="number" id="ef-cadência" value="${frente.cadênciaEsperada ?? ''}" min="1" />
      </label>
      <label>Foco atual
        <input type="text" id="ef-foco" value="${escapeHtml(frente.contextoFoco ?? '')}" />
      </label>
      <label>Bloqueio (se condição = bloqueada)
        <input type="text" id="ef-bloqueio" value="${escapeHtml(frente.contextoBloqueio ?? '')}" />
      </label>
      <button type="submit">Salvar alterações</button>
      ${HTML_STATUS}
    </form>
  `
}

function ligarFormEditarFrente(frente: Frente): void {
  const form = document.getElementById('form-editar-frente') as HTMLFormElement
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const valor = (id: string) => (document.getElementById(id) as HTMLInputElement).value
    const cadênciaStr = valor('ef-cadência').trim()
    const edição = {
      nome: valor('ef-nome').trim(),
      área: valor('ef-área') as Área,
      tipo: valor('ef-tipo') as TipoFrente,
      cicloVida: valor('ef-ciclo-vida') as CicloVida,
      condição: valor('ef-condição') as Condição,
      cadênciaEsperada: cadênciaStr === '' ? null : Number(cadênciaStr),
      contextoFoco: valor('ef-foco').trim() || null,
      contextoBloqueio: valor('ef-bloqueio').trim() || null
    }
    void executarAção({
      operação: 'salvar as alterações da frente',
      botão: form.querySelector<HTMLButtonElement>('button[type="submit"]'),
      status: form.querySelector('[data-status]'),
      tentar: () => editarFrente(storageRef, frente.id, edição),
      sucesso: 'Alterações salvas.',
      aoConcluir: recarregar
    })
  })
}

function ligarFormRegistro(frente: Frente): void {
  const form = document.getElementById('form-registro') as HTMLFormElement
  const chave = `registro:${frente.id}`
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const texto = (document.getElementById('reg-texto') as HTMLTextAreaElement).value.trim()
    const contaComoMovimento = (document.getElementById('reg-conta') as HTMLInputElement).checked
    const dataStr = (document.getElementById('reg-data') as HTMLInputElement).value
    const data = dataStr ? new Date(dataStr).getTime() : Date.now()
    if (!texto) return
    // id e criadoEm fixos entre tentativas: repetir após falha parcial
    // regrava o MESMO registro (upsert), nunca cria um segundo
    const { id, criadoEm } = chaveForm(chave)

    void executarAção({
      operação: 'salvar o registro',
      botão: form.querySelector<HTMLButtonElement>('button[type="submit"]'),
      status: form.querySelector('[data-status]'),
      tentar: () => criarRegistro(storageRef, { id, criadoEm, frenteId: frente.id, data, texto, contaComoMovimento }),
      sucesso: 'Registro salvo.',
      aoConcluir: async () => {
        chavesForm.delete(chave)
        await recarregar()
      }
    })
  })
}

function ligarAçõesRegistro(frente: Frente): void {
  const statusHistórico = () => document.getElementById('status-historico')

  document.querySelectorAll<HTMLElement>('.acao-editar-registro').forEach((el) => {
    el.addEventListener('click', () => {
      editandoRegistroId = el.dataset.id!
      void recarregar()
    })
  })

  document.querySelectorAll<HTMLElement>('.acao-excluir-registro').forEach((el) => {
    el.addEventListener('click', () => {
      if (!confirm('Excluir este registro? Não dá pra desfazer.')) return
      void executarAção({
        operação: 'excluir o registro',
        status: statusHistórico(),
        tentar: () => excluirRegistro(storageRef, el.dataset.id!, frente.id),
        sucesso: 'Registro excluído.',
        aoConcluir: recarregar
      })
    })
  })

  document.querySelectorAll<HTMLFormElement>('.form-editar-registro').forEach((form) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const idRegistro = form.dataset.id!
      const texto = (form.querySelector('.er-texto') as HTMLTextAreaElement).value.trim()
      const contaComoMovimento = (form.querySelector('.er-conta') as HTMLInputElement).checked
      if (!texto) return
      void executarAção({
        operação: 'salvar o registro',
        botão: form.querySelector<HTMLButtonElement>('button[type="submit"]'),
        status: form.querySelector('[data-status]'),
        tentar: () => editarRegistro(storageRef, idRegistro, { texto, contaComoMovimento }, frente.id),
        sucesso: 'Registro atualizado.',
        aoConcluir: async () => {
          editandoRegistroId = null
          await recarregar()
        }
      })
    })
    form.querySelector('.er-cancelar')!.addEventListener('click', () => {
      editandoRegistroId = null
      void recarregar()
    })
  })
}

function ligarFormRetrospectiva(frente: Frente): void {
  const form = document.getElementById('form-retrospectiva') as HTMLFormElement
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const dias = Number((document.getElementById('retro-período') as HTMLSelectElement).value)
    const agora = Date.now()
    const período: Período = { início: agora - dias * DIA_MS, fim: agora + 1 }
    const área = document.getElementById('retro-resultado')!

    void executarAção({
      operação: 'montar a retrospectiva',
      botão: form.querySelector<HTMLButtonElement>('button[type="submit"]'),
      status: área,
      tentar: async () => {
        const leitura = comMemoDeLeitura(storageRef)
        const retro = await obterRetrospectiva(leitura, frente.id, período)
        const texto = await formatarRetrospectiva(leitura, retro)
        // formatarRetrospectiva retorna Markdown simples (#, ##, -) —
        // renderização mínima linha a linha, sem introduzir parser novo
        área.innerHTML = texto
          .split('\n')
          .map((linha) => {
            if (linha.startsWith('## ')) return `<h3>${escapeHtml(linha.slice(3))}</h3>`
            if (linha.startsWith('# ')) return ''
            if (linha.startsWith('- ')) return `<p class="subtitulo">${escapeHtml(linha.slice(2))}</p>`
            if (linha.startsWith('_') && linha.endsWith('_')) return `<p class="vazio">${escapeHtml(linha.slice(1, -1))}</p>`
            return linha ? `<p>${escapeHtml(linha)}</p>` : ''
          })
          .join('')
      },
      aoConcluir: () => undefined
    })
  })
}

function ligarExclusãoFrente(frente: Frente, qtdFilhos: number, pai: Frente | null | undefined): void {
  document.getElementById('btn-excluir-frente')!.addEventListener('click', () => {
    const aviso =
      qtdFilhos > 0
        ? `Isso vai apagar "${frente.nome}", suas ${qtdFilhos} sub-frente(s) e todos os registros associados. Não dá pra desfazer. Confirma?`
        : `Isso vai apagar "${frente.nome}" e todos os seus registros. Não dá pra desfazer. Confirma?`
    if (!confirm(aviso)) return
    void executarAção({
      operação: 'excluir a frente',
      botão: document.getElementById('btn-excluir-frente') as HTMLButtonElement,
      status: document.getElementById('status-excluir'),
      tentar: () => excluirFrenteComFilhos(frente.id, storageRef),
      sucesso: 'Frente excluída.',
      aoConcluir: () => ir(pai ? `/frente/${pai.id}` : '/frentes')
    })
  })
}

// ---------- FORM: NOVA FRENTE ----------

function renderFormNovaFrente(parentId: string | null, título = 'Nova frente'): string {
  return `
    <h3>${título}</h3>
    <form id="form-nova-frente" data-parent="${parentId ?? ''}">
      <label>Nome
        <input type="text" id="nf-nome" required />
      </label>
      <label>Área
        <select id="nf-área">
          <option value="work">Work</option>
          <option value="life">Life</option>
          <option value="art">Art</option>
        </select>
      </label>
      <label>Tipo
        <select id="nf-tipo">
          <option value="projeto">Projeto (tem escopo, pode terminar)</option>
          <option value="prática">Prática (recorrente, sem fim)</option>
          <option value="domínio">Domínio (agrupa outras frentes)</option>
        </select>
      </label>
      <label>Cadência esperada em dias
        <input type="number" id="nf-cadência" value="7" min="1" required />
      </label>
      <button type="submit">Criar</button>
      ${HTML_STATUS}
    </form>
  `
}

function ligarFormNovaFrente(parentId: string | null): void {
  const form = document.getElementById('form-nova-frente') as HTMLFormElement | null
  if (!form) return
  const chave = `nova-frente:${parentId ?? 'raiz'}`

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const nome = (document.getElementById('nf-nome') as HTMLInputElement).value.trim()
    const área = (document.getElementById('nf-área') as HTMLSelectElement).value as Área
    const tipo = (document.getElementById('nf-tipo') as HTMLSelectElement).value as TipoFrente
    const cadênciaEsperada = Number((document.getElementById('nf-cadência') as HTMLInputElement).value)
    if (!nome) return
    // mesmo id entre tentativas: repetir após falha parcial completa a
    // MESMA frente (criarFrente é idempotente por id), sem duplicar
    const { id, criadoEm } = chaveForm(chave)

    void executarAção({
      operação: 'criar a frente',
      botão: form.querySelector<HTMLButtonElement>('button[type="submit"]'),
      status: form.querySelector('[data-status]'),
      tentar: () =>
        criarFrente(storageRef, {
          id,
          criadaEm: criadoEm,
          nome,
          área,
          tipo,
          parentId,
          cicloVida: 'ativa',
          condição: 'normal',
          cadênciaEsperada,
          contextoFoco: null,
          contextoBloqueio: null,
          pausaMotivo: null,
          pausaRetomadaEm: null
        }),
      sucesso: 'Frente criada.',
      aoConcluir: async () => {
        chavesForm.delete(chave)
        await recarregar()
      }
    })
  })
}

// ---------- HELPERS DE RENDERIZAÇÃO ----------

function badgeSinal(sinal: Parameters<typeof rotuloSinal>[0]): string {
  return `<span class="badge badge-sinal-${classeSinal(sinal)}">${rotuloSinal(sinal)}</span>`
}

function badgeCondição(condição: Condição): string {
  if (condição === 'normal') return ''
  return `<span class="badge badge-condicao-${condição}">${rotuloCondição(condição)}</span>`
}

function ligarCliquesItem(): void {
  document.querySelectorAll<HTMLElement>('.item[data-id]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-expandir]')) return
      ir(`/frente/${el.dataset.id}`)
    })
  })
}

// ---------- REGISTRAR (captura global) ----------

async function renderRegistrarGlobal(): Promise<void> {
  const g = geração
  const todasFrentes = await storageRef.getFrentes()
  const ordenadas = [...todasFrentes].sort((a, b) => a.nome.localeCompare(b.nome))

  let html = `<a href="#/" class="voltar">← voltar</a>`
  html += `<h1>Registrar</h1>`

  if (ordenadas.length === 0) {
    html += `<div class="vazio">Nenhuma frente criada ainda — crie uma frente primeiro.</div>`
    pintar(g, html)
    return
  }

  html += `
    <form id="form-registrar-global">
      <label>Frente
        <select id="rg-frente" required>
          ${ordenadas.map((f) => `<option value="${f.id}">${escapeHtml(f.nome)}</option>`).join('')}
        </select>
      </label>
      <label>O que aconteceu?
        <textarea id="rg-texto" required></textarea>
      </label>
      <label><input type="checkbox" id="rg-conta" checked /> Conta como movimento</label>
      <label>Quando aconteceu? (deixe em branco para agora)
        <input type="datetime-local" id="rg-data" />
      </label>
      <button type="submit">Registrar</button>
      ${HTML_STATUS}
    </form>
  `

  if (!pintar(g, html)) return

  const formGlobal = document.getElementById('form-registrar-global') as HTMLFormElement
  formGlobal.addEventListener('submit', (e) => {
    e.preventDefault()
    const frenteId = (document.getElementById('rg-frente') as HTMLSelectElement).value
    const texto = (document.getElementById('rg-texto') as HTMLTextAreaElement).value.trim()
    const contaComoMovimento = (document.getElementById('rg-conta') as HTMLInputElement).checked
    const dataStr = (document.getElementById('rg-data') as HTMLInputElement).value
    const data = dataStr ? new Date(dataStr).getTime() : undefined
    if (!texto) return

    const chave = `registro-global:${frenteId}`
    const { id, criadoEm } = chaveForm(chave)

    void executarAção({
      operação: 'salvar o registro',
      botão: formGlobal.querySelector<HTMLButtonElement>('button[type="submit"]'),
      status: formGlobal.querySelector('[data-status]'),
      tentar: () => registrarGlobal(storageRef, { frenteId, texto, contaComoMovimento, data, id, criadoEm }),
      sucesso: 'Registro salvo.',
      aoConcluir: () => {
        chavesForm.delete(chave)
        ir(`/frente/${frenteId}`)
      }
    })
  })
}

// ---------- BUSCAR ----------

async function renderBuscar(filtrosIniciais: FiltroRegistros = {}): Promise<void> {
  const g = geração
  const todasFrentes = await storageRef.getFrentes()
  const ordenadas = [...todasFrentes].sort((a, b) => a.nome.localeCompare(b.nome))

  let html = `<a href="#/" class="voltar">← voltar</a>`
  html += `<h1>Buscar</h1>`

  html += `
    <form id="form-buscar">
      <label>Texto
        <input type="text" id="bs-texto" value="${escapeHtml(filtrosIniciais.texto ?? '')}" />
      </label>
      <label>Frente (todas, se vazio)
        <select id="bs-frente">
          <option value="">(todas)</option>
          ${ordenadas.map((f) => `<option value="${f.id}" ${filtrosIniciais.frenteId === f.id ? 'selected' : ''}>${escapeHtml(f.nome)}</option>`).join('')}
        </select>
      </label>
      <label><input type="checkbox" id="bs-descendentes" ${filtrosIniciais.incluirDescendentes ? 'checked' : ''} /> Incluir descendentes</label>
      <label>Ordem
        <select id="bs-ordem">
          <option value="decrescente" ${filtrosIniciais.ordem !== 'crescente' ? 'selected' : ''}>Mais recente primeiro</option>
          <option value="crescente" ${filtrosIniciais.ordem === 'crescente' ? 'selected' : ''}>Mais antigo primeiro</option>
        </select>
      </label>
      <button type="submit">Buscar</button>
    </form>
    <div id="bs-resultados"></div>
  `

  if (!pintar(g, html)) return

  const frentesPorId = new Map(todasFrentes.map((f) => [f.id, f]))

  async function executarBusca(filtros: FiltroRegistros): Promise<void> {
    const area = document.getElementById('bs-resultados')!
    let resultados
    try {
      resultados = await buscarRegistros(comMemoDeLeitura(storageRef), filtros)
    } catch (err) {
      registrarDiagnóstico('buscar registros', err)
      mostrarStatus(area, err, 'buscar registros', () => void executarBusca(filtros))
      return
    }
    if (resultados.length === 0) {
      area.innerHTML = `<div class="vazio">Nenhum registro encontrado.</div>`
      return
    }
    area.innerHTML = resultados
      .map((r) => {
        const nomeFrente = frentesPorId.get(r.frenteId)?.nome ?? '(frente removida)'
        return `
          <div class="registro">
            <div class="registro-data">${formatarData(r.data)} · ${escapeHtml(nomeFrente)}${r.contaComoMovimento ? '' : ' · observação'}</div>
            <div class="registro-texto">${escapeHtml(r.texto)}</div>
          </div>
        `
      })
      .join('')
  }

  if (filtrosIniciais.texto || filtrosIniciais.frenteId) {
    void executarBusca(filtrosIniciais)
  }

  document.getElementById('form-buscar')!.addEventListener('submit', (e) => {
    e.preventDefault()
    const texto = (document.getElementById('bs-texto') as HTMLInputElement).value.trim()
    const frenteId = (document.getElementById('bs-frente') as HTMLSelectElement).value
    const incluirDescendentes = (document.getElementById('bs-descendentes') as HTMLInputElement).checked
    const ordem = (document.getElementById('bs-ordem') as HTMLSelectElement).value as 'crescente' | 'decrescente'

    void executarBusca({
      texto: texto || undefined,
      frenteId: frenteId || undefined,
      incluirDescendentes: frenteId ? incluirDescendentes : undefined,
      ordem
    })
  })
}
