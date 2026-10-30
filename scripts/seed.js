/**
 * Popula a API com eventos sintéticos para ver o painel com histórico antes de
 * integrar os agentes de verdade. Requer a API rodando (`npm run dev`).
 *
 *   node scripts/seed.js            # 7 dias, ~400 eventos
 *   node scripts/seed.js 3 150      # 3 dias, 150 eventos
 *
 * Para ver a animação ao vivo em vez do histórico, use `npm run demo`.
 */

const ENDPOINT = process.env.TOKEN_MONITOR_URL ?? 'http://localhost:4000';
const API_KEY = process.env.TOKEN_MONITOR_API_KEY;

const days = Number(process.argv[2] ?? 7);
const count = Number(process.argv[3] ?? 400);

// Os mesmos papéis do elenco: o nome do agente é o que o painel usa para
// escolher o personagem.
const AGENTS = [
  { agent: 'orquestrador', model: 'claude-opus-5-5', weight: 4 },
  { agent: 'designer', model: 'claude-sonnet-5-5', weight: 2 },
  { agent: 'frontend', model: 'claude-sonnet-5-5', weight: 5 },
  { agent: 'backend', model: 'claude-sonnet-5-5', weight: 5 },
  { agent: 'backend', model: 'claude-haiku-5-5', weight: 3 },
  { agent: 'revisor-codigo', model: 'claude-opus-5-5', weight: 2 },
];

const OPERATIONS = ['plano', 'componente', 'endpoint', 'migracao', 'revisao', 'layout'];

function pickWeighted(items) {
  const total = items.reduce((acc, i) => acc + i.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

const now = Date.now();
const windowMs = days * 24 * 60 * 60 * 1000;

const events = Array.from({ length: count }, () => {
  const { agent, model } = pickWeighted(AGENTS);
  const inputTokens = randInt(400, 24_000);
  const cacheReadTokens = Math.random() < 0.55 ? randInt(1000, 40_000) : 0;
  const isError = Math.random() < 0.04;

  return {
    ts: new Date(now - Math.random() * windowMs).toISOString(),
    agent,
    model,
    provider: 'anthropic',
    operation: OPERATIONS[randInt(0, OPERATIONS.length - 1)],
    sessionId: `sess_${randInt(1, 60)}`,
    inputTokens,
    outputTokens: isError ? 0 : randInt(80, 4000),
    cacheReadTokens,
    cacheWriteTokens: cacheReadTokens === 0 && Math.random() < 0.3 ? randInt(1000, 20_000) : 0,
    latencyMs: randInt(600, 42_000),
    status: isError ? 'error' : 'ok',
    error: isError ? 'rate_limit_error: 429' : undefined,
  };
});

// Lotes de 200 para não estourar o limite do endpoint.
let accepted = 0;
let totalTokens = 0;

for (let i = 0; i < events.length; i += 200) {
  const batch = events.slice(i, i + 200);
  const res = await fetch(`${ENDPOINT}/v1/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
    },
    body: JSON.stringify({ events: batch }),
  });

  if (!res.ok) {
    console.error(`falhou: HTTP ${res.status}`, await res.text());
    process.exit(1);
  }

  const json = await res.json();
  accepted += json.accepted;
  totalTokens += json.totalTokens;
}

console.log(`${accepted} eventos inseridos, ${totalTokens.toLocaleString('pt-BR')} tokens`);
