import nodemailer from 'nodemailer';
import { buildWeeklyReport, renderHtml, renderText, subjectFor } from './report.js';

/**
 * Envio do relatório por e-mail.
 *
 * Configure um servidor SMTP com `SMTP_URL`
 * (`smtps://usuario:senha@smtp.exemplo.com:465`) ou com as variáveis separadas.
 * Sem destinatário em `REPORT_TO`, nada é enviado.
 *
 * `MAIL_DRY_RUN=1` monta a mensagem e devolve o conteúdo sem abrir conexão —
 * use para conferir o relatório antes de apontar para o SMTP de verdade.
 */

const TO = (process.env.REPORT_TO ?? '')
  .split(',')
  .map((e) => e.trim())
  .filter(Boolean);

const FROM = process.env.REPORT_FROM ?? 'Token Monitor <token-monitor@localhost>';
const DRY_RUN = process.env.MAIL_DRY_RUN === '1';

function buildTransport() {
  // jsonTransport não abre conexão: devolve a mensagem montada.
  if (DRY_RUN) return nodemailer.createTransport({ jsonTransport: true });

  if (process.env.SMTP_URL) return nodemailer.createTransport(process.env.SMTP_URL);

  if (!process.env.SMTP_HOST) return null;

  const port = Number(process.env.SMTP_PORT ?? 587);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}

export function mailConfigured() {
  return TO.length > 0 && (DRY_RUN || Boolean(process.env.SMTP_URL || process.env.SMTP_HOST));
}

export function recipients() {
  return TO;
}

/**
 * Monta e envia o relatório da última semana fechada. Devolve o que foi feito,
 * para quem chamou poder logar ou responder na API.
 */
export async function sendWeeklyReport({ now = new Date(), to = TO } = {}) {
  if (to.length === 0) {
    return { sent: false, reason: 'REPORT_TO não configurado' };
  }

  const transport = buildTransport();
  if (!transport) {
    return { sent: false, reason: 'SMTP não configurado (SMTP_URL ou SMTP_HOST)' };
  }

  const report = buildWeeklyReport({ project, now });
  const info = await transport.sendMail({
    from: FROM,
    to: to.join(', '),
    subject: subjectFor(report),
    text: renderText(report),
    html: renderHtml(report),
  });

  return {
    sent: true,
    dryRun: DRY_RUN,
    to,
    subject: subjectFor(report),
    messageId: info.messageId,
    period: report.period,
    totalTokens: report.totals.totalTokens,
  };
}
