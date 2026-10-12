import { test, expect, type Page } from '@playwright/test'

// Mobile e desktop: sem rolagem horizontal, navegação e controles
// alcançáveis, nada coberto pela navegação fixa.

const DIA = 86_400_000

async function semear(page: Page): Promise<string> {
  const agora = Date.now()
  const frentes = [
    { id: 'dom', nome: 'Darkline (domínio com nome bem comprido para testar quebra de linha em telas pequenas)', área: 'work', tipo: 'domínio', parentId: null, cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: null, últimoMovimento: null, contextoFoco: 'Estruturando a pesquisa e resolvendo a validação com usuários reais', contextoBloqueio: null, pausaMotivo: null, pausaRetomadaEm: null, criadaEm: agora - 60 * DIA },
    { id: 'p1', nome: 'Origens', área: 'work', tipo: 'projeto', parentId: 'dom', cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: 7, últimoMovimento: agora - 20 * DIA, contextoFoco: null, contextoBloqueio: null, pausaMotivo: null, pausaRetomadaEm: null, criadaEm: agora - 60 * DIA },
    { id: 'p2', nome: 'MEA', área: 'work', tipo: 'projeto', parentId: 'dom', cicloVida: 'ativa', condição: 'bloqueada', cadênciaEsperada: 7, últimoMovimento: agora - 2 * DIA, contextoFoco: null, contextoBloqueio: 'Sem acesso aos usuários', pausaMotivo: null, pausaRetomadaEm: null, criadaEm: agora - 60 * DIA },
    { id: 'p3', nome: 'Violino', área: 'art', tipo: 'prática', parentId: null, cicloVida: 'ativa', condição: 'pausada', cadênciaEsperada: 3, últimoMovimento: agora - 9 * DIA, contextoFoco: null, contextoBloqueio: null, pausaMotivo: 'Férias', pausaRetomadaEm: agora - 2 * DIA, criadaEm: agora - 60 * DIA },
    { id: 'p4', nome: 'Antigo', área: 'life', tipo: 'projeto', parentId: null, cicloVida: 'arquivada', condição: 'normal', cadênciaEsperada: 7, últimoMovimento: null, contextoFoco: null, contextoBloqueio: null, pausaMotivo: null, pausaRetomadaEm: null, criadaEm: agora - 90 * DIA }
  ]
  const registros = Array.from({ length: 40 }, (_, i) => ({
    id: `r${i}`, frenteId: i % 2 ? 'p1' : 'p2', data: agora - (i + 3) * DIA, criadoEm: agora - (i + 3) * DIA,
    texto: `Registro ${i} — um texto razoavelmente longo para forçar quebra de linha dentro do cartão e verificar que nada vaza para fora da tela no celular`,
    contaComoMovimento: i % 5 !== 0
  }))
  const eventos = frentes.map((f, i) => ({ id: `e${i}`, frenteId: f.id, tipo: 'criação', valorAnterior: null, valorNovo: null, criadoEm: f.criadaEm }))
  await page.addInitScript(
    ([f, r, e]) => {
      if (!localStorage.getItem('controle-pessoal:frentes')) {
        localStorage.setItem('controle-pessoal:frentes', JSON.stringify(f))
        localStorage.setItem('controle-pessoal:registros', JSON.stringify(r))
        localStorage.setItem('controle-pessoal:eventos-estruturais', JSON.stringify(e))
      }
    },
    [frentes, registros, eventos] as const
  )
  return 'p1'
}

const ROTAS = (id: string) => ['#/', '#/frentes', `#/frente/${id}`, `#/frente/dom`, '#/registrar', '#/buscar']

for (const viewport of [
  { nome: 'mobile 390×844', width: 390, height: 844 },
  { nome: 'mobile pequeno 320×568', width: 320, height: 568 },
  { nome: 'desktop 1280×800', width: 1280, height: 800 }
]) {
  test.describe(viewport.nome, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test('todas as rotas: sem rolagem horizontal e sem [object Object]', async ({ page }) => {
      const id = await semear(page)
      for (const rota of ROTAS(id)) {
        await page.goto(`./${rota}`)
        await expect(page.locator('main h1, main .erro, main .vazio').first()).toBeVisible()
        const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))
        expect(sw, `rolagem horizontal em ${rota}`).toBeLessThanOrEqual(iw)
        await expect(page.locator('body')).not.toContainText('[object Object]')
        await expect(page.locator('main .erro')).toHaveCount(0)
      }
    })

    test('navegação principal visível e funcional; conteúdo final não fica atrás dela', async ({ page }) => {
      const id = await semear(page)
      await page.goto(`./#/frente/${id}`)
      const nav = viewport.width >= 720 ? page.locator('#nav-desktop') : page.locator('#nav-mobile')
      await expect(nav).toBeVisible()
      for (const rótulo of ['Home', 'Frentes', 'Registrar', 'Buscar']) {
        await expect(nav.getByText(rótulo, { exact: true })).toBeVisible()
      }
      // vai ao fim da página: o último controle (excluir) precisa estar acima da nav fixa
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      const botão = page.locator('#btn-excluir-frente')
      await expect(botão).toBeInViewport()
      if (viewport.width < 720) {
        const b = (await botão.boundingBox())!
        const n = (await nav.boundingBox())!
        expect(b.y + b.height, 'botão coberto pela navegação móvel').toBeLessThanOrEqual(n.y + 1)
      }
      await nav.getByText('Buscar', { exact: true }).click()
      await expect(page).toHaveURL(/#\/buscar/)
    })

    test('formulários e botões alcançáveis (dentro da largura da tela)', async ({ page }) => {
      const id = await semear(page)
      for (const rota of [`#/frente/${id}`, '#/frentes', '#/registrar', '#/buscar']) {
        await page.goto(`./${rota}`)
        const caixas = await page.locator('main button, main input:not([type=checkbox]), main select, main textarea').evaluateAll((els) =>
          els.map((e) => {
            const r = e.getBoundingClientRect()
            return { x: r.x, w: r.width, h: r.height, id: (e as HTMLElement).id || e.tagName }
          })
        )
        expect(caixas.length).toBeGreaterThan(0)
        for (const c of caixas) {
          expect(c.x, `${c.id} sai pela esquerda em ${rota}`).toBeGreaterThanOrEqual(-1)
          expect(c.x + c.w, `${c.id} sai pela direita em ${rota}`).toBeLessThanOrEqual(viewport.width + 1)
          expect(c.h, `${c.id} sem altura em ${rota}`).toBeGreaterThan(0)
        }
      }
    })

    test('Home mostra atenção (bloqueada, pausa vencida, fora do ritmo) sem listar tudo', async ({ page }) => {
      await semear(page)
      await page.goto('./#/')
      await expect(page.getByText('Merece atenção')).toBeVisible()
      await expect(page.locator('.item', { hasText: 'MEA' }).first()).toBeVisible()
      await expect(page.locator('.item', { hasText: 'Violino' }).first()).toBeVisible()
      await expect(page.locator('.item', { hasText: 'Antigo' })).toHaveCount(0) // arquivada nunca em atenção
    })
  })
}
