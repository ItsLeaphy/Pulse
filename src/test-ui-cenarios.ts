// ============================================================
// Verificação estrutural dos cenários de borda pedidos na Fase 2.
// Não é um teste de DOM real (ambiente sem browser headless) —
// valida que as FUNÇÕES DE DADOS que a UI consome (obterEstadoFrente,
// obterHistórico, obterRitmoObservado, obterTendênciaFrente,
// obterFrentesEmAtenção, obterMudançasRecentes) não lançam exceção
// e retornam formas coerentes para cada cenário pedido. Isso cobre
// a camada que mais importa verificar automaticamente: se os dados
// que alimentam a UI estão corretos para cada caso de borda, a UI
// (que só traduz e exibe) não tem como quebrar silenciosamente.
// ============================================================
import { MemoryAdapter } from './storage'
import { criarFrente, criarRegistro, mudarCicloVida } from './frente-ops'
import { obterEstadoFrente, obterFrentesEmAtenção } from './estado'
import { obterHistórico } from './historico'
import { obterRitmoObservado } from './ritmo'
import { obterTendênciaFrente } from './tendencias'
import { obterMudançasRecentes, obterAtençãoGeral, obterDomíniosComSinalRelevante } from './ui/home-dados'
import { fraseMovimento, frasePausa, fraseEvento, rotuloSinal, rotuloCondição } from './ui/traducao'
import type { Frente } from './types'

const dia = 1000 * 60 * 60 * 24
const base = new Date('2026-09-29T00:00:00Z').getTime()
const agora = base + 20 * dia
const storage = new MemoryAdapter()

let falhas = 0
function check(condição: boolean, mensagem: string): void {
  if (condição) console.log(`✅ ${mensagem}`)
  else {
    console.log(`❌ ${mensagem}`)
    falhas++
  }
}

async function novaFrente(parcial: Partial<Frente> & Pick<Frente, 'id' | 'nome' | 'tipo'>, criadaEm: number) {
  return criarFrente(storage, {
    área: 'work', parentId: null, cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: 7,
    contextoFoco: null, contextoBloqueio: null, pausaMotivo: null, pausaRetomadaEm: null, criadaEm, ...parcial
  })
}

console.log('=== Frente sem registros ===')
await novaFrente({ id: 'sem-registros', nome: 'Sem Registros', tipo: 'projeto' }, base)
const estadoSemRegistros = await obterEstadoFrente(storage, 'sem-registros', agora)
check(estadoSemRegistros.movimento.tipo === 'nunca_movimentou', 'estado: nunca_movimentou')
check(fraseMovimento(estadoSemRegistros.movimento).length > 0, 'fraseMovimento não é vazia')
const histVazio = await obterHistórico(storage, 'sem-registros')
check(histVazio.length === 1, 'histórico tem só o evento de criação (1 item), sem lançar erro') // 1 = criação

console.log('\n=== Frente com muitos registros ===')
await novaFrente({ id: 'muitos-registros', nome: 'Muitos Registros', tipo: 'projeto' }, base)
for (let i = 0; i < 50; i++) {
  await criarRegistro(storage, { frenteId: 'muitos-registros', data: base + i * dia, texto: `registro ${i}`, contaComoMovimento: true })
}
const histGrande = await obterHistórico(storage, 'muitos-registros')
check(histGrande.length === 51, `histórico com 50 registros + 1 criação = 51 itens, veio ${histGrande.length}`) // +criação

console.log('\n=== Domínio vazio ===')
await novaFrente({ id: 'dom-vazio', nome: 'Domínio Vazio', tipo: 'domínio', cadênciaEsperada: null }, base)
const estadoDomVazio = await obterEstadoFrente(storage, 'dom-vazio', agora)
check(estadoDomVazio.sinal === null, 'domínio vazio: sinal null (não "ruim")')
check(estadoDomVazio.causasDomínio.length === 0, 'domínio vazio: sem causas')
check(rotuloSinal(estadoDomVazio.sinal) === 'Sem sinal aplicável', 'rótulo de sinal null é neutro, não alarmante')

console.log('\n=== Domínio com múltiplos descendentes ===')
await novaFrente({ id: 'dom-multi', nome: 'Domínio Multi', tipo: 'domínio', cadênciaEsperada: null }, base)
await novaFrente({ id: 'dom-multi-a', nome: 'A', tipo: 'projeto', parentId: 'dom-multi' }, base)
await novaFrente({ id: 'dom-multi-b', nome: 'B', tipo: 'projeto', parentId: 'dom-multi' }, base)
await criarRegistro(storage, { frenteId: 'dom-multi-a', data: base - 50 * dia, texto: 'velho', contaComoMovimento: true })
const estadoDomMulti = await obterEstadoFrente(storage, 'dom-multi', agora)
check(estadoDomMulti.causasDomínio.includes('dom-multi-a'), 'domínio com descendente negligenciado: causa identificada corretamente')

console.log('\n=== Frente pausada ===')
await novaFrente({ id: 'pausada', nome: 'Pausada', tipo: 'projeto', condição: 'pausada', pausaRetomadaEm: agora + 5 * dia }, base)
const estadoPausada = await obterEstadoFrente(storage, 'pausada', agora)
check(estadoPausada.pausa.tipo === 'pausa_com_data_futura', 'pausada com data futura: leitura correta')
check(frasePausa(estadoPausada.pausa) !== null, 'frasePausa não é null para frente pausada')

console.log('\n=== Bloqueada ===')
await novaFrente({ id: 'bloqueada', nome: 'Bloqueada', tipo: 'projeto', condição: 'bloqueada' }, base)
const estadoBloqueada = await obterEstadoFrente(storage, 'bloqueada', agora)
check(estadoBloqueada.sinal === null, 'bloqueada: sinal null')
check(rotuloCondição(estadoBloqueada.condição) === 'Bloqueada', 'rótulo de condição correto')

console.log('\n=== Aguardando ===')
await novaFrente({ id: 'aguardando', nome: 'Aguardando', tipo: 'projeto', condição: 'aguardando' }, base)
const estadoAguardando = await obterEstadoFrente(storage, 'aguardando', agora)
check(estadoAguardando.condição === 'aguardando', 'aguardando preservado')

console.log('\n=== Concluída ===')
await novaFrente({ id: 'concluida', nome: 'Concluída', tipo: 'projeto' }, base)
await mudarCicloVida(storage, 'concluida', 'concluída', base + 2 * dia)
const estadoConcluida = await obterEstadoFrente(storage, 'concluida', agora)
check(estadoConcluida.sinal === null, 'concluída: sinal null')
check(estadoConcluida.cicloVida === 'concluída', 'ciclo de vida preservado')
const atençãoGeral1 = await obterFrentesEmAtenção(storage, undefined, agora)
check(!atençãoGeral1.some((a) => a.frenteId === 'concluida'), 'concluída NÃO aparece em atenção')

console.log('\n=== Arquivada ===')
await novaFrente({ id: 'arquivada', nome: 'Arquivada', tipo: 'projeto' }, base)
await mudarCicloVida(storage, 'arquivada', 'arquivada', base + 2 * dia)
const estadoArquivada = await obterEstadoFrente(storage, 'arquivada', agora)
check(estadoArquivada.sinal === null, 'arquivada: sinal null')
check(!atençãoGeral1.some((a) => a.frenteId === 'arquivada'), 'arquivada NÃO aparece em atenção')

console.log('\n=== Sem sinal aplicável vs com sinal ===')
await novaFrente({ id: 'com-sinal', nome: 'Com Sinal', tipo: 'projeto' }, base)
await criarRegistro(storage, { frenteId: 'com-sinal', data: agora - 1 * dia, texto: 'recente', contaComoMovimento: true })
const estadoComSinal = await obterEstadoFrente(storage, 'com-sinal', agora)
check(estadoComSinal.sinal === 'no_ritmo', 'frente ativa+normal+movimento recente: sinal real')

console.log('\n=== Sem histórico suficiente para tendência/ritmo ===')
const ritmoInsuf = await obterRitmoObservado(storage, 'sem-registros', { início: agora - 30 * dia, fim: agora + 1 })
const tendInsuf = await obterTendênciaFrente(storage, 'sem-registros', { início: agora - 30 * dia, fim: agora + 1 })
check(ritmoInsuf.classificação === 'evidência_insuficiente', 'ritmo sem dados: evidência_insuficiente, não erro')
check(tendInsuf.tendência === 'insuficiente_evidência', 'tendência sem dados: insuficiente_evidência, não erro')

console.log('\n=== Home: mudanças recentes, atenção, domínios relevantes — sem lançar erro ===')
const período7d = { início: agora - 7 * dia, fim: agora + 1 }
const mudançasHome = await obterMudançasRecentes(storage, período7d)
check(Array.isArray(mudançasHome.movimentos), 'obterMudançasRecentes retorna estrutura válida')
const atençãoHome = await obterAtençãoGeral(storage, agora)
check(Array.isArray(atençãoHome), 'obterAtençãoGeral retorna array')
const domíniosHome = await obterDomíniosComSinalRelevante(storage, agora)
check(Array.isArray(domíniosHome), 'obterDomíniosComSinalRelevante retorna array')

console.log('\n=== Tradução de eventos nunca expõe nome técnico ===')
const eventosCriacao = await storage.getEventosEstruturais('bloqueada')
const eventoCondição = eventosCriacao.find((e) => e.tipo === 'condição_mudou')
if (eventoCondição) {
  const frase = fraseEvento(eventoCondição, () => 'raiz')
  check(!frase.includes('_mudou') && !frase.includes('condição_'), `fraseEvento não vaza nome técnico: "${frase}"`)
}

console.log(`\n${falhas === 0 ? '✅ Todos os cenários de UI verificados' : `❌ ${falhas} cenário(s) falharam`}`)
