/**
 * Conecta um projeto seu ao monitor.
 *
 *   npm run connect                          lista o que dá para conectar
 *   npm run connect -- --dir "<pasta>"       conecta aquela pasta de transcript
 *   npm run connect -- --nome din-din        casa pelo nome do projeto
 *   npm run connect -- --todos               conecta tudo que ainda não está
 *   npm run connect -- --nome din-din --agente orquestrador --id dindin
 *
 * Não escreve nada dentro do seu projeto: o monitor lê os transcripts que o
 * Claude Code já grava em ~/.claude/projects. Nenhum hook, nenhuma chave,
 * nenhuma linha a mais no `.claude/settings.json` de lá.
 *
 * Fala direto com o banco, então funciona com o servidor no ar ou parado. Com
 * o servidor no ar, o `PRAGMA busy_timeout` do `db.js` cobre o encontro dos
 * dois no mesmo arquivo.
 */

// `win32` entende as duas barras: o `cwd` vem do Windows mesmo dentro do container.
import { win32 } from 'node:path';

const { basename } = win32;

import { descobrir, importarProjeto } from '../server/src/transcripts.js';
import {
  upsertProject,
  addSource,
  getProject,
  slugify,
  listProjects,
} from '../server/src/projects.js';

function arg(nome) {
  const i = process.argv.indexOf(`--${nome}`);
  return i === -1 ? null : process.argv[i + 1];
}
const flag = (nome) => process.argv.includes(`--${nome}`);

const fmt = (n) => Number(n).toLocaleString('pt-BR');

const { root, candidates } = descobrir();

if (candidates.length === 0) {
  console.error(`nenhuma pasta de transcript em ${root}`);
  console.error('use o Claude Code num projeto pelo menos uma vez e rode de novo.');
  process.exit(1);
}

// --- Sem argumento: mostra o que existe ----------------------------------

if (!arg('dir') && !arg('nome') && !flag('todos')) {
  console.log(`pastas em ${root}:\n`);
  for (const c of candidates) {
    const onde = c.cwd ?? `(sem cwd) ${c.folder}`;
    const estado = c.project ? `já conectado a "${c.project}"` : 'livre';
    console.log(`  ${String(c.sessions).padStart(3)} sessões  ${onde}`);
    console.log(`              ${estado}`);
  }
  console.log('\npara conectar:');
  console.log('  npm run connect -- --nome <parte-do-caminho>');
  console.log('  npm run connect -- --todos');
  process.exit(0);
}

// --- Escolher as pastas ---------------------------------------------------

let alvos;

if (flag('todos')) {
  alvos = candidates.filter((c) => !c.project);
  if (alvos.length === 0) {
    console.log('tudo já está conectado.');
    process.exit(0);
  }
} else if (arg('dir')) {
  const dir = arg('dir');
  alvos = candidates.filter((c) => c.dir === dir);
  if (alvos.length === 0) {
    console.error(`pasta não encontrada entre os candidatos: ${dir}`);
    process.exit(1);
  }
} else {
  const termo = arg('nome').toLowerCase();
  alvos = candidates.filter(
    (c) => (c.cwd ?? c.folder).toLowerCase().includes(termo),
  );
  if (alvos.length === 0) {
    console.error(`nada casou com "${termo}". Rode sem argumento para ver a lista.`);
    process.exit(1);
  }
}

// Pastas diferentes com o mesmo `cwd` são o mesmo projeto — o Claude Code
// pode criar mais de uma pasta para o mesmo caminho.
const porProjeto = new Map();
for (const c of alvos) {
  const nome = c.cwd ? basename(c.cwd) : c.folder;
  const id = arg('id') ?? slugify(nome);
  if (!porProjeto.has(id)) porProjeto.set(id, { id, nome, pastas: [] });
  porProjeto.get(id).pastas.push(c);
}

if (arg('id') && porProjeto.size > 1) {
  console.error('--id serve para um projeto só, mas o filtro casou com vários:');
  for (const g of porProjeto.values()) console.error(`  ${g.nome}`);
  process.exit(1);
}

// --- Conectar e importar --------------------------------------------------

for (const grupo of porProjeto.values()) {
  const jaExistia = Boolean(getProject(grupo.id));

  upsertProject({
    id: grupo.id,
    name: grupo.nome,
    sourcePath: grupo.pastas.find((p) => p.cwd)?.cwd ?? null,
    mainAgent: arg('agente') ?? undefined,
  });

  for (const pasta of grupo.pastas) addSource(grupo.id, pasta.dir);

  console.log(`\n${jaExistia ? 'atualizando' : 'conectando'} "${grupo.nome}" (${grupo.id})`);
  for (const pasta of grupo.pastas) console.log(`  lendo ${pasta.dir}`);

  const inicio = Date.now();
  const r = await importarProjeto(grupo.id);
  const segundos = ((Date.now() - inicio) / 1000).toFixed(1);

  console.log(
    `  ${fmt(r.inserted)} eventos novos, ${fmt(r.skipped)} já conhecidos, em ${segundos}s`,
  );
  if (r.declarados.length) {
    console.log(`  do .claude/agents, ainda sem uso: ${r.declarados.join(', ')}`);
  }
  console.log(`  painel: http://localhost:4000/?project=${encodeURIComponent(grupo.id)}`);
}

console.log(`\nprojetos: ${listProjects().map((p) => p.id).join(', ')}`);
console.log('o servidor relê sozinho ao subir; `npm run import` relê agora.');
