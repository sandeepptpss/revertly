/**
 * Support Ticket Email Notification Service
 * Sends transactional email notifications to admin via Resend API.
 */

const RESEND_API_URL = "https://api.resend.com/emails";

/**
 * Escapes HTML characters to prevent XSS in email templates.
 */
function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Dispatches an email notification to the administrator when a merchant submits a support ticket.
 *
 * @param {Object} params
 * @param {Object} params.ticket - The newly created SupportTicket Prisma record
 * @param {string} params.shop - The merchant's myshopify domain
 * @param {string} [params.merchantEmail] - The merchant's contact/reply-to email
 * @param {string} [params.planTier] - The merchant's current subscription plan
 * @returns {Promise<{ success: boolean, id?: string, error?: string }>}
 */
export async function sendSupportTicketAdminEmail({ ticket, shop, merchantEmail, planTier = "Free" }) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  const adminEmail = process.env.ADMIN_ALERT_EMAIL;

  if (!apiKey) {
    console.error("[SupportEmail] RESEND_API_KEY is not configured in .env.");
    return { success: false, error: "RESEND_API_KEY is missing from environment variables." };
  }

  if (!fromEmail || !adminEmail) {
    console.error("[SupportEmail] RESEND_FROM_EMAIL or ADMIN_ALERT_EMAIL is not configured in .env.");
    return { success: false, error: "Email configuration is incomplete in .env." };
  }

  const priority = (ticket.priority || "NORMAL").toUpperCase();
  const priorityColor = priority === "URGENT" ? "#dc2626" : priority === "HIGH" ? "#ea580c" : "#2563eb";
  const priorityBg = priority === "URGENT" ? "#fee2e2" : priority === "HIGH" ? "#ffedd5" : "#dbeafe";

  const safeSubject = escapeHtml(ticket.subject);
  const safeCategory = escapeHtml(ticket.category || "General");
  const safeMessage = escapeHtml(ticket.message || "").replace(/\n/g, "<br/>");
  const safeEmail = escapeHtml(merchantEmail || "Not provided");
  const safePlan = escapeHtml(planTier);
  const ticketId = ticket.id;

  const emailSubject = `[Revertly Support #${ticketId}] [${priority}] ${ticket.subject} — ${shop}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${emailSubject}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #1e293b;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
    
    <!-- Header Banner -->
    <div style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); padding: 24px; color: #ffffff;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
        <span style="font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #38bdf8;">Revertly Support Desk</span>
        <span style="display: inline-block; background-color: ${priorityBg}; color: ${priorityColor}; font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 9999px; text-transform: uppercase; letter-spacing: 0.05em;">
          ${priority} Priority
        </span>
      </div>
      <h1 style="margin: 0; font-size: 20px; font-weight: 700; line-height: 1.3; color: #ffffff;">
        New Support Ticket #${ticketId}
      </h1>
      <p style="margin: 6px 0 0 0; font-size: 14px; color: #94a3b8;">
        Submitted by <strong>${shop}</strong>
      </p>
    </div>

    <!-- Ticket Metadata Grid -->
    <div style="padding: 20px 24px; background-color: #f1f5f9; border-bottom: 1px solid #e2e8f0;">
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <tr>
          <td style="padding: 6px 0; color: #64748b; width: 35%;"><strong>Category:</strong></td>
          <td style="padding: 6px 0; color: #0f172a; font-weight: 600;">${safeCategory}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b;"><strong>Merchant Email:</strong></td>
          <td style="padding: 6px 0; color: #0f172a;">
            ${merchantEmail ? `<a href="mailto:${safeEmail}" style="color: #0284c7; text-decoration: none; font-weight: 600;">${safeEmail}</a>` : '<span style="color: #94a3b8;">Not provided</span>'}
          </td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b;"><strong>Shop Domain:</strong></td>
          <td style="padding: 6px 0; color: #0f172a;">
            <a href="https://${shop}/admin" target="_blank" style="color: #0284c7; text-decoration: none;">${shop}</a>
          </td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b;"><strong>Store Plan:</strong></td>
          <td style="padding: 6px 0; color: #0f172a; font-weight: 600;">${safePlan}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b;"><strong>Submitted At:</strong></td>
          <td style="padding: 6px 0; color: #0f172a;">${new Date().toUTCString()}</td>
        </tr>
      </table>
    </div>

    <!-- Ticket Content -->
    <div style="padding: 24px;">
      <h2 style="font-size: 16px; margin: 0 0 12px 0; color: #0f172a; font-weight: 700;">
        Subject: ${safeSubject}
      </h2>
      <div style="background-color: #f8fafc; border-left: 4px solid #0284c7; padding: 16px; border-radius: 4px; font-size: 14px; line-height: 1.6; color: #334155;">
        ${safeMessage}
      </div>

      <!-- Quick Action CTA -->
      ${merchantEmail ? `
      <div style="margin-top: 24px; padding-top: 20px; border-top: 1px solid #e2e8f0; text-align: center;">
        <a href="mailto:${safeEmail}?subject=${encodeURIComponent(`Re: [Revertly Support #${ticketId}] ${ticket.subject}`)}" 
           style="display: inline-block; background-color: #059669; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-size: 14px; font-weight: 600; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          ✉️ Reply Directly to Merchant (${safeEmail})
        </a>
        <p style="margin: 8px 0 0 0; font-size: 12px; color: #94a3b8;">
          You can also simply hit "Reply" to this email in your email client.
        </p>
      </div>
      ` : ""}
    </div>

    <!-- Footer -->
    <div style="padding: 16px 24px; background-color: #f8fafc; border-top: 1px solid #e2e8f0; text-align: center; font-size: 12px; color: #94a3b8;">
      Revertly Catalog Health &amp; Store Protection Support Engine &bull; Automated Admin Notification
    </div>

  </div>
</body>
</html>
  `.trim();

  const payload = {
    from: fromEmail,
    to: [adminEmail],
    subject: emailSubject,
    html,
  };

  if (merchantEmail && merchantEmail.includes("@")) {
    payload.reply_to = merchantEmail;
  }

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[SupportEmail] Resend API error (${res.status}): ${errorText}`);
      return { success: false, error: `Resend error: ${errorText}` };
    }

    const data = await res.json();
    console.log(`[SupportEmail] Ticket #${ticketId} admin notification sent to ${adminEmail}, Resend ID: ${data.id}`);
    return { success: true, id: data.id };
  } catch (err) {
    console.error("[SupportEmail] Exception sending email via Resend:", err);
    return { success: false, error: err.message };
  }
}
