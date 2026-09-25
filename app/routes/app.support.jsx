import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { sendSupportTicketAdminEmail } from "../supportEmail.server.js";
import { getEffectivePlanId } from "../billing.server.js";
import {
  HelpCircleIcon,
  SearchIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ShieldCheckIcon,
  FileCodeIcon,
  ClockIcon,
  SparklesIcon,
  CheckCircleIcon,
  MailIcon,
  ZapIcon,
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

// The fields getEffectivePlanId reads. With planId alone, an external
// Enterprise contract or a Partner development store resolved as its stored plan.
const PLAN_FIELDS = { planId: true, customBillingMethod: true, customPriceStatus: true, isPartnerDevelopment: true };

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const isEmergency = url.searchParams.get("emergency") === "1";
  const initialSubject = isEmergency
    ? "[EMERGENCY SOS] Urgent Store Recovery & Restore Assistance"
    : (url.searchParams.get("subject") || "");
  const initialCategory = isEmergency
    ? "Rollback"
    : (url.searchParams.get("category") || "General");
  const initialPriority = isEmergency
    ? "URGENT"
    : (url.searchParams.get("priority") || "NORMAL");
  const initialProducts = url.searchParams.get("products") || "";
  let initialMessage = url.searchParams.get("message") || "";

  if (isEmergency && !initialMessage) {
    initialMessage = `Hello Revertly Emergency Team,\n\nOur store (${shop}) is currently facing an urgent store emergency (accidental bulk change, price crash, or theme break).\n\nPlease escalate this to the on-call engineers for immediate restoration assistance.\n\nDescription of the incident:\n`;
  } else if (initialProducts && !initialMessage) {
    initialMessage = `Hi Revertly Team,\n\nOur store (${shop}) currently has approximately ${Number(initialProducts).toLocaleString()} products, which exceeds the standard 200,000 product limit on Enterprise.\n\nWe would like to request a Custom Enterprise Plus quote with dedicated high-volume infrastructure, custom retention, and priority SLA.\n\nThank you!`;
  }

  let defaultEmail = "";
  let planTier = "Free";

  try {
    const settings = await prisma.appSettings.findUnique({
      where: { shop },
      select: { alertEmail: true, ...PLAN_FIELDS },
    });
    if (settings?.alertEmail) defaultEmail = settings.alertEmail;
    planTier = await getEffectivePlanId(shop, settings);
  } catch (err) {
    console.error("[Support] Error fetching appSettings in loader:", err);
  }

  // Attempt to prefetch shop email if not configured in AppSettings
  if (!defaultEmail && admin) {
    try {
      const resp = await admin.graphql(`
        query getShopContactEmail {
          shop {
            email
            contactEmail
          }
        }
      `);
      const json = await resp.json();
      defaultEmail = json.data?.shop?.contactEmail || json.data?.shop?.email || "";
    } catch {
      // Graceful fallback
    }
  }

  const tickets = await prisma.supportTicket.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 15,
  }).catch(() => []);

  return {
    shop,
    tickets,
    defaultEmail,
    planTier,
    initialSubject,
    initialCategory,
    initialPriority,
    initialMessage,
    isEmergency,
  };
};

const TICKET_PRIORITIES = new Set(["NORMAL", "HIGH", "URGENT"]);

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const subject = formData.get("subject")?.trim();
  // Category is free text on the wire; clip it to its column rather than let
  // the insert fail.
  const category = Array.from(formData.get("category")?.trim() || "General").slice(0, 100).join("");
  // The admin queue sorts by priority, so only the three levels the form
  // offers may be stored — anything else would sort below NORMAL or above URGENT.
  const rawPriority = String(formData.get("priority") || "NORMAL").trim().toUpperCase();
  const priority = TICKET_PRIORITIES.has(rawPriority) ? rawPriority : "NORMAL";
  const message = formData.get("message")?.trim();
  const email = formData.get("email")?.trim();

  if (!subject) {
    return { success: false, error: "Please provide a subject for your inquiry." };
  }

  if (Array.from(subject).length > 500) {
    return { success: false, error: "Please keep the subject to 500 characters or fewer." };
  }

  if (email && email.length > 255) {
    return { success: false, error: "Please provide a valid reply-to email address." };
  }

  if (!message) {
    return { success: false, error: "Please describe your question or issue in detail." };
  }

  if (email && !email.includes("@")) {
    return { success: false, error: "Please provide a valid reply-to email address." };
  }

  let planTier = "Free";
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { shop },
      select: PLAN_FIELDS,
    });
    planTier = await getEffectivePlanId(shop, settings);
  } catch {
    // Graceful fallback
  }

  try {
    const isEmergency = priority === "URGENT";
    // Enterprise includes a priority support queue: its tickets are raised to
    // at least HIGH, and the admin queue (app.admin.jsx) serves them ahead of
    // other plans at the same priority.
    const effectivePriority = planTier === "enterprise" && priority === "NORMAL" ? "HIGH" : priority;

    const ticket = await prisma.supportTicket.create({
      data: {
        shop,
        subject,
        category,
        priority: effectivePriority,
        isEmergency,
        planTier,
        message,
        email: email || null,
        status: "OPEN",
      },
    });

    // Send transactional email notification to admin via Resend
    const emailResult = await sendSupportTicketAdminEmail({
      ticket,
      shop,
      merchantEmail: email,
      planTier,
    });

    return {
      success: true,
      ticket: {
        id: ticket.id,
        subject: ticket.subject,
        category: ticket.category,
        priority: ticket.priority,
        email: ticket.email,
        message: ticket.message,
        createdAt: ticket.createdAt,
        status: ticket.status,
      },
      emailSent: emailResult.success,
      message: `Support ticket #${ticket.id} created successfully! Our support team has been notified and will respond shortly.${planTier === "enterprise" ? " As an Enterprise store, your ticket is in the priority queue." : ""}`,
    };
  } catch (err) {
    console.error("[Support] Failed to create support ticket:", err);
    return {
      success: false,
      error: "We could not save your support ticket. Please try again or reach out directly to support@revertly.app.",
    };
  }
};

export default function Support() {
  const {
    shop,
    tickets,
    defaultEmail,
    planTier,
    initialSubject,
    initialCategory,
    initialPriority,
    initialMessage,
    isEmergency = false,
  } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const isSubmitting = fetcher.state !== "idle";

  const [expandedIndex, setExpandedIndex] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Form input state (pre-filled from URL query params if present)
  const [subject, setSubject] = useState(initialSubject || "");
  const [category, setCategory] = useState(initialCategory || "General");
  const [priority, setPriority] = useState(initialPriority || "NORMAL");
  const [email, setEmail] = useState(defaultEmail || "");
  const [message, setMessage] = useState(initialMessage || "");

  // Sync state if query parameters change
  useEffect(() => {
    if (initialSubject) setSubject(initialSubject);
    if (initialCategory) setCategory(initialCategory);
    if (initialPriority) setPriority(initialPriority);
    if (initialMessage) setMessage(initialMessage);
  }, [initialSubject, initialCategory, initialPriority, initialMessage]);

  // Success view state
  const [showSuccessCard, setShowSuccessCard] = useState(false);
  const [submittedTicket, setSubmittedTicket] = useState(null);

  // Expanded ticket row in recent inquiries table
  const [expandedTicketId, setExpandedTicketId] = useState(null);

  // Sync email default when loader data is ready
  useEffect(() => {
    if (defaultEmail) {
      setEmail((current) => (current ? current : defaultEmail));
    }
  }, [defaultEmail]);

  // Handle successful submission
  useEffect(() => {
    if (result?.success && result?.ticket) {
      setShowSuccessCard(true);
      setSubmittedTicket(result.ticket);

      // Trigger Shopify App Bridge toast if available
      if (typeof window !== "undefined" && window.shopify?.toast) {
        window.shopify.toast.show(`Support ticket #${result.ticket.id} submitted successfully!`);
      }
    }
  }, [result]);

  const handleResetForm = () => {
    setSubject("");
    setCategory("General");
    setPriority("NORMAL");
    setMessage("");
    setShowSuccessCard(false);
    setSubmittedTicket(null);
  };

  const toggleArticle = (i) => setExpandedIndex(expandedIndex === i ? null : i);
  const toggleTicketDetail = (id) => setExpandedTicketId(expandedTicketId === id ? null : id);

  const filteredArticles = HELP_ARTICLES.filter(
    (a) =>
      a.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.body.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.category.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Include newly submitted ticket dynamically at the top of recent tickets list
  const recentTickets = [
    ...(submittedTicket ? [submittedTicket] : []),
    ...tickets.filter((t) => t.id !== submittedTicket?.id),
  ];

  return (
    <s-page heading="Help & Support" inlineSize="large">

      {/* ── Emergency Disaster Recovery Banner ── */}
      {isEmergency && (
        <Banner
          tone="critical"
          title="Emergency Disaster Recovery Mode Active"
          className="rv-fade-in"
          style={{ marginBottom: "20px" }}
        >
          You have flagged an urgent store crisis. Tickets submitted in Emergency Mode bypass standard support queues and immediately alert our on-call engineering team for prioritized restoration.
        </Banner>
      )}

      {/* ── Top Hero Banner ── */}
      <div className="rv-hero-banner" style={{ marginBottom: "20px" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px", flexWrap: "wrap" }}>
            <strong style={{ fontSize: "17px", color: "var(--rv-text)", fontWeight: 700 }}>
              Merchant Help &amp; Technical Support
            </strong>
            <span className="rv-badge rv-badge-success">Response SLA: Under 24h</span>
            {planTier === "enterprise" && <span className="rv-badge rv-badge-info">Priority support queue</span>}
            <span className="rv-badge rv-badge-neutral" style={{ textTransform: "capitalize" }}>
              Store Plan: {planTier}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
            Have a question about rollback safety, theme restoration, or high-volume API limits? We&apos;re here to help.
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "13px", color: "var(--rv-text-subdued)", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => {
              setPriority("URGENT");
              setCategory("Rollback");
              setSubject("[EMERGENCY SOS] Urgent Store Recovery & Restore Assistance");
              if (!message) {
                setMessage("Hello Revertly Team,\n\nOur store is facing an urgent issue and we need immediate engineering assistance to restore our data.\n\nDetails:\n");
              }
            }}
            className="rv-btn rv-btn-critical rv-btn-sm"
            style={{ fontWeight: 600, display: "inline-flex", alignItems: "center", gap: "6px" }}
          >
            <span>Trigger Emergency SOS</span>
          </button>
          <span>
            Direct Email:{" "}
            <a href="mailto:support@revertly.app" style={{ color: "var(--rv-info)", fontWeight: 600 }}>
              support@revertly.app
            </a>
          </span>
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
            <div className="rv-card-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h3 className="rv-card-title" style={{ margin: 0 }}>
                <SparklesIcon size={18} style={{ color: "var(--rv-primary)" }} />
                <span>Submit a Support Ticket</span>
              </h3>
              <span className="rv-badge rv-badge-neutral rv-badge-sm">24h Response</span>
            </div>

            <div className="rv-card-body">
              {/* If newly submitted successfully, show clear dedicated confirmation card */}
              {showSuccessCard && submittedTicket ? (
                <div className="rv-ticket-success-box">
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "52px",
                      height: "52px",
                      borderRadius: "50%",
                      backgroundColor: "#dcfce7",
                      color: "#16a34a",
                      marginBottom: "12px",
                    }}
                  >
                    <CheckCircleIcon size={32} />
                  </div>

                  <h4 style={{ margin: "0 0 6px 0", fontSize: "17px", fontWeight: 700, color: "#166534" }}>
                    Support Ticket #TKT-{submittedTicket.id} Created!
                  </h4>

                  <p style={{ margin: "0 0 16px 0", fontSize: "13px", color: "#374151", lineHeight: 1.5 }}>
                    Your request has been logged and our support team has been notified by email.
                  </p>

                  <div
                    style={{
                      background: "#ffffff",
                      border: "1px solid #e5e7eb",
                      borderRadius: "8px",
                      padding: "12px 16px",
                      textAlign: "left",
                      fontSize: "12px",
                      marginBottom: "18px",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid #f3f4f6" }}>
                      <span style={{ color: "#6b7280" }}>Subject:</span>
                      <span style={{ fontWeight: 600, color: "#111827", maxWidth: "65%", textAlign: "right" }}>
                        {submittedTicket.subject}
                      </span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid #f3f4f6" }}>
                      <span style={{ color: "#6b7280" }}>Category:</span>
                      <span style={{ fontWeight: 600, color: "#111827" }}>{submittedTicket.category}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid #f3f4f6" }}>
                      <span style={{ color: "#6b7280" }}>Priority:</span>
                      <span
                        className={`rv-badge rv-badge-sm ${submittedTicket.priority === "URGENT"
                          ? "rv-badge-critical"
                          : submittedTicket.priority === "HIGH"
                            ? "rv-badge-warning"
                            : "rv-badge-info"
                          }`}
                      >
                        {submittedTicket.priority}
                      </span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                      <span style={{ color: "#6b7280" }}>Reply-To Email:</span>
                      <span style={{ fontWeight: 600, color: "#111827" }}>
                        {submittedTicket.email || email || "Store Contact"}
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleResetForm}
                    className="rv-btn rv-btn-secondary"
                    style={{ width: "100%" }}
                  >
                    <span>Submit Another Request</span>
                  </button>
                </div>
              ) : (
                /* Main Interactive Form */
                <fetcher.Form method="POST">
                  {/* Inline Error Banner if submission failed */}
                  {result?.error && (
                    <div style={{ marginBottom: "16px" }}>
                      <Banner tone="critical" title="Unable to Submit Ticket">
                        {result.error}
                      </Banner>
                    </div>
                  )}

                  {/* Subject Field */}
                  <div className="rv-form-field" style={{ marginBottom: "14px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <label htmlFor="ticket-subject" className="rv-form-label">
                        Subject <span style={{ color: "var(--rv-critical)" }}>*</span>
                      </label>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)" }}>
                        {subject.length}/150
                      </span>
                    </div>
                    <input
                      id="ticket-subject"
                      type="text"
                      name="subject"
                      value={subject}
                      onChange={(e) => setSubject(e.target.value.slice(0, 150))}
                      required
                      placeholder="Brief summary of your question or issue"
                      className="rv-input"
                    />
                  </div>

                  {/* Category & Priority Grid */}
                  <div className="rv-form-grid" style={{ marginBottom: "14px" }}>
                    <div className="rv-form-field">
                      <label htmlFor="ticket-category" className="rv-form-label">
                        Category
                      </label>
                      <select
                        id="ticket-category"
                        name="category"
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                        className="rv-select"
                      >
                        {CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="rv-form-field">
                      <label htmlFor="ticket-priority" className="rv-form-label">
                        Priority
                      </label>
                      <select
                        id="ticket-priority"
                        name="priority"
                        value={priority}
                        onChange={(e) => setPriority(e.target.value)}
                        className="rv-select"
                      >
                        <option value="NORMAL">Normal (Standard &bull; &lt; 24h)</option>
                        <option value="HIGH">High (Operations Impacted)</option>
                        <option value="URGENT">Urgent (Active Emergency / Data Loss)</option>
                      </select>
                    </div>
                  </div>

                  {/* Reply-to Email Field */}
                  <div className="rv-form-field" style={{ marginBottom: "14px" }}>
                    <label htmlFor="ticket-email" className="rv-form-label">
                      Reply-to Email
                    </label>
                    <input
                      id="ticket-email"
                      type="email"
                      name="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="merchant@example.com"
                      className="rv-input"
                    />
                    <div className="rv-form-help">
                      Our response will be delivered directly to this email address.
                    </div>
                  </div>

                  {/* Issue Description Field */}
                  <div className="rv-form-field" style={{ marginBottom: "16px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <label htmlFor="ticket-message" className="rv-form-label">
                        Describe your issue in detail <span style={{ color: "var(--rv-critical)" }}>*</span>
                      </label>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)" }}>
                        {message.length} chars
                      </span>
                    </div>
                    <textarea
                      id="ticket-message"
                      name="message"
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      required
                      placeholder="Include product titles/IDs, approximate time, and what assistance you need..."
                      className="rv-textarea"
                      style={{ minHeight: "120px" }}
                    />
                    <div className="rv-form-help">
                      Tip: Include details like product titles or error messages to help us diagnose quickly.
                    </div>
                  </div>

                  {/* Context note */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      padding: "8px 12px",
                      background: "#f8fafc",
                      border: "1px solid #e2e8f0",
                      borderRadius: "6px",
                      fontSize: "12px",
                      color: "var(--rv-text-subdued)",
                      marginBottom: "16px",
                    }}
                  >
                    <ZapIcon size={15} style={{ color: "var(--rv-info)", flexShrink: 0 }} />
                    <span>
                      Store <strong>{shop}</strong> ({planTier} plan) is automatically linked for faster diagnostic support.
                    </span>
                  </div>

                  {/* Submit Button with Loading State */}
                  <button
                    type="submit"
                    disabled={isSubmitting || !subject.trim() || !message.trim()}
                    className="rv-btn rv-btn-primary rv-btn-lg"
                    style={{ width: "100%", cursor: isSubmitting ? "not-allowed" : "pointer" }}
                  >
                    {isSubmitting ? (
                      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                        <span className="rv-spinner" />
                        Submitting Ticket &amp; Notifying Team...
                      </span>
                    ) : (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                        <MailIcon size={16} />
                        Submit Support Request
                      </span>
                    )}
                  </button>
                </fetcher.Form>
              )}
            </div>
          </div>
        </div>

      </div>

      {/* ── Past Support Tickets ── */}
      {recentTickets.length > 0 && (
        <div className="rv-card">
          <div className="rv-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 className="rv-card-title" style={{ margin: 0 }}>
              <span>Your Recent Support Inquiries ({recentTickets.length})</span>
            </h3>
            <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
              Click any ticket to view submitted details
            </span>
          </div>

          <div className="rv-table-container" style={{ border: "none", borderRadius: 0 }}>
            <table className="rv-table">
              <thead>
                <tr>
                  <th style={{ width: "90px" }}>Ticket ID</th>
                  <th>Subject</th>
                  <th>Category</th>
                  <th>Priority</th>
                  <th>Submitted At</th>
                  <th style={{ textAlign: "right" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {recentTickets.map((t) => {
                  const isExpanded = expandedTicketId === t.id;
                  const priorityClass =
                    t.priority === "URGENT"
                      ? "rv-badge-critical"
                      : t.priority === "HIGH"
                        ? "rv-badge-warning"
                        : "rv-badge-neutral";

                  const statusClass =
                    t.status === "RESOLVED"
                      ? "rv-badge-success"
                      : t.status === "IN_PROGRESS"
                        ? "rv-badge-warning"
                        : "rv-badge-info";

                  return (
                    <tr key={t.id}>
                      <td style={{ fontWeight: 600, color: "var(--rv-info)" }}>
                        #{t.id}
                      </td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                          <span style={{ fontWeight: 600, color: "var(--rv-text)" }}>{t.subject}</span>
                          {t.message && (
                            <button
                              type="button"
                              onClick={() => toggleTicketDetail(t.id)}
                              className="rv-btn rv-btn-subtle rv-btn-sm"
                              style={{ padding: "2px 8px", fontSize: "11px", height: "auto" }}
                            >
                              {isExpanded ? "Hide Details" : "View Message"}
                            </button>
                          )}
                        </div>
                        {isExpanded && t.message && (
                          <div
                            style={{
                              marginTop: "8px",
                              padding: "10px 12px",
                              background: "#f8fafc",
                              borderLeft: "3px solid var(--rv-info)",
                              borderRadius: "4px",
                              fontSize: "12px",
                              color: "var(--rv-text)",
                              lineHeight: 1.5,
                              whiteSpace: "pre-wrap",
                            }}
                          >
                            <strong>Merchant Message:</strong>
                            <p style={{ margin: "4px 0 0 0" }}>{t.message}</p>
                            {t.email && (
                              <p style={{ margin: "6px 0 0 0", color: "var(--rv-text-subdued)", fontSize: "11px" }}>
                                Reply-to: {t.email}
                              </p>
                            )}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className="rv-badge rv-badge-neutral rv-badge-sm">
                          {t.category || "General"}
                        </span>
                      </td>
                      <td>
                        <span className={`rv-badge rv-badge-sm ${priorityClass}`}>
                          {t.priority || "NORMAL"}
                        </span>
                      </td>
                      <td style={{ color: "var(--rv-text-subdued)", fontSize: "12px" }}>
                        {new Date(t.createdAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <span className={`rv-badge rv-badge-sm ${statusClass}`}>
                          {t.status || "OPEN"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
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
