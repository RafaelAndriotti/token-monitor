import { db } from './db.js';
import { TODOS_PROJETOS } from './migrate.js';

/**
 * As métricas possíveis de consumo. A diferença entre elas é grande: numa
 * sessão típica do Claude Code a releitura de cache responde por mais de 80%
 * de `total`, então uma cota em cima dele não diz nada sobre o consumo real.
 */
export const METRICAS = {
  // Tudo que passou pelo modelo.
  total: 'total_tokens',
  // O que de fato se paga: releitura de cache é barata e não entra.
  faturavel: 'input_tokens + cache_write_tokens + output_tokens',
  // Só o que o modelo escreveu.
  saida: 'output_tokens',
};

export const METRICA_PADRAO = 'faturavel';

const SUM_COLUMNS = `
  count(*)                        AS requests,
  coalesce(sum(input_tokens), 0)       AS inputTokens,
  coalesce(sum(output_tokens), 0)      AS outputTokens,
  coalesce(sum(cache_read_tokens), 0)  AS cacheReadTokens,
  coalesce(sum(cache_write_tokens), 0) AS cacheWriteTokens,
  coalesce(sum(total_tokens), 0)       AS totalTokens,
  coalesce(sum(${METRICAS.faturavel}), 0) AS billableTokens,
  coalesce(sum(cost_usd), 0)           AS costUsd,
  sum(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
  cast(avg(latency_ms) AS real)        AS avgLatencyMs
`;

/**
 * Monta o WHERE e os parâmetros a partir dos filtros da query string.
 *
 * É o único lugar que escreve cláusula: `summary`, `timeseries`, `groupBy` e
 * `recentEvents` herdam daqui. Ausência de `project`, ou `project` igual ao
 * sentinela, significa "todos os projetos" — é o que mantém a visão geral
 * funcionando sem rota separada.
 */
function buildFilter({ from, to, project, agent, model, provider }) {
  const clauses = [];
  const params = [];

  if (project && project !== TODOS_PROJETOS) {
    clauses.push('project = ?');
    params.push(project);
  }
  if (from) {
    clauses.push('ts >= ?');
    params.push(new Date(from).toISOString());
  }
  if (to) {
    clauses.push('ts <= ?');
    params.push(new Date(to).toISOString());
  }
  if (agent) {
    clauses.push('agent = ?');
    params.push(agent);
  }
  if (model) {
    clauses.push('model = ?');
    params.push(model);
  }
  if (provider) {
    clauses.push('provider = ?');
    params.push(provider);
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
    escopado: Boolean(project && project !== TODOS_PROJETOS),
  };
}

export function summary(filters) {
  const { where, params, escopado } = buildFilter(filters);
  const row = db.prepare(`SELECT ${SUM_COLUMNS} FROM events ${where}`).get(...params);

  // Sem filtro de projeto, dois projetos com um agente `designer` seriam
  // contados como um. O separador de unidade (0x1F) não aparece em nome.
  const expr = escopado ? 'agent' : "project || char(31) || agent";
  const agents = db
    .prepare(`SELECT count(DISTINCT ${expr}) AS n FROM events ${where}`)
    .get(...params).n;

  return { ...row, agents };
}

const BUCKETS = {
  // strftime no SQLite: agrupa o timestamp ISO em janelas.
  hour: "strftime('%Y-%m-%dT%H:00:00Z', ts)",
  day: "strftime('%Y-%m-%dT00:00:00Z', ts)",
  minute: "strftime('%Y-%m-%dT%H:%M:00Z', ts)",
};

export function timeseries(filters, bucket = 'hour') {
  const expr = BUCKETS[bucket] ?? BUCKETS.hour;
  const { where, params } = buildFilter(filters);
  return db
    .prepare(
      `SELECT ${expr} AS bucket, ${SUM_COLUMNS}
       FROM events ${where}
       GROUP BY bucket
       ORDER BY bucket ASC`,
    )
    .all(...params);
}

const DIMENSOES = ['project', 'agent', 'model', 'provider', 'operation'];

export function groupBy(column, filters, limit = 20) {
  if (!DIMENSOES.includes(column)) {
    throw new Error(`coluna não permitida: ${column}`);
  }
  const { where, params } = buildFilter(filters);
  return db
    .prepare(
      `SELECT ${column} AS key, ${SUM_COLUMNS}
       FROM events ${where}
       GROUP BY ${column}
       ORDER BY totalTokens DESC
       LIMIT ?`,
    )
    .all(...params, limit);
}

export function recentEvents(filters, limit = 50, offset = 0) {
  const { where, params } = buildFilter(filters);
  return db
    .prepare(
      `SELECT id, ts, project, agent, model, provider, operation, session_id AS sessionId,
              input_tokens AS inputTokens, output_tokens AS outputTokens,
              cache_read_tokens AS cacheReadTokens, cache_write_tokens AS cacheWriteTokens,
              total_tokens AS totalTokens, cost_usd AS costUsd,
              latency_ms AS latencyMs, status, error
       FROM events ${where}
       ORDER BY ts DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
}

export function distinctValues(filters = {}) {
  const { where, params } = buildFilter(filters);
  const distintos = (coluna) =>
    db
      .prepare(`SELECT DISTINCT ${coluna} AS v FROM events ${where} ORDER BY v`)
      .all(...params)
      .map((r) => r.v);

  return {
    agents: distintos('agent'),
    models: distintos('model'),
    providers: distintos('provider'),
  };
}

/**
 * Consumo de um agente — ou de todos, quando `agent` é nulo — desde uma data,
 * na métrica pedida. É a conta que decide o estado de uma cota.
 */
export function usageSince({ project, agent, since, metric = METRICA_PADRAO }) {
  const expr = METRICAS[metric] ?? METRICAS[METRICA_PADRAO];
  const { where, params } = buildFilter({ project, agent, from: since });
  return db
    .prepare(`SELECT coalesce(sum(${expr}), 0) AS total FROM events ${where}`)
    .get(...params).total;
}
