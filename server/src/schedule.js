import { mailConfigured, sendWeeklyReport, recipients } from './mailer.js';

/**
 * Agendador do relatório semanal. Sem dependência de cron: calcula quanto falta
 * para o próximo horário e dorme até lá, reagendando depois de cada envio.
 *
 * `REPORT_DAY` usa a convenção do `getUTCDay` (0 = domingo, 1 = segunda) e
 * `REPORT_HOUR` é a hora em UTC. O padrão é segunda-feira às 9h UTC, logo depois
 * de a semana fechar.
 */

const DAY = Number(process.env.REPORT_DAY ?? 1);
const HOUR = Number(process.env.REPORT_HOUR ?? 9);

export function nextRun(now = new Date()) {
  const next = new Date(now);
  next.setUTCHours(HOUR, 0, 0, 0);

  let adiar = (DAY - next.getUTCDay() + 7) % 7;
  // Se é o dia certo mas o horário já passou, vai para a semana que vem.
  if (adiar === 0 && next <= now) adiar = 7;
  next.setUTCDate(next.getUTCDate() + adiar);

  return next;
}

export function startReportSchedule() {
  if (!mailConfigured()) {
    return { scheduled: false, reason: 'e-mail não configurado (REPORT_TO + SMTP)' };
  }

  const alvo = nextRun();

  function agendar(quando) {
    const espera = quando.getTime() - Date.now();
    const timer = setTimeout(async () => {
      try {
        const resultado = await sendWeeklyReport();
        console.log(
          resultado.sent
            ? `[relatório] enviado para ${resultado.to.join(', ')}`
            : `[relatório] não enviado: ${resultado.reason}`,
        );
      } catch (err) {
        console.warn(`[relatório] falhou: ${err.message}`);
      }
      agendar(nextRun());
    }, espera);

    // Um relatório pendente não deve segurar o processo no ar sozinho.
    timer.unref?.();
  }

  agendar(alvo);
  return { scheduled: true, nextRun: alvo.toISOString(), to: recipients() };
}
