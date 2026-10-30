/**
 * Põe o time inteiro para trabalhar em ciclo, para ver o palco animado sem
 * ligar os agentes de verdade. Requer a API rodando.
 *
 *   npm run showroom            # roda sem parar, até Ctrl+C
 *   npm run showroom -- --once  # um ciclo só
 *   node scripts/showroom.js --once --fast
 *
 * Cada agente usa o SDK como um agente real usaria: ping de `pensando` antes
 * da chamada, evento de uso no fim. A "chamada ao modelo" é uma espera com
 * números de tokens plausíveis — nenhuma API externa é contatada e nenhum
 * token é gasto na sua conta.
 *
 * De vez em quando um passo falha de propósito: é o único jeito de ver o
 * estado `erro` sem esperar um incidente de verdade.
 */

import { createTracker } from '../sdk/tracker.js';

const ENDPOINT = process.env.TOKEN_MONITOR_URL ?? 'http://localhost:4000';
const args = process.argv.slice(2);
const UMA_VEZ = args.includes('--once');
const RAPIDO = args.includes('--fast');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const pick = (lista) => lista[randInt(0, lista.length - 1)];

/** O fator de tempo: `--fast` encurta tudo, para conferir o desenho depressa. */
const t = (ms) => Math.round(ms * (RAPIDO ? 0.35 : 1));

const PROMPTS = [
  'refazer a tela de login',
  'exportar o relatório em CSV',
  'migrar o cadastro para o novo schema',
  'corrigir o carrinho que some no refresh',
  'subir a versão 2.3 para produção',
  'investigar a lentidão na busca',
  'criar o onboarding em três passos',
];

/**
 * O elenco. Os nomes são os agentes que já existem no banco — assim o palco
 * não enche de agente novo a cada execução.
 */
const EQUIPE = [
  { agent: 'designer', operacao: 'layout', modelo: 'claude-sonnet-5-5' },
  { agent: 'frontend', operacao: 'componente', modelo: 'claude-sonnet-5-5' },
  { agent: 'backend', operacao: 'endpoint', modelo: 'claude-sonnet-5-5' },
  { agent: 'devops-deploy', operacao: 'deploy', modelo: 'claude-haiku-5-5' },
  { agent: 'extrator-notas', operacao: 'extracao', modelo: 'claude-haiku-5-5' },
  { agent: 'agente-suporte', operacao: 'e2e', modelo: 'claude-haiku-5-5' },
  { agent: 'revisor-codigo', operacao: 'revisao', modelo: 'claude-opus-5-5' },
  { agent: 'pesquisador', operacao: 'pesquisa', modelo: 'claude-opus-5-5' },
];

const FALHAS = [
  'overloaded_error: 529',
  'rate_limit_error: 429',
  'timeout após 60000ms',
  'invalid_request_error: max_tokens excedido',
];

/** Finge uma chamada ao modelo: demora um tempo e devolve um `usage`. */
async function fakeCall({ modelo, ms, falha }) {
  await sleep(ms);
  if (falha) throw new Error(falha);
  return {
    model: modelo,
    usage: {
      input_tokens: randInt(1500, 14_000),
      output_tokens: randInt(250, 3200),
      cache_read_input_tokens: Math.random() < 0.6 ? randInt(4000, 38_000) : 0,
      cache_creation_input_tokens: 0,
    },
  };
}

/** Um passo de um especialista, com a falha ocasional já tratada. */
async function passo(tracker, { operacao, modelo }, indice, total) {
  const falha = Math.random() < 0.12 ? pick(FALHAS) : null;
  try {
    await tracker.measure(
      () => fakeCall({ modelo, ms: t(randInt(2200, 5200)), falha }),
      { operation: `${operacao}-${indice + 1}` },
    );
    console.log(`    ${operacao} ${indice + 1}/${total}`);
  } catch (err) {
    // O erro já foi registrado pelo `measure`; aqui ele só não derruba o ciclo.
    console.log(`    ${operacao} ${indice + 1}/${total} falhou: ${err.message}`);
    // Deixa o selo de erro na tela antes do próximo passo apagar o estado.
    await sleep(t(2500));
  }
}

async function ciclo(n) {
  const prompt = pick(PROMPTS);
  const runId = `showroom-${Date.now().toString(36)}`;
  const maestro = createTracker({ agent: 'orquestrador', runId });
  await maestro.startRun({ runId, label: prompt });

  console.log(`\nciclo ${n} · "${prompt}"`);

  // 1. O orquestrador lê o prompt e monta o plano.
  await maestro.measure(() => fakeCall({ modelo: 'claude-opus-5-5', ms: t(randInt(2500, 4200)) }), {
    operation: 'plano',
  });
  console.log('  orquestrador: plano pronto');

  // 2. Três a cinco especialistas trabalham ao mesmo tempo, cada um no seu ritmo.
  const escalados = [...EQUIPE].sort(() => Math.random() - 0.5).slice(0, randInt(3, 5));

  await Promise.all(
    escalados.map(async (membro, i) => {
      await sleep(t(i * randInt(600, 1400)));
      const tracker = createTracker({ agent: membro.agent, runId });
      const passos = randInt(1, 3);
      console.log(`  ${membro.agent}: ${passos} passo(s)`);
      for (let p = 0; p < passos; p += 1) {
        await passo(tracker, membro, p, passos);
      }
      await tracker.flush();
    }),
  );

  // 3. O orquestrador costura o resultado e fecha o ciclo.
  await maestro.measure(() => fakeCall({ modelo: 'claude-opus-5-5', ms: t(randInt(1600, 2600)) }), {
    operation: 'revisao-final',
  });
  await maestro.endRun();
  console.log('  ciclo encerrado');
}

// Sem a API no ar não há o que mostrar: avisa antes de fingir que funcionou.
try {
  const res = await fetch(`${ENDPOINT}/health`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (err) {
  console.error(`a API não respondeu em ${ENDPOINT}: ${err.message}`);
  console.error('suba o servidor com `npm run dev` e rode de novo.');
  process.exit(1);
}

console.log(`palco em ${ENDPOINT} — deixe a página aberta e acompanhe`);
if (!UMA_VEZ) console.log('Ctrl+C para parar');

let n = 1;
do {
  await ciclo(n);
  n += 1;
  // Uma pausa entre ciclos, para o selo de concluído aparecer e o palco
  // voltar ao repouso antes do próximo prompt.
  if (!UMA_VEZ) await sleep(t(randInt(5000, 9000)));
} while (!UMA_VEZ);
