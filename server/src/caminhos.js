/**
 * Tradução de caminhos do host para o disco que este processo enxerga.
 *
 * Os transcripts trazem caminhos do Windows (`C:\dev\projeto`), e o banco
 * guarda o que o `connect` viu. Rodando num container, esses caminhos não
 * existem: as pastas estão montadas em outro lugar. `PATH_MAP` diz onde:
 *
 *   PATH_MAP="C:\Users\eu\.claude\projects=/claude/projects;C:\dev=/host/dev"
 *
 * Sem `PATH_MAP`, nada muda — é o caso de rodar direto no Windows.
 */

const barra = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '');

const MAPA = (process.env.PATH_MAP ?? '')
  .split(';')
  .map((par) => par.split('='))
  .filter(([de, para]) => de?.trim() && para?.trim())
  .map(([de, para]) => [barra(de.trim()).toLowerCase(), barra(para.trim())])
  // O prefixo mais longo ganha: `C:\dev\x` antes de `C:\dev`.
  .sort((a, b) => b[0].length - a[0].length);

/** O caminho como este processo deve abri-lo. */
export function noDisco(caminho) {
  if (!caminho || MAPA.length === 0) return caminho;
  const p = barra(caminho);
  const chave = p.toLowerCase();
  for (const [de, para] of MAPA) {
    if (chave === de || chave.startsWith(`${de}/`)) return para + p.slice(de.length);
  }
  return caminho;
}
