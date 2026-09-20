import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// LOGIN
// App pessoal, um usuário só. Sem tela de cadastro pública —
// você cria sua própria conta pelo painel do Supabase (ver
// README) e só faz login aqui. Menos superfície, menos risco.
// ============================================================

export async function exigirLogin(client: SupabaseClient): Promise<void> {
  const { data } = await client.auth.getSession()
  if (data.session) return

  return new Promise((resolve) => {
    const root = document.getElementById('app')!
    root.innerHTML = `
      <h1>Pulse</h1>
      <p class="meta-row">Entrar pra ver o estado das suas frentes.</p>
      <form id="form-login">
        <label>Email</label>
        <input type="email" id="login-email" required />
        <label>Senha</label>
        <input type="password" id="login-senha" required />
        <button type="submit">Entrar</button>
        <div id="login-erro" style="color:#a12a2a; font-size:0.85rem;"></div>
      </form>
    `

    document.getElementById('form-login')!.addEventListener('submit', (e) => {
      e.preventDefault()
      const email = (document.getElementById('login-email') as HTMLInputElement).value.trim()
      const senha = (document.getElementById('login-senha') as HTMLInputElement).value

      void (async () => {
        const { error } = await client.auth.signInWithPassword({ email, password: senha })
        if (error) {
          document.getElementById('login-erro')!.textContent = error.message
          return
        }
        resolve()
      })()
    })
  })
}
