import { db } from './db.js';
import { PROJETO_PADRAO, TODOS_PROJETOS } from './migrate.js';

/**
 * Os projetos monitorados. Um projeto é um conjunto de pastas de transcript
 * do Claude Code mais o elenco e as cotas daquele trabalho.
 *
 * O `id` é imutável: é ele que está gravado em `events.project`,
 * `agents.project` e `budgets.project`. Renomear mexe só no `name` — se o id
 * pudesse mudar, um rename deixaria linhas órfãs em quatro tabelas.
 *
 * As tabelas são criadas pelas migrações, em `migrate.js`.
 */

const RESERVADOS = new Set([TODOS_PROJETOS, 'all', 'todos']);

/** Transforma um nome livre num id usável: minúsculo, sem acento, sem espaço. */
export function slugify(texto) {
  return String(texto)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function validateId(id) {
  if (!id) throw new Error('id do projeto é obrigatório');
  if (RESERVADOS.has(id)) throw new Error(`"${id}" é reservado e não pode ser um projeto`);
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) {
    throw new Error('id deve ter de 1 a 40 caracteres: minúsculas, números, hífen ou _');
  }
  return id;
}

function shape(row) {
  return {
    id: row.id,
    name: row.name,
    sourcePath: row.source_path,
    mainAgent: row.main_agent,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    sources: db
      .prepare('SELECT transcript_dir FROM project_sources WHERE project = ? ORDER BY transcript_dir')
      .all(row.id)
      .map((r) => r.transcript_dir),
  };
}

export function listProjects({ includeArchived = false } = {}) {
  const sql = includeArchived
    ? 'SELECT * FROM projects ORDER BY name'
    : 'SELECT * FROM projects WHERE archived_at IS NULL ORDER BY name';
  return db.prepare(sql).all().map(shape);
}

export function getProject(id) {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  return row ? shape(row) : null;
}

/**
 * O projeto que vale quando ninguém disse qual. Com um projeto só — o caso
 * comum — é ele, para o painel não exigir escolha antes de mostrar algo.
 */
export function defaultProject() {
  const ativos = listProjects();
  if (ativos.length === 1) return ativos[0].id;
  if (ativos.some((p) => p.id === PROJETO_PADRAO)) return PROJETO_PADRAO;
  return ativos[0]?.id ?? PROJETO_PADRAO;
}

export function upsertProject({ id, name, sourcePath, mainAgent, archived }) {
  const slug = validateId(id ?? slugify(name ?? ''));
  const atual = db.prepare('SELECT * FROM projects WHERE id = ?').get(slug);
  const agora = new Date().toISOString();

  db.prepare(
    `INSERT INTO projects (id, name, source_path, main_agent, created_at, archived_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       source_path = excluded.source_path,
       main_agent = excluded.main_agent,
       archived_at = excluded.archived_at`,
  ).run(
    slug,
    name ?? atual?.name ?? slug,
    sourcePath ?? atual?.source_path ?? null,
    mainAgent ?? atual?.main_agent ?? 'orquestrador',
    atual?.created_at ?? agora,
    archived === true ? agora : archived === false ? null : (atual?.archived_at ?? null),
  );

  return getProject(slug);
}

/** Liga uma pasta de transcript a um projeto. Um projeto pode ter várias. */
export function addSource(project, transcriptDir) {
  db.prepare(
    `INSERT INTO project_sources (project, transcript_dir) VALUES (?, ?)
     ON CONFLICT(project, transcript_dir) DO NOTHING`,
  ).run(project, transcriptDir);
  return getProject(project);
}

export function removeSource(project, transcriptDir) {
  return (
    db
      .prepare('DELETE FROM project_sources WHERE project = ? AND transcript_dir = ?')
      .run(project, transcriptDir).changes > 0
  );
}

/** Qual projeto é dono de uma pasta de transcript, se algum. */
export function projectForSource(transcriptDir) {
  const row = db
    .prepare('SELECT project FROM project_sources WHERE transcript_dir = ?')
    .get(transcriptDir);
  return row?.project ?? null;
}

export function listSources() {
  return db
    .prepare('SELECT project, transcript_dir AS dir FROM project_sources ORDER BY project')
    .all();
}
