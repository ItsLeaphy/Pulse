import {
  ErroPulse,
  ErroParcial,
  ErroValidação,
  extrairDetalhes,
  mensagemParaUsuário,
  normalizarErro,
  redigirSegredos
} from './erros'

// ============================================================
// TESTE: normalização de erros — nenhum valor lançado pode virar
// "[object Object]". Rode com: npm run test:erros
// ============================================================

let falhas = 0
function check(condição: boolean, mensagem: string): void {
  if (condição) console.log(`✅ ${mensagem}`)
  else {
    console.log(`❌ ${mensagem}`)
    falhas++
  }
}

const circular: Record<string, unknown> = {}
circular.self = circular

const entradas: [string, unknown][] = [
  ['Error comum', new Error('falhou')],
  ['PostgrestError (objeto simples)', { code: '23505', message: 'duplicate key', details: 'Key (id)=(1)', hint: 'use upsert' }],
  ['string', 'texto solto'],
  ['objeto só com error_description', { error_description: 'invalid grant' }],
  ['objeto vazio', {}],
  ['null', null],
  ['undefined', undefined],
  ['número', 42],
  ['objeto circular', circular],
  ['TypeError de rede', new TypeError('Failed to fetch')],
  ['ErroPulse', new ErroPulse('salvar a frente', { mensagem: 'x', código: '42501' })],
  ['ErroValidação', new ErroValidação('Dê um nome para a frente.')],
  ['ErroParcial', new ErroParcial('Criar frente', ['frente criada'], ['histórico'], { message: 'rede caiu' })]
]
for (const [rótulo, valor] of entradas) {
  for (const dev of [false, true]) {
    const texto = mensagemParaUsuário(valor, 'salvar', dev)
    check(
      texto.trim() !== '' && !texto.includes('[object Object]') && !texto.includes('undefined'),
      `${rótulo} (${dev ? 'dev' : 'prod'}): "${texto.slice(0, 70)}"`
    )
  }
}

// ---- extração estruturada
const d = extrairDetalhes({ code: '23505', message: 'duplicate key', details: 'Key (id)', hint: 'dica' })
check(d.código === '23505' && d.mensagem === 'duplicate key' && d.detalhes === 'Key (id)' && d.dica === 'dica', 'PostgrestError: código, mensagem, detalhes e dica extraídos')
check(extrairDetalhes(new Error('boom')).mensagem === 'boom', 'Error: lê Error.message')

// ---- produção não expõe internos; dev expõe
const interno = { code: 'XX999', message: 'falha esquisita', details: 'tabela frentes coluna foo', hint: 'x' }
const prod = mensagemParaUsuário(interno, 'salvar a frente', false)
const dev = mensagemParaUsuário(interno, 'salvar a frente', true)
check(prod.startsWith('Não foi possível salvar a frente.'), 'mensagem contextualizada pela operação')
check(!prod.includes('XX999') && !prod.includes('tabela frentes'), 'produção: sem código nem detalhes internos')
check(dev.includes('XX999') && dev.includes('tabela frentes'), 'desenvolvimento: com código e detalhes')

// ---- classificações amigáveis
check(/internet|conex/i.test(mensagemParaUsuário(new TypeError('Failed to fetch'), 'carregar', false)), 'falha de rede → mensagem de conexão')
check(/sess/i.test(mensagemParaUsuário({ code: 'PGRST301', message: 'JWT expired' }, 'carregar', false)), 'JWT expirado → mensagem de sessão')
check(/permiss/i.test(mensagemParaUsuário({ code: '42501', message: 'rls' }, 'salvar', false)), 'RLS → mensagem de permissão')
check(/migra/i.test(mensagemParaUsuário({ code: '23502', message: 'null value in column "estado"' }, 'salvar', false)), 'schema incompatível → orienta migrações')

// ---- parcial / validação
const parcial = new ErroParcial('Criar frente', ['frente criada'], ['registro no histórico'], { message: 'rede' }, async () => {})
const txtParcial = mensagemParaUsuário(parcial, 'criar', false)
check(txtParcial.includes('frente criada') && txtParcial.includes('registro no histórico'), 'parcial: diz o que foi salvo e o que falta')
check(!/^Não foi possível/.test(txtParcial), 'parcial: NÃO é apresentado como falha total')
check(txtParcial.includes('Tentar completar'), 'parcial com completar: oferece retry sem duplicar')
check(mensagemParaUsuário(new ErroValidação('Dê um nome.'), 'criar', false) === 'Dê um nome.', 'validação: mensagem direta, sem prefixo')

// ---- normalizar é idempotente
const ep = normalizarErro({ message: 'a' }, 'op')
check(normalizarErro(ep, 'outra') === ep, 'normalizarErro de um ErroPulse devolve o mesmo objeto')

// ---- segredos
const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-xyz'
check(!redigirSegredos(`token ${jwt}`).includes('eyJ'), 'JWT removido de logs')
check(!redigirSegredos('apikey: sb_secret_12345').includes('sb_secret_12345'), 'apikey removida de logs')
check(!redigirSegredos('Authorization: Bearer abc.def.ghi').includes('abc.def.ghi'), 'Authorization removido de logs')

console.log(`\n${falhas === 0 ? '✅ Tratamento de erros: todos os testes passaram' : `❌ ${falhas} teste(s) falharam`}`)
