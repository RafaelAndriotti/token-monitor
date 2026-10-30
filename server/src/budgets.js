import { db } from './db.js';
import { TODOS_PROJETOS } from './migrate.js';
import { usageSince, METRICAS, METRICA_PADRAO } from './stats.js';

/**
 * Cotas de tokens por agente, dentro de um projeto. O agente `*` é a cota do
 * projeto inteiro: soma o consumo de todos os agentes dele.
 *
 * O limite é em tokens, não em dinheiro: num plano de assinatura o que acaba é
 * a cota, e o custo em dólar da API de primeira parte não diz nada sobre ela.
 *
 * Cada cota escolhe **qual** token conta (`metric`). O padrão para cota nova é
 * `faturavel`, porque `total` é dominado pela releitura de cache — numa sessão
 * típica ela passa de 80% do número, e uma cota em cima dele estoura no
 * primeiro dia sem significar nada.
 *
 * A tabela `budgets` é criada pelas migrações, em `migrate.js`.
 */

export const GLOBAL_AGENT = '*';
export const PERIODS = ['day', 'week', 'month'];
export const METRIC_NAMES = Object.keys(METRICAS);

/** Início do período atual, em UTC. A semana começa na segunda-feira. */
export function periodStart(period, now = new Date()) {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  if (period === 'day') return d;
  if (period === 'week') {
    const weekday = (d.getUTCDay() + 6) % 7; // segunda = 0
    d.setUTCDate(d.getUTCDate() - weekday);
    return d;
  }
  d.setUTCDate(1);
  return d;
}

/** Identifica o período atual, para saber quando o ciclo virou. */
function periodKey(period, now = new Date()) {
  return `${period}:${periodStart(period, now).toISOString().slice(0, 10)}`;
}

function stateOf(used, limitTokens, warnPct) {
  if (used >= limitTokens) return 'estourado';
  if (used >= limitTokens * warnPct) return 'atencao';
  return 'ok';
}

const SEVERITY = { ok: 0, atencao: 1, estourado: 2 };

/** Cota + consumo do período corrente, já com o estado calculado. */
function evaluate(row, now = new Date()) {
  const start = periodStart(row.period, now);
  const used = usageSince({
    project: row.project,
    // O agente `*` mede o projeto inteiro: sem cláusula de agente.
    agent: row.agent === GLOBAL_AGENT ? null : row.agent,
    since: start.toISOString(),
    metric: row.metric,
  });
  const state = stateOf(used, row.limit_tokens, row.warn_pct);
  return {
    project: row.project,
    agent: row.agent,
    period: row.period,
    metric: row.metric,
    limitTokens: row.limit_tokens,
    warnPct: row.warn_pct,
    periodStart: start.toISOString(),
    usedTokens: used,
    usedPct: row.limit_tokens > 0 ? used / row.limit_tokens : 0,
    remainingTokens: Math.max(row.limit_tokens - used, 0),
    state,
    notifiedAt: row.notified_at,
  };
}

/** `project` nulo ou o sentinela lista as cotas de todos os projetos. */
export function listBudgets(project, now = new Date()) {
  const todos = !project || project === TODOS_PROJETOS;
  const rows = todos
    ? db.prepare('SELECT * FROM budgets ORDER BY project, agent = ? DESC, agent').all(GLOBAL_AGENT)
    : db
        .prepare('SELECT * FROM budgets WHERE project = ? ORDER BY agent = ? DESC, agent')
        .all(project, GLOBAL_AGENT);

  return rows.map((row) => evaluate(row, now));
}

export function upsertBudget({
  project,
  agent,
  period = 'month',
  metric = METRICA_PADRAO,
  limitTokens,
  warnPct = 0.8,
}) {
  if (!project) throw new Error('project é obrigatório');
  if (!agent) throw new Error('agent é obrigatório');
  if (!PERIODS.includes(period)) throw new Error(`period deve ser um de: ${PERIODS.join(', ')}`);
  if (!METRICAS[metric]) throw new Error(`metric deve ser um de: ${METRIC_NAMES.join(', ')}`);
  const limit = Number(limitTokens);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('limitTokens deve ser > 0');
  const warn = Number(warnPct);
  if (!Number.isFinite(warn) || warn <= 0 || warn > 1) {
    throw new Error('warnPct deve estar entre 0 e 1');
  }

  db.prepare(
    `INSERT INTO budgets
       (project, agent, period, metric, limit_tokens, warn_pct, last_state, last_period, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ok', ?, ?)
     ON CONFLICT(project, agent) DO UPDATE SET
       period = excluded.period,
       metric = excluded.metric,
       limit_tokens = excluded.limit_tokens,
       warn_pct = excluded.warn_pct,
       updated_at = excluded.updated_at`,
  ).run(
    project,
    agent,
    period,
    metric,
    Math.round(limit),
    warn,
    periodKey(period),
    new Date().toISOString(),
  );

  return evaluate(
    db.prepare('SELECT * FROM budgets WHERE project = ? AND agent = ?').get(project, agent),
  );
}

export function deleteBudget(project, agent) {
  return (
    db.prepare('DELETE FROM budgets WHERE project = ? AND agent = ?').run(project, agent)
      .changes > 0
  );
}

/**
 * Reavalia as cotas que os agentes recém-ingeridos tocam e devolve apenas as
 * escaladas de estado — é o que merece notificação. Uma queda de estado
 * (período novo, limite aumentado) atualiza o registro em silêncio.
 */
export function detectAlerts(project, agents, now = new Date()) {
  const affected = new Set([...agents, GLOBAL_AGENT]);
  const alerts = [];

  for (const agent of affected) {
    const row = db
      .prepare('SELECT * FROM budgets WHERE project = ? AND agent = ?')
      .get(project, agent);
    if (!row) continue;

    const current = periodKey(row.period, now);
    // Período virou: o consumo zera, então o estado anterior não vale mais.
    const previousState = row.last_period === current ? row.last_state : 'ok';
    const evaluated = evaluate(row, now);

    if (SEVERITY[evaluated.state] > SEVERITY[previousState]) {
      alerts.push(evaluated);
      db.prepare(
        `UPDATE budgets SET last_state = ?, last_period = ?, notified_at = ?
         WHERE project = ? AND agent = ?`,
      ).run(evaluated.state, current, now.toISOString(), project, agent);
    } else if (evaluated.state !== previousState || row.last_period !== current) {
      db.prepare(
        'UPDATE budgets SET last_state = ?, last_period = ? WHERE project = ? AND agent = ?',
      ).run(evaluated.state, current, project, agent);
    }
  }

  return alerts;
}
