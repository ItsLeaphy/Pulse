import { test, expect, type Page } from '@playwright/test'
import { instalarSimulador, sim, lerStore } from './helpers'

// Fluxos essenciais ponta a ponta no navegador real (build de produção,
// modo local). Cada teste começa com localStorage vazio.

test.beforeEach(async ({ page }) => {
  await instalarSimulador(page)
})

const aviso = (page: Page) => page.locator('#aviso')

async function criarFrente(page: Page, nome: string, tipo: 'projeto' | 'prática' | 'domínio', cadência = '7') {
  await page.locator('[id="nf-nome"]').fill(nome)
  await page.locator('[id="nf-tipo"]').selectOption(tipo)
  await page.locator('[id="nf-cadência"]').fill(cadência)
  await page.locator('#form-nova-frente button[type="submit"]').click()
}

test('abre a Home vazia, com navegação principal e sem erro', async ({ page }) => {
  await page.goto('./')
  await expect(page.locator('h1')).toHaveText('Pulse')
  await expect(page.getByText('Nenhuma frente ainda')).toBeVisible()
  const nav = page.locator('#nav-desktop a, #nav-mobile a')
  await expect(nav.filter({ hasText: 'Frentes' }).first()).toBeAttached()
  await expect(page.locator('.erro')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('[object Object]')
})

test('criar, consultar, selecionar Frente; criar sub-frente; abrir Frente', async ({ page }) => {
  await page.goto('./#/frentes')
  await criarFrente(page, 'Darkline', 'domínio', '14')
  await expect(aviso(page)).toContainText('Frente criada')
  await expect(page.locator('.item', { hasText: 'Darkline' })).toBeVisible()

  // abrir a Frente
  await page.locator('.item', { hasText: 'Darkline' }).click()
  await expect(page).toHaveURL(/#\/frente\//)
  await expect(page.locator('h1')).toHaveText('Darkline')

  // domínio vazio: sem sinal aplicável (não "ruim")
  await expect(page.locator('.meta-row .badge').first()).toContainText('Sem sinal aplicável')

  // sub-frente
  await criarFrente(page, 'Origens', 'projeto', '7')
  await expect(page.locator('.item', { hasText: 'Origens' })).toBeVisible()
  await page.locator('.item', { hasText: 'Origens' }).click()
  await expect(page.locator('h1')).toHaveText('Origens')
  await expect(page.locator('.meta-row a', { hasText: 'Darkline' })).toBeVisible() // posição na hierarquia

  // árvore em /frentes: expandir domínio mostra o filho
  await page.goto('./#/frentes')
  await page.locator('[data-expandir]').first().click()
  await expect(page.locator('.item', { hasText: 'Origens' })).toBeVisible()
  await expect(page.locator('.erro')).toHaveCount(0)
})

test('registrar na Frente → histórico → busca → editar → excluir → persiste após reload', async ({ page }) => {
  await page.goto('./#/frentes')
  await criarFrente(page, 'Violino', 'prática', '3')
  await page.locator('.item', { hasText: 'Violino' }).click()

  await page.locator('#reg-texto').fill('estudei escalas por 40 minutos')
  await page.locator('#form-registro button[type="submit"]').click()
  await expect(aviso(page)).toContainText('Registro salvo')
  await expect(page.locator('.registro', { hasText: 'estudei escalas' })).toBeVisible()
  await expect(page.locator('.registro', { hasText: 'Criou' }).or(page.locator('.registro', { hasText: 'criada' })).first()).toBeVisible()

  // data retroativa: sem erro e aparece no histórico
  await page.locator('#reg-texto').fill('esqueci de registrar ontem')
  await page.locator('#reg-data').fill('2026-01-05T10:00')
  await page.locator('#form-registro button[type="submit"]').click()
  await expect(page.locator('.registro', { hasText: 'esqueci de registrar ontem' })).toBeVisible()

  // Home reflete o movimento recente
  await page.goto('./#/')
  await expect(page.getByText('estudei escalas')).toBeVisible()

  // busca
  await page.goto('./#/buscar')
  await page.locator('#bs-texto').fill('escalas')
  await page.locator('#form-buscar button[type="submit"]').click()
  await expect(page.locator('#bs-resultados .registro')).toHaveCount(1)
  await expect(page.locator('#bs-resultados')).toContainText('Violino')
  await page.locator('#bs-texto').fill('xyz-nada')
  await page.locator('#form-buscar button[type="submit"]').click()
  await expect(page.getByText('Nenhum registro encontrado')).toBeVisible()

  // editar registro
  await page.goto('./#/frentes')
  await page.locator('.item', { hasText: 'Violino' }).click()
  await page.locator('.registro', { hasText: 'estudei escalas' }).locator('.acao-editar-registro').click()
  await page.locator('.er-texto').fill('estudei escalas e arpejos')
  await page.locator('.form-editar-registro button[type="submit"]').click()
  await expect(page.locator('.registro', { hasText: 'escalas e arpejos' })).toBeVisible()

  // persistência após reload
  await page.reload()
  await expect(page.locator('h1')).toHaveText('Violino')
  await expect(page.locator('.registro', { hasText: 'escalas e arpejos' })).toBeVisible()

  // excluir registro
  page.once('dialog', (d) => void d.accept())
  await page.locator('.registro', { hasText: 'esqueci de registrar ontem' }).locator('.acao-excluir-registro').click()
  await expect(page.locator('.registro', { hasText: 'esqueci de registrar ontem' })).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.registro', { hasText: 'esqueci de registrar ontem' })).toHaveCount(0)
  await expect(page.locator('.registro', { hasText: 'escalas e arpejos' })).toBeVisible()
})

test('Registrar global escolhe a Frente e leva ao histórico', async ({ page }) => {
  await page.goto('./#/frentes')
  await criarFrente(page, 'Escola', 'projeto', '5')
  await page.goto('./#/registrar')
  await page.locator('#rg-texto').fill('prova de matemática')
  await page.locator('#form-registrar-global button[type="submit"]').click()
  await expect(page).toHaveURL(/#\/frente\//)
  await expect(page.locator('.registro', { hasText: 'prova de matemática' })).toBeVisible()
})

test('editar Frente concluída (regressão: antes falhava parcialmente) e persistir', async ({ page }) => {
  await page.goto('./#/frentes')
  await criarFrente(page, 'MEO', 'projeto', '7')
  await page.locator('.item', { hasText: 'MEO' }).click()

  await page.locator('[id="ef-ciclo-vida"]').selectOption('concluída')
  await page.locator('#form-editar-frente button[type="submit"]').click()
  await expect(aviso(page)).toContainText('Alterações salvas')
  await expect(page.locator('.meta-row')).toContainText('Concluída')

  // editar só o nome de uma frente concluída
  await page.locator('[id="ef-nome"]').fill('MEO v2')
  await page.locator('#form-editar-frente button[type="submit"]').click()
  await expect(aviso(page)).toContainText('Alterações salvas')
  await expect(page.locator('.erro')).toHaveCount(0)
  await expect(page.locator('h1')).toHaveText('MEO v2')

  await page.reload()
  await expect(page.locator('h1')).toHaveText('MEO v2')
  // evento estrutural traduzido para linguagem humana, sem nome técnico
  await expect(page.locator('body')).not.toContainText('ciclo_vida_mudou')
})

test('excluir Frente com confirmação remove frente e registros', async ({ page }) => {
  await page.goto('./#/frentes')
  await criarFrente(page, 'Temporária', 'projeto', '7')
  await page.locator('.item', { hasText: 'Temporária' }).click()
  await page.locator('#reg-texto').fill('algo')
  await page.locator('#form-registro button[type="submit"]').click()
  await expect(page.locator('.registro', { hasText: 'algo' })).toBeVisible()

  page.once('dialog', (d) => void d.accept())
  await page.locator('#btn-excluir-frente').click()
  await expect(page).toHaveURL(/#\/frentes$/)
  await expect(page.locator('.item', { hasText: 'Temporária' })).toHaveCount(0)
  const s = await lerStore(page)
  expect(s.frentes).toHaveLength(0)
  expect(s.registros).toHaveLength(0)
  expect(s.eventos).toHaveLength(0)
})

test('Frente inexistente: mensagem, sem tela quebrada', async ({ page }) => {
  await page.goto('./#/frente/nao-existe')
  await expect(page.getByText('não existe')).toBeVisible()
  await expect(page.locator('body')).not.toContainText('[object Object]')
})

// ---------------- erros simulados ----------------

test('falha ao salvar: erro local ao lado do formulário, app continua, retry sem duplicar', async ({ page }) => {
  await page.goto('./#/frentes')
  await sim(page, { falharEscritaChaves: ['controle-pessoal:frentes'] })
  await criarFrente(page, 'Falha', 'projeto', '7')

  const erro = page.locator('#form-nova-frente .erro')
  await expect(erro).toBeVisible()
  await expect(erro).toContainText('Não foi possível criar a frente')
  await expect(page.locator('body')).not.toContainText('[object Object]')
  // não substituiu a app: navegação e formulário preenchido continuam
  await expect(page.locator('#nav-desktop a, #nav-mobile a').first()).toBeAttached()
  await expect(page.locator('[id="nf-nome"]')).toHaveValue('Falha')
  await expect(page.locator('#form-nova-frente button[type="submit"]')).toBeEnabled()
  expect((await lerStore(page)).frentes).toHaveLength(0)

  // volta a funcionar → retry
  await sim(page, { falharEscritaChaves: [] })
  await page.locator('#form-nova-frente button[type="submit"]').click()
  await expect(aviso(page)).toContainText('Frente criada')
  const s = await lerStore(page)
  expect(s.frentes).toHaveLength(1)
  expect(s.eventos.filter((e) => e.tipo === 'criação')).toHaveLength(1)
})

test('falha parcial: frente salva, histórico não → "Tentar completar" sem duplicar', async ({ page }) => {
  await page.goto('./#/frentes')
  await sim(page, { falharEscritaChaves: ['controle-pessoal:eventos-estruturais'] })
  await criarFrente(page, 'Parcial', 'projeto', '7')

  const erro = page.locator('#form-nova-frente .erro')
  await expect(erro).toContainText('Parte da operação foi salva')
  await expect(erro).not.toContainText('Não foi possível criar')
  let s = await lerStore(page)
  expect(s.frentes).toHaveLength(1)
  expect(s.eventos).toHaveLength(0)

  await sim(page, { falharEscritaChaves: [] })
  await erro.getByRole('button', { name: 'Tentar completar' }).click()
  await expect(aviso(page)).toContainText('Concluído')
  s = await lerStore(page)
  expect(s.frentes).toHaveLength(1)
  expect(s.eventos.filter((e) => e.tipo === 'criação')).toHaveLength(1)
})

test('falha ao carregar: painel de erro com "Tentar de novo"; a navegação continua; retry recupera', async ({ page }) => {
  await page.goto('./#/')
  await expect(page.getByText('Nenhuma frente ainda')).toBeVisible()
  await sim(page, { falharLeitura: true })
  await page.locator('#nav-desktop').getByText('Frentes', { exact: true }).click()
  const painel = page.locator('main .erro')
  await expect(painel).toBeVisible()
  await expect(painel).toContainText('Não foi possível carregar as frentes')
  await expect(page.locator('body')).not.toContainText('[object Object]')
  await expect(page.locator('#nav-desktop')).toBeVisible() // só a área principal foi afetada

  await sim(page, { falharLeitura: false })
  await page.getByRole('button', { name: 'Tentar de novo' }).click()
  await expect(page.locator('main h1')).toHaveText('Frentes')
  await expect(page.locator('main .erro')).toHaveCount(0)
})

test('falha ao salvar registro: texto digitado é preservado', async ({ page }) => {
  await page.goto('./#/frentes')
  await criarFrente(page, 'Texto', 'projeto', '7')
  await page.locator('.item', { hasText: 'Texto' }).click()
  await sim(page, { falharEscritaChaves: ['controle-pessoal:registros'] })
  await page.locator('#reg-texto').fill('não perder isto')
  await page.locator('#form-registro button[type="submit"]').click()
  await expect(page.locator('#form-registro .erro')).toBeVisible()
  await expect(page.locator('#reg-texto')).toHaveValue('não perder isto')
  expect((await lerStore(page)).registros).toHaveLength(0)
})
