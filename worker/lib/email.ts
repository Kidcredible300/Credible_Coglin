/**
 * Outbound mail (COG-041, invite slice).
 *
 * One rule governs this file: the recipient address is a parameter and never
 * becomes state. It arrives from the coach's form, goes into `EMAIL.send()`,
 * and goes out of scope. It is not returned, not stored, and not logged —
 * including in the error path, which is the easy place to leak it by reflex.
 * See the header of `migrations/0002_invites.sql` for why.
 */
import type { Bindings } from '../types';

const FROM = { email: 'admin@lilithforge.com', name: 'Coglin' };

export interface InviteMail {
  /** Recipient. Transient — see the file header. */
  to: string;
  inviterName: string;
  teamNumber: number;
  teamName: string;
  displayName: string;
  url: string;
  expiresInDays: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Deliberately plain. This mail lands in the inbox of a 14-year-old and, often,
 * their parent, and it asks them to click a link and set a password — which is
 * the exact shape of a phishing email. Naming the inviter, the team, and the
 * expiry, with no images or tracking pixels and one obvious link, is what makes
 * it read as legitimate.
 */
function render(mail: InviteMail): { subject: string; html: string; text: string } {
  const team = `${mail.teamNumber} ${mail.teamName}`;
  const subject = `${mail.inviterName} has invited you to join ${team}`;
  const safeUrl = escapeHtml(mail.url);

  const text = [
    `${mail.inviterName} has invited you to join ${team} on Coglin.`,
    '',
    'Coglin is where the team keeps its boards, roster, and outreach log for the season.',
    '',
    `Open this link to choose your username and password:`,
    mail.url,
    '',
    `The link works once and expires in ${mail.expiresInDays} days.`,
    '',
    "If you weren't expecting this, you can ignore this email.",
    '',
    'Coglin is not affiliated with or endorsed by FIRST®.',
  ].join('\n');

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f6f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1c1b1a;">
    <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;">
      <p style="margin:0 0 16px;font-size:18px;line-height:1.5;">
        <strong>${escapeHtml(mail.inviterName)}</strong> has invited you to join
        <strong>${escapeHtml(team)}</strong> on Coglin.
      </p>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#57534e;">
        Coglin is where the team keeps its boards, roster, and outreach log for
        the season. Open the link below to choose your username and password.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${safeUrl}" style="display:inline-block;background:#1c1b1a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;">
          Set up your account
        </a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#78716c;">
        Or paste this into your browser:<br />
        <span style="word-break:break-all;">${safeUrl}</span>
      </p>
      <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#78716c;">
        The link works once and expires in ${mail.expiresInDays} days. If you
        weren't expecting this, you can ignore this email.
      </p>
      <p style="margin:24px 0 0;font-size:12px;color:#a8a29e;">
        Coglin is not affiliated with or endorsed by FIRST®.
      </p>
    </div>
  </body>
</html>`;

  return { subject, html, text };
}

/**
 * Returns whether the send succeeded rather than throwing, because the invite
 * row is already committed by this point and the coach still has the copyable
 * link. A failed send is a degraded result, not a failed operation.
 */
export async function sendInvite(
  env: Bindings,
  mail: InviteMail,
): Promise<boolean> {
  const { subject, html, text } = render(mail);
  try {
    await env.EMAIL.send({ to: mail.to, from: FROM, subject, html, text });
    return true;
  } catch (err) {
    // Log the failure class only. The recipient must not reach the log, and
    // provider errors quote the address back, so the message is not safe to
    // print verbatim.
    console.error(
      'invite email send failed:',
      err instanceof Error ? err.name : 'unknown',
    );
    return false;
  }
}
