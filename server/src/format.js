/** Formatação de tokens compartilhada entre log, webhook e e-mail. */

const BR = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

/** 1234 → "1,2 mil"; 2_400_000 → "2,4 mi". Abaixo de mil, o número inteiro. */
export function tokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${BR.format(v / 1_000_000)} mi`;
  if (v >= 1_000) return `${BR.format(v / 1_000)} mil`;
  return BR.format(v);
}

/** O número cheio, com separador de milhar. Para tabelas e tooltips. */
export function tokensFull(n) {
  return new Intl.NumberFormat('pt-BR').format(Math.round(Number(n) || 0));
}
