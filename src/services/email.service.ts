import { logger } from "../lib/logger";

async function getResend() {
  const key = process.env["RESEND_API_KEY"];
  if (!key) return null;
  const { Resend } = await import("resend");
  return new Resend(key);
}

export async function sendOtpEmail(email: string, code: string): Promise<void> {
  const resend = await getResend();
  if (!resend) {
    logger.warn({ email, code }, "RESEND_API_KEY not set — OTP logged only");
    return;
  }
  try {
    await resend.emails.send({
      from: "OXIER <noreply@oxier.com>",
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
  } catch (err) {
    logger.error({ err }, "Failed to send OTP email");
  }
}

export async function sendRejectionEmail(
  email: string,
  reason: string,
  txId: string
): Promise<void> {
  const resend = await getResend();
  if (!resend) return;
  try {
    await resend.emails.send({
      from: "OXIER <noreply@oxier.com>",
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
  } catch (err) {
    logger.error({ err }, "Failed to send rejection email");
  }
}
