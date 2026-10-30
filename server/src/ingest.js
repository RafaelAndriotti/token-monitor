import { insertEvents } from './db.js';
import { ensureAgents } from './roster.js';
import { detectAlerts } from './budgets.js';
import { recordEvent, bus } from './activity.js';
import { notify } from './notify.js';

/**
 * O caminho único de entrada de eventos: grava, registra o agente, acende o
 * palco e avalia as cotas.
 *
 * Existe porque a ingestão tem dois clientes — o `POST /v1/events` e o
 * importador de transcripts — e a parte delicada é a mesma nos dois: **só o
 * que entrou de verdade** pode animar um personagem ou disparar um alerta.
 * Reler um transcript inteiro é uma operação normal aqui, e ela não pode
 * reanimar o palco nem repetir notificação já dada.
 */

/** Eventos mais velhos que isto são histórico: entram no banco, não no palco. */
const JANELA_AO_VIVO_MS = 120_000;

export function ingest(normalized, { ignoreDuplicates = false, live = true } = {}) {
  if (normalized.length === 0) {
    return { inserted: 0, skipped: 0, ids: [], alerts: [], totalTokens: 0 };
  }

  const { ids, novos, inserted, skipped } = insertEvents(normalized, { ignoreDuplicates });

  const porProjeto = new Map();
  for (const event of novos) {
    if (!porProjeto.has(event.project)) porProjeto.set(event.project, new Set());
    porProjeto.get(event.project).add(event.agent);
  }
  for (const [project, agentes] of porProjeto) ensureAgents(project, agentes);

  const agora = Date.now();
  if (live) {
    for (const event of novos) {
      if (agora - new Date(event.ts).getTime() < JANELA_AO_VIVO_MS) recordEvent(event);
    }
  }

  const alerts = [];
  for (const [project, agentes] of porProjeto) {
    alerts.push(...detectAlerts(project, agentes));
  }
  notify(alerts).catch((err) => console.warn(`[alerta] ${err.message}`));
  for (const alert of alerts) bus.emit('alert', alert);

  return {
    ids,
    inserted,
    skipped,
    alerts,
    totalTokens: novos.reduce((acc, e) => acc + e.totalTokens, 0),
  };
}
