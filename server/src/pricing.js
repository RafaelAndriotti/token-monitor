/**
 * Tabela de preços por 1 milhão de tokens, em dólares.
 *
 * Os preços dos modelos Claude são as tarifas da API de primeira parte da
 * Anthropic (cache: leitura barata, escrita mais cara que o input normal).
 * Bedrock e Vertex AI têm preços próprios, definidos pelo parceiro.
 *
 * Para modelos de outros provedores, acrescente entradas neste arquivo ou envie
 * `costUsd` já calculado no evento: quando o evento traz `costUsd`, a API usa
 * esse valor e não recalcula nada.
 */

// cacheWrite não é publicado para todos os modelos; onde falta, usamos este
// multiplicador sobre o preço de input. Ajuste se a sua fatura divergir.
export const CACHE_WRITE_MULTIPLIER = 1.25;

export const PRICING = {
  // --- Anthropic (preços por 1M tokens, API de primeira parte) ---
  'claude-fable-5-1': { input: 10.0, output: 50.0, cacheRead: 0.25 },
  'claude-fable-5': { input: 10.0, output: 50.0 },
  'claude-mythos-5-1': { input: 10.0, output: 50.0, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4.0, output: 20.0, cacheRead: 0.2 },
  'claude-opus-5': { input: 5.0, output: 25.0, cacheRead: 0.2 },
  'claude-opus-4-8': { input: 5.0, output: 25.0 },
  'claude-opus-4-7': { input: 5.0, output: 25.0 },
  'claude-opus-4-6': { input: 5.0, output: 25.0 },
  'claude-sonnet-5-5': { input: 2.0, output: 10.0, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2.0, output: 10.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
};

// Aliases para IDs com sufixo de data ou prefixo de plataforma
// (ex.: "anthropic.claude-opus-5-5" no Bedrock).
function normalizeModel(model) {
  if (!model) return '';
  let id = String(model).trim().toLowerCase();
  id = id.replace(/^(anthropic|us|eu|apac)\./, '');
  id = id.replace(/@\d{8}$/, '');
  id = id.replace(/-\d{8}$/, '');
  return id;
}

export function priceFor(model) {
  return PRICING[normalizeModel(model)] ?? null;
}

/**
 * Calcula o custo em dólares de um evento de uso.
 * Retorna 0 quando o modelo é desconhecido — nesse caso envie `costUsd` no evento.
 */
export function computeCost({
  model,
  inputTokens = 0,
  outputTokens = 0,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
}) {
  const p = priceFor(model);
  if (!p) return { costUsd: 0, priced: false };

  const cacheRead = p.cacheRead ?? p.input * 0.1;
  const cacheWrite = p.cacheWrite ?? p.input * CACHE_WRITE_MULTIPLIER;

  const costUsd =
    (inputTokens * p.input +
      outputTokens * p.output +
      cacheReadTokens * cacheRead +
      cacheWriteTokens * cacheWrite) /
    1_000_000;

  return { costUsd, priced: true };
}

export function knownModels() {
  return Object.keys(PRICING).sort();
}
