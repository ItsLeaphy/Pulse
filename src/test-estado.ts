import { MemoryAdapter } from './storage'
import { criarFrente, criarRegistro, mudarCicloVida, mudarCondição } from './frente-ops'
import { obterEstadoFrente, obterFrentesEmAtenção, obterDuraçãoCondição } from './estado'
import type { Frente } from './types'

// ============================================================
// TESTE: estado derivado da frente — BLOCO 3
// Rode com: npm run test:estado
// ============================================================

const dia = 1000 * 60 * 60 * 24
const base = new Date('2026-09-29T00:00:00Z').getTime()
const agora = base + 20 * dia // timestamp de referência FIXO — determinismo

const storage = new MemoryAdapter()

let falhas = 0
function check(condição: boolean, mensagem: string): void {
  if (condição) {
    console.log(`✅ ${mensagem}`)
  } else {
    console.log(`❌ ${mensagem}`)
    falhas++
  }
}

async function novaFrente(parcial: Partial<Frente> & Pick<Frente, 'id' | 'nome' | 'tipo'>, criadaEm: number) {
  return criarFrente(storage, {
    área: 'work',
    parentId: null,
    cicloVida: 'ativa',
    condição: 'normal',
    cadênciaEsperada: 7,
    contextoFoco: null,
    contextoBloqueio: null,
    pausaMotivo: null,
    pausaRetomadaEm: null,
    criadaEm,
    ...parcial
  })
}

console.log('=== PARTE 1: estados individuais ===\n')

// normal, movimento recente
await novaFrente({ id: 'normal-1', nome: 'Normal', tipo: 'projeto' }, base)
await criarRegistro(storage, { frenteId: 'normal-1', data: agora - 1 * dia, texto: 'trabalhei', contaComoMovimento: true })
let e = await obterEstadoFrente(storage, 'normal-1', agora)
check(e.sinal === 'no_ritmo', 'Normal com movimento recente: sinal=no_ritmo')
check(e.movimento.tipo === 'movimentou', 'Normal: movimento.tipo=movimentou')

// esfriando (desvio entre 1x e 2x cadência)
await novaFrente({ id: 'esfriando-1', nome: 'Esfriando', tipo: 'projeto', cadênciaEsperada: 7 }, base)
await criarRegistro(storage, { frenteId: 'esfriando-1', data: agora - 10 * dia, texto: 'último movimento', contaComoMovimento: true })
e = await obterEstadoFrente(storage, 'esfriando-1', agora)
check(e.sinal === 'esfriando', `Esfriando (10d, cadência 7d): sinal=esfriando, veio ${e.sinal}`)

// negligenciada / fora_do_ritmo (desvio > 2x cadência)
await novaFrente({ id: 'negligenciada-1', nome: 'Negligenciada', tipo: 'projeto', cadênciaEsperada: 7 }, base)
await criarRegistro(storage, { frenteId: 'negligenciada-1', data: agora - 40 * dia, texto: 'esquecido', contaComoMovimento: true })
e = await obterEstadoFrente(storage, 'negligenciada-1', agora)
check(e.sinal === 'fora_do_ritmo', `Negligenciada (40d, cadência 7d): sinal=fora_do_ritmo, veio ${e.sinal}`)

// bloqueada
await novaFrente({ id: 'bloqueada-1', nome: 'Bloqueada', tipo: 'projeto', condição: 'bloqueada' }, base)
e = await obterEstadoFrente(storage, 'bloqueada-1', agora)
check(e.sinal === null, 'Bloqueada: sinal=null (não negligência)')
check(e.condição === 'bloqueada', 'Bloqueada: condição preservada como bloqueada')
check(e.movimento.tipo === 'sem_movimento_esperado', 'Bloqueada: movimento.tipo=sem_movimento_esperado')

// aguardando
await novaFrente({ id: 'aguardando-1', nome: 'Aguardando', tipo: 'projeto', condição: 'aguardando' }, base)
e = await obterEstadoFrente(storage, 'aguardando-1', agora)
check(e.sinal === null, 'Aguardando: sinal=null')
check(e.condição === 'aguardando', 'Aguardando: condição preservada')

// pausada com retomada futura
await novaFrente(
  { id: 'pausada-futura-1', nome: 'Pausada Futura', tipo: 'projeto', condição: 'pausada', pausaRetomadaEm: agora + 5 * dia },
  base
)
e = await obterEstadoFrente(storage, 'pausada-futura-1', agora)
check(e.sinal === null, 'Pausada com retomada futura: sinal=null')
check(e.pausa.tipo === 'pausa_com_data_futura', 'Pausa com data futura: pausa.tipo correto')
if (e.pausa.tipo === 'pausa_com_data_futura') {
  check(Math.abs(e.pausa.diasRestantes - 5) < 0.01, `diasRestantes ≈ 5, veio ${e.pausa.diasRestantes}`)
}

// pausada sem data
await novaFrente({ id: 'pausada-sem-data-1', nome: 'Pausada Sem Data', tipo: 'projeto', condição: 'pausada', pausaRetomadaEm: null }, base)
e = await obterEstadoFrente(storage, 'pausada-sem-data-1', agora)
check(e.pausa.tipo === 'pausa_sem_data', 'Pausa sem data: pausa.tipo=pausa_sem_data')

// pausa vencida
await novaFrente(
  { id: 'pausa-vencida-1', nome: 'Pausa Vencida', tipo: 'projeto', condição: 'pausada', pausaRetomadaEm: agora - 3 * dia },
  base
)
e = await obterEstadoFrente(storage, 'pausa-vencida-1', agora)
check(e.pausa.tipo === 'pausa_vencida', 'Pausa vencida: pausa.tipo=pausa_vencida')
if (e.pausa.tipo === 'pausa_vencida') {
  check(Math.abs(e.pausa.diasVencida - 3) < 0.01, `diasVencida ≈ 3, veio ${e.pausa.diasVencida}`)
}
check(e.condição === 'pausada', 'Pausa vencida NÃO altera condição automaticamente — continua pausada')

// concluída
await novaFrente({ id: 'concluida-1', nome: 'Concluída', tipo: 'projeto' }, base)
await mudarCicloVida(storage, 'concluida-1', 'concluída', base + 2 * dia)
e = await obterEstadoFrente(storage, 'concluida-1', agora)
check(e.sinal === null, 'Concluída: sinal=null')
check(e.cicloVida === 'concluída', 'Concluída: cicloVida preservado')

// arquivada
await novaFrente({ id: 'arquivada-1', nome: 'Arquivada', tipo: 'projeto' }, base)
await mudarCicloVida(storage, 'arquivada-1', 'arquivada', base + 2 * dia)
e = await obterEstadoFrente(storage, 'arquivada-1', agora)
check(e.sinal === null, 'Arquivada: sinal=null')

// sem movimento (nunca registrou nada, mas movimento é esperado)
await novaFrente({ id: 'sem-movimento-1', nome: 'Sem Movimento', tipo: 'projeto', cadênciaEsperada: 100 }, base)
e = await obterEstadoFrente(storage, 'sem-movimento-1', agora)
check(e.movimento.tipo === 'nunca_movimentou', 'Frente sem nenhum registro de movimento: movimento.tipo=nunca_movimentou')

console.log('\n=== PARTE 2: domínio vazio, com filhos, causas, empate ===\n')

await novaFrente({ id: 'dominio-vazio-1', nome: 'Domínio Vazio', tipo: 'domínio', cadênciaEsperada: null }, base)
e = await obterEstadoFrente(storage, 'dominio-vazio-1', agora)
check(e.sinal === null, 'Domínio vazio: sinal=null')
check(e.causasDomínio.length === 0, 'Domínio vazio: causasDomínio vazio')

// domínio com filhos em estados diferentes — causa deve apontar pro pior
await novaFrente({ id: 'dom-misto', nome: 'Domínio Misto', tipo: 'domínio', cadênciaEsperada: null }, base)
await novaFrente({ id: 'dom-misto-filho-ok', nome: 'Filho OK', tipo: 'projeto', parentId: 'dom-misto', cadênciaEsperada: 7 }, base)
await criarRegistro(storage, { frenteId: 'dom-misto-filho-ok', data: agora - 1 * dia, texto: 'ok', contaComoMovimento: true })
await novaFrente({ id: 'dom-misto-filho-ruim', nome: 'Filho Ruim', tipo: 'projeto', parentId: 'dom-misto', cadênciaEsperada: 5 }, base)
await criarRegistro(storage, { frenteId: 'dom-misto-filho-ruim', data: agora - 50 * dia, texto: 'esquecido', contaComoMovimento: true })

e = await obterEstadoFrente(storage, 'dom-misto', agora)
check(e.sinal === 'fora_do_ritmo', `Domínio misto herda o pior sinal (fora_do_ritmo), veio ${e.sinal}`)
check(
  e.causasDomínio.length === 1 && e.causasDomínio[0] === 'dom-misto-filho-ruim',
  `Causa do domínio misto é exatamente o filho ruim, veio ${JSON.stringify(e.causasDomínio)}`
)

// empate: dois filhos com o mesmo pior sinal
await novaFrente({ id: 'dom-empate', nome: 'Domínio Empate', tipo: 'domínio', cadênciaEsperada: null }, base)
await novaFrente({ id: 'dom-empate-a', nome: 'Empate A', tipo: 'projeto', parentId: 'dom-empate', cadênciaEsperada: 5 }, base)
await criarRegistro(storage, { frenteId: 'dom-empate-a', data: agora - 50 * dia, texto: 'esquecido A', contaComoMovimento: true })
await novaFrente({ id: 'dom-empate-b', nome: 'Empate B', tipo: 'projeto', parentId: 'dom-empate', cadênciaEsperada: 5 }, base)
await criarRegistro(storage, { frenteId: 'dom-empate-b', data: agora - 60 * dia, texto: 'esquecido B', contaComoMovimento: true })

e = await obterEstadoFrente(storage, 'dom-empate', agora)
check(
  e.causasDomínio.length === 2 &&
    e.causasDomínio.includes('dom-empate-a') &&
    e.causasDomínio.includes('dom-empate-b'),
  `Empate: AMBOS os filhos aparecem como causa, veio ${JSON.stringify(e.causasDomínio)}`
)

// domínio aninhado: causa deve alcançar neto, não só filho direto
await novaFrente({ id: 'dom-neto-raiz', nome: 'Raiz', tipo: 'domínio', cadênciaEsperada: null }, base)
await novaFrente({ id: 'dom-neto-meio', nome: 'Meio', tipo: 'domínio', parentId: 'dom-neto-raiz', cadênciaEsperada: null }, base)
await novaFrente({ id: 'dom-neto-folha', nome: 'Folha', tipo: 'projeto', parentId: 'dom-neto-meio', cadênciaEsperada: 5 }, base)
await criarRegistro(storage, { frenteId: 'dom-neto-folha', data: agora - 50 * dia, texto: 'esquecido', contaComoMovimento: true })

e = await obterEstadoFrente(storage, 'dom-neto-raiz', agora)
check(
  e.causasDomínio.length === 1 && e.causasDomínio[0] === 'dom-neto-folha',
  `Causa propaga até o neto (não fica presa no domínio intermediário), veio ${JSON.stringify(e.causasDomínio)}`
)

console.log('\n=== PARTE 3: duração da condição ===\n')

await novaFrente({ id: 'duracao-1', nome: 'Duração Teste', tipo: 'projeto' }, base)
await mudarCondição(storage, 'duracao-1', 'bloqueada', base + 1 * dia)
const duração = await obterDuraçãoCondição(storage, 'duracao-1', agora)
check(duração !== null, 'Duração da condição não é null quando há evento condição_mudou')
if (duração) {
  const diasEsperados = (agora - (base + 1 * dia)) / dia
  check(Math.abs(duração.dias - diasEsperados) < 0.01, `Duração ≈ ${diasEsperados.toFixed(1)}d, veio ${duração.dias.toFixed(1)}d`)
  check(duração.desde === base + 1 * dia, 'duração.desde bate com o timestamp do evento condição_mudou')
}

// ausência de evento suficiente: frente criada sem storage registrar
// evento de criação (simulando migração de dados antigos) — não deve inventar data
const storageSemEventos = new MemoryAdapter()
await storageSemEventos.salvarFrente({
  id: 'sem-evento-1',
  nome: 'Sem Evento',
  área: 'work',
  tipo: 'projeto',
  parentId: null,
  cicloVida: 'ativa',
  condição: 'normal',
  cadênciaEsperada: 7,
  últimoMovimento: null,
  contextoFoco: null,
  contextoBloqueio: null,
  pausaMotivo: null,
  pausaRetomadaEm: null,
  criadaEm: base
})
const duraçãoSemEvento = await obterDuraçãoCondição(storageSemEventos, 'sem-evento-1', agora)
check(duraçãoSemEvento === null, 'Sem nenhum evento estrutural: duração retorna null, não inventa data')

// condição nunca mudou desde a criação — duração usa o evento de criação
await novaFrente({ id: 'duracao-so-criacao', nome: 'Só Criação', tipo: 'projeto' }, base + 2 * dia)
const duraçãoSóCriação = await obterDuraçãoCondição(storage, 'duracao-so-criacao', agora)
check(
  duraçãoSóCriação !== null && duraçãoSóCriação.desde === base + 2 * dia,
  'Condição nunca mudou: duração usa o evento de criação como "desde"'
)

console.log('\n=== PARTE 4: data do acontecimento (Registro.data), não criadoEm ===\n')

await novaFrente({ id: 'data-vs-criado-1', nome: 'Data vs CriadoEm', tipo: 'projeto', cadênciaEsperada: 100 }, base)
// registro retroativo: data é de 5 dias atrás, mas criadoEm (quando foi inserido) é agora
await criarRegistro(storage, {
  frenteId: 'data-vs-criado-1',
  data: agora - 5 * dia,
  criadoEm: agora,
  texto: 'retroativo',
  contaComoMovimento: true
})
e = await obterEstadoFrente(storage, 'data-vs-criado-1', agora)
check(
  e.movimento.tipo === 'movimentou' && Math.abs((e.movimento as { diasDesde: number }).diasDesde - 5) < 0.01,
  `Tempo desde último movimento usa Registro.data (5 dias), NÃO criadoEm (0 dias) — veio ${
    e.movimento.tipo === 'movimentou' ? (e.movimento as { diasDesde: number }).diasDesde : 'N/A'
  }`
)

console.log('\n=== PARTE 5: lista de atenção ===\n')

const atenção = await obterFrentesEmAtenção(storage, undefined, agora)
const idsEmAtenção = atenção.map((a) => a.frenteId)

check(idsEmAtenção.includes('esfriando-1'), 'Esfriando aparece na lista de atenção')
check(idsEmAtenção.includes('negligenciada-1'), 'Negligenciada (fora_do_ritmo) aparece na lista de atenção')
check(idsEmAtenção.includes('bloqueada-1'), 'Bloqueada aparece na lista de atenção')
check(idsEmAtenção.includes('aguardando-1'), 'Aguardando aparece na lista de atenção')
check(idsEmAtenção.includes('pausa-vencida-1'), 'Pausa vencida aparece na lista de atenção')
check(!idsEmAtenção.includes('normal-1'), 'Normal (no_ritmo) NÃO aparece na lista de atenção')
check(!idsEmAtenção.includes('concluida-1'), 'Concluída NÃO aparece na lista de atenção')
check(!idsEmAtenção.includes('arquivada-1'), 'Arquivada NÃO aparece na lista de atenção')
check(!idsEmAtenção.includes('pausada-futura-1'), 'Pausada com retomada futura (não vencida) NÃO aparece na lista')

const motivoBloqueada = atenção.find((a) => a.frenteId === 'bloqueada-1')
check(
  motivoBloqueada !== undefined &&
    motivoBloqueada.motivos.length === 1 &&
    motivoBloqueada.motivos[0]?.tipo === 'condição',
  'Bloqueada tem exatamente 1 motivo, tipo=condição (estrutura preservada, não string concatenada)'
)

console.log('\n=== PARTE 6: determinismo (timestamp de referência fixo) ===\n')

const e1 = await obterEstadoFrente(storage, 'esfriando-1', agora)
const e2 = await obterEstadoFrente(storage, 'esfriando-1', agora)
check(
  JSON.stringify(e1) === JSON.stringify(e2),
  'obterEstadoFrente com o mesmo `agora` produz exatamente o mesmo resultado'
)

const atenção1 = await obterFrentesEmAtenção(storage, undefined, agora)
const atenção2 = await obterFrentesEmAtenção(storage, undefined, agora)
check(
  JSON.stringify(atenção1) === JSON.stringify(atenção2),
  'obterFrentesEmAtenção com o mesmo `agora` produz exatamente o mesmo resultado'
)

console.log(`\n${falhas === 0 ? '✅ Todos os testes de estado passaram' : `❌ ${falhas} teste(s) falharam`}`)
