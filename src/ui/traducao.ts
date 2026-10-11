import type { Sinal, Condição, CicloVida, EventoEstrutural } from '../types'
import type { LeituraMovimento, LeituraPausa, DuraçãoCondição } from '../estado'
import type { ClassificaçãoRitmo, SugestãoCadência } from '../ritmo'
import type { Tendência, Confiança } from '../tendencias'

// ============================================================
// TRADUÇÃO — camada de apresentação pura
//
// Única responsabilidade: transformar os valores que o domínio
// já calculou em frases que uma pessoa lê sem precisar saber o
// nome de nenhum tipo/enum interno. Nada aqui decide ritmo,
// sinal, condição ou tendência — isso já veio pronto de
// estado.ts/signal.ts/ritmo.ts/tendencias.ts. É só vocabulário.
// ============================================================

export function diasPorExtenso(dias: number): string {
  const arred = Math.round(dias)
  if (arred === 0) return 'hoje'
  if (arred === 1) return '1 dia'
  return `${arred} dias`
}

export function rotuloSinal(sinal: Sinal): string {
  if (sinal === null) return 'Sem sinal aplicável'
  if (sinal === 'no_ritmo') return 'Em ritmo'
  if (sinal === 'esfriando') return 'Esfriando'
  return 'Fora do ritmo'
}

export function classeSinal(sinal: Sinal): string {
  return sinal === null ? 'sinal-nenhum' : sinal
}

export function rotuloCondição(condição: Condição): string {
  switch (condição) {
    case 'normal': return 'Normal'
    case 'bloqueada': return 'Bloqueada'
    case 'aguardando': return 'Aguardando'
    case 'pausada': return 'Pausada'
  }
}

export function rotuloCicloVida(cicloVida: CicloVida): string {
  switch (cicloVida) {
    case 'ativa': return 'Ativa'
    case 'concluída': return 'Concluída'
    case 'arquivada': return 'Arquivada'
  }
}

/** Frase curta para LeituraMovimento — "última evidência", na
 * linguagem do produto, nunca "últimoMovimento: <timestamp>". */
export function fraseMovimento(leitura: LeituraMovimento): string {
  switch (leitura.tipo) {
    case 'sem_movimento_esperado':
      return 'Sem expectativa de movimento agora'
    case 'nunca_movimentou':
      return 'Ainda sem nenhum movimento registrado'
    case 'movimentou':
      return `Último movimento há ${diasPorExtenso(leitura.diasDesde)}`
  }
}

/** Frase para LeituraPausa — nunca soa como alarme, mesmo quando
 * vencida: é uma decisão anterior que pode merecer revisão, não
 * um erro do sistema. */
export function frasePausa(leitura: LeituraPausa): string | null {
  switch (leitura.tipo) {
    case 'sem_pausa':
      return null
    case 'pausa_sem_data':
      return 'Pausada sem data prevista de retomada'
    case 'pausa_com_data_futura':
      return `Pausada — retomada prevista em ${diasPorExtenso(leitura.diasRestantes)}`
    case 'pausa_vencida':
      return `Pausa prevista para retomar há ${diasPorExtenso(leitura.diasVencida)} — vale revisar`
  }
}

export function fraseDuraçãoCondição(condição: Condição, duração: DuraçãoCondição | null): string | null {
  if (condição === 'normal' || duração === null) return null
  return `${rotuloCondição(condição)} há ${diasPorExtenso(duração.dias)}`
}

/** Traduz um EventoEstrutural para uma frase na voz do produto —
 * nunca "tipo: valorAnterior → valorNovo". `nomePorId` resolve ids
 * de frente pra nome (usado em hierarquia_mudou); passar um mapa
 * já carregado evita I/O repetido na UI. */
export function fraseEvento(evento: EventoEstrutural, nomePorId: (id: string | null) => string): string {
  switch (evento.tipo) {
    case 'criação':
      return 'Frente criada'
    case 'ciclo_vida_mudou':
      if (evento.valorNovo === 'concluída') return 'Marcada como concluída'
      if (evento.valorNovo === 'arquivada') return 'Arquivada'
      if (evento.valorNovo === 'ativa') return 'Reativada'
      return 'Ciclo de vida alterado'
    case 'condição_mudou':
      if (evento.valorNovo === 'bloqueada') return 'Entrou em bloqueio'
      if (evento.valorNovo === 'aguardando') return 'Passou a aguardar'
      if (evento.valorNovo === 'pausada') return 'Entrou em pausa'
      if (evento.valorNovo === 'normal') return 'Voltou ao normal'
      return 'Condição alterada'
    case 'cadência_mudou':
      return evento.valorNovo
        ? `Cadência ajustada para ${evento.valorNovo} dia(s)`
        : 'Cadência removida'
    case 'hierarquia_mudou':
      return `Movida para ${nomePorId(evento.valorNovo)}`
  }
}

export function fraseClassificaçãoRitmo(c: ClassificaçãoRitmo): string {
  switch (c) {
    case 'ritmo_compatível': return 'Compatível com a cadência declarada'
    case 'abaixo_do_esperado': return 'Abaixo do ritmo esperado'
    case 'acima_do_esperado': return 'Acima do ritmo esperado'
    case 'evidência_insuficiente': return 'Evidência insuficiente'
  }
}

export function fraseSugestãoCadência(s: SugestãoCadência): string {
  switch (s) {
    case 'compatível': return 'A cadência declarada parece compatível com o histórico'
    case 'possivelmente_alta': return 'A cadência declarada pode estar frouxa para o ritmo real'
    case 'possivelmente_baixa': return 'A cadência declarada pode estar apertada para o ritmo real'
    case 'evidência_insuficiente': return 'Evidência insuficiente para avaliar a cadência'
  }
}

export function rotuloTendência(t: Tendência): string {
  switch (t) {
    case 'melhorando': return 'Melhorando'
    case 'estável': return 'Estável'
    case 'piorando': return 'Piorando'
    case 'insuficiente_evidência': return 'Evidência insuficiente'
  }
}

export function rotuloConfiança(c: Confiança): string {
  switch (c) {
    case 'insuficiente': return 'confiança insuficiente'
    case 'limitada': return 'confiança limitada'
    case 'moderada': return 'confiança moderada'
    case 'forte': return 'confiança forte'
  }
}

export function formatarData(ts: number): string {
  return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
}

export function formatarDataHora(ts: number): string {
  return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function escapeHtml(s: string): string {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}
