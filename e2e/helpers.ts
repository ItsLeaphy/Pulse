import type { Page } from '@playwright/test'

/** Falhas simuladas de armazenamento, controladas pelo teste via window.__sim. */
export async function instalarSimulador(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __sim: { falharEscritaChaves: string[]; falharLeitura: boolean } }
    w.__sim = { falharEscritaChaves: [], falharLeitura: false }
    const set = Storage.prototype.setItem
    Storage.prototype.setItem = function (k: string, v: string) {
      if (w.__sim.falharEscritaChaves.some((x) => k.includes(x))) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      }
      return set.call(this, k, v)
    }
    const get = Storage.prototype.getItem
    Storage.prototype.getItem = function (k: string) {
      if (w.__sim.falharLeitura && k.startsWith('controle-pessoal:')) {
        throw new Error('leitura simulada falhou')
      }
      return get.call(this, k)
    }
  })
}

export async function sim(page: Page, estado: Partial<{ falharEscritaChaves: string[]; falharLeitura: boolean }>): Promise<void> {
  await page.evaluate((e) => {
    Object.assign((window as unknown as { __sim: object }).__sim, e)
  }, estado)
}

export async function lerStore(page: Page): Promise<{ frentes: any[]; registros: any[]; eventos: any[] }> {
  return page.evaluate(() => ({
    frentes: JSON.parse(localStorage.getItem('controle-pessoal:frentes') ?? '[]'),
    registros: JSON.parse(localStorage.getItem('controle-pessoal:registros') ?? '[]'),
    eventos: JSON.parse(localStorage.getItem('controle-pessoal:eventos-estruturais') ?? '[]')
  }))
}
