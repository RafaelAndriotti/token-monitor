import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { dbPath, ping, schemaVersion } from './db.js';
import { ingest } from './ingest.js';
import { PROJETO_PADRAO, TODOS_PROJETOS } from './migrate.js';
import { normalizeEvent, ValidationError } from './normalize.js';
import { knownModels } from './pricing.js';
import {
  listProjects,
  getProject,
  defaultProject,
  upsertProject,
  addSource,
  removeSource,
} from './projects.js';
import { descobrir, importarProjeto, importarTudo } from './transcripts.js';
import {
  listBudgets,
  upsertBudget,
  deleteBudget,
  detectAlerts,
  periodStart,
  PERIODS,
  METRIC_NAMES,
  GLOBAL_AGENT,
} from './budgets.js';
import {
  ROLES,
  listAgents,
  upsertAgent,
  deleteAgent,
  ensureAgents,
  backfillFromEvents,
} from './roster.js';
import {
  bus,
  mark,
  recordEvent,
  snapshot as activitySnapshot,
  activeRun,
  startRun,
  endRun,
  startSweeper,
} from './activity.js';
import { notify, webhookConfigured } from './notify.js';
import { buildWeeklyReport, renderHtml } from './report.js';
import { sendWeeklyReport, recipients } from './mailer.js';
import { startReportSchedule } from './schedule.js';
import {
  summary,
  timeseries,
  groupBy,
  recentEvents,
  distinctValues,
} from './stats.js';

const PORT = Number(process.env.PORT ?? 4000);
const API_KEY = process.env.API_KEY ?? null;
/** De quanto em quanto tempo relê os transcripts. `0` desliga. */
const IMPORT_INTERVAL_MS = Number(process.env.IMPORT_INTERVAL_SEC ?? 30) * 1000;
const STARTED_AT = Date.now();
const VERSION = '0.3.0';

const here = dirname(fileURLToPath(import.meta.url));
// O painel é HTML/JS estático: React e htm vêm por CDN, sem etapa de build.
const PUBLIC_DIR = resolve(here, '../public');

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

/** Exige x-api-key apenas quando API_KEY está definida no ambiente. */
function auth(req, res, next) {
  if (!API_KEY) return next();
  const sent = req.get('x-api-key');
  if (sent !== API_KEY) return res.status(401).json({ error: 'api key inválida' });
  next();
}

/**
 * O projeto de uma requisição de leitura. Sem parâmetro, cai no projeto padrão
 * — que é o único existente, quando só há um. O sentinela `*` significa todos
 * os projetos e é o que alimenta a visão geral.
 */
function projectOf(req) {
  return req.params.project ?? req.query.project ?? req.body?.project ?? defaultProject();
}

/** Para rotas de escrita: o projeto tem de existir e ser dito. */
function requireProject(req, res) {
  const id = req.params.project ?? req.query.project ?? req.body?.project;
  if (!id || id === TODOS_PROJETOS) {
    res.status(400).json({ error: 'informe o projeto em ?project=' });
    return null;
  }
  if (!getProject(id)) {
    res.status(404).json({ error: `projeto não encontrado: ${id}` });
    return null;
  }
  return id;
}

// --- Health ---------------------------------------------------------------

app.get('/health', (req, res) => {
  let dbStatus = 'ok';
  let eventCount = null;
  let projectCount = null;
  try {
    eventCount = ping();
    projectCount = listProjects().length;
  } catch (err) {
    dbStatus = `erro: ${err.message}`;
  }

  const healthy = dbStatus === 'ok';
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    version: VERSION,
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    timestamp: new Date().toISOString(),
    checks: {
      database: {
        status: dbStatus,
        path: dbPath(),
        schemaVersion,
        events: eventCount,
        projects: projectCount,
      },
    },
  });
});

// Alias comum em orquestradores (Kubernetes, Render, Fly).
app.get('/healthz', (req, res) => res.redirect(307, '/health'));

// --- Projetos -------------------------------------------------------------

app.get('/v1/projects', (req, res) => {
  res.json(listProjects());
});

app.put('/v1/projects/:project', auth, (req, res) => {
  try {
    res.json(upsertProject({ id: req.params.project, ...req.body }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Ingestão -------------------------------------------------------------

app.post('/v1/events', auth, (req, res) => {
  const body = req.body;
  const list = Array.isArray(body) ? body : Array.isArray(body?.events) ? body.events : [body];

  if (list.length === 0) return res.status(400).json({ error: 'nenhum evento enviado' });
  if (list.length > 1000) return res.status(413).json({ error: 'máximo de 1000 eventos por lote' });

  // O projeto do lote vale para os eventos que não disserem o seu.
  const projetoLote = body?.project ?? req.query.project ?? defaultProject();

  const normalized = [];
  const unpriced = [];
  try {
    for (const [i, raw] of list.entries()) {
      const { event, priced } = normalizeEvent(raw);
      event.project = event.project ?? projetoLote;
      normalized.push(event);
      if (!priced) unpriced.push({ index: i, model: event.model });
    }
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    throw err;
  }

  const resultado = ingest(normalized, {
    ignoreDuplicates: Boolean(body?.ignoreDuplicates),
  });

  res.status(201).json({
    accepted: resultado.inserted,
    skipped: resultado.skipped,
    ids: resultado.ids,
    totalTokens: resultado.totalTokens,
    // Modelos fora da tabela de preços: só afeta o custo estimado, que é
    // informativo num plano de assinatura.
    unpricedModels: unpriced,
    alerts: resultado.alerts,
  });
});

// --- Transcripts ----------------------------------------------------------

/** As pastas do Claude Code que podem virar projeto. */
app.get('/v1/discover', (req, res) => {
  try {
    res.json(descobrir());
  } catch (err) {
    res.status(500).json({ error: `não consegui ler as pastas: ${err.message}` });
  }
});

/** Liga uma pasta de transcript a um projeto e já importa o que há nela. */
app.post('/v1/projects/:project/sources', auth, async (req, res) => {
  const project = getProject(req.params.project);
  if (!project) return res.status(404).json({ error: 'projeto não encontrado' });

  const dir = req.body?.dir;
  if (!dir) return res.status(400).json({ error: 'informe `dir`' });

  try {
    addSource(project.id, dir);
    res.status(202).json(await importarProjeto(project.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/v1/projects/:project/sources', auth, (req, res) => {
  const dir = req.query.dir;
  if (!dir) return res.status(400).json({ error: 'informe ?dir=' });
  if (!removeSource(req.params.project, dir)) {
    return res.status(404).json({ error: 'pasta não ligada a este projeto' });
  }
  res.status(204).end();
});

/** Relê os transcripts agora, sem esperar o próximo ciclo. */
app.post('/v1/projects/:project/import', auth, async (req, res) => {
  try {
    res.json(await importarProjeto(req.params.project));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// --- Elenco e palco -------------------------------------------------------

app.get('/v1/roles', (req, res) => {
  res.json(Object.entries(ROLES).map(([role, meta]) => ({ role, ...meta })));
});

app.get('/v1/agents', (req, res) => {
  res.json(listAgents(projectOf(req)));
});

app.put('/v1/agents/:agent', auth, (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  try {
    const agente = upsertAgent({ project, agent: req.params.agent, ...req.body });
    bus.emit('roster', agente);
    res.json(agente);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/v1/agents/:agent', auth, (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  if (!deleteAgent(project, req.params.agent)) {
    return res.status(404).json({ error: 'agente não encontrado' });
  }
  res.status(204).end();
});

/** Ping de início/fim de trabalho. É o que faz o personagem animar na hora. */
app.post('/v1/activity', auth, (req, res) => {
  try {
    res.status(202).json(mark({ project: projectOf(req), ...req.body }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/v1/runs', auth, (req, res) => {
  res.status(201).json(startRun({ project: projectOf(req), ...req.body }));
});

app.post('/v1/runs/:id/end', auth, (req, res) => {
  const run = endRun(projectOf(req), req.params.id);
  if (!run) return res.status(404).json({ error: 'run não encontrada' });
  res.json(run);
});

app.get('/v1/activity', (req, res) => {
  res.json(activitySnapshot(projectOf(req)));
});

/**
 * Tudo que o palco precisa numa chamada: elenco com papel, estado ao vivo e
 * consumo do período. Depois disso o painel só escuta `/v1/stream`.
 */
app.get('/v1/stage', (req, res) => {
  const project = projectOf(req);
  const period = PERIODS.includes(req.query.period) ? req.query.period : 'day';
  const from = periodStart(period).toISOString();
  const filtros = { project, from };

  const live = new Map(activitySnapshot(project).agents.map((a) => [a.agent, a]));
  const uso = new Map(groupBy('agent', filtros, 200).map((r) => [r.key, r]));
  const cotas = new Map(listBudgets(project).map((b) => [b.agent, b]));

  res.json({
    project,
    period,
    periodStart: from,
    totals: summary(filtros),
    globalBudget: cotas.get(GLOBAL_AGENT) ?? null,
    run: activeRun(project),
    agents: listAgents(project).map((a) => ({
      ...a,
      live: live.get(a.agent) ?? { state: 'parado', burst: null, runId: null },
      usage: uso.get(a.agent) ?? { totalTokens: 0, outputTokens: 0, requests: 0, errors: 0 },
      budget: cotas.get(a.agent) ?? null,
    })),
  });
});

/** Uma linha por projeto: é o que a tela de visão geral desenha. */
app.get('/v1/overview', (req, res) => {
  const period = PERIODS.includes(req.query.period) ? req.query.period : 'day';
  const from = periodStart(period).toISOString();

  const uso = new Map(groupBy('project', { from }, 200).map((r) => [r.key, r]));
  const vivos = activitySnapshot(TODOS_PROJETOS).agents;
  const cotas = listBudgets(TODOS_PROJETOS);

  res.json({
    period,
    periodStart: from,
    totals: summary({ from }),
    projects: listProjects().map((p) => ({
      ...p,
      usage: uso.get(p.id) ?? { totalTokens: 0, billableTokens: 0, requests: 0, errors: 0 },
      agents: listAgents(p.id).length,
      working: vivos.filter(
        (a) => a.project === p.id && (a.state === 'pensando' || a.state === 'trabalhando'),
      ).length,
      budget: cotas.find((b) => b.project === p.id && b.agent === GLOBAL_AGENT) ?? null,
    })),
  });
});

/**
 * Stream de eventos para o navegador (SSE). Um frame por mudança de estado,
 * então a animação começa no mesmo instante em que o agente chama o modelo.
 *
 * Cada assinante escolhe o seu projeto: a filtragem é no servidor, para um
 * navegador nunca receber o tráfego de outro projeto.
 */
app.get('/v1/stream', (req, res) => {
  const escopo = req.query.project && req.query.project !== TODOS_PROJETOS
    ? req.query.project
    : null;

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Alguns proxies seguram SSE sem isto.
    'x-accel-buffering': 'no',
  });

  const send = (type, data) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const doEscopo = (data) => !escopo || data.project === escopo;
  const encaminhar = (type) => (data) => {
    if (doEscopo(data)) send(type, data);
  };

  send('hello', {
    ...activitySnapshot(escopo ?? TODOS_PROJETOS),
    project: escopo,
    roster: listAgents(escopo ?? TODOS_PROJETOS),
  });

  const handlers = {
    activity: encaminhar('activity'),
    event: encaminhar('event'),
    run: encaminhar('run'),
    alert: encaminhar('alert'),
    roster: encaminhar('roster'),
  };
  for (const [tipo, fn] of Object.entries(handlers)) bus.on(tipo, fn);

  // Comentário periódico: mantém a conexão viva atrás de proxy e detecta
  // cliente morto que não disparou 'close'.
  const batida = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(batida);
    for (const [tipo, fn] of Object.entries(handlers)) bus.off(tipo, fn);
  });
});

// --- Cotas e alertas ------------------------------------------------------

app.get('/v1/budgets', (req, res) => {
  res.json(listBudgets(projectOf(req)));
});

app.put('/v1/budgets/:agent', auth, (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  try {
    res.json(upsertBudget({ project, agent: req.params.agent, ...req.body }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/v1/budgets/:agent', auth, (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  if (!deleteBudget(project, req.params.agent)) {
    return res.status(404).json({ error: 'cota não encontrada' });
  }
  res.status(204).end();
});

app.get('/v1/alerts', (req, res) => {
  res.json({
    webhook: webhookConfigured(),
    periods: PERIODS,
    metrics: METRIC_NAMES,
    globalAgent: GLOBAL_AGENT,
    alerts: listBudgets(projectOf(req)).filter((b) => b.state !== 'ok'),
  });
});

// --- Relatório semanal ----------------------------------------------------

app.get('/v1/reports/weekly', (req, res) => {
  res.json(buildWeeklyReport({ project: req.query.project }));
});

// Prévia do e-mail no navegador, para conferir antes de disparar o envio.
app.get('/v1/reports/weekly.html', (req, res) => {
  res.type('html').send(renderHtml(buildWeeklyReport({ project: req.query.project })));
});

app.post('/v1/reports/weekly/send', auth, async (req, res) => {
  try {
    const resultado = await sendWeeklyReport({ project: req.query.project });
    res.status(resultado.sent ? 200 : 409).json(resultado);
  } catch (err) {
    res.status(502).json({ error: `envio falhou: ${err.message}` });
  }
});

// --- Consultas ------------------------------------------------------------

function filtersFrom(req) {
  return {
    project: projectOf(req),
    from: req.query.from,
    to: req.query.to,
    agent: req.query.agent,
    model: req.query.model,
    provider: req.query.provider,
  };
}

app.get('/v1/stats/summary', (req, res) => {
  res.json(summary(filtersFrom(req)));
});

app.get('/v1/stats/timeseries', (req, res) => {
  res.json(timeseries(filtersFrom(req), req.query.bucket));
});

app.get('/v1/stats/by/:dimension', (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 200);
    res.json(groupBy(req.params.dimension, filtersFrom(req), limit));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/v1/events', (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 500);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);
  res.json(recentEvents(filtersFrom(req), limit, offset));
});

app.get('/v1/meta', (req, res) => {
  res.json({
    ...distinctValues(filtersFrom(req)),
    projects: listProjects(),
    pricedModels: knownModels(),
  });
});

// --- Painel estático ------------------------------------------------------

if (existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
}

// --- Erros ----------------------------------------------------------------

app.use((err, req, res, next) => {
  // JSON malformado chega aqui com status 400 vindo do body-parser. Devolver
  // 500 esconderia do cliente que o erro é dele, e não do servidor.
  const status = err.status ?? err.statusCode ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: status === 400 ? `corpo inválido: ${err.message}` : 'erro interno',
  });
});

app.listen(PORT, () => {
  const agenda = startReportSchedule();
  startSweeper();
  const novos = backfillFromEvents();
  const projetos = listProjects();

  // Varredura inicial: é o que recupera o período em que o monitor esteve
  // desligado. O `source_uuid` garante que reler não duplica nada.
  importarTudo()
    .then((rs) => {
      const total = rs.reduce((acc, r) => acc + r.inserted, 0);
      if (total) console.log(`  transcripts: ${total} eventos novos importados`);
    })
    .catch((err) => console.warn(`[transcript] varredura inicial falhou: ${err.message}`));

  // Releitura contínua: com o servidor sempre no ar (serviço, container), é
  // isto que traz o uso novo sem `npm run import`. Polling, não `fs.watch`:
  // pasta montada do Windows num container não gera evento de inotify.
  if (IMPORT_INTERVAL_MS > 0) {
    let lendo = false;
    setInterval(async () => {
      if (lendo) return;
      lendo = true;
      try {
        const rs = await importarTudo();
        const total = rs.reduce((acc, r) => acc + r.inserted, 0);
        if (total) console.log(`  transcripts: ${total} eventos novos importados`);
      } catch (err) {
        console.warn(`[transcript] releitura falhou: ${err.message}`);
      } finally {
        lendo = false;
      }
    }, IMPORT_INTERVAL_MS).unref();
  }

  console.log(`token-monitor em http://localhost:${PORT}`);
  console.log(`  painel   GET  /`);
  console.log(`  health   GET  /health`);
  console.log(`  ingestão POST /v1/events`);
  console.log(`  ao vivo  POST /v1/activity · GET /v1/stream?project=`);
  console.log(`  banco    ${dbPath()} (schema v${schemaVersion})`);
  console.log(
    `  projetos ${projetos.map((p) => p.id).join(', ') || 'nenhum'} · padrão ${defaultProject()}`,
  );
  console.log(
    `  elenco   ${listAgents(TODOS_PROJETOS).length} agentes${novos.length ? ` (${novos.length} novos)` : ''}`,
  );
  console.log(`  alertas  webhook ${webhookConfigured() ? 'configurado' : 'não configurado'}`);
  console.log(
    agenda.scheduled
      ? `  relatório semanal para ${recipients().join(', ')}, próximo em ${agenda.nextRun}`
      : `  relatório semanal desligado: ${agenda.reason}`,
  );
  if (!API_KEY) console.log('  aviso: API_KEY não definida, ingestão aberta');
});
