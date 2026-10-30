/**
 * Envio de alertas para fora. Sem `ALERT_WEBHOOK_URL` configurada, os alertas
 * só vão para o log e para o painel.
 *
 * O payload é genérico (JSON com os campos do alerta); Slack e Discord aceitam
 * `text`/`content`, então mandamos os três campos e cada destino usa o que
 * entende.
 */

import { tokens } from './format.js';

const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL ?? null;

function describe(alert) {
  const pct = Math.round(alert.usedPct * 100);
  const global = alert.agent === '*';
  const onde = alert.project ? ` [${alert.project}]` : '';
  const alvo = global ? `Todos os agentes${onde}` : `Agente ${alert.agent}${onde}`;
  const periodo = { day: 'hoje', week: 'esta semana', month: 'este mês' }[alert.period];
  const verbo =
    alert.state === 'estourado'
      ? global
        ? 'estouraram a cota'
        : 'estourou a cota'
      : global
        ? 'estão perto do limite'
        : 'está perto do limite';

  return (
    `${alvo} ${verbo}: ${tokens(alert.usedTokens)} de ` +
    `${tokens(alert.limitTokens)} tokens (${pct}%) ${periodo}.`
  );
}

export async function notify(alerts) {
  if (alerts.length === 0) return;

  for (const alert of alerts) {
    const mensagem = describe(alert);
    console.warn(`[alerta] ${mensagem}`);

    if (!WEBHOOK_URL) continue;

    try {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: mensagem, // Slack
          content: mensagem, // Discord
          alert, // integração própria
        }),
      });
      if (!res.ok) console.warn(`[alerta] webhook respondeu HTTP ${res.status}`);
    } catch (err) {
      // Falha ao notificar nunca derruba a ingestão.
      console.warn(`[alerta] webhook falhou: ${err.message}`);
    }
  }
}

export function webhookConfigured() {
  return Boolean(WEBHOOK_URL);
}
