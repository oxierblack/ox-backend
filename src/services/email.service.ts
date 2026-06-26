import { logger } from "../lib/logger";

const MAILERSEND_API_URL = "https://api.mailersend.com/v1/email";

// MailerSend trial accounts can only send FROM the trial subdomain they
// were issued (the "from" address below) — sending from a regular Gmail
// address as the "from" will be rejected by MailerSend.
// Once a real domain is verified on MailerSend, update FROM_EMAIL.
const FROM_EMAIL = process.env["MAILERSEND_FROM_EMAIL"] || "noreply@test-ywj2lpn007jg7oqz.mlsender.net";
const FROM_NAME = "OXIER";

async function sendViaMailerSend(params: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const apiKey = process.env["MAILERSEND_API_KEY"];
  if (!apiKey) {
    logger.warn({ to: params.to }, "MAILERSEND_API_KEY not set — email not sent");
    return;
  }

  try {
    const res = await fetch(MAILERSEND_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: { email: FROM_EMAIL, name: FROM_NAME },
        to: [{ email: params.to }],
        subject: params.subject,
        html: params.html,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error({ status: res.status, body }, "MailerSend API returned an error");
    }
  } catch (err) {
    logger.error({ err }, "Failed to send email via MailerSend");
  }
}

export async function sendOtpEmail(email: string, code: string): Promise<void> {
  await sendViaMailerSend({
    to: email,
    subject: "Your OXIER Verification Code",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#1a1a2e">OXIER Verification</h2>
        <p>Your verification code is:</p>
        <h1 style="letter-spacing:8px;color:#e94560;font-size:40px">${code}</h1>
        <p style="color:#666">Valid for 10 minutes. Do not share this code.</p>
      </div>
    `,
  });
}

export async function sendRejectionEmail(
  email: string,
  reason: string,
  txId: string
): Promise<void> {
  await sendViaMailerSend({
    to: email,
    subject: "Transaction Update — OXIER",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#1a1a2e">Transaction ${txId}</h2>
        <p>Your transaction has been <strong style="color:#e94560">rejected</strong>.</p>
        <p><strong>Reason:</strong> ${reason}</p>
        <p>Please contact support if you have questions.</p>
      </div>
    `,
  });
}
