import { readdirSync, statSync, existsSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename, win32 } from 'node:path';
import { homedir } from 'node:os';

import { db } from './db.js';
import { normalizeEvent } from './normalize.js';
import { ingest } from './ingest.js';
import { getProject, listSources, projectForSource } from './projects.js';
import { ensureAgents } from './roster.js';
import { noDisco } from './caminhos.js';

/**
 * Lê os transcripts do Claude Code e transforma cada mensagem do assistente
 * num evento de uso.
 *
 * O Claude Code já grava tudo o que o painel precisa, então nada é empurrado
 * pelos seus projetos: nenhum hook, nenhuma chave, nenhuma linha a mais no
 * `.claude/settings.json` deles. O preço é o monitor precisar rodar na mesma
 * máquina que o Claude Code.
 *
 * Layout no disco, verificado:
 *
 *   ~/.claude/projects/<pasta>/
 *     <sessao>.jsonl                        sessão principal
 *     <sessao>/subagents/agent-<id>.jsonl   cada subagente, separado
 *     <sessao>/subagents/agent-<id>.meta.json
 *
 * A corretude vem do `uuid` de cada linha, gravado em `events.source_uuid` sob
 * índice único: reler um arquivo inteiro custa I/O e nada mais. O cursor por
 * arquivo é só otimização.
 */

/** O rótulo do ciclo é o seu prompt, então vem desligado por padrão. */
const RUN_LABELS = process.env.RUN_LABELS === '1';

/** Quantas linhas processar antes de devolver o event loop. */
const LOTE = 500;

export function claudeProjectsDir() {
  return process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');
}

const pausa = () => new Promise((r) => setImmediate(r));

// --- Leitura de arquivo ---------------------------------------------------

/**
 * Lê de `offset` até o último `\n` completo. Trabalha em bytes, não em
 * caracteres: os transcripts são UTF-8 e os prompts têm acento, então contar
 * caracteres daria um offset errado na próxima leitura.
 */
function lerDesde(path, offset, { maxBytes = Infinity } = {}) {
  const { size } = statSync(path);
  if (size <= offset) return { linhas: [], offset, size };

  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size - offset, maxBytes));
    readSync(fd, buf, 0, buf.length, offset);

    const ultimaQuebra = buf.lastIndexOf(0x0a);
    if (ultimaQuebra === -1) return { linhas: [], offset, size };

    const completo = buf.subarray(0, ultimaQuebra + 1);
    return {
      linhas: completo.toString('utf8').split('\n').filter(Boolean),
      offset: offset + completo.length,
      size,
    };
  } finally {
    closeSync(fd);
  }
}

function lerCursor(project, path) {
  return (
    db
      .prepare('SELECT byte_offset, size FROM transcript_cursors WHERE project = ? AND path = ?')
      .get(project, path) ?? { byte_offset: 0, size: 0 }
  );
}

function gravarCursor(project, path, offset, size) {
  db.prepare(
    `INSERT INTO transcript_cursors (project, path, byte_offset, size, mtime, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?)
     ON CONFLICT(project, path) DO UPDATE SET
       byte_offset = excluded.byte_offset,
       size = excluded.size,
       updated_at = excluded.updated_at`,
  ).run(project, path, offset, size, new Date().toISOString());
}

// --- Interpretação --------------------------------------------------------

function parse(linha) {
  try {
    return JSON.parse(linha);
  } catch {
    return null;
  }
}

/**
 * Transforma uma linha de transcript num evento, ou devolve `null` quando a
 * linha não é uso de modelo. Ignorar o que não entende, em vez de quebrar, é
 * o que mantém o importador vivo se o formato mudar.
 */
function eventoDaLinha(linha, { project, agent, operation, runLabel, sidechain }) {
  const j = parse(linha);
  if (!j || j.type !== 'assistant') return null;

  const usage = j.message?.usage;
  const model = j.message?.model;
  if (!usage || !model || !j.uuid) return null;

  // No transcript principal, uma linha marcada como sidechain é trabalho de
  // subagente e chegaria de novo pelo arquivo próprio dele, com o nome certo
  // do agente. No arquivo do subagente, por outro lado, **toda** linha vem
  // marcada assim — é o normal, e descartá-la perderia o uso inteiro dele.
  if (j.isSidechain && sidechain === 'skip') return null;

  return {
    project,
    agent,
    model,
    provider: 'anthropic',
    operation,
    ts: j.timestamp,
    sessionId: j.sessionId,
    sourceUuid: j.uuid,
    usage,
    status: j.message?.stop_reason === 'refusal' ? 'error' : 'ok',
    metadata: {
      runLabel,
      // Só o nome final da pasta: o caminho inteiro é informação demais. O
      // `win32` entende as duas barras, e o `cwd` vem do Windows mesmo
      // quando o monitor roda num container Linux.
      cwd: j.cwd ? win32.basename(j.cwd) : undefined,
      gitBranch: j.gitBranch || undefined,
      requestId: j.requestId,
      thinkingTokens: usage.output_tokens_details?.thinking_tokens,
    },
  };
}

/** O último prompt do usuário antes das respostas, quando os rótulos estão ligados. */
function rotuloDoCiclo(linhas) {
  if (!RUN_LABELS) return undefined;
  for (let i = linhas.length - 1; i >= 0; i -= 1) {
    const j = parse(linhas[i]);
    if (j?.type !== 'user') continue;
    const conteudo = j.message?.content;
    const texto =
      typeof conteudo === 'string'
        ? conteudo
        : Array.isArray(conteudo)
          ? (conteudo.find((b) => b.type === 'text')?.text ?? '')
          : '';
    if (texto) return texto.replace(/\s+/g, ' ').trim().slice(0, 80);
  }
  return undefined;
}

/** O `cwd` real de uma pasta de transcript — o nome da pasta é ambíguo. */
export function cwdDaPasta(dir) {
  for (const arquivo of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    // O `cwd` aparece nas primeiras linhas: ler o arquivo inteiro para achá-lo
    // custaria megabytes por pasta na tela de descoberta.
    const { linhas } = lerDesde(join(dir, arquivo), 0, { maxBytes: 256 * 1024 });
    for (const linha of linhas.slice(0, 40)) {
      const j = parse(linha);
      if (j?.cwd) return j.cwd;
    }
  }
  return null;
}

// --- Agentes declarados ---------------------------------------------------

/**
 * Os nomes dos subagentes definidos em `<projeto>/.claude/agents/`. O `name:`
 * do frontmatter é o que o Claude Code usa como `agentType`; sem ele, vale o
 * nome do arquivo.
 */
export function agentesDeclarados(sourcePath) {
  if (!sourcePath) return [];
  const pasta = join(noDisco(sourcePath), '.claude', 'agents');
  if (!existsSync(pasta)) return [];

  const nomes = new Set();
  for (const arquivo of readdirSync(pasta, { recursive: true })) {
    if (!String(arquivo).endsWith('.md')) continue;
    let texto;
    try {
      texto = readFileSync(join(pasta, arquivo), 'utf8');
    } catch {
      continue;
    }
    const frontmatter = texto.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
    const nome =
      frontmatter.match(/^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m)?.[1] ??
      basename(String(arquivo), '.md');
    if (nome) nomes.add(nome);
  }
  return [...nomes];
}

/**
 * Põe no elenco os agentes que o projeto declara, mesmo os que nunca rodaram.
 * Sem isto um agente só aparece no palco depois de gastar o primeiro token.
 */
export function registrarDeclarados(project) {
  const p = getProject(project);
  if (!p) return [];
  return ensureAgents(project, agentesDeclarados(p.sourcePath));
}

// --- Importação -----------------------------------------------------------

/** Os arquivos de uma pasta: a sessão principal e os subagentes dela. */
function arquivosDe(dir, mainAgent) {
  const alvos = [];

  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);

    if (nome.endsWith('.jsonl')) {
      alvos.push({ path: caminho, agent: mainAgent, operation: null, sidechain: 'skip' });
      continue;
    }

    const subagentes = join(caminho, 'subagents');
    if (!existsSync(subagentes)) continue;

    for (const sub of readdirSync(subagentes).filter((f) => f.endsWith('.jsonl'))) {
      const meta = parse(
        existsSync(join(subagentes, sub.replace(/\.jsonl$/, '.meta.json')))
          ? readFileSync(join(subagentes, sub.replace(/\.jsonl$/, '.meta.json')), 'utf8')
          : '',
      );
      // Agente interno do Claude Code (sugestão de prompt e afins) vem com
      // `agentType` vazio: não é um personagem do time.
      if (!meta?.agentType) continue;
      alvos.push({
        path: join(subagentes, sub),
        agent: meta.agentType,
        operation: meta.description?.slice(0, 120) ?? null,
        sidechain: 'keep',
      });
    }
  }

  return alvos;
}

async function importarArquivo(project, alvo) {
  const cursor = lerCursor(project, alvo.path);
  const { size } = statSync(alvo.path);

  // Arquivo encolheu: compactação reescreveu. Relê do zero — o índice único
  // em `source_uuid` faz a releitura não duplicar nada.
  const inicio = size < cursor.byte_offset ? 0 : cursor.byte_offset;

  const { linhas, offset } = lerDesde(alvo.path, inicio);
  if (linhas.length === 0) return { inserted: 0, skipped: 0, lidas: 0 };

  const runLabel = rotuloDoCiclo(linhas);
  let inserted = 0;
  let skipped = 0;

  for (let i = 0; i < linhas.length; i += LOTE) {
    const fatia = linhas.slice(i, i + LOTE);
    const eventos = [];

    for (const linha of fatia) {
      const bruto = eventoDaLinha(linha, { project, ...alvo, runLabel });
      if (!bruto) continue;
      try {
        eventos.push(normalizeEvent(bruto).event);
      } catch (err) {
        console.warn(`[transcript] linha ignorada: ${err.message}`);
      }
    }

    if (eventos.length) {
      const r = ingest(eventos, { ignoreDuplicates: true });
      inserted += r.inserted;
      skipped += r.skipped;
    }
    // Uma pasta grande não pode travar a API enquanto é lida.
    await pausa();
  }

  gravarCursor(project, alvo.path, offset, size);
  return { inserted, skipped, lidas: linhas.length };
}

/** Importa uma pasta de transcript inteira para um projeto. */
export async function importarPasta(project, origem) {
  const dir = noDisco(origem);
  if (!existsSync(dir)) return { inserted: 0, skipped: 0, arquivos: 0 };

  const p = getProject(project);
  const mainAgent = p?.mainAgent ?? 'orquestrador';

  let inserted = 0;
  let skipped = 0;
  const alvos = arquivosDe(dir, mainAgent);

  for (const alvo of alvos) {
    try {
      const r = await importarArquivo(project, alvo);
      inserted += r.inserted;
      skipped += r.skipped;
    } catch (err) {
      console.warn(`[transcript] ${alvo.path}: ${err.message}`);
    }
  }

  return { inserted, skipped, arquivos: alvos.length };
}

/** Importa tudo que está ligado a um projeto. */
export async function importarProjeto(project) {
  const p = getProject(project);
  if (!p) throw new Error(`projeto não encontrado: ${project}`);

  let inserted = 0;
  let skipped = 0;
  for (const dir of p.sources) {
    const r = await importarPasta(project, dir);
    inserted += r.inserted;
    skipped += r.skipped;
  }
  // Depois da importação: assim só sobram como novos os que nunca rodaram.
  const declarados = registrarDeclarados(project);
  return { project, inserted, skipped, sources: p.sources.length, declarados };
}

/**
 * Varre tudo na subida. É isto que recupera o período em que o monitor esteve
 * desligado, sem fila nem arquivo de reserva: o transcript é a fonte.
 */
export async function importarTudo() {
  const resultados = [];
  const fontes = listSources();
  for (const project of new Set(fontes.map((f) => f.project))) {
    try {
      registrarDeclarados(project);
    } catch (err) {
      console.warn(`[transcript] agentes de ${project}: ${err.message}`);
    }
  }
  for (const { project, dir } of fontes) {
    try {
      const r = await importarPasta(project, dir);
      resultados.push({ project, dir, ...r });
    } catch (err) {
      console.warn(`[transcript] ${dir}: ${err.message}`);
    }
  }
  return resultados;
}

// --- Descoberta -----------------------------------------------------------

/** As pastas candidatas, com o que dá para saber sem importar nada. */
export function descobrir() {
  const raiz = claudeProjectsDir();
  if (!existsSync(raiz)) return { root: raiz, candidates: [] };

  // A pasta pode estar gravada com o caminho do Windows e ser vista aqui com
  // o do container: compara as duas pelo mesmo `noDisco`.
  const donos = new Map(listSources().map((s) => [noDisco(s.dir), s.project]));

  const candidates = [];
  for (const nome of readdirSync(raiz)) {
    const dir = join(raiz, nome);
    let sessoes = 0;
    try {
      if (!statSync(dir).isDirectory()) continue;
      sessoes = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).length;
    } catch {
      continue;
    }
    if (sessoes === 0) continue;

    let cwd = null;
    try {
      cwd = cwdDaPasta(dir);
    } catch {
      // Pasta ilegível: ainda assim vale listar, só sem o caminho.
    }

    candidates.push({
      dir,
      folder: nome,
      cwd,
      // O nome da pasta é ambíguo, então o agrupamento usa o `cwd` lido.
      key: cwd ? cwd.toLowerCase().replace(/[\\/]+$/, '') : nome.toLowerCase(),
      sessions: sessoes,
      project: donos.get(dir) ?? projectForSource(dir),
    });
  }

  return { root: raiz, candidates: candidates.sort((a, b) => b.sessions - a.sessions) };
}
