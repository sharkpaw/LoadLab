import nodemailer from 'nodemailer';
import { config } from './config.js';

const smtp = config.smtp;
export const mailEnabled = Boolean(smtp.host);

const transport = mailEnabled
  ? nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    })
  : null;

/** Logs whether mail works; never fatal. */
export async function verifyMail() {
  if (!transport) {
    console.log('[mail] SMTP not configured: password-reset links will be printed to this log.');
    return;
  }
  try {
    await transport.verify();
    console.log(`[mail] SMTP ready (${smtp.host}:${smtp.port})`);
  } catch (err) {
    console.error(`[mail] SMTP check failed (${smtp.host}:${smtp.port}): ${(err as Error).message}`);
  }
}

interface Mail {
  to: string;
  subject: string;
  text: string;
  /** Printed to the log instead when SMTP is not configured (e.g. the reset link). */
  logFallback?: string;
}

/** Sends a mail, or prints `logFallback` to the API log when SMTP is not configured. Returns true if sent. */
export async function sendMail(mail: Mail): Promise<boolean> {
  if (!transport) {
    if (mail.logFallback) {
      const line = '─'.repeat(72);
      console.log(`\n${line}\n[mail] SMTP not configured — ${mail.subject} for ${mail.to}\n${mail.logFallback}\n${line}\n`);
    }
    return false;
  }
  try {
    await transport.sendMail({ from: smtp.from, to: mail.to, subject: mail.subject, text: mail.text });
    return true;
  } catch (err) {
    console.error(`[mail] could not send "${mail.subject}" to ${mail.to}: ${(err as Error).message}`);
    if (mail.logFallback) console.log(`[mail] fallback for ${mail.to}: ${mail.logFallback}`);
    return false;
  }
}

export function passwordResetMail(to: string, url: string, minutes: number): Mail {
  return {
    to,
    subject: 'Reset your LoadLab password',
    text: [
      'Someone asked to reset the password of your LoadLab account.',
      `Open this link within ${minutes} minutes to choose a new password:`,
      '',
      url,
      '',
      'If this was not you, ignore this email; your password stays the same.',
      '',
      '—',
      'LoadLab hesabınız için şifre sıfırlama istendi.',
      `Yeni şifre belirlemek için bağlantıyı ${minutes} dakika içinde açın. Siz istemediyseniz bu e-postayı yok sayın.`,
    ].join('\n'),
    logFallback: `Password reset link (valid ${minutes} min): ${url}`,
  };
}

export function passwordChangedMail(to: string): Mail {
  return {
    to,
    subject: 'Your LoadLab password was changed',
    text: [
      'The password of your LoadLab account was just reset and all sessions were signed out.',
      'If this was not you, contact your LoadLab administrator immediately.',
      '',
      '—',
      'LoadLab hesabınızın şifresi sıfırlandı ve tüm oturumlar kapatıldı. Bu işlemi siz yapmadıysanız hemen yöneticinize haber verin.',
    ].join('\n'),
  };
}
