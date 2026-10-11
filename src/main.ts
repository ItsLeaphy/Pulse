import { LocalStorageAdapter } from './storage'
import { SupabaseAdapter, criarClienteSupabase } from './storage-supabase'
import { exigirLogin } from './auth'
import { renderApp } from './ui'

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

void iniciar()
