import { summary, groupBy } from './stats.js';
import { listBudgets, periodStart } from './budgets.js';
import { getAgent } from './roster.js';
import { tokens as fmtTokens, tokensFull } from './format.js';

/**
 * Relatório semanal: tokens por agente e por modelo na semana que fechou,
 * comparado com a semana anterior, mais a situação das cotas.
 *
 * A semana vai de segunda a domingo, em UTC — o mesmo corte das cotas.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Semana fechada mais recente: a anterior à que está correndo agora. */
export function lastClosedWeek(now = new Date()) {
  const currentWeekStart = periodStart('week', now);
  const to = currentWeekStart;
  const from = new Date(to.getTime() - WEEK_MS);
  return { from, to };
}

function delta(current, previous) {
  if (!previous) return null;
  return (current - previous) / previous;
}

export function buildWeeklyReport({ project, now = new Date() } = {}) {
  const { from, to } = lastClosedWeek(now);
  const previous = { from: new Date(from.getTime() - WEEK_MS), to: from };

  // `project` indefinido significa todos: o relatório vira o consolidado.
  const range = { project, from: from.toISOString(), to: to.toISOString() };
  const previousRange = {
    project,
    from: previous.from.toISOString(),
    to: previous.to.toISOString(),
  };

  const totals = summary(range);
  const previousTotals = summary(previousRange);

  const previousByAgent = new Map(
    groupBy('agent', previousRange, 100).map((row) => [row.key, row]),
  );

  const byAgent = groupBy('agent', range, 20).map((row) => {
    const antes = previousByAgent.get(row.key)?.totalTokens ?? 0;
    return {
      ...row,
      role: project ? (getAgent(project, row.key)?.label ?? null) : null,
      previousTotalTokens: antes,
      deltaPct: delta(row.totalTokens, antes),
    };
  });

  return {
    project: project ?? null,
    period: { from: range.from, to: range.to },
    previousPeriod: previousRange,
    totals,
    previousTotals,
    deltaPct: delta(totals.totalTokens, previousTotals.totalTokens),
    byAgent,
    byModel: groupBy('model', range, 20),
    byProject: project ? null : groupBy('project', range, 20),
    budgets: listBudgets(project, now),
    generatedAt: new Date(now).toISOString(),
  };
}

// --- Formatação -----------------------------------------------------------

const compact = (n) =>
  (n ?? 0).toLocaleString('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });

const dia = (iso) =>
  new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });

function variacao(deltaPct) {
  if (deltaPct == null) return '—';
  const sinal = deltaPct >= 0 ? '+' : '';
  return `${sinal}${Math.round(deltaPct * 100)}%`;
}

function escape(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

export function subjectFor(report) {
  const periodo = `${dia(report.period.from)} a ${dia(
    new Date(new Date(report.period.to).getTime() - 1).toISOString(),
  )}`;
  return `Token Monitor · ${periodo} · ${fmtTokens(report.totals.totalTokens)} tokens`;
}

/**
 * HTML de e-mail: tabelas e estilos inline, porque clientes de e-mail ignoram
 * folha de estilo externa, flexbox e grid.
 */
export function renderHtml(report) {
  const fim = new Date(new Date(report.period.to).getTime() - 1).toISOString();
  const maxAgente = Math.max(...report.byAgent.map((a) => a.totalTokens), 1);

  const celula = 'padding:8px 10px;border-bottom:1px solid #e5e9f0;font-size:14px;';
  const cabecalho =
    'padding:8px 10px;border-bottom:2px solid #d8dee9;font-size:11px;' +
    'text-transform:uppercase;letter-spacing:0.05em;color:#5b6b85;text-align:left;';

  const linhasAgente = report.byAgent
    .map((a) => {
      const largura = Math.max((a.totalTokens / maxAgente) * 100, 2);
      return `
        <tr>
          <td style="${celula}">${escape(a.key)}${
            a.role ? `<span style="color:#5b6b85;font-size:12px;"> · ${escape(a.role)}</span>` : ''
          }</td>
          <td style="${celula}width:36%;">
            <div style="background:#eef2f8;border-radius:3px;height:8px;">
              <div style="background:#2563eb;width:${largura}%;height:8px;border-radius:3px;"></div>
            </div>
          </td>
          <td style="${celula}text-align:right;">${tokensFull(a.totalTokens)}</td>
          <td style="${celula}text-align:right;color:${
            a.deltaPct == null ? '#5b6b85' : a.deltaPct > 0 ? '#b91c1c' : '#047857'
          };">${variacao(a.deltaPct)}</td>
        </tr>`;
    })
    .join('');

  const linhasModelo = report.byModel
    .map(
      (m) => `
        <tr>
          <td style="${celula}font-family:ui-monospace,Consolas,monospace;font-size:13px;">${escape(
            m.key,
          )}</td>
          <td style="${celula}text-align:right;">${compact(m.requests)}</td>
          <td style="${celula}text-align:right;">${tokensFull(m.totalTokens)}</td>
          <td style="${celula}text-align:right;">${tokensFull(m.outputTokens)}</td>
        </tr>`,
    )
    .join('');

  const estourados = report.budgets.filter((b) => b.state !== 'ok');
  const blocoCotas = estourados.length
    ? `
      <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#5b6b85;margin:28px 0 8px;">
        Cotas fora do lugar
      </h2>
      <ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.7;">
        ${estourados
          .map(
            (b) =>
              `<li><strong>${escape(
                b.agent === '*' ? 'Todos os agentes' : b.agent,
              )}</strong>: ${tokensFull(b.usedTokens)} de ${tokensFull(
                b.limitTokens,
              )} tokens (${Math.round(b.usedPct * 100)}%) — ${
                b.state === 'estourado' ? 'estourada' : 'em atenção'
              }</li>`,
          )
          .join('')}
      </ul>`
    : '';

  return `<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;padding:24px;background:#f6f8fc;color:#0f1724;font-family:ui-sans-serif,system-ui,'Segoe UI',sans-serif;">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #dde5f0;border-radius:14px;padding:28px;">
      <h1 style="margin:0;font-size:20px;">Relatório semanal de tokens</h1>
      <p style="margin:4px 0 24px;color:#5b6b85;font-size:14px;">
        ${dia(report.period.from)} a ${dia(fim)} (UTC)
      </p>

      <table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:8px;">
        <tr>
          <td style="padding:0 12px 0 0;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#5b6b85;">Tokens</div>
            <div style="font-size:26px;font-weight:600;">${fmtTokens(
              report.totals.totalTokens,
            )}</div>
            <div style="font-size:13px;color:#5b6b85;">${variacao(
              report.deltaPct,
            )} vs. semana anterior (${fmtTokens(report.previousTotals.totalTokens)})</div>
          </td>
          <td style="padding:0 12px;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#5b6b85;">Saída</div>
            <div style="font-size:26px;font-weight:600;">${fmtTokens(
              report.totals.outputTokens,
            )}</div>
            <div style="font-size:13px;color:#5b6b85;">${compact(
              report.totals.requests,
            )} chamadas</div>
          </td>
          <td style="padding:0 0 0 12px;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#5b6b85;">Erros</div>
            <div style="font-size:26px;font-weight:600;">${report.totals.errors ?? 0}</div>
            <div style="font-size:13px;color:#5b6b85;">${
              report.totals.requests
                ? ((report.totals.errors / report.totals.requests) * 100).toFixed(1)
                : '0.0'
            }% das chamadas</div>
          </td>
        </tr>
      </table>

      <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#5b6b85;margin:28px 0 8px;">
        Tokens por agente
      </h2>
      <table role="presentation" style="width:100%;border-collapse:collapse;">
        <tr>
          <th style="${cabecalho}">Agente</th>
          <th style="${cabecalho}"></th>
          <th style="${cabecalho}text-align:right;">Tokens</th>
          <th style="${cabecalho}text-align:right;">vs. anterior</th>
        </tr>
        ${linhasAgente || `<tr><td style="${celula}" colspan="4">Sem chamadas na semana.</td></tr>`}
      </table>

      <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#5b6b85;margin:28px 0 8px;">
        Uso por modelo
      </h2>
      <table role="presentation" style="width:100%;border-collapse:collapse;">
        <tr>
          <th style="${cabecalho}">Modelo</th>
          <th style="${cabecalho}text-align:right;">Chamadas</th>
          <th style="${cabecalho}text-align:right;">Tokens</th>
          <th style="${cabecalho}text-align:right;">Saída</th>
        </tr>
        ${linhasModelo || `<tr><td style="${celula}" colspan="4">Sem chamadas na semana.</td></tr>`}
      </table>

      ${blocoCotas}

      <p style="margin:28px 0 0;color:#5b6b85;font-size:12px;">
        Gerado pelo Token Monitor em ${new Date(report.generatedAt).toLocaleString('pt-BR', {
          timeZone: 'UTC',
        })} UTC.
      </p>
    </div>
  </body>
</html>`;
}

/** Versão em texto puro, para clientes que não renderizam HTML. */
export function renderText(report) {
  const fim = new Date(new Date(report.period.to).getTime() - 1).toISOString();
  const linhas = [
    `Relatório semanal de tokens · ${dia(report.period.from)} a ${dia(fim)} (UTC)`,
    '',
    `Tokens: ${tokensFull(report.totals.totalTokens)} (${variacao(
      report.deltaPct,
    )} vs. semana anterior)`,
    `Saída: ${tokensFull(report.totals.outputTokens)} em ${report.totals.requests} chamadas`,
    `Erros: ${report.totals.errors ?? 0}`,
    '',
    'Tokens por agente:',
    ...report.byAgent.map(
      (a) => `  ${a.key}: ${tokensFull(a.totalTokens)} (${variacao(a.deltaPct)})`,
    ),
    '',
    'Uso por modelo:',
    ...report.byModel.map(
      (m) => `  ${m.key}: ${tokensFull(m.totalTokens)} tokens · ${m.requests} chamadas`,
    ),
  ];

  const fora = report.budgets.filter((b) => b.state !== 'ok');
  if (fora.length) {
    linhas.push('', 'Cotas fora do lugar:');
    for (const b of fora) {
      linhas.push(
        `  ${b.agent === '*' ? 'todos os agentes' : b.agent}: ${tokensFull(
          b.usedTokens,
        )} de ${tokensFull(b.limitTokens)} tokens (${Math.round(b.usedPct * 100)}%)`,
      );
    }
  }

  return linhas.join('\n');
}
