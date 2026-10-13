import { randomUUID } from 'node:crypto'
import { conectarAdmin, criarBanco, urlAdmin, type BancoDeTeste, type ClientePg } from './teste-pg-cliente'
import { SupabaseAdapter } from './storage-supabase'
import { ErroPulse, mensagemParaUsuário } from './erros'
import { suiteAtômica, frenteBase, capturar, códigoDe, type Ambiente } from './teste-atomico-comum'
import { criarFrente, criarRegistro } from './frente-ops'

// ============================================================
// TESTE COM POSTGRESQL REAL — migration 005 (operações atômicas)
//
// Executa as migrations/funções num PostgreSQL de verdade e prova:
// rollback real, idempotência, conflito (compare-and-swap), cascata
// sem órfãos, ultimo_movimento, isolamento entre usuários (RLS),
// privilégios, concorrência e o contrato SupabaseAdapter ↔ funções.
//
// NÃO é o Supabase (sem PostgREST/GoTrue — ver teste-pg-cliente.ts) e
// NÃO toca o banco remoto de ninguém: cria bancos temporários locais
// (pulse_t_*) e os remove no fim.
//
// Requer PostgreSQL acessível (PULSE_TEST_PG_URL, com um superusuário).
// Sem PostgreSQL o teste NÃO executa e sai com código 2 — nunca finge
// que passou. Rode com: npm run test:pg
// ============================================================

let falhas = 0
let total = 0
function check(condição: boolean, mensagem: string): void {
  total++
  if (condição) console.log(`✅ ${mensagem}`)
  else {
    console.log(`❌ ${mensagem}`)
    falhas++
  }
}

const conexão = await conectarAdmin()
if ('erro' in conexão) {
  console.log(`⚠️  NÃO EXECUTADO: PostgreSQL indisponível em ${urlAdmin().replace(/:[^:@/]*@/, ':***@')}`)
  console.log(`   motivo: ${conexão.erro}`)
  console.log('   Suba um PostgreSQL 14+ com um superusuário e defina PULSE_TEST_PG_URL (veja README.md → "Testes com PostgreSQL real").')
  process.exit(2)
}
const admin = conexão.pool
const versão = (await admin.query('show server_version')).rows[0].server_version as string
console.log(`PostgreSQL ${versão} — bancos temporários pulse_t_*`)

const LEGADO = [
  'supabase-schema.sql',
  'supabase-migration-001-aditiva.sql',
  'supabase-migration-002-bloco2-aditiva.sql',
  'supabase-migration-003-bloco5-aditiva.sql',
  'supabase-migration-004-compat-adapter.sql'
]
const M005 = 'supabase-migration-005-operacoes-atomicas.sql'

const bancos: BancoDeTeste[] = []
async function banco(rótulo: string, arquivos: string[]): Promise<BancoDeTeste> {
  const b = await criarBanco(admin, rótulo, arquivos)
  bancos.push(b)
  return b
}

const AGORA = 1_800_000_000_000
const DIA = 86_400_000

// ---------- payloads (chaves = colunas, como o adapter envia) ----------
const F = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  nome: 'Frente',
  area: 'work',
  tipo: 'projeto',
  parent_id: null,
  ciclo_vida: 'ativa',
  condicao: 'normal',
  cadencia_esperada: 7,
  contexto_foco: null,
  contexto_bloqueio: null,
  pausa_motivo: null,
  pausa_retomada_em: null,
  criada_em: AGORA,
  ...extra
})
const EV = (frenteId: string, tipo: string, ant: string | null, novo: string | null, id: string = randomUUID()) => ({
  id,
  frente_id: frenteId,
  tipo,
  valor_anterior: ant,
  valor_novo: novo,
  criado_em: AGORA
})
const RG = (frenteId: string, data: number, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  frente_id: frenteId,
  data,
  criado_em: AGORA,
  texto: 'registro',
  conta_como_movimento: true,
  duracao_min: null,
  ...extra
})

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
async function rpc(u: ClientePg, nome: string, args: Record<string, unknown>): Promise<{ r: Json | null; erro: { code: string; message: string } | null }> {
  const { data, error } = (await u.rpc(nome, args)) as { data: Json | null; error: { code: string; message: string } | null }
  return { r: data, erro: error }
}
const salvarFrente = (u: ClientePg, f: Json, esperado: Json | null, eventos: Json[] = []) =>
  rpc(u, 'pulse_salvar_frente', { p_frente: f, p_esperado: esperado, p_eventos: eventos })
const salvarRegistro = (u: ClientePg, r: Json, esperado: Json | null = null) =>
  rpc(u, 'pulse_salvar_registro', { p_registro: r, p_esperado: esperado })
const excluirRegistro = (u: ClientePg, id: string) => rpc(u, 'pulse_excluir_registro', { p_id: id })
const excluirFrente = (u: ClientePg, id: string) => rpc(u, 'pulse_excluir_frente', { p_id: id })

const contar = async (b: BancoDeTeste, tabela: string, onde = 'true', params: unknown[] = []) =>
  Number((await b.admin(`select count(*)::int n from public.${tabela} where ${onde}`, params))[0]!.n)
const linhaFrente = async (b: BancoDeTeste, id: string) => (await b.admin('select * from public.frentes where id = $1', [id]))[0] as Json | undefined

// ============================================================
// 0. MIGRATIONS EM POSTGRES REAL
// ============================================================
console.log('\n— migrations 001–005 em PostgreSQL real')
const legado = await banco('legado', [...LEGADO, M005])
const novo = await banco('novo', ['supabase-schema-atual.sql', M005])

{
  const cols = await legado.admin(
    `select column_name, is_nullable from information_schema.columns where table_schema='public' and table_name='frentes'`
  )
  const nul = (c: string) => cols.find((x) => x.column_name === c)?.is_nullable
  check(nul('estado') === 'YES' && nul('ultimo_toque') === 'YES' && nul('opt_out_negligencia') === 'YES', 'v1 + 001–004: colunas legadas aceitam NULL (migration 004 funciona de verdade)')
  check(cols.some((c) => c.column_name === 'ciclo_vida') && cols.some((c) => c.column_name === 'condicao'), 'v1 + 001: ciclo_vida e condicao existem')
  const colsNovo = await novo.admin(`select column_name from information_schema.columns where table_schema='public' and table_name='frentes'`)
  check(!colsNovo.some((c) => ['estado', 'ultimo_toque', 'opt_out_negligencia'].includes(c.column_name as string)), 'schema atual (instalação nova): sem colunas legadas')

  // reaplicar é inofensivo
  await legado.aplicar(M005)
  await legado.aplicar(M005)
  check(true, 'migration 005 é idempotente (aplicada 3× no mesmo banco sem erro)')

  const nFn = Number((await legado.admin(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'pulse\\_%'`))[0]!.n)
  check(nFn === 6, `5 → 6 funções pulse_* (4 RPC + 2 auxiliares), sem duplicatas após reaplicar (${nFn})`)

  // precondições: falha cedo com mensagem clara
  const velho = await banco('so_v1', ['supabase-schema.sql'])
  const e1 = await capturar(() => velho.aplicar(M005))
  check(e1 instanceof Error && /eventos_estruturais não existe/.test(e1.message), 'sem 001: a 005 recusa com mensagem clara')
  const sem4 = await banco('sem004', LEGADO.slice(0, 4))
  const e2 = await capturar(() => sem4.aplicar(M005))
  check(e2 instanceof Error && /Aplique 004/.test(e2.message), 'sem 004: a 005 recusa com mensagem clara')
  const aposRecusa = Number((await sem4.admin(`select count(*)::int n from pg_proc where proname = 'pulse_salvar_frente'`))[0]!.n)
  check(aposRecusa === 0, 'a recusa não deixa funções pela metade')
}

// ============================================================
// 1. FUNÇÕES SQL — comportamento direto
// ============================================================
const bd = legado // o banco que espelha o do usuário (v1 + 001–005)
const A = bd.cliente(await bd.novoUsuário())
const B = bd.cliente(await bd.novoUsuário())

console.log('\n— pulse_salvar_frente: criação')
{
  const id = randomUUID()
  const { r, erro } = await salvarFrente(A, F(id, { nome: '  Com espaços  ' }), null, [EV(id, 'criação', null, null)])
  check(erro === null && r?.status === 'criada', 'cria a frente')
  check((await contar(bd, 'eventos_estruturais', 'frente_id = $1', [id])) === 1, 'criar uma Frente gera EXATAMENTE 1 evento de criação')
  const linha = await linhaFrente(bd, id)
  check(linha?.nome === 'Com espaços' && linha?.user_id === A.userId && linha?.ultimo_movimento === null, 'nome aparado; user_id = quem chamou (default auth.uid()); sem último movimento')
  check(linha?.estado === null && linha?.ultimo_toque === null, 'colunas legadas ficam NULL (não são escritas)')

  const nova = await salvarFrente(A, F(id, { nome: 'Outro' }), null, [EV(id, 'criação', null, null)])
  check(nova.r?.status === 'ja_existia' && (await contar(bd, 'eventos_estruturais', 'frente_id = $1', [id])) === 1, 'criar de novo (retry): ja_existia, ainda 1 evento')
  check((await linhaFrente(bd, id))?.nome === 'Com espaços', 'a frente existente NÃO é sobrescrita')

  // criação concorrente idêntica (clique duplo / retry durante a espera)
  const idc = randomUUID()
  const rs = await Promise.all(Array.from({ length: 5 }, () => salvarFrente(A, F(idc), null, [EV(idc, 'criação', null, null)])))
  const st = rs.map((x) => x.r?.status ?? x.erro?.code).sort()
  check(rs.every((x) => x.erro === null) && st.filter((s) => s === 'criada').length === 1 && st.filter((s) => s === 'ja_existia').length === 4, `5 criações simultâneas: 1 criada + 4 ja_existia, sem erro (${st.join(',')})`)
  check((await contar(bd, 'frentes', 'id = $1', [idc])) === 1 && (await contar(bd, 'eventos_estruturais', 'frente_id = $1', [idc])) === 1, '…e exatamente 1 frente e 1 evento')

  const inv = await salvarFrente(A, F(randomUUID(), { nome: '   ' }), null)
  check(inv.erro?.code === 'PU422', 'nome em branco → PU422')
  const semPai = await salvarFrente(A, F(randomUUID(), { parent_id: randomUUID() }), null)
  check(semPai.erro?.code === 'PU422', 'pai inexistente → PU422')
}

console.log('\n— pulse_salvar_frente: edição com todos os eventos')
{
  const id = randomUUID()
  await salvarFrente(A, F(id, { condicao: 'bloqueada' }), null, [EV(id, 'criação', null, null)])
  const atual = (await linhaFrente(bd, id))!
  const novoEstado = F(id, { area: 'art', tipo: 'prática', ciclo_vida: 'arquivada', condicao: 'normal', cadencia_esperada: 14, contexto_foco: 'foco', criada_em: AGORA })
  const evs = [
    EV(id, 'ciclo_vida_mudou', 'ativa', 'arquivada'),
    EV(id, 'condição_mudou', 'bloqueada', 'normal'),
    EV(id, 'cadência_mudou', '7', '14')
  ]
  const { r, erro } = await salvarFrente(A, novoEstado, atual, evs)
  check(erro === null && r?.status === 'aplicada', 'edição composta aplicada numa única chamada')
  const f = (await linhaFrente(bd, id))!
  check(f.ciclo_vida === 'arquivada' && f.condicao === 'normal' && f.cadencia_esperada === 14 && f.area === 'art' && f.contexto_foco === 'foco', 'todos os campos gravados')
  check((await contar(bd, 'eventos_estruturais', 'frente_id = $1', [id])) === 4, 'os 3 eventos foram gravados junto (+ criação)')

  // retry com resposta perdida: mesma chamada de novo
  const retry = await salvarFrente(A, novoEstado, atual, evs)
  check(retry.r?.status === 'ja_aplicada' && (await contar(bd, 'eventos_estruturais', 'frente_id = $1', [id])) === 4, 'retry da mesma chamada: ja_aplicada, nenhum evento duplicado')
  // outra aba chega ao mesmo estado com ids de evento diferentes
  const outra = await salvarFrente(A, novoEstado, atual, evs.map((e) => ({ ...e, id: randomUUID() })))
  check(outra.r?.status === 'ja_aplicada' && (await contar(bd, 'eventos_estruturais', 'frente_id = $1', [id])) === 4, 'mesmo estado final por outro caminho: não duplica o histórico')

  // conflito: base desatualizada
  const stale = await salvarFrente(A, F(id, { nome: 'B', ciclo_vida: 'arquivada', area: 'art', tipo: 'prática', cadencia_esperada: 14, contexto_foco: 'foco' }), atual, [EV(id, 'cadência_mudou', '14', '14')])
  check(stale.erro?.code === 'PU409', 'base desatualizada → PU409 (conflito)')
  check((await linhaFrente(bd, id))?.nome === 'Frente' && (await contar(bd, 'eventos_estruturais', 'frente_id = $1', [id])) === 4, 'o conflito não sobrescreve nem grava evento')
  const semFrente = await salvarFrente(A, F(randomUUID(), { nome: 'x' }), F(randomUUID()))
  check(semFrente.erro?.code === 'PU404', 'editar frente que não existe → PU404')
  const evOutra = await salvarFrente(A, F(id, { nome: 'Z' }), (await linhaFrente(bd, id))!, [EV(randomUUID(), 'cadência_mudou', null, null)])
  check(evOutra.erro?.code === 'PU422', 'evento de outra frente → PU422')
  const ev2 = await salvarFrente(A, F(id, { nome: 'Z', ciclo_vida: 'arquivada', area: 'art', tipo: 'prática', cadencia_esperada: 14, contexto_foco: 'foco' }), F(id, { nome: 'Q' }), [])
  check(ev2.erro?.code === 'PU409', 'validação de evento vem antes do conflito apenas para eventos inválidos; aqui o conflito prevalece')
}

console.log('\n— ROLLBACK REAL: falha provocada no meio da transação')
{
  // (a) CHECK do banco viola no 2º evento, DEPOIS do update da frente e do 1º evento
  const id = randomUUID()
  await salvarFrente(A, F(id), null, [EV(id, 'criação', null, null)])
  const atual = (await linhaFrente(bd, id))!
  const antesEv = await contar(bd, 'eventos_estruturais')
  const r = await salvarFrente(A, F(id, { nome: 'NÃO DEVE FICAR', condicao: 'bloqueada' }), atual, [
    EV(id, 'condição_mudou', 'normal', 'bloqueada'),
    EV(id, 'tipo_inexistente', null, null)
  ])
  check(r.erro?.code === '23514', 'evento com tipo inválido → violação de CHECK (23514)')
  const f = (await linhaFrente(bd, id))!
  check(f.nome === 'Frente' && f.condicao === 'normal', 'ROLLBACK: a frente voltou ao que era (o UPDATE foi desfeito)')
  check((await contar(bd, 'eventos_estruturais')) === antesEv, 'ROLLBACK: o 1º evento (válido) também não ficou')

  // (b) trigger lança no 2º evento — outro tipo de falha, no meio
  await bd.admin(`create or replace function pt_falha_evento() returns trigger language plpgsql as $$ begin if new.valor_novo = 'boom' then raise exception 'falha provocada' using errcode = 'XX999'; end if; return new; end $$`)
  await bd.admin(`create trigger pt_falha_evento before insert on public.eventos_estruturais for each row execute function pt_falha_evento()`)
  const r2 = await salvarFrente(A, F(id, { nome: 'NÃO DEVE FICAR 2', cadencia_esperada: 3 }), atual, [EV(id, 'cadência_mudou', '7', '3'), EV(id, 'cadência_mudou', '3', 'boom')])
  check(r2.erro?.code === 'XX999', 'trigger provocou erro no meio da função')
  check((await linhaFrente(bd, id))!.nome === 'Frente' && (await linhaFrente(bd, id))!.cadencia_esperada === 7 && (await contar(bd, 'eventos_estruturais')) === antesEv, 'ROLLBACK: frente e eventos intactos')
  // criação com falha: nem a frente nasce
  const idc = randomUUID()
  const r3 = await salvarFrente(A, F(idc), null, [EV(idc, 'criação', null, 'boom')])
  check(r3.erro?.code === 'XX999' && (await linhaFrente(bd, idc)) === undefined, 'ROLLBACK: criação com evento que falha NÃO deixa a frente criada sem o evento')
  await bd.admin('drop trigger pt_falha_evento on public.eventos_estruturais')

  // (c) registro: o UPDATE do cache da frente falha depois do INSERT do registro
  await bd.admin(`create or replace function pt_falha_frente() returns trigger language plpgsql as $$ begin if new.ultimo_movimento = 777 then raise exception 'falha provocada no cache' using errcode = 'XX998'; end if; return new; end $$`)
  await bd.admin(`create trigger pt_falha_frente before update on public.frentes for each row execute function pt_falha_frente()`)
  const reg = RG(id, 777)
  const r4 = await salvarRegistro(A, reg)
  check(r4.erro?.code === 'XX998', 'falha ao atualizar o cache da frente, depois de inserir o registro')
  check((await contar(bd, 'registros', 'id = $1', [reg.id])) === 0 && (await linhaFrente(bd, id))!.ultimo_movimento === null, 'ROLLBACK: o registro NÃO ficou salvo sem o cache atualizado')
  const bom = RG(id, 100)
  await salvarRegistro(A, bom)
  const r5 = await salvarRegistro(A, { ...bom, data: 777 }, bom)
  check(r5.erro?.code === 'XX998' && Number((await bd.admin('select data from public.registros where id=$1', [bom.id]))[0]!.data) === 100, 'ROLLBACK: edição de registro cujo cache falha volta à data anterior')
  const r6 = await salvarRegistro(A, RG(id, 777))
  check(r6.erro?.code === 'XX998', 'cenário repetível')
  await bd.admin('drop trigger pt_falha_frente on public.frentes')

  // (d) exclusão de árvore: o DELETE das frentes falha depois de apagar eventos e registros
  const raiz = randomUUID()
  const filha = randomUUID()
  await salvarFrente(A, F(raiz, { tipo: 'domínio', cadencia_esperada: null }), null, [EV(raiz, 'criação', null, null)])
  await salvarFrente(A, F(filha, { parent_id: raiz, nome: 'bomba' }), null, [EV(filha, 'criação', null, null)])
  await salvarRegistro(A, RG(filha, 5))
  await salvarRegistro(A, RG(raiz, 6))
  await bd.admin(`create or replace function pt_falha_del() returns trigger language plpgsql as $$ begin if old.nome = 'bomba' then raise exception 'falha provocada na exclusão' using errcode = 'XX997'; end if; return old; end $$`)
  await bd.admin(`create trigger pt_falha_del before delete on public.frentes for each row execute function pt_falha_del()`)
  const antes = [await contar(bd, 'frentes'), await contar(bd, 'registros'), await contar(bd, 'eventos_estruturais')]
  const r7 = await excluirFrente(A, raiz)
  const depois = [await contar(bd, 'frentes'), await contar(bd, 'registros'), await contar(bd, 'eventos_estruturais')]
  check(r7.erro?.code === 'XX997' && antes.join() === depois.join(), `ROLLBACK: exclusão que falha no fim restaura eventos e registros já apagados (${antes.join('/')} → ${depois.join('/')})`)
  await bd.admin('drop trigger pt_falha_del on public.frentes')
  const ok = await excluirFrente(A, raiz)
  check(ok.r?.status === 'removida' && ok.r?.frentes === 2 && ok.r?.registros === 2 && ok.r?.eventos === 2, 'sem a falha, a mesma exclusão conclui e informa as contagens')
}

console.log('\n— hierarquia')
{
  const [pai, filha, neta] = [randomUUID(), randomUUID(), randomUUID()]
  await salvarFrente(A, F(pai, { tipo: 'domínio', cadencia_esperada: null }), null, [EV(pai, 'criação', null, null)])
  await salvarFrente(A, F(filha), null, [EV(filha, 'criação', null, null)])
  await salvarFrente(A, F(neta, { parent_id: filha }), null, [EV(neta, 'criação', null, null)])
  const f0 = (await linhaFrente(bd, filha))!
  const mover = await salvarFrente(A, F(filha, { parent_id: pai }), f0, [EV(filha, 'hierarquia_mudou', null, pai)])
  check(mover.r?.status === 'aplicada' && (await linhaFrente(bd, filha))!.parent_id === pai, 'mover aplica a nova posição')
  check((await contar(bd, 'eventos_estruturais', `frente_id = $1 and tipo = 'hierarquia_mudou'`, [filha])) === 1, 'alterar a hierarquia não deixa a Frente modificada sem seu evento')
  const f1 = (await linhaFrente(bd, filha))!
  const ciclo = await salvarFrente(A, F(filha, { parent_id: neta }), f1, [EV(filha, 'hierarquia_mudou', pai, neta)])
  check(ciclo.erro?.code === 'PU422' && /ciclo/.test(ciclo.erro.message), 'mover para dentro de um descendente → PU422 (ciclo)')
  const auto = await salvarFrente(A, F(filha, { parent_id: filha }), f1, [])
  check(auto.erro?.code === 'PU422', 'pai = a própria frente → PU422')
  check((await linhaFrente(bd, filha))!.parent_id === pai && (await contar(bd, 'eventos_estruturais', `frente_id = $1 and tipo = 'hierarquia_mudou'`, [filha])) === 1, 'recusas não alteram nada')
  const dois = await Promise.all([
    salvarFrente(A, F(pai, { tipo: 'domínio', cadencia_esperada: null, parent_id: neta }), (await linhaFrente(bd, pai))!, [EV(pai, 'hierarquia_mudou', null, neta)]),
    salvarFrente(A, F(neta, { parent_id: pai }), (await linhaFrente(bd, neta))!, [EV(neta, 'hierarquia_mudou', filha, pai)])
  ])
  const ciclos = (await bd.admin(`with recursive anc as (select id, parent_id, 1 d from public.frentes where id = any($1) union all select f.id, f.parent_id, a.d+1 from public.frentes f join anc a on a.parent_id = f.id where a.d < 10) select count(*)::int n from anc where d >= 10`, [[pai, filha, neta]]))[0]!
  check(Number(ciclos.n) === 0, `dois movimentos simultâneos que, juntos, formariam um ciclo: nenhum ciclo persistido (${dois.map((x) => x.r?.status ?? x.erro?.code).join(' / ')})`)
}

console.log('\n— registros e ultimo_movimento')
{
  const id = randomUUID()
  await salvarFrente(A, F(id), null, [EV(id, 'criação', null, null)])
  const um = async () => (await linhaFrente(bd, id))!.ultimo_movimento as number | null
  check((await um()) === null, 'frente nova: ultimo_movimento = null')
  const r1 = RG(id, AGORA - 5 * DIA)
  const c = await salvarRegistro(A, r1)
  check(c.r?.status === 'criado' && (await um()) === AGORA - 5 * DIA && c.r?.ultimo_movimento === AGORA - 5 * DIA, 'criar registro atualiza o ultimo_movimento (na mesma chamada)')
  const r2 = RG(id, AGORA - 2 * DIA)
  await salvarRegistro(A, r2)
  check((await um()) === AGORA - 2 * DIA, 'registro mais recente avança')
  await salvarRegistro(A, RG(id, AGORA - 9 * DIA))
  check((await um()) === AGORA - 2 * DIA, 'retroativo não recua')
  await salvarRegistro(A, RG(id, AGORA, { conta_como_movimento: false }))
  check((await um()) === AGORA - 2 * DIA, 'registro que não conta como movimento não altera')
  const e1 = await salvarRegistro(A, { ...r2, data: AGORA - 7 * DIA }, r2)
  check(e1.r?.status === 'aplicado' && (await um()) === AGORA - 5 * DIA, 'editar a data recalcula')
  const r1b = { ...r1, conta_como_movimento: false }
  await salvarRegistro(A, r1b, r1)
  check((await um()) === AGORA - 7 * DIA, 'editar "conta como movimento" recalcula')
  const x = await excluirRegistro(A, r2.id)
  check(x.r?.status === 'removido' && (await um()) === AGORA - 9 * DIA && x.r?.ultimo_movimento === AGORA - 9 * DIA, 'excluir recalcula (na mesma chamada)')
  const x2 = await excluirRegistro(A, r2.id)
  check(x2.r?.status === 'ja_removido', 'excluir de novo: ja_removido')
  for (const reg of await bd.admin(`select id from public.registros where frente_id=$1 and conta_como_movimento`, [id])) await excluirRegistro(A, reg.id as string)
  check((await um()) === null, 'sem nenhum movimento: volta a null')

  // cache corrompido é curado pela próxima operação
  await bd.admin('update public.frentes set ultimo_movimento = 42 where id = $1', [id])
  await salvarRegistro(A, RG(id, 1234))
  check((await um()) === 1234, 'cache divergente é recalculado do zero a partir dos registros')

  // o cliente não manda no cache
  const f = (await linhaFrente(bd, id))!
  await salvarFrente(A, F(id, { nome: 'Renomeada', ultimo_movimento: 99999 }), f)
  check((await um()) === 1234 && (await linhaFrente(bd, id))!.nome === 'Renomeada', 'ultimo_movimento enviado pelo cliente é ignorado (derivado dos registros)')

  const semFrente = await salvarRegistro(A, RG(randomUUID(), 1))
  check(semFrente.erro?.code === 'PU404', 'registro em frente inexistente → PU404')
  const mudaFrente = RG(id, 5)
  await salvarRegistro(A, mudaFrente)
  const outraFrente = randomUUID()
  await salvarFrente(A, F(outraFrente), null, [EV(outraFrente, 'criação', null, null)])
  const mv = await salvarRegistro(A, { ...mudaFrente, frente_id: outraFrente }, mudaFrente)
  check(mv.erro?.code === 'PU422', 'registro não muda de frente → PU422')

  // retries / conflito
  const rr = RG(id, 777)
  const a1 = await salvarRegistro(A, rr)
  const a2 = await salvarRegistro(A, { ...rr, texto: 'ignorado' })
  check(a1.r?.status === 'criado' && a2.r?.status === 'ja_existia' && a2.r?.registro.texto === 'registro', 'criar registro repetido: ja_existia, sem sobrescrever')
  const ed = { ...rr, texto: 'novo' }
  const e2a = await salvarRegistro(A, ed, rr)
  const e2b = await salvarRegistro(A, ed, rr)
  check(e2a.r?.status === 'aplicado' && e2b.r?.status === 'ja_aplicado', 'editar repetido: aplicado, depois ja_aplicado')
  const e2c = await salvarRegistro(A, { ...rr, texto: 'de B' }, rr)
  check(e2c.erro?.code === 'PU409' && (await bd.admin('select texto from public.registros where id=$1', [rr.id]))[0]!.texto === 'novo', 'edição com base desatualizada → PU409; valor mais recente preservado')
  const e2d = await salvarRegistro(A, { ...rr, texto: 'x' }, { ...rr, id: randomUUID() })
  check(e2d.erro?.code === 'PU409' || e2d.erro?.code === 'PU404', 'esperado de outro registro não passa')
}

console.log('\n— excluir árvore')
{
  const [raiz, filha, neta, outra] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
  await salvarFrente(A, F(raiz, { tipo: 'domínio', cadencia_esperada: null }), null, [EV(raiz, 'criação', null, null)])
  await salvarFrente(A, F(filha, { parent_id: raiz }), null, [EV(filha, 'criação', null, null)])
  await salvarFrente(A, F(neta, { parent_id: filha }), null, [EV(neta, 'criação', null, null), EV(neta, 'cadência_mudou', '7', '8')])
  await salvarFrente(A, F(outra), null, [EV(outra, 'criação', null, null)])
  for (const id of [raiz, filha, neta, outra]) {
    await salvarRegistro(A, RG(id, 1))
    await salvarRegistro(A, RG(id, 2))
  }
  const r = await excluirFrente(A, raiz)
  check(r.r?.status === 'removida' && r.r?.frentes === 3 && r.r?.registros === 6 && r.r?.eventos === 4, `contagens: 3 frentes, 6 registros, 4 eventos (${JSON.stringify(r.r)})`)
  const ids = [raiz, filha, neta]
  check((await contar(bd, 'frentes', 'id = any($1)', [ids])) === 0, 'frentes da árvore removidas')
  check((await contar(bd, 'registros', 'frente_id = any($1)', [ids])) === 0, 'excluir uma árvore não deixa registros órfãos')
  check((await contar(bd, 'eventos_estruturais', 'frente_id = any($1)', [ids])) === 0, 'excluir uma árvore não deixa eventos órfãos')
  check((await contar(bd, 'frentes', 'id = $1', [outra])) === 1 && (await contar(bd, 'registros', 'frente_id = $1', [outra])) === 2 && (await contar(bd, 'eventos_estruturais', 'frente_id = $1', [outra])) === 1, 'frente de fora da árvore intacta')
  const r2 = await excluirFrente(A, raiz)
  check(r2.r?.status === 'ja_removida' && r2.r?.frentes === 0, 'excluir de novo: ja_removida')
  // ciclo em dado corrompido não trava (union, não union all)
  const [c1, c2] = [randomUUID(), randomUUID()]
  await salvarFrente(A, F(c1), null)
  await salvarFrente(A, F(c2, { parent_id: c1 }), null)
  await bd.admin('update public.frentes set parent_id = $2 where id = $1', [c1, c2]) // corrompe: c1 → c2 → c1
  const rc = await excluirFrente(A, c1)
  check(rc.r?.status === 'removida' && rc.r?.frentes === 2, 'dado com ciclo (corrompido): a exclusão termina e remove as duas')
}

console.log('\n— isolamento entre usuários (RLS) via RPC')
{
  const idA = randomUUID()
  const filhaA = randomUUID()
  await salvarFrente(A, F(idA, { nome: 'Da A' }), null, [EV(idA, 'criação', null, null)])
  await salvarFrente(A, F(filhaA, { parent_id: idA }), null, [EV(filhaA, 'criação', null, null)])
  const regA = RG(idA, 10)
  await salvarRegistro(A, regA)
  const foto = async () => JSON.stringify([await bd.admin('select * from public.frentes where id = any($1) order by id', [[idA, filhaA]]), await bd.admin('select * from public.registros where frente_id = $1', [idA]), await bd.admin('select * from public.eventos_estruturais where frente_id = any($1) order by id', [[idA, filhaA]])])
  const antes = await foto()
  const atualA = (await linhaFrente(bd, idA))!

  const t1 = await salvarFrente(B, F(idA, { nome: 'SEQUESTRADA' }), atualA, [EV(idA, 'condição_mudou', 'normal', 'pausada')])
  check(t1.erro !== null && t1.erro.code === 'PU404', 'B edita frente da A (com esperado) → PU404 (não enxerga)')
  const t2 = await salvarFrente(B, F(idA, { nome: 'SEQUESTRADA' }), null, [EV(idA, 'criação', null, null)])
  check(t2.erro !== null || t2.r?.status !== 'criada', `B "cria" com o id da A: não consegue (${t2.erro?.code ?? t2.r?.status})`)
  const t3 = await salvarFrente(B, F(randomUUID(), { parent_id: idA }), null)
  check(t3.erro?.code === 'PU422', 'B cria frente-filha de uma frente da A → PU422 (o FK ignoraria RLS; a função checa)')
  const t4 = await salvarRegistro(B, RG(idA, 99))
  check(t4.erro?.code === 'PU404', 'B registra na frente da A → PU404')
  const t5 = await salvarRegistro(B, { ...regA, texto: 'HACK' }, regA)
  check(t5.erro?.code === 'PU404', 'B edita registro da A → PU404')
  const t6 = await excluirRegistro(B, regA.id)
  check(t6.r?.status === 'ja_removido', 'B exclui registro da A → no-op (ja_removido)')
  const t7 = await excluirFrente(B, idA)
  check(t7.r?.status === 'ja_removida' && t7.r?.frentes === 0, 'B exclui frente da A → no-op')
  check((await foto()) === antes, 'NENHUMA linha da A foi alterada ou removida por chamadas da B')
  check((await B.sql('select count(*)::int n from public.frentes where id = $1', [idA]))[0]!.n === 0, 'B nem enxerga a frente da A (RLS)')

  // e a A continua conseguindo mexer nas suas
  const a = await salvarFrente(A, F(idA, { nome: 'Da A, renomeada' }), atualA)
  check(a.r?.status === 'aplicada', 'A continua editando a própria frente')
}

console.log('\n— privilégios e modo de execução das funções')
{
  const fn = ['pulse_salvar_frente(jsonb, jsonb, jsonb)', 'pulse_salvar_registro(jsonb, jsonb)', 'pulse_excluir_registro(uuid)', 'pulse_excluir_frente(uuid)']
  for (const f of fn) {
    const { anon, auth, def, cfg } = ((await bd.admin(
      `select has_function_privilege('anon', $1::regprocedure, 'execute') anon,
              has_function_privilege('authenticated', $1::regprocedure, 'execute') auth,
              p.prosecdef def, p.proconfig cfg
       from pg_proc p where p.oid = $1::regprocedure`,
      [`public.${f}`]
    ))[0] ?? {}) as Json
    const nome = f.split('(')[0]!
    check(anon === false && auth === true, `${nome}: anon NÃO executa; authenticated executa`)
    check(def === false, `${nome}: SECURITY INVOKER (não é SECURITY DEFINER)`)
    check(Array.isArray(cfg) && cfg.some((c: string) => c.startsWith('search_path=')), `${nome}: search_path fixado`)
  }
  const publico = Number((await bd.admin(`select count(*)::int n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.proname like 'pulse\\_%' and a.grantee = 0 and a.privilege_type = 'EXECUTE'`))[0]!.n)
  check(publico === 0, 'nenhuma função pulse_* é executável por PUBLIC')
  const anon = bd.cliente(null)
  const e = await anon.sql(`select public.pulse_excluir_registro(gen_random_uuid())`).catch((x: { code?: string }) => x)
  check((e as { code?: string }).code === '42501', 'chamada anônima → permission denied (42501)')
  const e2 = await anon.sql(`select count(*) from public.frentes`).then(
    (rows) => rows[0]!.count === '0' || Number(rows[0]!.count) === 0,
    (x: { code?: string }) => x.code === '42501'
  )
  check(e2 === true, 'anônimo não lê dados de frentes')
}

console.log('\n— concorrência')
{
  const id = randomUUID()
  await salvarFrente(A, F(id), null, [EV(id, 'criação', null, null)])
  const regs = Array.from({ length: 24 }, (_, i) => RG(id, 1000 + i))
  const rs = await Promise.all(regs.map((r) => salvarRegistro(A, r)))
  check(rs.every((x) => x.erro === null), '24 registros simultâneos na mesma frente: nenhum erro (frente travada em ordem fixa, sem deadlock)')
  check((await linhaFrente(bd, id))!.ultimo_movimento === 1023 && (await contar(bd, 'registros', 'frente_id = $1', [id])) === 24, 'ultimo_movimento final = o maior (1023): nenhuma atualização perdida')

  // 6 edições simultâneas com a mesma base: só uma vence; as outras recebem conflito
  const atual = (await linhaFrente(bd, id))!
  const eds = await Promise.all(
    Array.from({ length: 6 }, (_, i) => salvarFrente(A, F(id, { nome: `Edição ${i}` }), atual, [EV(id, 'cadência_mudou', null, `${i}`)]))
  )
  const aplicadas = eds.filter((x) => x.r?.status === 'aplicada').length
  const conflitos = eds.filter((x) => x.erro?.code === 'PU409').length
  check(aplicadas === 1 && conflitos === 5, `6 edições com a mesma base: 1 aplicada, 5 conflitos (${aplicadas}/${conflitos})`)
  check((await contar(bd, 'eventos_estruturais', `frente_id = $1 and tipo = 'cadência_mudou'`, [id])) === 1, 'apenas o evento da edição vencedora foi gravado')

  // registro + exclusão simultâneos na mesma frente
  const base = RG(id, 5000)
  await salvarRegistro(A, base)
  const mix = await Promise.all([
    excluirRegistro(A, base.id),
    salvarRegistro(A, RG(id, 6000)),
    salvarRegistro(A, RG(id, 7000)),
    excluirRegistro(A, base.id)
  ])
  check(mix.every((x) => x.erro === null), 'criar e excluir registros em paralelo: sem erro')
  const esperado = Number((await bd.admin('select max(data) m from public.registros where frente_id=$1 and conta_como_movimento', [id]))[0]!.m)
  check((await linhaFrente(bd, id))!.ultimo_movimento === esperado, `cache consistente com os registros após a corrida (${esperado})`)
}

// ============================================================
// 2. SupabaseAdapter + frente-ops (caminho real do app) sobre o Postgres
// ============================================================
for (const [rótulo, b] of [['Supabase/PG v1+001–005', legado], ['Supabase/PG schema atual', novo]] as const) {
  await suiteAtômica(
    rótulo,
    async (): Promise<Ambiente> => {
      const u = await b.novoUsuário()
      return { storage: new SupabaseAdapter(b.cliente(u).comoSupabase()), outraAba: new SupabaseAdapter(b.cliente(u).comoSupabase()) }
    },
    check
  )
}

console.log('\n— SupabaseAdapter: contrato com o banco real')
for (const [rótulo, b] of [['v1+001–005', legado], ['schema atual', novo]] as const) {
  const u = await b.novoUsuário()
  const cli = b.cliente(u)
  const s = new SupabaseAdapter(cli.comoSupabase())

  // escritas simples (usadas pela importação): upsert direto, sem colunas legadas
  const id = randomUUID()
  const f = { ...frenteBase(id), criadaEm: AGORA, últimoMovimento: null }
  await s.salvarFrente(f)
  await s.salvarRegistro({ id: randomUUID(), frenteId: id, data: 1, criadoEm: 1, texto: 'a', contaComoMovimento: true })
  await s.salvarEventoEstrutural({ id: randomUUID(), frenteId: id, tipo: 'criação', valorAnterior: null, valorNovo: null, criadoEm: 1 })
  check((await s.getFrente(id))?.nome === 'Frente', `[${rótulo}] salvarFrente (upsert simples) funciona no banco real, sem tocar colunas legadas`)

  // paginação real: 2500 registros > limite de 1000 por página
  const frenteGrande = randomUUID()
  await s.salvarFrente({ ...f, id: frenteGrande })
  await b.admin(
    `insert into public.registros (id, user_id, frente_id, data, criado_em, texto, conta_como_movimento)
     select gen_random_uuid(), $1, $2, g, g, 't', true from generate_series(1, 2500) g`,
    [u, frenteGrande]
  )
  const todos = await s.getRegistros(frenteGrande)
  check(todos.length === 2500 && new Set(todos.map((r) => r.id)).size === 2500, `[${rótulo}] paginação real (range) devolve os 2500 registros sem duplicar nem perder`)
  check(todos[0]!.data === 2500 && todos[2499]!.data === 1, `[${rótulo}] ordem data desc preservada através das páginas`)
  check((await s.getTodosRegistros()).length === 2501, `[${rótulo}] getTodosRegistros paginado (2501)`)

  // erro estruturado de verdade, vindo do Postgres, vira mensagem útil
  const eRpc = await capturar(() => s.salvarFrenteComEventos({ ...frenteBase(randomUUID()), criadaEm: AGORA, últimoMovimento: null, nome: ' ' }, [], null))
  check(eRpc instanceof ErroPulse && eRpc.código === 'PU422' && eRpc.podeRepetir === false, `[${rótulo}] erro PU422 do Postgres chega como ErroPulse (código, não repetível)`)
  check(eRpc instanceof ErroPulse && !mensagemParaUsuário(eRpc, 'x', false).includes('[object Object]') && /Dê um nome/.test(mensagemParaUsuário(eRpc, 'x', false)), `[${rótulo}] mensagem para o usuário é a da função (sem [object Object])`)

  // conflito vindo do banco real
  const vista = (await s.getFrente(id))!
  await s.salvarFrenteComEventos({ ...vista, nome: 'A' }, [], vista)
  const eConf = await capturar(() => s.salvarFrenteComEventos({ ...vista, nome: 'B' }, [], vista))
  check(códigoDe(eConf) === 'PU409' && /Recarregue/.test((eConf as Error).message), `[${rótulo}] conflito real: PU409 com instrução para recarregar`)

  // adapter de usuário diferente não enxerga nada do outro
  const outro = new SupabaseAdapter(b.cliente(await b.novoUsuário()).comoSupabase())
  check((await outro.getFrentes()).length === 0 && (await outro.getTodosRegistros()).length === 0, `[${rótulo}] outro usuário não lê dados deste`)

  // contagem de chamadas HTTP-equivalentes por operação (1 RPC cada)
  const c2 = b.cliente(u)
  const s2 = new SupabaseAdapter(c2.comoSupabase())
  const nid = randomUUID()
  await criarFrente(s2, frenteBase(nid))
  await criarRegistro(s2, { frenteId: nid, data: AGORA, texto: 'x', contaComoMovimento: true })
  check(c2.chamadas['rpc:pulse_salvar_frente'] === 1 && c2.chamadas['rpc:pulse_salvar_registro'] === 1, `[${rótulo}] criar frente = 1 RPC; criar registro = 1 RPC`)
  check(Object.keys(c2.chamadas).filter((k) => k.startsWith('from:')).length === 0, `[${rótulo}] criar frente e registro não fazem nenhuma leitura/gravação solta (antes: 3–5 chamadas)`)
}

// função inexistente (migration 005 não aplicada) → mensagem acionável
{
  const sem = await banco('sem005', LEGADO)
  const u = await sem.novoUsuário()
  const s = new SupabaseAdapter(sem.cliente(u).comoSupabase())
  const e = await capturar(() => criarFrente(s, frenteBase(randomUUID())))
  check(e instanceof ErroPulse && e.código === '42883', 'banco SEM a 005: erro 42883 (função inexistente)')
  check(/desatualizado.*005/.test(mensagemParaUsuário(e, 'x', false)), 'a mensagem ao usuário manda aplicar a migration 005')
  check(!(await sem.admin('select 1 from public.frentes limit 1')).length, 'e nada foi gravado sem a função (nenhum fallback não atômico)')
}

// ============================================================
for (const b of bancos) await b.derrubar().catch((e) => console.log(`(aviso) não consegui remover ${b.nome}: ${e}`))
await admin.end()

console.log(`\n${falhas === 0 ? `✅ PostgreSQL real: ${total} verificações passaram` : `❌ ${falhas} de ${total} verificações falharam`}`)
if (falhas > 0) process.exit(1)
