/**
 * Relê os transcripts de todos os projetos conectados agora.
 *
 *   npm run import
 *
 * O servidor já faz isto ao subir; isto aqui serve para puxar o que acabou de
 * acontecer sem reiniciar nada. Reler é sempre seguro: cada mensagem vira um
 * evento só, por mais vezes que o arquivo passe por aqui.
 */

import { importarTudo } from '../server/src/transcripts.js';

const fmt = (n) => Number(n).toLocaleString('pt-BR');
const resultados = await importarTudo();

if (resultados.length === 0) {
  console.log('nenhum projeto conectado. Rode `npm run connect`.');
  process.exit(0);
}

let total = 0;
for (const r of resultados) {
  total += r.inserted;
  console.log(`${r.project}: ${fmt(r.inserted)} novos, ${fmt(r.skipped)} já conhecidos`);
}
console.log(`\n${fmt(total)} eventos novos no total`);
