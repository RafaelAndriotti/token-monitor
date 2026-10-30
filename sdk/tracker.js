/**
 * Cliente para enviar uso de tokens e sinais de atividade ao token-monitor.
 *
 * São dois canais com propósitos diferentes:
 *
 * - **uso** (`track`/`measure` → `POST /v1/events`): vai para o banco em lote.
 *   É o histórico, e uma falha de rede aqui nunca derruba o agente — o erro vai
 *   para `onError` e o lote é descartado.
 * - **atividade** (`begin`/`end`/`measure` → `POST /v1/activity`): sai na hora,
 *   sem fila, e só vive em memória no servidor. É o que faz o personagem do
 *   agente animar durante a chamada, em vez de só depois dela.
 *
 * Uso direto:
 *
 *   const tracker = createTracker({ agent: 'backend', runId: 'prompt-42' });
 *   const response = await client.messages.create({ ... });
 *   tracker.track({ model: response.model, usage: response.usage });
 *   await tracker.flush();
 *
 * Uso com medição, animação e captura de erro — o caminho recomendado:
 *
 *   const response = await tracker.measure(
 *     () => client.messages.create({ model, max_tokens: 16000, messages }),
 *     { operation: 'endpoint' },
 *   );
 */

const DEFAULT_ENDPOINT = process.env.TOKEN_MONITOR_URL ?? 'http://localhost:4000';

export function createTracker({
  endpoint = DEFAULT_ENDPOINT,
  apiKey = process.env.TOKEN_MONITOR_API_KEY,
  agent,
  provider = 'anthropic',
  sessionId,
  runId,
  flushIntervalMs = 5000,
  maxBatch = 100,
  onError = (err) => console.warn('[token-monitor]', err.message),
} = {}) {
  if (!agent) throw new Error('createTracker: informe `agent`');

  let queue = [];
  let timer = null;
  let currentRun = runId ?? null;

  function headers() {
    return {
      'content-type': 'application/json',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    };
  }

  function schedule() {
    if (timer || flushIntervalMs <= 0) return;
    timer = setTimeout(() => {
      timer = null;
      flush().catch(onError);
    }, flushIntervalMs);
    timer.unref?.();
  }

  async function send(batch) {
    const res = await fetch(`${endpoint}/v1/events`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ events: batch }),
    });
    if (!res.ok) {
      throw new Error(`ingestão falhou: HTTP ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  /**
   * Sinal de atividade. Não espera resposta e não propaga erro: o painel fora
   * do ar não pode travar nem quebrar o agente.
   */
  function signal(state, meta = {}) {
    const body = JSON.stringify({
      agent,
      state,
      runId: meta.runId ?? currentRun,
      operation: meta.operation,
      model: meta.model,
      note: meta.note,
    });
    return fetch(`${endpoint}/v1/activity`, { method: 'POST', headers: headers(), body }).catch(
      () => {},
    );
  }

  /** Enfileira um evento. Aceita `usage` cru da Anthropic ou tokens já separados. */
  function track(event) {
    queue.push({
      agent,
      provider,
      sessionId,
      ts: new Date().toISOString(),
      ...event,
      metadata: { runId: event.runId ?? currentRun, ...event.metadata },
    });
    if (queue.length >= maxBatch) flush().catch(onError);
    else schedule();
    return queue.length;
  }

  /** Envia tudo o que está na fila. Chame antes do processo encerrar. */
  async function flush() {
    if (queue.length === 0) return null;
    const batch = queue;
    queue = [];
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      return await send(batch);
    } catch (err) {
      onError(err);
      return null;
    }
  }

  /**
   * Executa a chamada ao modelo, mede a latência e registra o uso — inclusive
   * quando a chamada lança: o evento sai com status 'error' e o erro é
   * repropagado para quem chamou.
   *
   * O ping de `pensando` sai antes da chamada, então o personagem já está
   * animando enquanto o modelo pensa; o uso em tokens chega no fim.
   */
  async function measure(fn, meta = {}) {
    const startedAt = Date.now();
    signal('pensando', meta);
    try {
      const response = await fn();
      track({
        ...meta,
        model: meta.model ?? response?.model,
        usage: response?.usage,
        latencyMs: Date.now() - startedAt,
        status: 'ok',
      });
      // O uso sai em lote; o fim do trabalho precisa aparecer no palco agora.
      await flush();
      return response;
    } catch (err) {
      track({
        ...meta,
        model: meta.model ?? 'desconhecido',
        latencyMs: Date.now() - startedAt,
        status: 'error',
        error: err.message,
      });
      signal('erro', { ...meta, note: err.message });
      await flush();
      throw err;
    }
  }

  /** Abre um ciclo (um prompt) e costura nele todo evento seguinte deste tracker. */
  async function startRun({ runId: id, label } = {}) {
    try {
      const res = await fetch(`${endpoint}/v1/runs`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ runId: id, label }),
      });
      const run = await res.json();
      currentRun = run.id;
      return run;
    } catch {
      currentRun = id ?? currentRun;
      return null;
    }
  }

  async function endRun() {
    if (!currentRun) return null;
    const id = currentRun;
    await flush();
    try {
      await fetch(`${endpoint}/v1/runs/${encodeURIComponent(id)}/end`, {
        method: 'POST',
        headers: headers(),
      });
    } catch {
      // Um ciclo que não fecha expira sozinho pelo decaimento do servidor.
    }
    return id;
  }

  return {
    track,
    flush,
    measure,
    startRun,
    endRun,
    /** Pings manuais, para quem não usa `measure`. */
    begin: (meta) => signal('pensando', meta),
    end: (meta) => signal('concluido', meta),
    get pending() {
      return queue.length;
    },
    get runId() {
      return currentRun;
    },
    set runId(value) {
      currentRun = value;
    },
  };
}
