import { MemoryAdapter } from './storage'
import { criarFrente, criarRegistro } from './frente-ops'
import { moverFrente } from './hierarquia'
import { exportarPulse, importarPulse, ErroImportPulse, VERSÃO_EXPORT_ATUAL, type PulseExport } from './portabilidade'
import type { Frente } from './types'

// ============================================================
// TESTE: export/import — BLOCO 5
// Rode com: npm run test:portabilidade
// ============================================================

const dia = 1000 * 60 * 60 * 24
const base = new Date('2026-09-29T00:00:00Z').getTime()

let falhas = 0
function check(condição: boolean, mensagem: string): void {
  if (condição) {
    console.log(`✅ ${mensagem}`)
  } else {
    console.log(`❌ ${mensagem}`)
    falhas++
  }
}

async function novaFrente(storage: MemoryAdapter, parcial: Partial<Frente> & Pick<Frente, 'id' | 'nome' | 'tipo'>, criadaEm: number) {
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

console.log('=== PARTE 1: exportação ===\n')

const storageVazio = new MemoryAdapter()
const exportVazio = await exportarPulse(storageVazio, base)
check(exportVazio.versão === VERSÃO_EXPORT_ATUAL, 'exportação vazia: versão correta')
check(exportVazio.frentes.length === 0 && exportVazio.registros.length === 0 && exportVazio.eventosEstruturais.length === 0, 'exportação vazia: todos os arrays vazios')
check(exportVazio.exportadoEm === base, 'exportação vazia: exportadoEm = timestamp passado')

const storage1 = new MemoryAdapter()
await novaFrente(storage1, { id: 'dom', nome: 'Domínio', tipo: 'domínio', cadênciaEsperada: null }, base)
await novaFrente(storage1, { id: 'filho', nome: 'Filho', tipo: 'projeto', parentId: 'dom' }, base)
await criarRegistro(storage1, { frenteId: 'filho', data: base + 1 * dia, texto: 'trabalho', contaComoMovimento: true })
await moverFrente(storage1, 'filho', null, base + 2 * dia)

const export1 = await exportarPulse(storage1, base + 3 * dia)
check(export1.frentes.length === 2, `exportação com árvore: 2 frentes, veio ${export1.frentes.length}`)
check(export1.registros.length === 1, `exportação com registros: 1 registro, veio ${export1.registros.length}`)
check(
  export1.eventosEstruturais.length === 3, // criação dom, criação filho, hierarquia_mudou filho
  `exportação com eventos estruturais: 3 eventos, veio ${export1.eventosEstruturais.length}`
)
check(
  export1.eventosEstruturais.some((e) => e.tipo === 'hierarquia_mudou'),
  'exportação inclui evento hierarquia_mudou (preserva histórico de reparenting)'
)

const jsonString = JSON.stringify(export1)
check(!jsonString.includes('token'), 'exportação não contém a palavra "token" (sem credenciais)')
check(!jsonString.toLowerCase().includes('supabase'), 'exportação não menciona Supabase (trabalha sobre o modelo de domínio, não sobre o adapter)')
check(!jsonString.toLowerCase().includes('anon_key') && !jsonString.toLowerCase().includes('apikey'), 'exportação não contém chaves de API')

// determinismo: exportar duas vezes os mesmos dados produz a mesma lista (exceto exportadoEm)
const export1DeNovo = await exportarPulse(storage1, base + 999 * dia)
check(
  JSON.stringify(export1.frentes) === JSON.stringify(export1DeNovo.frentes) &&
    JSON.stringify(export1.registros) === JSON.stringify(export1DeNovo.registros) &&
    JSON.stringify(export1.eventosEstruturais) === JSON.stringify(export1DeNovo.eventosEstruturais),
  'exportação é determinística: mesmos dados produzem a mesma lista de frentes/registros/eventos (exportadoEm pode variar, o resto não)'
)

console.log('\n=== PARTE 2: importação válida + round-trip ===\n')

const storageDestino = new MemoryAdapter()
await importarPulse(storageDestino, export1)

const frentesImportadas = await storageDestino.getFrentes()
check(frentesImportadas.length === 2, `importação válida: 2 frentes no destino, veio ${frentesImportadas.length}`)

const filhoImportado = await storageDestino.getFrente('filho')
check(filhoImportado !== undefined && filhoImportado.parentId === null, 'round-trip: filho importado mantém parentId=null (estado pós-reparenting preservado)')

const registrosImportados = await storageDestino.getRegistros('filho')
check(
  registrosImportados.length === 1 && registrosImportados[0]?.texto === 'trabalho',
  'round-trip: registro importado com texto preservado'
)

const eventosImportados = await storageDestino.getEventosEstruturais('filho')
check(
  eventosImportados.some((e) => e.tipo === 'hierarquia_mudou' && e.valorNovo === null),
  'round-trip: evento hierarquia_mudou importado preserva valorNovo=null (raiz)'
)

console.log('\n=== PARTE 3: rejeições de importação ===\n')

let erro: ErroImportPulse | undefined
try {
  await importarPulse(new MemoryAdapter(), { versão: 999, frentes: [], registros: [], eventosEstruturais: [] })
} catch (e) {
  erro = e instanceof ErroImportPulse ? e : undefined
}
check(erro !== undefined && erro.erros.some((x) => x.campo === 'versão'), 'versão inválida: rejeitada com erro sobre o campo versão')

erro = undefined
try {
  await importarPulse(new MemoryAdapter(), { versão: 1, frentes: 'não é array', registros: [], eventosEstruturais: [] })
} catch (e) {
  erro = e instanceof ErroImportPulse ? e : undefined
}
check(erro !== undefined, 'estrutura inválida (frentes não é array): rejeitada')

const comIdDuplicado: PulseExport = {
  versão: 1,
  exportadoEm: base,
  frentes: [
    { id: 'dup', nome: 'A', área: 'work', tipo: 'projeto', parentId: null, cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: 7, últimoMovimento: null, contextoFoco: null, contextoBloqueio: null, pausaMotivo: null, pausaRetomadaEm: null, criadaEm: base },
    { id: 'dup', nome: 'B', área: 'work', tipo: 'projeto', parentId: null, cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: 7, últimoMovimento: null, contextoFoco: null, contextoBloqueio: null, pausaMotivo: null, pausaRetomadaEm: null, criadaEm: base }
  ],
  registros: [],
  eventosEstruturais: []
}
erro = undefined
try {
  await importarPulse(new MemoryAdapter(), comIdDuplicado)
} catch (e) {
  erro = e instanceof ErroImportPulse ? e : undefined
}
check(erro !== undefined && erro.erros.some((x) => x.mensagem.includes('duplicado')), 'IDs duplicados dentro do import: rejeitados')

const comParentInexistente: PulseExport = {
  versão: 1,
  exportadoEm: base,
  frentes: [
    { id: 'f1', nome: 'F1', área: 'work', tipo: 'projeto', parentId: 'nao-existe', cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: 7, últimoMovimento: null, contextoFoco: null, contextoBloqueio: null, pausaMotivo: null, pausaRetomadaEm: null, criadaEm: base }
  ],
  registros: [],
  eventosEstruturais: []
}
erro = undefined
try {
  await importarPulse(new MemoryAdapter(), comParentInexistente)
} catch (e) {
  erro = e instanceof ErroImportPulse ? e : undefined
}
check(erro !== undefined, 'parentId inexistente (fora do import): rejeitado')

const comCiclo: PulseExport = {
  versão: 1,
  exportadoEm: base,
  frentes: [
    { id: 'a', nome: 'A', área: 'work', tipo: 'domínio', parentId: 'b', cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: null, últimoMovimento: null, contextoFoco: null, contextoBloqueio: null, pausaMotivo: null, pausaRetomadaEm: null, criadaEm: base },
    { id: 'b', nome: 'B', área: 'work', tipo: 'domínio', parentId: 'a', cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: null, últimoMovimento: null, contextoFoco: null, contextoBloqueio: null, pausaMotivo: null, pausaRetomadaEm: null, criadaEm: base }
  ],
  registros: [],
  eventosEstruturais: []
}
erro = undefined
try {
  await importarPulse(new MemoryAdapter(), comCiclo)
} catch (e) {
  erro = e instanceof ErroImportPulse ? e : undefined
}
check(erro !== undefined && erro.erros.some((x) => x.mensagem.includes('ciclo')), 'ciclo dentro do import (a→b→a): rejeitado')

const comRegistroÓrfão: PulseExport = {
  versão: 1,
  exportadoEm: base,
  frentes: [],
  registros: [
    { id: 'r1', frenteId: 'frente-fantasma', data: base, criadoEm: base, texto: 'x', contaComoMovimento: true }
  ],
  eventosEstruturais: []
}
erro = undefined
try {
  await importarPulse(new MemoryAdapter(), comRegistroÓrfão)
} catch (e) {
  erro = e instanceof ErroImportPulse ? e : undefined
}
check(erro !== undefined, 'registro apontando para frente inexistente: rejeitado')

const comEventoÓrfão: PulseExport = {
  versão: 1,
  exportadoEm: base,
  frentes: [],
  registros: [],
  eventosEstruturais: [
    { id: 'e1', frenteId: 'frente-fantasma', tipo: 'criação', valorAnterior: null, valorNovo: null, criadoEm: base }
  ]
}
erro = undefined
try {
  await importarPulse(new MemoryAdapter(), comEventoÓrfão)
} catch (e) {
  erro = e instanceof ErroImportPulse ? e : undefined
}
check(erro !== undefined, 'evento apontando para frente inexistente: rejeitado')

console.log('\n=== PARTE 4: colisão com dados existentes ===\n')

const storageComDados = new MemoryAdapter()
await novaFrente(storageComDados, { id: 'já-existe', nome: 'Já Existe', tipo: 'projeto' }, base)

const comColisão: PulseExport = {
  versão: 1,
  exportadoEm: base,
  frentes: [
    { id: 'já-existe', nome: 'Tentando sobrescrever', área: 'work', tipo: 'projeto', parentId: null, cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: 7, últimoMovimento: null, contextoFoco: null, contextoBloqueio: null, pausaMotivo: null, pausaRetomadaEm: null, criadaEm: base }
  ],
  registros: [],
  eventosEstruturais: []
}
erro = undefined
try {
  await importarPulse(storageComDados, comColisão)
} catch (e) {
  erro = e instanceof ErroImportPulse ? e : undefined
}
check(erro !== undefined && erro.erros.some((x) => x.mensagem.includes('já existe')), 'colisão de id com storage existente: rejeitada, não faz merge silencioso')

const frenteAindaOriginal = await storageComDados.getFrente('já-existe')
check(frenteAindaOriginal?.nome === 'Já Existe', 'dados existentes NÃO foram alterados pela tentativa de importação rejeitada')

console.log('\n=== PARTE 5: validação completa antes de qualquer escrita (sem estado parcial) ===\n')

// import com 1 frente válida + 1 registro inválido (frenteId órfão) — deve rejeitar
// TUDO, inclusive a frente válida, sem gravar nada
const storageParcial = new MemoryAdapter()
const comMisturaVálidoInválido: PulseExport = {
  versão: 1,
  exportadoEm: base,
  frentes: [
    { id: 'válida', nome: 'Válida', área: 'work', tipo: 'projeto', parentId: null, cicloVida: 'ativa', condição: 'normal', cadênciaEsperada: 7, últimoMovimento: null, contextoFoco: null, contextoBloqueio: null, pausaMotivo: null, pausaRetomadaEm: null, criadaEm: base }
  ],
  registros: [
    { id: 'r-orfao', frenteId: 'nao-existe-mesmo', data: base, criadoEm: base, texto: 'x', contaComoMovimento: true }
  ],
  eventosEstruturais: []
}
erro = undefined
try {
  await importarPulse(storageParcial, comMisturaVálidoInválido)
} catch (e) {
  erro = e instanceof ErroImportPulse ? e : undefined
}
check(erro !== undefined, 'import misto (1 frente válida + 1 registro órfão): rejeitado')
const frentesAposRejeição = await storageParcial.getFrentes()
check(
  frentesAposRejeição.length === 0,
  `nenhuma escrita parcial: a frente válida NÃO foi gravada mesmo sendo válida isoladamente, veio ${frentesAposRejeição.length} frente(s)`
)

console.log(`\n${falhas === 0 ? '✅ Todos os testes de portabilidade passaram' : `❌ ${falhas} teste(s) falharam`}`)
