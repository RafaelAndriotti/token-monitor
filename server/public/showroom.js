import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { html } from 'htm/react';

import { ClaudeFigure } from './claudes.js';

/**
 * Vitrine do elenco: todos os papéis e todos os estados lado a lado, sem
 * depender de nenhum agente estar rodando.
 *
 * É a folha de referência do desenho — serve para comparar silhuetas, ver se
 * dois papéis ficaram parecidos demais e conferir cada animação isolada. O
 * palco de verdade é a página `/`.
 */

const STATES = [
  { id: 'parado', label: 'parado', nota: 'sem chamadas recentes' },
  { id: 'pensando', label: 'pensando', nota: 'ping de início, antes da resposta' },
  { id: 'trabalhando', label: 'trabalhando', nota: 'evento de uso chegando' },
  { id: 'concluido', label: 'concluiu', nota: 'ciclo fechado' },
  { id: 'erro', label: 'erro', nota: 'a chamada falhou' },
];

function Figura({ role, state, size = 200 }) {
  return html`
    <div class="sr-fig actor" data-role=${role.role}>
      <${ClaudeFigure} prop=${role.prop} hat=${role.hat} state=${state} size=${size} />
    </div>
  `;
}

function App() {
  const [roles, setRoles] = useState([]);
  const [state, setState] = useState('ciclo');
  const [auto, setAuto] = useState('parado');
  const [foco, setFoco] = useState('orquestrador');

  useEffect(() => {
    fetch('/v1/roles')
      .then((r) => r.json())
      .then((lista) => setRoles(lista.sort((a, b) => a.order - b.order)))
      .catch(() => {});
  }, []);

  // No modo ciclo, o elenco inteiro percorre os cinco estados.
  useEffect(() => {
    if (state !== 'ciclo') return;
    let i = 0;
    const timer = setInterval(() => {
      i = (i + 1) % STATES.length;
      setAuto(STATES[i].id);
    }, 3200);
    return () => clearInterval(timer);
  }, [state]);

  const atual = state === 'ciclo' ? auto : state;
  const papelFoco = roles.find((r) => r.role === foco) ?? roles[0];

  return html`
    <div class="wrap">
      <header class="top">
        <div>
          <h1>Elenco</h1>
          <div class="sub">Todos os papéis e todos os estados, sem precisar de agente rodando</div>
        </div>
        <a class="sr-back" href="/">voltar ao palco</a>
      </header>

      <div class="controls">
        <div class="seg">
          <button aria-pressed=${String(state === 'ciclo')} onClick=${() => setState('ciclo')}>
            ciclo
          </button>
          ${STATES.map(
            (s) => html`<button
              key=${s.id}
              aria-pressed=${String(state === s.id)}
              onClick=${() => setState(s.id)}
            >
              ${s.label}
            </button>`,
          )}
        </div>
        <span class="sr-nota">
          ${STATES.find((s) => s.id === atual)?.nota}
          ${state === 'ciclo' ? ' · trocando a cada 3,2 s' : ''}
        </span>
      </div>

      <h2 class="sr-h2">Os ${roles.length} papéis, em <strong>${atual}</strong></h2>
      <div class="sr-grid">
        ${roles.map(
          (r) => html`<article class="sr-card" key=${r.role}>
            <${Figura} role=${r} state=${atual} />
            <div class="sr-name actor" data-role=${r.role}>${r.label}</div>
            <div class="sr-meta">${r.hat ?? 'sem chapéu'} · ${r.prop}</div>
          </article>`,
        )}
        ${roles.length === 0 ? html`<div class="empty">Carregando o elenco…</div>` : null}
      </div>

      <h2 class="sr-h2">Os cinco estados, no mesmo papel</h2>
      <div class="controls">
        <div class="seg">
          ${roles.map(
            (r) => html`<button
              key=${r.role}
              aria-pressed=${String(foco === r.role)}
              onClick=${() => setFoco(r.role)}
            >
              ${r.label}
            </button>`,
          )}
        </div>
      </div>

      <div class="sr-row">
        ${papelFoco
          ? STATES.map(
              (s) => html`<article class="sr-card" key=${s.id}>
                <${Figura} role=${papelFoco} state=${s.id} size=${186} />
                <div class="sr-name">${s.label}</div>
                <div class="sr-meta">${s.nota}</div>
              </article>`,
            )
          : null}
      </div>

      <footer class="foot">
        As animações respeitam <code>prefers-reduced-motion</code>: com movimento reduzido cada
        estado continua legível pela pose, pelo selo e pelo texto.
      </footer>
    </div>
  `;
}

createRoot(document.getElementById('root')).render(html`<${App} />`);
