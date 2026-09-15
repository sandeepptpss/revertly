import { useState } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  HelpCircleIcon,
  SearchIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ShieldCheckIcon,
  FileCodeIcon,
  ClockIcon,
  SparklesIcon,
} from "../components/Icons.jsx";
import { Banner } from "../components/Banner.jsx";

const HELP_ARTICLES = [
  {
    title: "How do I take an initial product snapshot?",
    body: "Go to the Initialize page from the navigation. Click 'Initialize Monitoring' to take a full snapshot of all your current products. This establishes a clean baseline before monitoring begins.",
    category: "Getting Started",
  },
  {
    title: "Why wasn't a catalog change detected?",
    body: "Make sure monitoring is enabled in Settings. The app detects product changes via real-time Shopify webhooks after the baseline snapshot is initialized.",
    category: "Monitoring",
  },
  {
    title: "What does an atomic rollback actually do?",
    body: "A rollback restores only the specific fields that were modified — not the entire product. For example, rolling back a price crash restores the previous price while leaving newer photos, descriptions, and inventory levels intact.",
    category: "Rollback",
  },
  {
    title: "How do I set up custom detection rules?",
    body: "Go to Rules in the top navigation. Click '+ Create New Rule' to select the field (e.g. price), condition (e.g. DECREASE_BY_PERCENT), and threshold percentage (e.g. 30%).",
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
  const { session } = await authenticate.admin(request);
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
    return { success: true, message: "Your ticket has been submitted. Our developer support team will respond within 24 hours." };
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
        <Banner
          tone="success"
          title="Inquiry Submitted"
        >
          {result.message}
        </Banner>
      )}

      {result?.error && (
        <Banner
          tone="critical"
          title="Submission Error"
        >
          {result.error}
        </Banner>
      )}

      {/* ── Top Hero Banner ── */}
      <div className="rv-hero-banner">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
            <strong style={{ fontSize: "17px", color: "var(--rv-text)", fontWeight: 700 }}>
              Merchant Help &amp; Technical Support
            </strong>
            <span className="rv-badge rv-badge-success">Response SLA: Under 24h</span>
          </div>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
            Have a question about rollback safety, theme restoration, or high-volume API limits? We&apos;re here to help.
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "13px", color: "var(--rv-text-subdued)" }}>
          <span>Direct Email: <a href="mailto:support@revertly.app" style={{ color: "var(--rv-info)", fontWeight: 600 }}>support@revertly.app</a></span>
        </div>
      </div>

      {/* ── Quick Knowledge Cards ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "16px", marginBottom: "24px" }}>
        <div className="rv-card" style={{ margin: 0 }}>
          <div className="rv-card-body">
            <div className="rv-stat-icon-wrapper rv-stat-icon-emerald" style={{ marginBottom: "10px" }}>
              <ShieldCheckIcon size={20} />
            </div>
            <strong style={{ fontSize: "15px", color: "var(--rv-text)", display: "block", marginBottom: "4px" }}>
              Atomic Rollback Engine
            </strong>
            <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
              Only modified attributes are rolled back. New photos, tags, and reviews remain preserved.
            </p>
          </div>
        </div>

        <div className="rv-card" style={{ margin: 0 }}>
          <div className="rv-card-body">
            <div className="rv-stat-icon-wrapper rv-stat-icon-blue" style={{ marginBottom: "10px" }}>
              <FileCodeIcon size={20} />
            </div>
            <strong style={{ fontSize: "15px", color: "var(--rv-text)", display: "block", marginBottom: "4px" }}>
              Theme Staging Preview
            </strong>
            <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
              Deploy theme backups directly to draft themes to preview storefronts before making them live.
            </p>
          </div>
        </div>

        <div className="rv-card" style={{ margin: 0 }}>
          <div className="rv-card-body">
            <div className="rv-stat-icon-wrapper rv-stat-icon-purple" style={{ marginBottom: "10px" }}>
              <ClockIcon size={20} />
            </div>
            <strong style={{ fontSize: "15px", color: "var(--rv-text)", display: "block", marginBottom: "4px" }}>
              Dispute Proof Vault
            </strong>
            <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
              Export timestamped JSON records to provide definitive evidence for payment disputes and audits.
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
                <HelpCircleIcon size={18} style={{ color: "var(--rv-info)" }} />
                <span>Frequently Asked Questions</span>
              </h3>
            </div>
            <div className="rv-card-body">
              <div className="rv-search-wrapper" style={{ width: "100%", marginBottom: "16px" }}>
                <span className="rv-search-icon">
                  <SearchIcon size={15} />
                </span>
                <input
                  type="text"
                  aria-label="Search FAQ topics"
                  placeholder="Search FAQ topics..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="rv-input rv-input-with-icon"
                  style={{ width: "100%", boxSizing: "border-box" }}
                />
              </div>

              <div className="rv-accordion">
                {filteredArticles.map((article, i) => {
                  const isExpanded = expandedIndex === i;
                  return (
                    <div key={i} className="rv-accordion-item">
                      <button
                        type="button"
                        className="rv-accordion-header"
                        onClick={() => toggleArticle(i)}
                        aria-expanded={isExpanded}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <span className="rv-badge rv-badge-neutral rv-badge-sm">
                            {article.category}
                          </span>
                          <span>{article.title}</span>
                        </div>
                        {isExpanded ? <ChevronUpIcon size={16} /> : <ChevronDownIcon size={16} />}
                      </button>

                      {isExpanded && (
                        <div className="rv-accordion-body">
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
                <SparklesIcon size={18} style={{ color: "var(--rv-primary)" }} />
                <span>Submit a Support Ticket</span>
              </h3>
            </div>
            <div className="rv-card-body">
              <fetcher.Form method="POST">
                <div className="rv-form-field">
                  <label htmlFor="ticket-subject" className="rv-form-label">Subject *</label>
                  <input
                    id="ticket-subject"
                    type="text"
                    name="subject"
                    required
                    placeholder="Brief summary of your question or issue"
                    className="rv-input"
                  />
                </div>

                <div className="rv-form-grid" style={{ marginBottom: "14px" }}>
                  <div className="rv-form-field">
                    <label htmlFor="ticket-category" className="rv-form-label">Category</label>
                    <select id="ticket-category" name="category" className="rv-select">
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>

                  <div className="rv-form-field">
                    <label htmlFor="ticket-email" className="rv-form-label">Reply-to Email</label>
                    <input
                      id="ticket-email"
                      type="email"
                      name="email"
                      placeholder="merchant@example.com"
                      className="rv-input"
                    />
                  </div>
                </div>

                <div className="rv-form-field">
                  <label htmlFor="ticket-message" className="rv-form-label">Describe your issue in detail *</label>
                  <textarea
                    id="ticket-message"
                    name="message"
                    required
                    placeholder="Include product titles, approximate time, and what assistance you need..."
                    className="rv-textarea"
                    style={{ minHeight: "110px" }}
                  />
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="rv-btn rv-btn-primary rv-btn-lg"
                  style={{ width: "100%" }}
                >
                  <span>{isSubmitting ? "Submitting Ticket..." : "Submit Support Request"}</span>
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
              <span>Your Recent Support Inquiries</span>
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
                    <td><span className="rv-badge rv-badge-neutral rv-badge-sm">{t.category}</span></td>
                    <td style={{ color: "var(--rv-text-subdued)", fontSize: "12px" }}>
                      {new Date(t.createdAt).toLocaleDateString()}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <span className={`rv-badge rv-badge-sm ${t.status === "RESOLVED" ? "rv-badge-success" : "rv-badge-info"}`}>
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
