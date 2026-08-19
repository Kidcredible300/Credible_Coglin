/**
 * Outbound mail (COG-041, invite slice).
 *
 * One rule governs this file: the recipient address is a parameter and never
 * becomes state. It arrives from the coach's form, goes out over the wire, and
 * goes out of scope. It is not returned, not stored, and not logged — including
 * in the error path, which is the easy place to leak it by reflex. See the
 * header of `migrations/0002_invites.sql` for why.
 *
 * Transport is **Resend**, not Cloudflare Email Sending. lilithforge.com has
 * been sending transactional mail through Resend since the Inkubus work —
 * `resend._domainkey.lilithforge.com` is live, and website/docs/EMAIL-RUNBOOK.md
 * documents the split deliberately: Zoho owns the human mailbox at admin@, and
 * Resend owns app mail, coexisting on separate DKIM selectors. Email Sending
 * would have meant onboarding a new sending domain and a Workers Paid plan to
 * obtain a capability this domain already has.
 *
 * The API key is shared with Inkubus. Worth knowing when it is next rotated:
 * rolling it for an Inkubus incident stops Coglin invites at the same moment.
 */
import type { Bindings } from '../types';

const ENDPOINT = 'https://api.resend.com/emails';

/**
 * Resend takes `Name <address>` in one string. Sending as admin@ rather than a
 * no-reply has a real benefit here: replies land in the Zoho mailbox, so a
 * parent who hits Reply on their child's invite reaches a person.
 */
const FROM = 'Coglin <admin@lilithforge.com>';

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
  <body style="margin:0;padding:24px;background:#f4f7f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#16201a;">
    <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;">
      <p style="margin:0 0 16px;font-size:18px;line-height:1.5;">
        <strong>${escapeHtml(mail.inviterName)}</strong> has invited you to join
        <strong>${escapeHtml(team)}</strong> on Coglin.
      </p>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#4e5a52;">
        Coglin is where the team keeps its boards, roster, and outreach log for
        the season. Open the link below to choose your username and password.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${safeUrl}" style="display:inline-block;background:#4fce74;color:#05190d;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;">
          Set up your account
        </a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#6f7a72;">
        Or paste this into your browser:<br />
        <span style="word-break:break-all;">${safeUrl}</span>
      </p>
      <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#6f7a72;">
        The link works once and expires in ${mail.expiresInDays} days. If you
        weren't expecting this, you can ignore this email.
      </p>
      <p style="margin:24px 0 0;font-size:12px;color:#9aa39c;">
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
  // No key configured is a normal state in local dev, not an error. The invite
  // still exists and the dialog still shows a working link.
  if (!env.RESEND_API_KEY) return false;

  const { subject, html, text } = render(mail);

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to: [mail.to], subject, html, text }),
    });

    // fetch does not throw on 4xx/5xx. Without this check every send would
    // report success, including a rejected address or a revoked key — and the
    // coach would be told the mail is on its way when nothing was sent.
    if (!response.ok) {
      // Status only. Resend's error bodies quote the recipient back, and a log
      // line is exactly the durable place this address must never reach.
      console.error(`invite email rejected by Resend: HTTP ${response.status}`);
      return false;
    }
    return true;
  } catch (err) {
    // Network-level failure. Same rule — the failure class, never the address.
    console.error(
      'invite email send failed:',
      err instanceof Error ? err.name : 'unknown',
    );
    return false;
  }
}
