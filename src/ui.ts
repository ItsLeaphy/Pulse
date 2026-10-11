import type { StorageAdapter } from './storage'
import type { Área, CicloVida, Condição, TipoFrente, Frente } from './types'
import { calcularSinalAgregado } from './signal'
import {
  excluirFrenteComFilhos,
  criarFrente,
  criarRegistro,
  editarRegistro,
  excluirRegistro,
  mudarCicloVida,
  mudarCondição,
  mudarCadência
} from './frente-ops'
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
    </div>
  `
  mainEl = document.getElementById('main')!

  window.addEventListener('hashchange', () => {
    rotear().catch(mostrarErro)
  })
  rotear().catch(mostrarErro)
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

function mostrarErro(err: unknown): void {
  console.error(err)
  const mensagem = err instanceof Error ? err.message : String(err)
  mainEl.innerHTML = `<div class="erro">Algo deu errado: ${escapeHtml(mensagem)}</div>`
}

async function rotear(): Promise<void> {
  const hash = rotaAtual()
  const partes = hash.split('/').filter(Boolean)

  renderNav()

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

  renderNav()
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
  const agora = Date.now()
  const todasFrentes = await storageRef.getFrentes()

  let html = `<h1>Pulse</h1>`

  if (todasFrentes.length === 0) {
    html += `<p class="subtitulo">Nenhuma frente ainda — comece criando a primeira.</p>`
    html += `<div class="acoes-rapidas"><a href="#/frentes" class="acao-rapida">Criar frente</a></div>`
    mainEl.innerHTML = html
    return
  }

  // ---- 1. frentes em atenção (bloqueios, esperas, esfriando, fora do ritmo, pausa vencida) ----
  const emAtenção = await obterAtençãoGeral(storageRef, agora)
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
  const domíniosRelevantes = await obterDomíniosComSinalRelevante(storageRef, agora)
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
  const período7d: Período = { início: agora - 7 * DIA_MS, fim: agora + 1 }
  const mudançasRecentes = await obterMudançasRecentes(storageRef, período7d)
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
  const recentes = await storageRef.getRegistrosRecentes(6)
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

  mainEl.innerHTML = html
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
  const todasFrentes = await storageRef.getFrentes()
  const raízesPorÁrea = (área: Área) => todasFrentes.filter((f) => f.área === área && f.parentId === null)

  let html = `<h1>Frentes</h1>`
  html += `<p class="subtitulo">A estrutura das coisas que compõem sua vida.</p>`

  for (const área of ÁREAS) {
    const raízes = raízesPorÁrea(área)
    if (raízes.length === 0) continue
    html += `<div class="secao-titulo">${RÓTULO_ÁREA[área]}</div>`
    html += `<div class="lista">`
    for (const frente of raízes) {
      html += await renderNóÁrvore(frente, todasFrentes, 0)
    }
    html += `</div>`
  }

  if (todasFrentes.filter((f) => f.parentId === null).length === 0) {
    html += `<div class="vazio">Nenhuma frente ainda.</div>`
  }

  html += renderFormNovaFrente(null)

  mainEl.innerHTML = html
  ligarCliquesItem()
  ligarExpansãoÁrvore()
  ligarFormNovaFrente(null)
}

async function renderNóÁrvore(frente: Frente, todasFrentes: Frente[], profundidade: number): Promise<string> {
  const sinal = await calcularSinalAgregado(frente.id, storageRef)
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
      html += await renderNóÁrvore(filho, todasFrentes, profundidade + 1)
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
      void renderFrentes()
    })
  })
}

// ============================================================
// DETALHE DE FRENTE
// "Agora" → sub-frentes → registrar → histórico → ritmo/tendência
// → retrospectiva → editar → zona de risco
// ============================================================

async function renderFrenteDetail(id: string): Promise<void> {
  const frente = await storageRef.getFrente(id)
  if (!frente) {
    await renderHome()
    return
  }

  const agora = Date.now()
  const estado = await obterEstadoFrente(storageRef, id, agora)
  const registros = await storageRef.getRegistros(frente.id)
  const todasFrentes = await storageRef.getFrentes()
  const filhos = todasFrentes.filter((f) => f.parentId === frente.id)
  const pai = frente.parentId ? await storageRef.getFrente(frente.parentId) : null

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
    for (const filho of filhos) {
      const sinalFilho = await calcularSinalAgregado(filho.id, storageRef)
      html += `
        <div class="item" data-id="${filho.id}">
          <span class="item-titulo">${escapeHtml(filho.nome)}</span>
          ${badgeSinal(sinalFilho)}
        </div>`
    }
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
    </form>
  `

  // ---- histórico, traduzido ----
  html += `<h3>Histórico</h3>`
  if (registros.length === 0) {
    html += `<div class="vazio">Nenhum registro ainda.</div>`
  } else {
    const nomePorId = (nid: string | null) => (nid ? todasFrentes.find((f) => f.id === nid)?.nome ?? '(frente removida)' : 'raiz')
    const histórico = await obterHistórico(storageRef, frente.id)
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
  const período30d: Período = { início: agora - 30 * DIA_MS, fim: agora + 1 }
  const ritmoHtml = await renderRitmoETendência(frente, período30d, agora)
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
    <div id="retro-resultado"></div>
  `

  html += renderFormNovaFrente(frente.id, 'Adicionar sub-frente')

  // ---- editar ----
  html += renderFormEditarFrente(frente)

  // ---- zona de risco ----
  const avisoFilhos = filhos.length > 0 ? ` e ${filhos.length} sub-frente(s)` : ''
  html += `<h3>Zona de risco</h3>`
  html += `<button id="btn-excluir-frente" type="button" class="botao-perigo">Excluir "${escapeHtml(frente.nome)}"${avisoFilhos}</button>`

  mainEl.innerHTML = html

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
async function renderRitmoETendência(frente: Frente, período: Período, agora: number): Promise<string | null> {
  if (frente.tipo === 'domínio') return null // domínio não tem ritmo próprio

  const ritmo = await obterRitmoObservado(storageRef, frente.id, período)
  const tendência = await obterTendênciaFrente(storageRef, frente.id, período)

  if (ritmo.classificação === 'evidência_insuficiente' && tendência.tendência === 'insuficiente_evidência') {
    return null
  }

  let html = `<h3>Ritmo</h3>`
  if (ritmo.classificação !== 'evidência_insuficiente' && ritmo.intervaloMédioDias !== null) {
    html += `<p class="subtitulo">Ritmo observado: aproximadamente ${Math.round(ritmo.intervaloMédioDias)} dia(s) entre movimentos — ${escapeHtml(fraseClassificaçãoRitmo(ritmo.classificação))}</p>`

    const calibração = await sugerirCadência(storageRef, frente.id, período)
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
    </form>
  `
}

function ligarFormEditarFrente(frente: Frente): void {
  document.getElementById('form-editar-frente')!.addEventListener('submit', (e) => {
    e.preventDefault()
    const nome = (document.getElementById('ef-nome') as HTMLInputElement).value.trim()
    const área = (document.getElementById('ef-área') as HTMLSelectElement).value as Área
    const tipo = (document.getElementById('ef-tipo') as HTMLSelectElement).value as TipoFrente
    const cicloVida = (document.getElementById('ef-ciclo-vida') as HTMLSelectElement).value as CicloVida
    const condição = (document.getElementById('ef-condição') as HTMLSelectElement).value as Condição
    const cadênciaStr = (document.getElementById('ef-cadência') as HTMLInputElement).value
    const cadênciaEsperada = cadênciaStr.trim() === '' ? null : Number(cadênciaStr)
    const contextoFoco = (document.getElementById('ef-foco') as HTMLInputElement).value.trim() || null
    const contextoBloqueio = (document.getElementById('ef-bloqueio') as HTMLInputElement).value.trim() || null
    if (!nome) return

    void (async () => {
      const atual = await storageRef.getFrente(frente.id)
      if (!atual) return
      await storageRef.salvarFrente({ ...atual, nome, área, tipo, contextoFoco, contextoBloqueio })
      await mudarCicloVida(storageRef, frente.id, cicloVida)
      await mudarCondição(storageRef, frente.id, condição)
      await mudarCadência(storageRef, frente.id, cadênciaEsperada)
      await renderFrenteDetail(frente.id)
    })()
  })
}

function ligarFormRegistro(frente: Frente): void {
  document.getElementById('form-registro')!.addEventListener('submit', (e) => {
    e.preventDefault()
    const texto = (document.getElementById('reg-texto') as HTMLTextAreaElement).value.trim()
    const contaComoMovimento = (document.getElementById('reg-conta') as HTMLInputElement).checked
    const dataStr = (document.getElementById('reg-data') as HTMLInputElement).value
    const data = dataStr ? new Date(dataStr).getTime() : Date.now()
    if (!texto) return

    void (async () => {
      await criarRegistro(storageRef, { frenteId: frente.id, data, texto, contaComoMovimento })
      await renderFrenteDetail(frente.id)
    })()
  })
}

function ligarAçõesRegistro(frente: Frente): void {
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
        await excluirRegistro(storageRef, el.dataset.id!)
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
        await editarRegistro(storageRef, idRegistro, { texto, contaComoMovimento })
        editandoRegistroId = null
        await renderFrenteDetail(frente.id)
      })()
    })
    form.querySelector('.er-cancelar')!.addEventListener('click', () => {
      editandoRegistroId = null
      void renderFrenteDetail(frente.id)
    })
  })
}

function ligarFormRetrospectiva(frente: Frente): void {
  document.getElementById('form-retrospectiva')!.addEventListener('submit', (e) => {
    e.preventDefault()
    const dias = Number((document.getElementById('retro-período') as HTMLSelectElement).value)
    const agora = Date.now()
    const período: Período = { início: agora - dias * DIA_MS, fim: agora + 1 }

    void (async () => {
      const retro = await obterRetrospectiva(storageRef, frente.id, período)
      const texto = await formatarRetrospectiva(storageRef, retro)
      const área = document.getElementById('retro-resultado')!
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
    })()
  })
}

function ligarExclusãoFrente(frente: Frente, qtdFilhos: number, pai: Frente | null | undefined): void {
  document.getElementById('btn-excluir-frente')!.addEventListener('click', () => {
    const aviso =
      qtdFilhos > 0
        ? `Isso vai apagar "${frente.nome}", suas ${qtdFilhos} sub-frente(s) e todos os registros associados. Não dá pra desfazer. Confirma?`
        : `Isso vai apagar "${frente.nome}" e todos os seus registros. Não dá pra desfazer. Confirma?`
    if (!confirm(aviso)) return
    void (async () => {
      await excluirFrenteComFilhos(frente.id, storageRef)
      ir(pai ? `/frente/${pai.id}` : '/frentes')
    })()
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

    void (async () => {
      await criarFrente(storageRef, {
        id: novoId(),
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
      })
      if (parentId) {
        await renderFrenteDetail(parentId)
      } else {
        await renderFrentes()
      }
    })()
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
  const todasFrentes = await storageRef.getFrentes()
  const ordenadas = [...todasFrentes].sort((a, b) => a.nome.localeCompare(b.nome))

  let html = `<a href="#/" class="voltar">← voltar</a>`
  html += `<h1>Registrar</h1>`

  if (ordenadas.length === 0) {
    html += `<div class="vazio">Nenhuma frente criada ainda — crie uma frente primeiro.</div>`
    mainEl.innerHTML = html
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
    </form>
    <div id="rg-status"></div>
  `

  mainEl.innerHTML = html

  document.getElementById('form-registrar-global')!.addEventListener('submit', (e) => {
    e.preventDefault()
    const frenteId = (document.getElementById('rg-frente') as HTMLSelectElement).value
    const texto = (document.getElementById('rg-texto') as HTMLTextAreaElement).value.trim()
    const contaComoMovimento = (document.getElementById('rg-conta') as HTMLInputElement).checked
    const dataStr = (document.getElementById('rg-data') as HTMLInputElement).value
    const data = dataStr ? new Date(dataStr).getTime() : undefined
    if (!texto) return

    void (async () => {
      try {
        await registrarGlobal(storageRef, { frenteId, texto, contaComoMovimento, data })
        ir(`/frente/${frenteId}`)
      } catch (err) {
        document.getElementById('rg-status')!.innerHTML =
          `<div class="erro">${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`
      }
    })()
  })
}

// ---------- BUSCAR ----------

async function renderBuscar(filtrosIniciais: FiltroRegistros = {}): Promise<void> {
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

  mainEl.innerHTML = html

  const frentesPorId = new Map(todasFrentes.map((f) => [f.id, f]))

  async function executarBusca(filtros: FiltroRegistros): Promise<void> {
    const resultados = await buscarRegistros(storageRef, filtros)
    const area = document.getElementById('bs-resultados')!
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
