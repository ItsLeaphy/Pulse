import { LocalStorageAdapter } from './storage'
import { SupabaseAdapter, criarClienteSupabase } from './storage-supabase'
import { exigirLogin } from './auth'
import { renderApp } from './ui'
import { mensagemParaUsuário, registrarDiagnóstico } from './erros'
import { escapeHtml } from './ui/traducao'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

async function iniciar(): Promise<void> {
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    const client = criarClienteSupabase(SUPABASE_URL, SUPABASE_ANON_KEY)
    await exigirLogin(client)
    renderApp(new SupabaseAdapter(client))
  } else {
    // sem configuração de Supabase — modo offline local, útil pra dev
    renderApp(new LocalStorageAdapter())
  }
}

iniciar().catch((err) => {
  // falha ao iniciar (sessão, rede, configuração): nunca tela em branco
  registrarDiagnóstico('iniciar o Pulse', err)
  const app = document.getElementById('app')
  if (!app) return
  app.innerHTML = `
    <div class="shell"><main class="shell-main">
      <h1>Pulse</h1>
      <div class="erro" role="alert">
        <p>${escapeHtml(mensagemParaUsuário(err, 'iniciar o Pulse'))}</p>
        <button type="button" id="btn-recarregar">Recarregar</button>
      </div>
    </main></div>`
  document.getElementById('btn-recarregar')?.addEventListener('click', () => window.location.reload())
})
