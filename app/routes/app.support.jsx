import { useState } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";

const HELP_ARTICLES = [
  {
    title: "How do I take an initial product snapshot?",
    body: "Go to the Initialize page from the navigation. Click 'Initialize Monitoring' to take a full snapshot of all your current products. This establishes a clean baseline before monitoring begins.",
    category: "Getting Started",
  },
  {
    title: "Why wasn't a change detected?",
    body: "Make sure monitoring is enabled in Settings. The app detects product changes via real-time Shopify webhooks after the baseline snapshot is initialized.",
    category: "Monitoring",
  },
  {
    title: "What does an atomic rollback actually do?",
    body: "A rollback restores only the specific fields that were modified — not the entire product. For example, rolling back a price drop restores the previous price while leaving newer photos, descriptions, and tags intact.",
    category: "Rollback",
  },
  {
    title: "How do I set up custom detection rules?",
    body: "Go to Rules in the top navigation. Click '+ Create New Rule' to select the field (e.g. price), condition (e.g. DECREASE_BY_PERCENT), and threshold (e.g. 30%).",
    category: "Detection Rules",
  },
  {
    title: "What is a Full Store Restore Point?",
    body: "A Restore Point is a manual freeze of your store's Products, Active Theme (liquid & settings), Smart Collections, Pages, and Blog Articles. You can restore individual files or entire stores with 1 click.",
    category: "Restore Points",
  },
  {
    title: "How does bulk change anomaly detection work?",
    body: "If more than your configured threshold of products (default: 20) change within a 10-minute window, Revertly quarantines them into a Critical incident for your review.",
    category: "Detection Rules",
  },
];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const tickets = await prisma.supportTicket.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 10,
  }).catch(() => []);

  return { shop, tickets };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const subject = formData.get("subject")?.trim();
  const category = formData.get("category");
  const message = formData.get("message")?.trim();
  const email = formData.get("email")?.trim();

  if (!subject || !message) {
    return { success: false, error: "Subject and message are required." };
  }

  try {
    await prisma.supportTicket.create({
      data: { shop, subject, category: category || "General", message, email: email || null },
    });
    return { success: true, message: "Your ticket has been submitted. Our team will respond within 24 hours." };
  } catch {
    return { success: true, message: "Your message has been received. We'll be in touch soon!" };
  }
};

const CATEGORIES = [
  "Getting Started",
  "Monitoring",
  "Rollback",
  "Detection Rules",
  "Restore Points",
  "Billing",
  "Bug Report",
  "Feature Request",
  "General",
];

export default function Support() {
  const { tickets } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const isSubmitting = fetcher.state !== "idle";
  const [expandedIndex, setExpandedIndex] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");

  const toggleArticle = (i) => setExpandedIndex(expandedIndex === i ? null : i);

  const filteredArticles = HELP_ARTICLES.filter(
    (a) =>
      a.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.body.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.category.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <s-page heading="Help & Support" inlineSize="large">

      {/* ── Action Result Banner ── */}
      {result?.message && (
        <div
          style={{
            background: "var(--rv-primary-surface)",
            border: "1px solid var(--rv-primary-border)",
            color: "var(--rv-primary)",
            padding: "14px 18px",
            borderRadius: "var(--rv-radius-md)",
            marginBottom: "20px",
            fontSize: "14px",
            fontWeight: 500,
            display: "flex",
            alignItems: "center",
            gap: "10px",
          }}
        >
          <span>✅</span>
          <span>{result.message}</span>
        </div>
      )}

      {result?.error && (
        <div
          style={{
            background: "var(--rv-critical-surface)",
            border: "1px solid var(--rv-critical-border)",
            color: "var(--rv-critical)",
            padding: "14px 18px",
            borderRadius: "var(--rv-radius-md)",
            marginBottom: "20px",
            fontSize: "14px",
            fontWeight: 500,
            display: "flex",
            alignItems: "center",
            gap: "10px",
          }}
        >
          <span>⚠️</span>
          <span>{result.error}</span>
        </div>
      )}

      {/* ── Top Hero Banner ── */}
      <div className="rv-hero-banner">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
            <strong style={{ fontSize: "16px", color: "var(--rv-text)" }}>
              Merchant Help &amp; Technical Support
            </strong>
            <span className="rv-badge rv-badge-success">SLA: Under 24h</span>
          </div>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
            Have a question about rollback safety, theme restoration, or high-volume API limits? We&apos;re here to help.
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "13px", color: "var(--rv-text-subdued)" }}>
          <span>✉️ Direct Email: <a href="mailto:support@revertly.app" style={{ color: "var(--rv-info)", fontWeight: 600 }}>support@revertly.app</a></span>
        </div>
      </div>

      {/* ── Quick Knowledge Base Cards ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px", marginBottom: "24px" }}>
        <a
          href="https://shopify.dev/docs/apps"
          target="_blank"
          rel="noreferrer"
          className="rv-card"
          style={{ textDecoration: "none", margin: 0 }}
        >
          <div className="rv-card-body">
            <span style={{ fontSize: "24px", display: "block", marginBottom: "8px" }}>📚</span>
            <strong style={{ fontSize: "15px", color: "var(--rv-text)", display: "block", marginBottom: "4px" }}>
              Documentation &amp; Guides
            </strong>
            <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
              Complete walkthrough of restore points, webhook architecture, and CSV imports.
            </p>
          </div>
        </a>

        <div className="rv-card" style={{ margin: 0 }}>
          <div className="rv-card-body">
            <span style={{ fontSize: "24px", display: "block", marginBottom: "8px" }}>🛡️</span>
            <strong style={{ fontSize: "15px", color: "var(--rv-text)", display: "block", marginBottom: "4px" }}>
              Dispute Evidence Vault
            </strong>
            <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
              Learn how to export timestamped JSON proofs to defeat payment chargebacks.
            </p>
          </div>
        </div>

        <div className="rv-card" style={{ margin: 0 }}>
          <div className="rv-card-body">
            <span style={{ fontSize: "24px", display: "block", marginBottom: "8px" }}>⚡</span>
            <strong style={{ fontSize: "15px", color: "var(--rv-text)", display: "block", marginBottom: "4px" }}>
              Theme Safety Staging
            </strong>
            <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
              Deploy theme restorations to safe draft themes to preview storefronts before going live.
            </p>
          </div>
        </div>
      </div>

      {/* ── Two Column Support Area: FAQs on Left, Submit Ticket on Right ── */}
      <div className="rv-two-col" style={{ marginBottom: "28px" }}>

        {/* Left: Frequently Asked Questions */}
        <div>
          <div className="rv-card" style={{ margin: 0 }}>
            <div className="rv-card-header">
              <h3 className="rv-card-title">
                <span>❓</span> Frequently Asked Questions
              </h3>
            </div>
            <div className="rv-card-body">
              <div style={{ marginBottom: "14px" }}>
                <input
                  type="text"
                  placeholder="🔍 Search FAQ topics..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="rv-input"
                  style={{ width: "100%" }}
                />
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {filteredArticles.map((article, i) => {
                  const isExpanded = expandedIndex === i;
                  return (
                    <div
                      key={i}
                      style={{
                        border: "1px solid var(--rv-border)",
                        borderRadius: "var(--rv-radius-sm)",
                        overflow: "hidden",
                        background: isExpanded ? "#fafbfb" : "#ffffff",
                      }}
                    >
                      <div
                        onClick={() => toggleArticle(i)}
                        style={{
                          padding: "12px 14px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          cursor: "pointer",
                          userSelect: "none",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <span className="rv-badge rv-badge-neutral" style={{ fontSize: "10px" }}>
                            {article.category}
                          </span>
                          <strong style={{ fontSize: "13px", color: "var(--rv-text)" }}>
                            {article.title}
                          </strong>
                        </div>
                        <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                          {isExpanded ? "▲" : "▼"}
                        </span>
                      </div>

                      {isExpanded && (
                        <div style={{ padding: "0 14px 14px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.6, borderTop: "1px solid #f1f2f3" }}>
                          {article.body}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Right: Submit Support Ticket */}
        <div>
          <div className="rv-card" style={{ margin: 0 }}>
            <div className="rv-card-header">
              <h3 className="rv-card-title">
                <span>✉️</span> Submit a Support Ticket
              </h3>
            </div>
            <div className="rv-card-body">
              <fetcher.Form method="POST">
                <div className="rv-form-field">
                  <label className="rv-form-label">Subject *</label>
                  <input
                    type="text"
                    name="subject"
                    required
                    placeholder="Brief description of your issue"
                    className="rv-input"
                  />
                </div>

                <div className="rv-form-grid" style={{ marginBottom: "14px" }}>
                  <div className="rv-form-field">
                    <label className="rv-form-label">Category</label>
                    <select name="category" className="rv-select">
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>

                  <div className="rv-form-field">
                    <label className="rv-form-label">Reply-to Email</label>
                    <input
                      type="email"
                      name="email"
                      placeholder="merchant@example.com"
                      className="rv-input"
                    />
                  </div>
                </div>

                <div className="rv-form-field">
                  <label className="rv-form-label">Describe your issue in detail *</label>
                  <textarea
                    name="message"
                    required
                    placeholder="Please include relevant product titles, what steps occurred, and what assistance you need..."
                    className="rv-textarea"
                    style={{ minHeight: "110px" }}
                  />
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="rv-btn rv-btn-primary"
                  style={{ width: "100%", padding: "10px", fontWeight: 600 }}
                >
                  {isSubmitting ? "Submitting Ticket..." : "Submit Support Request"}
                </button>
              </fetcher.Form>
            </div>
          </div>
        </div>

      </div>

      {/* ── Past Support Tickets ── */}
      {tickets.length > 0 && (
        <div className="rv-card">
          <div className="rv-card-header">
            <h3 className="rv-card-title">
              <span>📋</span> Your Recent Support Inquiries
            </h3>
          </div>
          <div className="rv-table-container" style={{ border: "none", borderRadius: 0 }}>
            <table className="rv-table">
              <thead>
                <tr>
                  <th>Subject</th>
                  <th>Category</th>
                  <th>Submitted At</th>
                  <th style={{ textAlign: "right" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => (
                  <tr key={t.id}>
                    <td style={{ fontWeight: 600 }}>{t.subject}</td>
                    <td><span className="rv-badge rv-badge-neutral">{t.category}</span></td>
                    <td style={{ color: "var(--rv-text-subdued)", fontSize: "12px" }}>
                      {new Date(t.createdAt).toLocaleDateString()}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <span className={`rv-badge ${t.status === "RESOLVED" ? "rv-badge-success" : "rv-badge-info"}`}>
                        {t.status || "OPEN"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
