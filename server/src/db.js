import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { migrate, PROJETO_PADRAO } from './migrate.js';

const DB_PATH = resolve(process.env.DB_PATH ?? 'data/tokens.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
// O importador de transcripts e a API abrem o mesmo arquivo. Sem isto, o
// primeiro encontro entre os dois derruba uma das leituras com SQLITE_BUSY.
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                 TEXT    NOT NULL,
    agent              TEXT    NOT NULL,
    model              TEXT    NOT NULL,
    provider           TEXT    NOT NULL DEFAULT 'anthropic',
    operation          TEXT,
    session_id         TEXT,
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens       INTEGER NOT NULL DEFAULT 0,
    cost_usd           REAL    NOT NULL DEFAULT 0,
    latency_ms         INTEGER,
    status             TEXT    NOT NULL DEFAULT 'ok',
    error              TEXT,
    metadata           TEXT
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)');

// O resto do esquema — a dimensão de projeto, o elenco, as cotas e as tabelas
// dos projetos — vem das migrações numeradas.
export const schemaVersion = migrate(db);

const COLUNAS = `
  project, ts, agent, model, provider, operation, session_id,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  total_tokens, cost_usd, latency_ms, status, error, metadata, source_uuid
`;
const VALORES = '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?';

const insertStmt = db.prepare(`INSERT INTO events (${COLUNAS}) VALUES (${VALORES})`);
// Usado pelo importador: reler um transcript inteiro não pode duplicar nada.
const insertIgnoreStmt = db.prepare(
  `INSERT OR IGNORE INTO events (${COLUNAS}) VALUES (${VALORES})`,
);

function parametros(e) {
  return [
    e.project ?? PROJETO_PADRAO,
    e.ts,
    e.agent,
    e.model,
    e.provider,
    e.operation ?? null,
    e.sessionId ?? null,
    e.inputTokens,
    e.outputTokens,
    e.cacheReadTokens,
    e.cacheWriteTokens,
    e.totalTokens,
    e.costUsd,
    e.latencyMs ?? null,
    e.status,
    e.error ?? null,
    e.metadata ? JSON.stringify(e.metadata) : null,
    e.sourceUuid ?? null,
  ];
}

/** Insere um evento. Com `ignoreDuplicates`, devolve `null` se já existia. */
export function insertEvent(e, { ignoreDuplicates = false } = {}) {
  const stmt = ignoreDuplicates ? insertIgnoreStmt : insertStmt;
  const result = stmt.run(...parametros(e));
  if (result.changes === 0) return null;
  return Number(result.lastInsertRowid);
}

/**
 * Insere um lote numa transação só.
 *
 * Devolve `{ ids, novos, skipped }` — e não a lista de ids crua de antes —
 * porque com `ignoreDuplicates` o que entra pode ser menos do que o que foi
 * passado. `novos` traz os eventos que de fato entraram: quem anima o palco e
 * quem dispara alerta de cota precisa saber exatamente quais são, não só
 * quantos.
 */
export function insertEvents(events, { ignoreDuplicates = false } = {}) {
  const ids = [];
  const novos = [];
  let skipped = 0;

  db.exec('BEGIN');
  try {
    for (const e of events) {
      const id = insertEvent(e, { ignoreDuplicates });
      if (id === null) {
        skipped += 1;
      } else {
        ids.push(id);
        novos.push(e);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { ids, novos, inserted: ids.length, skipped };
}

export function dbPath() {
  return DB_PATH;
}

export function ping() {
  return db.prepare('SELECT count(*) AS n FROM events').get().n;
}
