/**
 * Migrações do banco, numeradas por `PRAGMA user_version`.
 *
 * Cada passo roda uma vez só e nunca descarta dado do usuário: papel de
 * agente, nome de exibição e cota são trabalho dele. Onde o SQLite não permite
 * alterar a chave primária por `ALTER TABLE`, a tabela é recriada e as linhas
 * copiadas para o projeto padrão.
 *
 * Para acrescentar um passo: some uma função no fim de `PASSOS` e não mexa nas
 * anteriores — bancos antigos vão rodar só o que falta.
 */

/** Projeto para onde vai tudo o que existia antes da dimensão de projeto. */
export const PROJETO_PADRAO = process.env.LEGACY_PROJECT ?? 'default';

/** Sentinela de "todos": nenhum projeto pode se chamar assim. */
export const TODOS_PROJETOS = '*';

function colunas(db, tabela) {
  return db
    .prepare(`PRAGMA table_info(${tabela})`)
    .all()
    .map((c) => c.name);
}

const PASSOS = [
  // 1 — a dimensão de projeto em `events`, sem reescrever a tabela.
  (db) => {
    const cols = colunas(db, 'events');
    if (!cols.includes('project')) {
      // ADD COLUMN com DEFAULT preenche as linhas existentes na hora.
      db.exec(
        `ALTER TABLE events ADD COLUMN project TEXT NOT NULL DEFAULT '${PROJETO_PADRAO}'`,
      );
    }
    if (!cols.includes('source_uuid')) {
      db.exec('ALTER TABLE events ADD COLUMN source_uuid TEXT');
    }

    // Índice parcial: evento vindo do SDK não tem uuid de origem e não pode
    // colidir com outro evento sem uuid.
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source
        ON events(project, source_uuid) WHERE source_uuid IS NOT NULL
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_events_proj_ts ON events(project, ts)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_events_proj_agent_ts ON events(project, agent, ts)',
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_events_proj_model_ts ON events(project, model, ts)',
    );

    // Os antigos viraram prefixo dos novos; `idx_events_ts` fica, porque a
    // visão de todos os projetos varre por tempo sem cláusula de projeto.
    db.exec('DROP INDEX IF EXISTS idx_events_agent_ts');
    db.exec('DROP INDEX IF EXISTS idx_events_model_ts');
  },

  // 2 — elenco por projeto: chave primária composta.
  (db) => {
    const cols = colunas(db, 'agents');
    if (cols.includes('project')) return;

    // Banco novo: a tabela nasce já no formato certo.
    if (cols.length === 0) {
      db.exec(`
        CREATE TABLE agents (
          project      TEXT NOT NULL,
          agent        TEXT NOT NULL,
          role         TEXT NOT NULL,
          display_name TEXT,
          first_seen   TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          PRIMARY KEY (project, agent)
        )
      `);
      return;
    }

    db.exec(`
      CREATE TABLE agents_novo (
        project      TEXT NOT NULL,
        agent        TEXT NOT NULL,
        role         TEXT NOT NULL,
        display_name TEXT,
        first_seen   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (project, agent)
      )
    `);
    db.exec(`
      INSERT INTO agents_novo (project, agent, role, display_name, first_seen, updated_at)
      SELECT '${PROJETO_PADRAO}', agent, role, display_name, first_seen, updated_at FROM agents
    `);
    db.exec('DROP TABLE agents');
    db.exec('ALTER TABLE agents_novo RENAME TO agents');
  },

  // 3 — cotas por projeto, com a métrica explícita.
  (db) => {
    const cols = colunas(db, 'budgets');
    if (cols.includes('project')) return;

    const temTokens = cols.includes('limit_tokens');
    const nova = cols.length === 0;

    db.exec(`
      CREATE TABLE ${nova ? 'budgets' : 'budgets_novo'} (
        project      TEXT NOT NULL,
        agent        TEXT NOT NULL,
        period       TEXT NOT NULL DEFAULT 'month',
        metric       TEXT NOT NULL DEFAULT 'total',
        limit_tokens INTEGER NOT NULL,
        warn_pct     REAL NOT NULL DEFAULT 0.8,
        last_state   TEXT NOT NULL DEFAULT 'ok',
        last_period  TEXT,
        notified_at  TEXT,
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (project, agent)
      )
    `);

    if (nova) return;

    if (temTokens) {
      // As cotas que já existem continuam medindo `total`, que é o que
      // mediam: mudar a métrica por baixo mudaria o estado delas sem aviso.
      db.exec(`
        INSERT INTO budgets_novo
          (project, agent, period, metric, limit_tokens, warn_pct, last_state, last_period, notified_at, updated_at)
        SELECT '${PROJETO_PADRAO}', agent, period, 'total', limit_tokens, warn_pct,
               last_state, last_period, notified_at, updated_at
        FROM budgets
      `);
    } else {
      // Esquema antigo em dólar: não há conversão honesta de dólar para
      // token, porque o preço varia por modelo. As cotas voltam vazias.
      console.warn('[migração] cotas em dólar encontradas; recriando em tokens');
    }

    db.exec('DROP TABLE budgets');
    db.exec('ALTER TABLE budgets_novo RENAME TO budgets');
  },

  // 4 — os projetos em si, e de onde cada um é lido.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        source_path TEXT,
        main_agent  TEXT NOT NULL DEFAULT 'orquestrador',
        created_at  TEXT NOT NULL,
        archived_at TEXT
      )
    `);

    // Um projeto pode ter mais de uma pasta de transcript: o Claude Code cria
    // pastas que diferem só na caixa do caminho.
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_sources (
        project        TEXT NOT NULL,
        transcript_dir TEXT NOT NULL,
        PRIMARY KEY (project, transcript_dir)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS transcript_cursors (
        project    TEXT NOT NULL,
        path       TEXT NOT NULL,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        size       INTEGER NOT NULL DEFAULT 0,
        mtime      TEXT,
        updated_at TEXT,
        PRIMARY KEY (project, path)
      )
    `);

    // O projeto que recebeu tudo o que já existia precisa existir na lista.
    const agora = new Date().toISOString();
    db.prepare(
      `INSERT INTO projects (id, name, source_path, main_agent, created_at)
       VALUES (?, ?, NULL, 'orquestrador', ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(PROJETO_PADRAO, 'Local', agora);
  },
];

/** Roda o que falta. Devolve a versão em que o banco ficou. */
export function migrate(db) {
  let versao = db.prepare('PRAGMA user_version').get().user_version;

  for (let i = versao; i < PASSOS.length; i += 1) {
    const passo = i + 1;
    db.exec('BEGIN');
    try {
      PASSOS[i](db);
      // PRAGMA não aceita parâmetro ligado; o valor é um inteiro nosso.
      db.exec(`PRAGMA user_version = ${passo}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migração ${passo} falhou: ${err.message}`);
    }
    console.log(`[migração] passo ${passo} aplicado`);
    versao = passo;
  }

  return versao;
}
