/**
 * Exemplo de time instrumentado com o token-monitor: um orquestrador que monta
 * o plano e um especialista que executa, no mesmo ciclo.
 *
 *   npm install @anthropic-ai/sdk
 *   export ANTHROPIC_API_KEY=...
 *   node examples/anthropic-agent.js
 *
 * O painel precisa estar rodando (`npm run dev`). Cada chamada aqui gasta
 * tokens de verdade na sua conta.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createTracker } from '../sdk/tracker.js';

const client = new Anthropic();
const sessionId = `sess_${Date.now()}`;
const tarefa = process.argv.slice(2).join(' ') || 'uma página de login com dois campos';

const maestro = createTracker({ agent: 'orquestrador', sessionId });

// O ciclo é o que o painel mostra na linha do palco e o que agrupa os agentes.
const run = await maestro.startRun({ label: tarefa });

const plano = await maestro.measure(
  () =>
    client.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      messages: [
        {
          role: 'user',
          content: `Liste em até 3 itens o que o frontend precisa fazer para: ${tarefa}`,
        },
      ],
    }),
  { operation: 'plano' },
);

const texto = (r) => r.content.find((b) => b.type === 'text')?.text ?? '';
console.log(`\n[orquestrador]\n${texto(plano)}`);

// O especialista entra no mesmo ciclo pelo runId que o orquestrador abriu.
const front = createTracker({ agent: 'frontend', sessionId, runId: run?.id ?? maestro.runId });

const componente = await front.measure(
  () =>
    client.messages.create({
      model: 'claude-sonnet-5-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      messages: [
        { role: 'user', content: `Escreva o componente React para:\n\n${texto(plano)}` },
      ],
    }),
  { operation: 'componente' },
);

console.log(`\n[frontend]\n${texto(componente)}`);

// Esvazie a fila e feche o ciclo antes do processo terminar.
await front.flush();
await maestro.endRun();
console.log('\nUso enviado ao painel: http://localhost:4000');
