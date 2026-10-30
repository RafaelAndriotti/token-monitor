/**
 * Gera o relatório da última semana fechada sem esperar o agendador.
 *
 *   node scripts/report.js --html > relatorio.html   # só imprime, não envia
 *   node scripts/report.js --text                    # resumo no terminal
 *   node scripts/report.js --send                    # envia por e-mail
 *
 * `--send` usa as mesmas variáveis do servidor (REPORT_TO + SMTP_*). Com
 * MAIL_DRY_RUN=1 a mensagem é montada e impressa, sem sair da máquina.
 */

import { buildWeeklyReport, renderHtml, renderText, subjectFor } from '../server/src/report.js';
import { sendWeeklyReport } from '../server/src/mailer.js';

const modo = process.argv[2] ?? '--text';

if (modo === '--send') {
  const resultado = await sendWeeklyReport();
  if (!resultado.sent) {
    console.error(`não enviado: ${resultado.reason}`);
    process.exit(1);
  }
  console.log(
    `${resultado.dryRun ? '[dry run] ' : ''}enviado para ${resultado.to.join(', ')}: ${
      resultado.subject
    }`,
  );
} else {
  const report = buildWeeklyReport();
  if (modo === '--html') {
    console.log(renderHtml(report));
  } else {
    console.log(subjectFor(report));
    console.log();
    console.log(renderText(report));
  }
}
