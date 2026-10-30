import { EventEmitter } from 'node:events';

import { PROJETO_PADRAO, TODOS_PROJETOS } from './migrate.js';

/**
 * Estado ao vivo de cada agente, por projeto, só em memória: é o que o palco
 * animado desenha. Nada disso vai para o banco — se o servidor reinicia, todo
 * mundo volta para `parado` e o histórico de tokens continua intacto na tabela
 * `events`.
 *
 * Cada projeto tem o seu balde de agentes e de ciclos. Balde aninhado, e não
 * uma chave composta num mapa só, para o `snapshot` de um projeto continuar
 * sendo uma leitura direta e para o limite de ciclos valer por projeto: um
 * projeto barulhento não pode empurrar para fora os ciclos de outro.
 *
 * Ciclo de um agente durante um prompt:
 *
 *   pensando --(evento com tokens)--> trabalhando --(fim)--> concluido --> parado
 *      \--------------------(erro)--------------> erro -----------------> parado
 */

export const bus = new EventEmitter();
// Vários navegadores abertos no painel, cada um com seu listener.
bus.setMaxListeners(0);

const ESTADOS = ['parado', 'pensando', 'trabalhando', 'concluido', 'erro'];

// Quanto tempo um agente fica animado sem receber nada novo.
const TTL_TRABALHO = Number(process.env.ACTIVITY_TTL_MS ?? 30_000);
const TTL_CONCLUIDO = Number(process.env.ACTIVITY_DONE_MS ?? 6_000);
const TTL_ERRO = Number(process.env.ACTIVITY_ERROR_MS ?? 12_000);
const MAX_RUNS = 20;
// Um projeto sem ninguém trabalhando há uma hora sai da memória.
const TTL_BALDE = 60 * 60 * 1000;

const projetos = new Map();

const TTL = {
  pensando: TTL_TRABALHO,
  trabalhando: TTL_TRABALHO,
  concluido: TTL_CONCLUIDO,
  erro: TTL_ERRO,
};

function agora() {
  return Date.now();
}

const BURST_ZERO = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  requests: 0,
};

function balde(project) {
  const id = project ?? PROJETO_PADRAO;
  let b = projetos.get(id);
  if (!b) {
    b = { project: id, agentes: new Map(), runs: new Map(), lastTouched: agora() };
    projetos.set(id, b);
  }
  b.lastTouched = agora();
  return b;
}

function estadoDe(project, agent) {
  const b = balde(project);
  let a = b.agentes.get(agent);
  if (!a) {
    a = {
      project: b.project,
      agent,
      state: 'parado',
      since: agora(),
      runId: null,
      operation: null,
      model: null,
      // Tokens do ciclo atual: zeram quando o agente volta a trabalhar.
      burst: { ...BURST_ZERO },
      lastError: null,
      lastSeen: null,
    };
    b.agentes.set(agent, a);
  }
  return a;
}

function snapshotAgente(a) {
  return {
    project: a.project,
    agent: a.agent,
    state: a.state,
    since: new Date(a.since).toISOString(),
    runId: a.runId,
    operation: a.operation,
    model: a.model,
    burst: { ...a.burst },
    lastError: a.lastError,
    lastSeen: a.lastSeen ? new Date(a.lastSeen).toISOString() : null,
  };
}

function mudar(a, state, extra = {}) {
  const mesmoEstado = a.state === state;
  a.state = state;
  if (!mesmoEstado) a.since = agora();
  Object.assign(a, extra);
  a.lastSeen = agora();
  bus.emit('activity', snapshotAgente(a));
}

// --- Ciclos: um prompt ----------------------------------------------------

function snapshotRun(run) {
  return {
    project: run.project,
    id: run.id,
    label: run.label,
    startedAt: new Date(run.startedAt).toISOString(),
    endedAt: run.endedAt ? new Date(run.endedAt).toISOString() : null,
    agents: [...run.agents],
    totalTokens: run.totalTokens,
    requests: run.requests,
  };
}

function tocarRun(project, runId, { label } = {}) {
  if (!runId) return null;
  const b = balde(project);
  let run = b.runs.get(runId);
  if (!run) {
    run = {
      project: b.project,
      id: runId,
      label: label ?? null,
      startedAt: agora(),
      endedAt: null,
      agents: new Set(),
      totalTokens: 0,
      requests: 0,
    };
    b.runs.set(runId, run);
    // Map mantém a ordem de inserção: a primeira chave é sempre a mais antiga.
    while (b.runs.size > MAX_RUNS) b.runs.delete(b.runs.keys().next().value);
    bus.emit('run', snapshotRun(run));
  } else if (label && !run.label) {
    run.label = label;
  }
  return run;
}

/** Marca o início de um prompt. O `runId` costura os agentes do mesmo ciclo. */
export function startRun({ project, runId, label } = {}) {
  const id = runId ?? `run-${agora().toString(36)}`;
  const run = tocarRun(project, id, { label });
  run.endedAt = null;
  bus.emit('run', snapshotRun(run));
  return snapshotRun(run);
}

export function endRun(project, runId) {
  const run = balde(project).runs.get(runId);
  if (!run) return null;
  run.endedAt = agora();
  bus.emit('run', snapshotRun(run));
  return snapshotRun(run);
}

// --- Entradas -------------------------------------------------------------

/** Ping de início/fim que o SDK manda em volta da chamada ao modelo. */
export function mark({ project, agent, state, runId, operation, model, note }) {
  if (!agent) throw new Error('agent é obrigatório');
  if (!ESTADOS.includes(state)) {
    throw new Error(`state deve ser um de: ${ESTADOS.join(', ')}`);
  }

  const a = estadoDe(project, agent);
  const run = tocarRun(a.project, runId ?? a.runId);
  if (run) run.agents.add(agent);

  if (state === 'pensando' || state === 'trabalhando') {
    // Começo de ciclo: o contador do burst recomeça.
    a.burst = { ...BURST_ZERO };
  }

  mudar(a, state, {
    runId: run?.id ?? null,
    operation: operation ?? a.operation,
    model: model ?? a.model,
    lastError: state === 'erro' ? (note ?? a.lastError) : null,
  });

  return snapshotAgente(a);
}

/** Um evento de uso chegou: o agente acende e os tokens do burst sobem. */
export function recordEvent(event) {
  const a = estadoDe(event.project, event.agent);
  const run = tocarRun(a.project, event.metadata?.runId ?? event.runId ?? a.runId, {
    label: event.runLabel,
  });
  if (run) {
    run.agents.add(event.agent);
    run.totalTokens += event.totalTokens;
    run.requests += 1;
    bus.emit('run', snapshotRun(run));
  }

  // Ciclo novo: o burst anterior já foi mostrado, então recomeça do zero.
  if (a.state === 'parado' || a.state === 'concluido' || a.state === 'erro') {
    a.burst = { ...BURST_ZERO };
  }
  a.burst.inputTokens += event.inputTokens;
  a.burst.outputTokens += event.outputTokens;
  a.burst.cacheReadTokens += event.cacheReadTokens;
  a.burst.totalTokens += event.totalTokens;
  a.burst.requests += 1;

  mudar(a, event.status === 'error' ? 'erro' : 'trabalhando', {
    runId: run?.id ?? null,
    operation: event.operation ?? a.operation,
    model: event.model,
    lastError: event.status === 'error' ? event.error : null,
  });

  bus.emit('event', {
    project: a.project,
    agent: event.agent,
    model: event.model,
    operation: event.operation,
    status: event.status,
    totalTokens: event.totalTokens,
    outputTokens: event.outputTokens,
    latencyMs: event.latencyMs,
    ts: event.ts,
    runId: run?.id ?? null,
  });

  return snapshotAgente(a);
}

// --- Decaimento -----------------------------------------------------------

/** Devolve ao estado `parado` quem passou do tempo. Roda por timer e no snapshot. */
export function sweep(now = agora()) {
  for (const b of projetos.values()) {
    let ativo = false;
    for (const a of b.agentes.values()) {
      const ttl = TTL[a.state];
      if (ttl == null) continue;
      ativo = true;
      if (now - a.since < ttl) continue;
      // Quem estava trabalhando passa por `concluido` antes de apagar, para a
      // animação ter um fim visível em vez de simplesmente sumir.
      mudar(a, a.state === 'trabalhando' ? 'concluido' : 'parado');
    }
    // Projeto parado há muito tempo não precisa ocupar memória: o painel o
    // recria na próxima leitura, já que o estado inicial é `parado` mesmo.
    if (!ativo && now - b.lastTouched > TTL_BALDE) projetos.delete(b.project);
  }
}

let timer = null;

export function startSweeper(intervalMs = 1000) {
  if (timer) return timer;
  timer = setInterval(() => sweep(), intervalMs);
  // Um palco vazio não deve segurar o processo no ar.
  timer.unref?.();
  return timer;
}

export function stopSweeper() {
  if (timer) clearInterval(timer);
  timer = null;
}

// --- Leitura --------------------------------------------------------------

function baldes(project) {
  if (!project || project === TODOS_PROJETOS) return [...projetos.values()];
  const b = projetos.get(project);
  return b ? [b] : [];
}

export function snapshot(project) {
  sweep();
  const lista = baldes(project);
  return {
    at: new Date().toISOString(),
    ttlMs: TTL_TRABALHO,
    project: project ?? null,
    agents: lista.flatMap((b) => [...b.agentes.values()].map(snapshotAgente)),
    // Mais recente primeiro, que é a ordem em que o painel lista.
    runs: lista.flatMap((b) => [...b.runs.values()].map(snapshotRun).reverse()),
  };
}

export function activeRun(project) {
  const lista = baldes(project);
  const todas = lista.flatMap((b) => [...b.runs.values()]);
  const abertas = todas.filter((r) => !r.endedAt);
  const run = abertas.at(-1) ?? todas.at(-1);
  return run ? snapshotRun(run) : null;
}
