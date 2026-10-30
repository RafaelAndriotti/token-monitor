import { computeCost } from './pricing.js';

/** Janela em que um `ts` é aceito como está. Fora dela, é preso na borda. */
const CLOCK_FUTURO_MS = 5 * 60 * 1000;
const CLOCK_PASSADO_MS = 365 * 24 * 60 * 60 * 1000;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export { ValidationError };

function int(value, field) {
  if (value == null) return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new ValidationError(`${field} deve ser um número inteiro >= 0`);
  }
  return Math.round(n);
}

function str(value, field, { required = false, max = 200 } = {}) {
  if (value == null || value === '') {
    if (required) throw new ValidationError(`${field} é obrigatório`);
    return null;
  }
  const s = String(value).trim();
  if (s.length > max) throw new ValidationError(`${field} excede ${max} caracteres`);
  return s;
}

/**
 * Aceita tanto o formato próprio (inputTokens/outputTokens) quanto o objeto
 * `usage` cru da API da Anthropic (input_tokens, output_tokens,
 * cache_read_input_tokens, cache_creation_input_tokens).
 */
export function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('evento deve ser um objeto');
  }

  const usage = raw.usage ?? {};

  const inputTokens = int(raw.inputTokens ?? usage.input_tokens, 'inputTokens');
  const outputTokens = int(raw.outputTokens ?? usage.output_tokens, 'outputTokens');
  const cacheReadTokens = int(
    raw.cacheReadTokens ?? usage.cache_read_input_tokens,
    'cacheReadTokens',
  );
  const cacheWriteTokens = int(
    raw.cacheWriteTokens ?? usage.cache_creation_input_tokens,
    'cacheWriteTokens',
  );

  const model = str(raw.model, 'model', { required: true });
  const agent = str(raw.agent, 'agent', { required: true });

  let ts = raw.ts ? new Date(raw.ts) : new Date();
  if (Number.isNaN(ts.getTime())) throw new ValidationError('ts não é uma data válida');

  // O timestamp vem do relógio de quem gerou o evento — no caso de um
  // transcript, da máquina na hora em que a mensagem foi escrita. Relógio
  // errado jogaria tokens para outro mês e corromperia um relatório já
  // fechado, então a data é presa a uma janela plausível.
  const agora = Date.now();
  if (ts.getTime() > agora + CLOCK_FUTURO_MS) {
    console.warn(`[normalize] ts no futuro (${ts.toISOString()}), preso em agora`);
    ts = new Date(agora);
  } else if (ts.getTime() < agora - CLOCK_PASSADO_MS) {
    console.warn(`[normalize] ts antigo demais (${ts.toISOString()}), preso no limite`);
    ts = new Date(agora - CLOCK_PASSADO_MS);
  }

  const status = raw.status === 'error' ? 'error' : 'ok';

  let costUsd;
  let priced;
  if (raw.costUsd != null) {
    const n = Number(raw.costUsd);
    if (!Number.isFinite(n) || n < 0) throw new ValidationError('costUsd inválido');
    costUsd = n;
    priced = true;
  } else {
    const computed = computeCost({
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    });
    costUsd = computed.costUsd;
    priced = computed.priced;
  }

  if (raw.metadata != null && typeof raw.metadata !== 'object') {
    throw new ValidationError('metadata deve ser um objeto');
  }

  return {
    event: {
      project: str(raw.project, 'project', { max: 64 }) ?? undefined,
      // Chave de deduplicação do importador: uma linha de transcript vira um
      // evento só, por mais vezes que o arquivo seja relido.
      sourceUuid: str(raw.sourceUuid, 'sourceUuid', { max: 120 }),
      ts: ts.toISOString(),
      agent,
      model,
      provider: str(raw.provider, 'provider') ?? 'anthropic',
      operation: str(raw.operation, 'operation'),
      sessionId: str(raw.sessionId ?? raw.session_id, 'sessionId'),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
      costUsd,
      latencyMs: raw.latencyMs == null ? null : int(raw.latencyMs, 'latencyMs'),
      status,
      error: str(raw.error, 'error', { max: 2000 }),
      metadata: raw.metadata ?? null,
    },
    priced,
  };
}
