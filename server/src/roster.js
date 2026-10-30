import { db } from './db.js';
import { TODOS_PROJETOS } from './migrate.js';

/**
 * Elenco: cada agente é um personagem com um papel, dentro de um projeto. O
 * mesmo nome pode existir em dois projetos com papéis diferentes, daí a chave
 * primária ser `(project, agent)`.
 *
 * O papel decide o desenho, o acessório de cabeça e a cor que o painel usa,
 * então o front não precisa adivinhar nada a partir do nome.
 *
 * Um agente aparece aqui na primeira vez que manda evento ou atividade. O
 * papel é chutado pelo nome e pode ser corrigido depois no painel.
 *
 * A tabela `agents` é criada pelas migrações, em `migrate.js`.
 */

export const ROLES = {
  orquestrador: { label: 'Orquestrador', prop: 'card', hat: 'headset', order: 0 },
  designer: { label: 'Designer', prop: 'picture', hat: 'beret', order: 1 },
  frontend: { label: 'Frontend', prop: 'screen', hat: 'cap', order: 2 },
  backend: { label: 'Backend', prop: 'rack', hat: 'helmet', order: 3 },
  devops: { label: 'DevOps', prop: 'pipeline', hat: 'headlamp', order: 4 },
  dados: { label: 'Dados', prop: 'chart', hat: 'visor', order: 5 },
  qa: { label: 'QA', prop: 'checklist', hat: 'band', order: 6 },
  revisor: { label: 'Revisor', prop: 'lens', hat: 'glasses', order: 7 },
  pesquisador: { label: 'Pesquisador', prop: 'book', hat: 'explorer', order: 8 },
  generico: { label: 'Agente', prop: 'spark', hat: null, order: 9 },
};

export const ROLE_NAMES = Object.keys(ROLES);

/**
 * Agentes embutidos do Claude Code, que não casariam com regra nenhuma por
 * serem nomes em inglês. Consultado antes do chute por nome.
 */
const PAPEIS_CLAUDE = {
  explore: 'pesquisador',
  plan: 'orquestrador',
  'general-purpose': 'generico',
  'statusline-setup': 'devops',
};

// Primeiro padrão que casa com o nome do agente ganha. Ordem importa:
// 'orquestrador-frontend' é orquestrador, não frontend.
const GUESSES = [
  [/orquestr|orchestr|maestr|lead|coordena/i, 'orquestrador'],
  [/design|ux|ui\b|visual|figma/i, 'designer'],
  [/devops|deploy|pipeline|infra|ci\b|cd\b|k8s|kube|terraform/i, 'devops'],
  [/front|web|react|interface|css/i, 'frontend'],
  [/back|api|server|banco|db\b|sql/i, 'backend'],
  [/dados|data|analytic|m[eé]trica|bi\b|etl/i, 'dados'],
  [/bug|ca[çc]ador|hunt|qa\b|teste|test|quality|e2e/i, 'qa'],
  [/revis|review|lint|auditor/i, 'revisor'],
  [/pesquis|research|busca|search|doc/i, 'pesquisador'],
];

export function guessRole(agent) {
  const chave = String(agent).toLowerCase();
  if (PAPEIS_CLAUDE[chave]) return PAPEIS_CLAUDE[chave];
  for (const [pattern, role] of GUESSES) {
    if (pattern.test(agent)) return role;
  }
  return 'generico';
}

function shape(row) {
  const role = ROLES[row.role] ? row.role : 'generico';
  return {
    project: row.project,
    agent: row.agent,
    role,
    label: ROLES[role].label,
    prop: ROLES[role].prop,
    hat: ROLES[role].hat,
    order: ROLES[role].order,
    displayName: row.display_name ?? row.agent,
    firstSeen: row.first_seen,
  };
}

/** `project` nulo ou o sentinela lista o elenco de todos os projetos. */
export function listAgents(project) {
  const todos = !project || project === TODOS_PROJETOS;
  const rows = todos
    ? db.prepare('SELECT * FROM agents').all()
    : db.prepare('SELECT * FROM agents WHERE project = ?').all(project);

  return rows
    .map(shape)
    .sort(
      (a, b) =>
        a.project.localeCompare(b.project) ||
        a.order - b.order ||
        a.agent.localeCompare(b.agent),
    );
}

export function getAgent(project, agent) {
  const row = db
    .prepare('SELECT * FROM agents WHERE project = ? AND agent = ?')
    .get(project, agent);
  return row ? shape(row) : null;
}

/** Registra os agentes que ainda não existem. Devolve os nomes recém-criados. */
export function ensureAgents(project, names) {
  const now = new Date().toISOString();
  const novos = [];
  const insert = db.prepare(
    `INSERT INTO agents (project, agent, role, display_name, first_seen, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?)
     ON CONFLICT(project, agent) DO NOTHING`,
  );
  for (const name of names) {
    if (insert.run(project, name, guessRole(name), now, now).changes > 0) novos.push(name);
  }
  return novos;
}

export function upsertAgent({ project, agent, role, displayName }) {
  if (!project) throw new Error('project é obrigatório');
  if (!agent) throw new Error('agent é obrigatório');
  if (role != null && !ROLES[role]) {
    throw new Error(`role deve ser um de: ${ROLE_NAMES.join(', ')}`);
  }
  const now = new Date().toISOString();
  const atual = db
    .prepare('SELECT * FROM agents WHERE project = ? AND agent = ?')
    .get(project, agent);

  db.prepare(
    `INSERT INTO agents (project, agent, role, display_name, first_seen, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project, agent) DO UPDATE SET
       role = excluded.role,
       display_name = excluded.display_name,
       updated_at = excluded.updated_at`,
  ).run(
    project,
    agent,
    role ?? atual?.role ?? guessRole(agent),
    displayName ?? atual?.display_name ?? null,
    atual?.first_seen ?? now,
    now,
  );

  return getAgent(project, agent);
}

export function deleteAgent(project, agent) {
  return (
    db.prepare('DELETE FROM agents WHERE project = ? AND agent = ?').run(project, agent)
      .changes > 0
  );
}

/** Agentes que já mandaram evento mas nunca passaram pelo registro. */
export function backfillFromEvents() {
  const pares = db.prepare('SELECT DISTINCT project, agent FROM events').all();
  const porProjeto = new Map();
  for (const { project, agent } of pares) {
    if (!porProjeto.has(project)) porProjeto.set(project, []);
    porProjeto.get(project).push(agent);
  }

  const novos = [];
  for (const [project, agentes] of porProjeto) {
    novos.push(...ensureAgents(project, agentes).map((a) => `${project}/${a}`));
  }
  return novos;
}
