import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { html } from 'htm/react';

import { ClaudeFigure } from './claudes.js';

/**
 * Painel: o palco animado em cima, o histórico em tokens embaixo.
 *
 * O estado ao vivo vem por SSE (`/v1/stream`), então o personagem reage no
 * instante em que o agente chama o modelo. Os agregados (série temporal,
 * barras, cotas) são recarregados por HTTP — na chegada de eventos, com um
 * atraso curto para não refazer a conta a cada token.
 */

// --- Formatação -----------------------------------------------------------

const BR1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const BRint = new Intl.NumberFormat('pt-BR');

/** 1234 → "1,2 mil"; 2,4M → "2,4 mi". Abaixo de mil, o inteiro. */
function tk(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${BR1.format(v / 1_000_000)} mi`;
  if (v >= 1_000) return `${BR1.format(v / 1_000)} mil`;
  return BRint.format(v);
}

const tkFull = (n) => BRint.format(Math.round(Number(n) || 0));

const pct = (n) => `${Math.round((Number(n) || 0) * 100)}%`;

const hora = (iso) =>
  new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const STATE_TEXT = {
  parado: 'parado',
  pensando: 'pensando',
  trabalhando: 'trabalhando',
  concluido: 'concluiu',
  erro: 'erro',
};

const PERIOD_LABEL = { day: 'hoje', week: 'esta semana', month: 'este mês' };

const RANGES = [
  { id: '24h', label: '24 h', hours: 24, bucket: 'hour' },
  { id: '7d', label: '7 dias', hours: 24 * 7, bucket: 'hour' },
  { id: '30d', label: '30 dias', hours: 24 * 30, bucket: 'day' },
];

// --- Projeto corrente -----------------------------------------------------

/**
 * O projeto vive na URL (`?project=din-din`), não só no estado do React: é o
 * que torna a visão de cada projeto um link que se guarda e se compartilha.
 *
 * Fica num módulo-nível além do estado porque `get()` precisa dele sem receber
 * por parâmetro em cada uma das nove chamadas.
 */
let projetoAtual = new URL(location.href).searchParams.get('project') ?? null;

function lerProjetoDaUrl() {
  return new URL(location.href).searchParams.get('project') ?? null;
}

function escreverProjetoNaUrl(project) {
  const url = new URL(location.href);
  if (project) url.searchParams.set('project', project);
  else url.searchParams.delete('project');
  history.pushState({ project }, '', url);
}

// --- API ------------------------------------------------------------------

async function get(path, params = {}) {
  const url = new URL(path, location.origin);
  // O projeto entra em tudo; `params` ainda pode sobrescrever quando precisar.
  if (projetoAtual) url.searchParams.set('project', projetoAtual);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function send(method, path, body) {
  const url = new URL(path, location.origin);
  if (projetoAtual) url.searchParams.set('project', projetoAtual);
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 204) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error ?? `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

const api = {
  stage: (period) => get('/v1/stage', { period }),
  timeseries: (from, bucket) => get('/v1/stats/timeseries', { from, bucket }),
  byAgent: (from) => get('/v1/stats/by/agent', { from, limit: 20 }),
  byModel: (from) => get('/v1/stats/by/model', { from, limit: 20 }),
  roles: () => get('/v1/roles'),
  saveAgent: (agent, body) => send('PUT', `/v1/agents/${encodeURIComponent(agent)}`, body),
  saveQuota: (agent, body) => send('PUT', `/v1/budgets/${encodeURIComponent(agent)}`, body),
  removeQuota: (agent) => send('DELETE', `/v1/budgets/${encodeURIComponent(agent)}`),
};

// --- Stream ao vivo -------------------------------------------------------

/**
 * Assina `/v1/stream`. Devolve o estado por agente, o ciclo corrente, o feed
 * das últimas chamadas e um contador que sobe a cada evento — é o gatilho para
 * recarregar os agregados.
 */
function useStream(project) {
  const [connected, setConnected] = useState(false);
  const [live, setLive] = useState({});
  const [run, setRun] = useState(null);
  const [feed, setFeed] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [tick, setTick] = useState(0);

  // O stream só traz o que acontecer daqui para frente, então o feed começa
  // com as últimas chamadas já gravadas — recarregar a página não zera a lista.
  useEffect(() => {
    let vivo = true;
    get('/v1/events', { limit: 25 })
      .then((rows) => {
        if (!vivo) return;
        setFeed((prev) =>
          prev.length ? prev : rows.map((e) => ({ ...e, key: `hist-${e.id}` })),
        );
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
    // Trocar de projeto recarrega o histórico do novo. O guarda `prev.length`
    // abaixo protege o caso em que um evento ao vivo chegou antes da resposta:
    // o que está na tela é mais recente que o histórico.
  }, [project]);

  // O projeto entra nas dependências: trocar de projeto tem de fechar o
  // stream antigo e abrir outro, senão o painel segue recebendo o tráfego de
  // quem foi deixado para trás.
  useEffect(() => {
    const url = project
      ? `/v1/stream?project=${encodeURIComponent(project)}`
      : '/v1/stream';
    const es = new EventSource(url);

    // Projeto novo, palco novo: o que estava na tela era de outro.
    setLive({});
    setFeed([]);
    setRun(null);

    es.addEventListener('open', () => setConnected(true));
    es.addEventListener('error', () => setConnected(false));

    es.addEventListener('hello', (e) => {
      const data = JSON.parse(e.data);
      setConnected(true);
      setLive(Object.fromEntries(data.agents.map((a) => [a.agent, a])));
      setRun(data.runs.find((r) => !r.endedAt) ?? data.runs[0] ?? null);
    });

    es.addEventListener('activity', (e) => {
      const a = JSON.parse(e.data);
      setLive((prev) => ({ ...prev, [a.agent]: a }));
    });

    es.addEventListener('run', (e) => setRun(JSON.parse(e.data)));

    es.addEventListener('event', (e) => {
      const ev = JSON.parse(e.data);
      setFeed((prev) => [{ ...ev, key: `${ev.ts}-${prev.length}-${Math.random()}` }, ...prev].slice(0, 60));
      setTick((n) => n + 1);
    });

    es.addEventListener('alert', (e) => {
      const alert = JSON.parse(e.data);
      setAlerts((prev) => [alert, ...prev.filter((a) => a.agent !== alert.agent)].slice(0, 6));
    });

    return () => es.close();
  }, [project]);

  return { connected, live, run, feed, alerts, tick };
}

/** Recarrega `load` quando as dependências mudam, agrupando rajadas de eventos. */
function useReload(load, deps, debounceMs = 0) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const fn = useRef(load);
  fn.current = load;

  useEffect(() => {
    let vivo = true;
    const run = () => {
      fn.current()
        .then((d) => vivo && (setData(d), setError(null)))
        .catch((err) => vivo && setError(err.message));
    };
    const timer = debounceMs ? setTimeout(run, debounceMs) : (run(), null);
    return () => {
      vivo = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error };
}

// --- Personagem com o card em volta --------------------------------------

function Actor({ a, max, lead }) {
  const estado = a.live?.state ?? 'parado';
  const burst = a.live?.burst;
  const ocupado = estado === 'pensando' || estado === 'trabalhando';
  const share = max > 0 ? Math.max((a.usage.totalTokens / max) * 100, a.usage.totalTokens > 0 ? 2 : 0) : 0;

  return html`
    <article
      class=${`actor${lead ? ' lead-actor' : ''}`}
      data-role=${a.role}
      data-busy=${String(ocupado)}
    >
      <div class="actor-fig">
        <${ClaudeFigure} prop=${a.prop} hat=${a.hat} state=${estado} size=${lead ? 236 : 202} />
      </div>
      <div class="actor-name">${a.displayName}</div>
      <div class="actor-role">${a.label}</div>

      <div class="actor-state">
        ${ocupado
          ? html`<strong>${STATE_TEXT[estado]}</strong>${a.live.operation
              ? html` · ${a.live.operation}`
              : null}`
          : estado === 'erro'
            ? html`<strong>erro</strong> · ${a.live.lastError ?? 'falhou'}`
            : estado === 'concluido'
              ? html`<strong>concluiu</strong>${burst?.totalTokens
                  ? html` · ${tk(burst.totalTokens)} tokens`
                  : null}`
              : 'parado'}
      </div>

      <div class="actor-tokens-label">tokens no período</div>
      <div class="actor-tokens" title=${`${tkFull(a.usage.totalTokens)} tokens`}>
        ${tk(a.usage.totalTokens)}
      </div>
      <div class="actor-bar"><i style=${{ width: `${share}%` }}></i></div>

      ${a.budget
        ? html`<div class="actor-quota" data-state=${a.budget.state}>
            ${pct(a.budget.usedPct)} da cota de ${tk(a.budget.limitTokens)}
          </div>`
        : html`<div class="actor-quota">${a.usage.requests} chamadas</div>`}
    </article>
  `;
}

/** Largura real do elemento, em pixels. */
function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}

/**
 * O feixe que liga o orquestrador aos especialistas: tronco, cotovelo
 * arredondado e um ponto na entrada de cada card.
 *
 * Desenhado em pixels reais, não em viewBox esticada — é o que mantém o raio
 * do cotovelo igual dos dois lados por maior que fique a tela.
 */
function Beam({ workers }) {
  const [ref, W] = useWidth();
  if (workers.length === 0) return null;

  const H = 56;
  const cx = W / 2;
  const yElbow = 24;
  const yEnd = H - 10;
  const r = 14;

  return html`
    <svg
      class="beam"
      ref=${ref}
      viewBox=${`0 0 ${Math.max(W, 1)} ${H}`}
      width=${Math.max(W, 1)}
      height=${H}
      aria-hidden="true"
    >
      ${W > 0
        ? workers.map((w, i) => {
            const x = ((i + 0.5) / workers.length) * W;
            const ocupado = w.live?.state === 'pensando' || w.live?.state === 'trabalhando';
            const dir = x > cx ? 1 : -1;
            // Perto do centro não há cotovelo que caiba: desce reto.
            const reto = Math.abs(x - cx) < r * 2;
            const d = reto
              ? `M${cx} 0 V${yEnd}`
              : `M${cx} 0 V${yElbow - r}` +
                ` Q${cx} ${yElbow} ${cx + dir * r} ${yElbow}` +
                ` H${x - dir * r}` +
                ` Q${x} ${yElbow} ${x} ${yElbow + r}` +
                ` V${yEnd}`;

            return html`<g key=${w.agent}>
              <path d=${d} data-busy=${String(ocupado)} />
              <circle cx=${x} cy=${yEnd + 4} r="3.5" data-busy=${String(ocupado)} />
            </g>`;
          })
        : null}
    </svg>
  `;
}

function Stage({ stage, period, run }) {
  if (!stage) return html`<section class="stage"><div class="empty">Carregando o palco…</div></section>`;

  const agentes = stage.agents;
  const lead = agentes.find((a) => a.role === 'orquestrador') ?? null;
  const equipe = agentes.filter((a) => a !== lead);
  const max = Math.max(...agentes.map((a) => a.usage.totalTokens), 1);
  const trabalhando = agentes.filter(
    (a) => a.live?.state === 'pensando' || a.live?.state === 'trabalhando',
  );

  return html`
    <section class="stage">
      <div class="stage-head">
        <div class="stage-title">Palco · ${PERIOD_LABEL[period]}</div>
        <div class="run-line">
          ${run && !run.endedAt
            ? html`<span class="run-live"></span>
                <span class="run-label">${run.label ?? run.id}</span> · ${tk(run.totalTokens)} tokens
                em ${run.requests} chamadas`
            : trabalhando.length
              ? `${trabalhando.length} agente(s) trabalhando`
              : run
                ? html`último ciclo: <span class="run-label">${run.label ?? run.id}</span> ·
                    ${tk(run.totalTokens)} tokens`
                : 'nenhum ciclo registrado ainda'}
        </div>
      </div>

      ${lead
        ? html`<div class="lead"><${Actor} a=${lead} max=${max} lead=${true} /></div>
            <${Beam} workers=${equipe} />`
        : null}

      <div class="crew">
        ${equipe.map((a) => html`<${Actor} key=${a.agent} a=${a} max=${max} />`)}
        ${agentes.length === 0
          ? html`<div class="empty">
              Nenhum agente registrado. Mande um evento ou rode <code>npm run demo</code>.
            </div>`
          : null}
      </div>
    </section>
  `;
}

// --- Série temporal em tokens --------------------------------------------

function TokensOverTime({ points, bucket }) {
  const [hover, setHover] = useState(null);
  const W = 960;
  const H = 240;
  const PAD = { top: 16, right: 14, bottom: 26, left: 56 };

  const dados = points ?? [];
  if (dados.length === 0) {
    return html`<div class="empty">Sem chamadas no período.</div>`;
  }

  const max = Math.max(...dados.map((p) => p.totalTokens), 1);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i) => PAD.left + (dados.length === 1 ? innerW / 2 : (i / (dados.length - 1)) * innerW);
  const y = (v) => PAD.top + innerH - (v / max) * innerH;

  const linha = dados.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p.totalTokens).toFixed(1)}`).join(' ');
  const area = `${linha} L${x(dados.length - 1).toFixed(1)} ${PAD.top + innerH} L${x(0).toFixed(1)} ${
    PAD.top + innerH
  } Z`;

  const ticks = [0, 0.5, 1].map((f) => ({ v: max * f, y: y(max * f) }));
  const rotuloX = (iso) =>
    bucket === 'day'
      ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
      : new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  function mover(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.left) / innerW) * (dados.length - 1));
    const idx = Math.min(Math.max(i, 0), dados.length - 1);
    setHover({ idx, left: (x(idx) / W) * 100, top: (y(dados[idx].totalTokens) / H) * 100 });
  }

  const p = hover ? dados[hover.idx] : null;

  return html`
    <div class="chart">
      <svg
        viewBox=${`0 0 ${W} ${H}`}
        onMouseMove=${mover}
        onMouseLeave=${() => setHover(null)}
        role="img"
        aria-label="Tokens ao longo do tempo"
      >
        ${ticks.map(
          (t) => html`<g key=${t.y}>
            <line class="grid-line" x1=${PAD.left} y1=${t.y} x2=${W - PAD.right} y2=${t.y} />
            <text class="axis-text" x=${PAD.left - 8} y=${t.y + 3} text-anchor="end">${tk(t.v)}</text>
          </g>`,
        )}
        <path class="series-area" d=${area} />
        <path class="series-line" d=${linha} />
        ${hover
          ? html`<g>
              <line class="cross" x1=${x(hover.idx)} y1=${PAD.top} x2=${x(hover.idx)} y2=${PAD.top + innerH} />
              <circle class="dot" cx=${x(hover.idx)} cy=${y(dados[hover.idx].totalTokens)} r="4.5" />
            </g>`
          : null}
        <text class="axis-text" x=${PAD.left} y=${H - 8}>${rotuloX(dados[0].bucket)}</text>
        <text class="axis-text" x=${W - PAD.right} y=${H - 8} text-anchor="end">
          ${rotuloX(dados[dados.length - 1].bucket)}
        </text>
      </svg>
      ${p
        ? html`<div class="tip" style=${{ left: `${hover.left}%`, top: `${hover.top}%` }}>
            <strong>${tkFull(p.totalTokens)}</strong> tokens<br />
            ${tk(p.outputTokens)} de saída · ${p.requests} chamadas<br />
            ${rotuloX(p.bucket)}
          </div>`
        : null}
    </div>
  `;
}

function TokensByAgent({ rows, roles }) {
  if (!rows || rows.length === 0) return html`<div class="empty">Sem chamadas no período.</div>`;
  const max = Math.max(...rows.map((r) => r.totalTokens), 1);
  return html`
    <div class="bars">
      ${rows.map((r) => {
        const role = roles[r.key] ?? 'generico';
        const cor = `var(--role-${role})`;
        return html`<div class="bar-row" key=${r.key}>
          <div class="bar-name">
            <span class="bar-dot" style=${{ background: cor }}></span>${r.key}
          </div>
          <div class="bar-value" title=${`${tkFull(r.totalTokens)} tokens`}>${tk(r.totalTokens)}</div>
          <div class="bar-track">
            <i style=${{ width: `${Math.max((r.totalTokens / max) * 100, 2)}%`, background: cor }}></i>
          </div>
        </div>`;
      })}
    </div>
  `;
}

function LiveFeed({ feed }) {
  if (feed.length === 0) {
    return html`<div class="empty">
      Esperando chamadas. Rode <code>npm run demo</code> para ver o time trabalhando.
    </div>`;
  }
  return html`
    <div class="feed">
      ${feed.map(
        (e) => html`<div class="feed-row" key=${e.key} data-status=${e.status}>
          <span class="feed-time">${hora(e.ts)}</span>
          <span class="feed-what">${e.agent}${e.operation ? ` · ${e.operation}` : ''}</span>
          <span class="feed-tokens">
            ${e.status === 'error' ? 'erro' : `+${tk(e.totalTokens)}`}
          </span>
        </div>`,
      )}
    </div>
  `;
}

// --- Cotas ----------------------------------------------------------------

function QuotaForm({ agents, onSaved }) {
  const [agent, setAgent] = useState('*');
  const [period, setPeriod] = useState('month');
  const [limit, setLimit] = useState('5');
  const [erro, setErro] = useState(null);
  const [salvando, setSalvando] = useState(false);

  async function salvar(e) {
    e.preventDefault();
    setSalvando(true);
    setErro(null);
    try {
      // O campo é em milhões de tokens: é a ordem de grandeza de um plano.
      await api.saveQuota(agent, { period, limitTokens: Math.round(Number(limit) * 1_000_000) });
      onSaved();
    } catch (err) {
      setErro(err.message);
    } finally {
      setSalvando(false);
    }
  }

  return html`
    <form class="quota-form" onSubmit=${salvar}>
      <label>
        agente
        <select value=${agent} onChange=${(e) => setAgent(e.target.value)}>
          <option value="*">todos (global)</option>
          ${agents.map((a) => html`<option key=${a} value=${a}>${a}</option>`)}
        </select>
      </label>
      <label>
        período
        <select value=${period} onChange=${(e) => setPeriod(e.target.value)}>
          <option value="day">dia</option>
          <option value="week">semana</option>
          <option value="month">mês</option>
        </select>
      </label>
      <label>
        limite (milhões de tokens)
        <input
          type="number"
          min="0.01"
          step="0.1"
          value=${limit}
          onChange=${(e) => setLimit(e.target.value)}
          style=${{ width: '92px' }}
        />
      </label>
      <button class="primary" type="submit" disabled=${salvando}>
        ${salvando ? 'salvando…' : 'definir cota'}
      </button>
      ${erro ? html`<span style=${{ color: 'var(--bad)', fontSize: '12px' }}>${erro}</span>` : null}
    </form>
  `;
}

function Quotas({ budgets, onChanged }) {
  if (!budgets || budgets.length === 0) {
    return html`<div class="empty">Nenhuma cota definida.</div>`;
  }
  return html`
    <table class="list">
      <thead>
        <tr>
          <th>Agente</th>
          <th>Período</th>
          <th class="num">Usado</th>
          <th class="num">Cota</th>
          <th class="num">%</th>
          <th>Estado</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${budgets.map(
          (b) => html`<tr key=${b.agent}>
            <td>${b.agent === '*' ? 'todos os agentes' : b.agent}</td>
            <td>${{ day: 'dia', week: 'semana', month: 'mês' }[b.period]}</td>
            <td class="num">${tk(b.usedTokens)}</td>
            <td class="num">${tk(b.limitTokens)}</td>
            <td class="num">${pct(b.usedPct)}</td>
            <td><span class="pill" data-state=${b.state}>${b.state}</span></td>
            <td class="num">
              <button
                class="ghost"
                onClick=${() => api.removeQuota(b.agent).then(onChanged)}
                title="remover cota"
              >
                remover
              </button>
            </td>
          </tr>`,
        )}
      </tbody>
    </table>
  `;
}

function Alerts({ alerts }) {
  if (alerts.length === 0) return null;
  return html`
    <div class="alerts">
      ${alerts.map(
        (a) => html`<div class="alert" key=${a.agent} data-state=${a.state}>
          <span class="alert-icon">${a.state === 'estourado' ? '!' : '·'}</span>
          <span>
            <strong>${a.agent === '*' ? 'Todos os agentes' : a.agent}</strong>
            ${
              // Numa única expressão: htm come o espaço em branco entre
              // interpolações separadas por quebra de linha.
              `${a.state === 'estourado' ? ' estourou a cota' : ' está perto do limite'}: ` +
              `${tkFull(a.usedTokens)} de ${tkFull(a.limitTokens)} tokens ` +
              `(${pct(a.usedPct)}) ${PERIOD_LABEL[a.period]}.`
            }
          </span>
        </div>`,
      )}
    </div>
  `;
}

/** Trocar o papel de um agente — é o que decide o personagem no palco. */
function RosterEditor({ agents, roles, onSaved }) {
  const [salvo, setSalvo] = useState(null);

  async function trocar(agent, role) {
    await api.saveAgent(agent, { role });
    setSalvo(agent);
    onSaved();
    setTimeout(() => setSalvo(null), 1600);
  }

  return html`
    <table class="list">
      <thead>
        <tr>
          <th>Agente</th>
          <th>Papel</th>
          <th class="num">Tokens no período</th>
        </tr>
      </thead>
      <tbody>
        ${agents.map(
          (a) => html`<tr key=${a.agent}>
            <td>${a.agent}${salvo === a.agent ? html` <span class="pill" data-state="ok">salvo</span>` : null}</td>
            <td>
              <select value=${a.role} onChange=${(e) => trocar(a.agent, e.target.value)}>
                ${roles.map((r) => html`<option key=${r.role} value=${r.role}>${r.label}</option>`)}
              </select>
            </td>
            <td class="num">${tk(a.usage.totalTokens)}</td>
          </tr>`,
        )}
      </tbody>
    </table>
  `;
}

/** Seletor de projeto. Fica escondido enquanto só existe um. */
function ProjectPicker({ projects, current, onChange }) {
  if (projects.length <= 1) return null;
  return html`
    <label class="proj">
      <span class="proj-label">projeto</span>
      <select value=${current ?? ''} onChange=${(e) => onChange(e.target.value)}>
        ${projects.map(
          (p) => html`<option key=${p.id} value=${p.id}>${p.name}</option>`,
        )}
      </select>
    </label>
  `;
}

// --- Aplicação ------------------------------------------------------------

function App() {
  const [projects, setProjects] = useState([]);
  const [project, setProject] = useState(lerProjetoDaUrl());

  // O módulo precisa saber o projeto antes de qualquer `get()`, e o React só
  // aplicaria o estado no próximo render.
  projetoAtual = project;

  const { connected, live, run, feed, alerts, tick } = useStream(project);
  const [period, setPeriod] = useState('day');
  const [rangeId, setRangeId] = useState('7d');
  const [recarga, setRecarga] = useState(0);
  const [mostrarAjustes, setMostrarAjustes] = useState(false);

  useEffect(() => {
    get('/v1/projects')
      .then((lista) => {
        setProjects(lista);
        // Sem projeto na URL, o painel abre no primeiro — e grava na URL, para
        // o endereço passar a identificar o que está na tela.
        if (!lerProjetoDaUrl() && lista.length) {
          projetoAtual = lista[0].id;
          setProject(lista[0].id);
          escreverProjetoNaUrl(lista[0].id);
        }
      })
      .catch(() => {});
  }, []);

  // Voltar e avançar do navegador trocam de projeto como o seletor.
  useEffect(() => {
    const aoVoltar = () => {
      const id = lerProjetoDaUrl();
      projetoAtual = id;
      setProject(id);
    };
    addEventListener('popstate', aoVoltar);
    return () => removeEventListener('popstate', aoVoltar);
  }, []);

  const trocarProjeto = useCallback((id) => {
    projetoAtual = id;
    setProject(id);
    escreverProjetoNaUrl(id);
  }, []);

  const range = RANGES.find((r) => r.id === rangeId) ?? RANGES[1];
  const from = useMemo(
    () => new Date(Date.now() - range.hours * 3600_000).toISOString(),
    [range.hours, recarga],
  );

  const refresh = useCallback(() => setRecarga((n) => n + 1), []);

  // O palco acompanha a chegada de eventos; 600ms agrupa uma rajada.
  const stage = useReload(() => api.stage(period), [project, period, tick, recarga], tick ? 600 : 0).data;
  const serie = useReload(
    () => api.timeseries(from, range.bucket),
    [project, from, range.bucket, tick, recarga],
    tick ? 900 : 0,
  ).data;
  const porAgente = useReload(() => api.byAgent(from), [project, from, tick, recarga], tick ? 900 : 0).data;
  const porModelo = useReload(() => api.byModel(from), [project, from, tick, recarga], tick ? 900 : 0).data;
  const roles = useReload(() => api.roles(), []).data ?? [];

  // O SSE é a fonte da verdade do estado ao vivo: sobrepõe o que veio no /v1/stage.
  const palco = useMemo(() => {
    if (!stage) return null;
    return {
      ...stage,
      agents: stage.agents.map((a) => ({ ...a, live: live[a.agent] ?? a.live })),
    };
  }, [stage, live]);

  const papelPorAgente = useMemo(
    () => Object.fromEntries((stage?.agents ?? []).map((a) => [a.agent, a.role])),
    [stage],
  );

  const cotasFora = (stage?.agents ?? [])
    .map((a) => a.budget)
    .concat(stage?.globalBudget ? [stage.globalBudget] : [])
    .filter((b) => b && b.state !== 'ok');

  const todasCotas = useMemo(() => {
    const lista = (stage?.agents ?? []).map((a) => a.budget).filter(Boolean);
    return stage?.globalBudget ? [stage.globalBudget, ...lista] : lista;
  }, [stage]);

  const totais = palco?.totals;

  return html`
    <div class="wrap">
      <header class="top">
        <div>
          <h1>Token Monitor</h1>
          <div class="sub">Consumo de tokens dos agentes, ao vivo</div>
        </div>
        <div class="top-right">
          <${ProjectPicker} projects=${projects} current=${project} onChange=${trocarProjeto} />
          <span class="conn" data-on=${String(connected)}>
            <span class="conn-dot"></span>${connected ? 'conectado ao stream' : 'sem stream'}
          </span>
        </div>
      </header>

      <${Alerts} alerts=${[...alerts, ...cotasFora].slice(0, 4)} />

      <div class="controls">
        <div class="seg">
          ${['day', 'week', 'month'].map(
            (p) => html`<button
              key=${p}
              aria-pressed=${String(period === p)}
              onClick=${() => setPeriod(p)}
            >
              ${PERIOD_LABEL[p]}
            </button>`,
          )}
        </div>
        <button class="ghost" onClick=${() => setMostrarAjustes((v) => !v)}>
          ${mostrarAjustes ? 'esconder ajustes' : 'papéis e cotas'}
        </button>
        <a class="ghost" href=${project ? `/escritorio.html?project=${encodeURIComponent(project)}` : '/escritorio.html'}>
          escritório 3D
        </a>
      </div>

      <div class="kpis">
        <div class="kpi">
          <div class="kpi-label">Tokens ${PERIOD_LABEL[period]}</div>
          <div class="kpi-value" title=${totais ? `${tkFull(totais.totalTokens)} tokens` : ''}>
            ${totais ? tk(totais.totalTokens) : '—'}
          </div>
          <div class="kpi-note">${totais ? `${tk(totais.outputTokens)} de saída` : ''}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Chamadas</div>
          <div class="kpi-value">${totais ? BRint.format(totais.requests) : '—'}</div>
          <div class="kpi-note">
            ${totais && totais.requests
              ? `${tkFull(Math.round(totais.totalTokens / totais.requests))} tokens por chamada`
              : ''}
          </div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Cache lido</div>
          <div class="kpi-value">${totais ? tk(totais.cacheReadTokens) : '—'}</div>
          <div class="kpi-note">
            ${totais && totais.totalTokens
              ? `${pct(totais.cacheReadTokens / totais.totalTokens)} do total`
              : ''}
          </div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Cota global</div>
          <div class="kpi-value">
            ${palco?.globalBudget ? pct(palco.globalBudget.usedPct) : '—'}
          </div>
          <div class="kpi-note">
            ${palco?.globalBudget
              ? `${tk(palco.globalBudget.remainingTokens)} restantes ${
                  PERIOD_LABEL[palco.globalBudget.period]
                }`
              : 'sem cota definida'}
          </div>
        </div>
      </div>

      <${Stage} stage=${palco} period=${period} run=${run} />

      ${mostrarAjustes
        ? html`<div class="grid">
            <section class="card">
              <h2>Papéis do elenco</h2>
              <${RosterEditor}
                agents=${palco?.agents ?? []}
                roles=${roles}
                onSaved=${refresh}
              />
            </section>
            <section class="card">
              <h2>Cotas de tokens</h2>
              <${QuotaForm}
                agents=${(palco?.agents ?? []).map((a) => a.agent)}
                onSaved=${refresh}
              />
              <${Quotas} budgets=${todasCotas} onChanged=${refresh} />
            </section>
          </div>`
        : null}

      <div class="controls">
        <div class="seg">
          ${RANGES.map(
            (r) => html`<button
              key=${r.id}
              aria-pressed=${String(r.id === rangeId)}
              onClick=${() => setRangeId(r.id)}
            >
              ${r.label}
            </button>`,
          )}
        </div>
      </div>

      <div class="grid">
        <section class="card">
          <h2>Tokens ao longo do tempo</h2>
          <${TokensOverTime} points=${serie} bucket=${range.bucket} />
        </section>
        <section class="card">
          <h2>Ao vivo</h2>
          <${LiveFeed} feed=${feed} />
        </section>
      </div>

      <div class="grid">
        <section class="card">
          <h2>Tokens por agente · ${range.label}</h2>
          <${TokensByAgent} rows=${porAgente} roles=${papelPorAgente} />
        </section>
        <section class="card">
          <h2>Uso por modelo · ${range.label}</h2>
          ${porModelo && porModelo.length
            ? html`<table class="list">
                <thead>
                  <tr>
                    <th>Modelo</th>
                    <th class="num">Chamadas</th>
                    <th class="num">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  ${porModelo.map(
                    (m) => html`<tr key=${m.key}>
                      <td style=${{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '12px' }}>
                        ${m.key}
                      </td>
                      <td class="num">${BRint.format(m.requests)}</td>
                      <td class="num">${tk(m.totalTokens)}</td>
                    </tr>`,
                  )}
                </tbody>
              </table>`
            : html`<div class="empty">Sem chamadas no período.</div>`}
        </section>
      </div>

      <footer class="foot">
        Períodos em UTC, semana a partir de segunda. Saúde da API em <a href="/health">/health</a> ·
        relatório semanal em <a href="/v1/reports/weekly.html">prévia do e-mail</a> · elenco e
        animações em <a href="/showroom.html">vitrine</a>.
      </footer>
    </div>
  `;
}

createRoot(document.getElementById('root')).render(html`<${App} />`);
