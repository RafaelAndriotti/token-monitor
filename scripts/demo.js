/**
 * Simula um prompt passando pelo time, para ver o palco animado sem precisar
 * ligar os agentes de verdade. Requer a API rodando.
 *
 *   node scripts/demo.js
 *   node scripts/demo.js "refazer a tela de login"
 *
 * Cada agente usa o SDK como um agente real usaria: ping de `pensando` antes da
 * chamada, evento de uso no fim. A "chamada ao modelo" aqui é só um sleep com
 * números de tokens plausíveis — nenhuma API externa é contatada.
 */

import { createTracker } from '../sdk/tracker.js';

const prompt = process.argv.slice(2).join(' ') || 'montar a tela de pedidos';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

/** Finge uma chamada ao modelo: demora um tempo e devolve um `usage`. */
async function fakeCall({ model, ms, input, output, cache = 0 }) {
  await sleep(ms);
  return {
    model,
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cache,
      cache_creation_input_tokens: 0,
    },
  };
}

const runId = `demo-${Date.now().toString(36)}`;
const maestro = createTracker({ agent: 'orquestrador', runId });
await maestro.startRun({ runId, label: prompt });

console.log(`run ${runId}: "${prompt}"`);

// 1. O orquestrador lê o prompt e monta o plano.
await maestro.measure(
  () =>
    fakeCall({
      model: 'claude-opus-5-5',
      ms: randInt(2500, 4000),
      input: randInt(3000, 9000),
      output: randInt(500, 1500),
      cache: randInt(8000, 30_000),
    }),
  { operation: 'plano' },
);
console.log('  orquestrador: plano pronto');

// 2. Os três especialistas trabalham ao mesmo tempo, cada um no seu ritmo.
const equipe = [
  { agent: 'designer', operation: 'layout', atraso: 0, passos: 1, model: 'claude-sonnet-5-5' },
  { agent: 'frontend', operation: 'componente', atraso: 900, passos: 3, model: 'claude-sonnet-5-5' },
  { agent: 'backend', operation: 'endpoint', atraso: 1600, passos: 2, model: 'claude-sonnet-5-5' },
];

await Promise.all(
  equipe.map(async ({ agent, operation, atraso, passos, model }) => {
    await sleep(atraso);
    const tracker = createTracker({ agent, runId });
    for (let i = 0; i < passos; i += 1) {
      await tracker.measure(
        () =>
          fakeCall({
            model,
            ms: randInt(2000, 5000),
            input: randInt(2000, 12_000),
            output: randInt(300, 3000),
            cache: randInt(0, 25_000),
          }),
        { operation: `${operation}-${i + 1}` },
      );
      console.log(`  ${agent}: ${operation} ${i + 1}/${passos}`);
    }
    await tracker.flush();
  }),
);

// 3. O orquestrador costura o resultado e fecha o ciclo.
await maestro.measure(
  () =>
    fakeCall({
      model: 'claude-opus-5-5',
      ms: randInt(1500, 2500),
      input: randInt(6000, 20_000),
      output: randInt(400, 1200),
      cache: randInt(20_000, 60_000),
    }),
  { operation: 'revisao-final' },
);

await maestro.endRun();
console.log('run encerrada');
