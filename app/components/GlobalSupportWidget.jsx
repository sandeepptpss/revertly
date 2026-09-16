import { useState, useEffect, useRef } from "react";
import { useFetcher, Link } from "react-router";

// Top FAQs for immediate in-widget assistance
const QUICK_FAQS = [
  {
    title: "How do I take an initial product snapshot?",
    category: "Getting Started",
    body: "Go to the Initialize page from the navigation. Click 'Initialize Monitoring' to take a full snapshot of all your current products. This establishes a clean baseline before monitoring begins.",
  },
  {
    title: "What does an atomic rollback actually do?",
    category: "Rollback",
    body: "A rollback restores only the specific fields that were modified — not the entire product. For example, rolling back a price crash restores the previous price while leaving newer photos, descriptions, and inventory levels intact.",
  },
  {
    title: "Why wasn't a catalog change detected?",
    category: "Monitoring",
    body: "Make sure monitoring is enabled in Settings. The app detects product changes via real-time Shopify webhooks after the baseline snapshot is initialized.",
  },
  {
    title: "How do I set up custom detection rules?",
    category: "Detection Rules",
    body: "Go to Rules in the navigation. Click '+ Create New Rule' to select the field (e.g. price), condition (e.g. DECREASE_BY_PERCENT), and threshold percentage (e.g. 30%).",
  },
  {
    title: "What is a Full Store Restore Point?",
    category: "Restore Points",
    body: "A Restore Point is a manual freeze of your store's Products, Active Theme (liquid & settings), Smart Collections, Pages, and Blog Articles. You can restore individual files or entire stores with 1 click.",
  },
  {
    title: "How does bulk change anomaly detection work?",
    category: "Detection Rules",
    body: "If more than your configured threshold of products (default: 20) change within a 10-minute window, Revertly quarantines them into a Critical incident for your review.",
  },
];

const CATEGORIES = [
  "General",
  "Getting Started",
  "Monitoring",
  "Rollback",
  "Detection Rules",
  "Restore Points",
  "Billing",
  "Bug Report",
  "Feature Request",
];

export function GlobalSupportWidget({ shop = "", defaultEmail = "", planTier = "Free" }) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("ticket"); // "ticket" | "faq"
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedFaq, setExpandedFaq] = useState(null);

  // Form states
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState("General");
  const [priority, setPriority] = useState("NORMAL");
  const [email, setEmail] = useState(defaultEmail || "");
  const [message, setMessage] = useState("");
  const [showSuccess, setShowSuccess] = useState(false);
  const [submittedTicket, setSubmittedTicket] = useState(null);

  const fetcher = useFetcher({ key: "global-support-ticket" });
  const isSubmitting = fetcher.state !== "idle";
  const result = fetcher.data;

  const drawerRef = useRef(null);
  const buttonRef = useRef(null);

  // Synchronize default email when provided
  useEffect(() => {
    if (defaultEmail && !email) {
      setEmail(defaultEmail);
    }
  }, [defaultEmail, email]);

  // Handle successful submission
  useEffect(() => {
    if (result?.success && result?.ticket) {
      setShowSuccess(true);
      setSubmittedTicket(result.ticket);

      if (typeof window !== "undefined" && window.shopify?.toast) {
        window.shopify.toast.show(`Support ticket #${result.ticket.id} submitted!`);
      }
    }
  }, [result]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape" && isOpen) {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (
        isOpen &&
        drawerRef.current &&
        !drawerRef.current.contains(e.target) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const handleResetForm = () => {
    setSubject("");
    setCategory("General");
    setPriority("NORMAL");
    setMessage("");
    setShowSuccess(false);
    setSubmittedTicket(null);
  };

  const filteredFaqs = QUICK_FAQS.filter(
    (faq) =>
      faq.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      faq.body.toLowerCase().includes(searchQuery.toLowerCase()) ||
      faq.category.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <>
      {/* ── Floating Action Button & Tooltip Container ── */}
      <div className="rv-support-fab-container">
        <button
          ref={buttonRef}
          type="button"
          className={`rv-support-fab ${isOpen ? "is-open" : ""}`}
          onClick={() => setIsOpen((prev) => !prev)}
          aria-label={isOpen ? "Close Support Panel" : "Open Support Panel"}
          aria-expanded={isOpen}
          title="Support"
        >
          <span className="rv-support-fab-icon">
            {isOpen ? (
              // Crisp White Close Icon (✕)
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            ) : (
              // White Chat Bubble with Smile (Matches User Reference Image)
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                {/* Chat Bubble Body with Bottom-Right Tail */}
                <path
                  d="M4.5 4H19.5C20.6 4 21.5 4.9 21.5 6V15C21.5 16.1 20.6 17 19.5 17H18L19.2 20.5C19.4 21.05 18.8 21.5 18.3 21.2L14.2 17H4.5C3.4 17 2.5 16.1 2.5 15V6C2.5 4.9 3.4 4 4.5 4Z"
                  fill="#ffffff"
                />
                {/* Curved Smile Cutout */}
                <path
                  d="M7.8 11.2C8.6 13.6 10.8 14.5 12 14.5C13.2 14.5 15.4 13.6 16.2 11.2"
                  stroke="#0084ff"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </span>
        </button>

        {/* Hover / Focus Tooltip */}
        <div className="rv-support-tooltip" role="tooltip">
          Support
        </div>
      </div>

      {/* ── Slide-up Interactive Support Drawer ── */}
      {isOpen && (
        <div
          ref={drawerRef}
          className="rv-support-drawer"
          role="dialog"
          aria-modal="false"
          aria-label="Revertly Support Panel"
        >
          {/* Drawer Header */}
          <div className="rv-support-drawer-header">
            <div className="rv-support-drawer-top-row">
              <div className="rv-support-drawer-title-wrap">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path
                    d="M4 4H20C21.1 4 22 4.9 22 6V15C22 16.1 21.1 17 20 17H18.5L19.7 20.6C19.9 21.1 19.3 21.5 18.8 21.2L14.5 17H4C2.9 17 2 16.1 2 15V6C2 4.9 2.9 4 4 4Z"
                    fill="#ffffff"
                  />
                  <path
                    d="M7.5 11C8.2 13 10.2 13.8 12 13.8C13.8 13.8 15.8 13 16.5 11"
                    stroke="#0066d6"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                <h3 className="rv-support-drawer-title">Revertly Support</h3>
              </div>

              <button
                type="button"
                className="rv-support-drawer-close-btn"
                onClick={() => setIsOpen(false)}
                aria-label="Close Support Panel"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <div className="rv-support-drawer-meta-row">
              <span className="rv-support-online-badge">
                <span className="rv-support-online-dot" />
                Engineering Online &bull; &lt; 24h SLA
              </span>
              {shop && (
                <span style={{ opacity: 0.85, fontSize: "11px" }}>
                  Store: {shop.replace(".myshopify.com", "")} ({planTier})
                </span>
              )}
            </div>
          </div>

          {/* Tab Navigation */}
          <div className="rv-support-tabs">
            <button
              type="button"
              className={`rv-support-tab-btn ${activeTab === "ticket" ? "is-active" : ""}`}
              onClick={() => setActiveTab("ticket")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                <polyline points="22,6 12,13 2,6" />
              </svg>
              <span>Submit Ticket</span>
            </button>
            <button
              type="button"
              className={`rv-support-tab-btn ${activeTab === "faq" ? "is-active" : ""}`}
              onClick={() => setActiveTab("faq")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span>Instant FAQs</span>
            </button>
          </div>

          {/* Drawer Body */}
          <div className="rv-support-drawer-body">
            {activeTab === "ticket" ? (
              showSuccess && submittedTicket ? (
                /* Ticket Confirmation State */
                <div className="rv-ticket-success-box" style={{ padding: "18px 14px" }}>
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "44px",
                      height: "44px",
                      borderRadius: "50%",
                      backgroundColor: "#dcfce7",
                      color: "#16a34a",
                      marginBottom: "10px",
                    }}
                  >
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                      <polyline points="22 4 12 14.01 9 11.01" />
                    </svg>
                  </div>

                  <h4 style={{ margin: "0 0 4px 0", fontSize: "15px", fontWeight: 700, color: "#166534" }}>
                    Ticket #TKT-{submittedTicket.id} Dispatched!
                  </h4>

                  <p style={{ margin: "0 0 12px 0", fontSize: "12px", color: "#374151", lineHeight: 1.4 }}>
                    Our engineering support team has been notified at <strong>sandeepptpss@gmail.com</strong>.
                  </p>

                  <div
                    style={{
                      background: "#ffffff",
                      border: "1px solid #e5e7eb",
                      borderRadius: "6px",
                      padding: "10px 12px",
                      textAlign: "left",
                      fontSize: "11.5px",
                      marginBottom: "14px",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid #f3f4f6" }}>
                      <span style={{ color: "#6b7280" }}>Subject:</span>
                      <span style={{ fontWeight: 600, color: "#111827", maxWidth: "65%", textAlign: "right" }}>
                        {submittedTicket.subject}
                      </span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid #f3f4f6" }}>
                      <span style={{ color: "#6b7280" }}>Priority:</span>
                      <span className="rv-badge rv-badge-sm rv-badge-info">{submittedTicket.priority}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
                      <span style={{ color: "#6b7280" }}>Reply-To:</span>
                      <span style={{ fontWeight: 600, color: "#111827" }}>
                        {submittedTicket.email || email || "Store Contact"}
                      </span>
                    </div>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <button
                      type="button"
                      onClick={handleResetForm}
                      className="rv-btn rv-btn-secondary rv-btn-sm"
                      style={{ width: "100%" }}
                    >
                      <span>Submit Another Inquiry</span>
                    </button>
                    <Link
                      to="/app/support"
                      onClick={() => setIsOpen(false)}
                      className="rv-btn rv-btn-subtle rv-btn-sm"
                      style={{ width: "100%", textAlign: "center" }}
                    >
                      <span>View All Tickets in Support Center &rarr;</span>
                    </Link>
                  </div>
                </div>
              ) : (
                /* Ticket Submission Form */
                <fetcher.Form method="POST" action="/app/support">
                  {result?.error && (
                    <div
                      style={{
                        padding: "8px 12px",
                        background: "#fef2f2",
                        border: "1px solid #fecaca",
                        borderRadius: "6px",
                        color: "#991b1b",
                        fontSize: "12px",
                        marginBottom: "12px",
                      }}
                    >
                      {result.error}
                    </div>
                  )}

                  {/* Subject */}
                  <div className="rv-form-field" style={{ marginBottom: "12px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <label htmlFor="global-ticket-subject" className="rv-form-label" style={{ fontSize: "12px" }}>
                        Subject <span style={{ color: "var(--rv-critical)" }}>*</span>
                      </label>
                      <span style={{ fontSize: "10.5px", color: "var(--rv-text-subdued)" }}>
                        {subject.length}/150
                      </span>
                    </div>
                    <input
                      id="global-ticket-subject"
                      type="text"
                      name="subject"
                      value={subject}
                      onChange={(e) => setSubject(e.target.value.slice(0, 150))}
                      required
                      placeholder="Brief summary of your question or issue"
                      className="rv-input"
                      style={{ fontSize: "12.5px", padding: "6px 10px", height: "34px" }}
                    />
                  </div>

                  {/* Category & Priority */}
                  <div className="rv-form-grid" style={{ marginBottom: "12px", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                    <div className="rv-form-field">
                      <label htmlFor="global-ticket-category" className="rv-form-label" style={{ fontSize: "12px" }}>
                        Category
                      </label>
                      <select
                        id="global-ticket-category"
                        name="category"
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                        className="rv-select"
                        style={{ fontSize: "12px", padding: "5px 8px", height: "34px" }}
                      >
                        {CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="rv-form-field">
                      <label htmlFor="global-ticket-priority" className="rv-form-label" style={{ fontSize: "12px" }}>
                        Priority
                      </label>
                      <select
                        id="global-ticket-priority"
                        name="priority"
                        value={priority}
                        onChange={(e) => setPriority(e.target.value)}
                        className="rv-select"
                        style={{ fontSize: "12px", padding: "5px 8px", height: "34px" }}
                      >
                        <option value="NORMAL">Normal (&lt; 24h)</option>
                        <option value="HIGH">High (Urgent)</option>
                        <option value="URGENT">Critical Emergency</option>
                      </select>
                    </div>
                  </div>

                  {/* Reply-To Email */}
                  <div className="rv-form-field" style={{ marginBottom: "12px" }}>
                    <label htmlFor="global-ticket-email" className="rv-form-label" style={{ fontSize: "12px" }}>
                      Reply-to Email
                    </label>
                    <input
                      id="global-ticket-email"
                      type="email"
                      name="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="merchant@example.com"
                      className="rv-input"
                      style={{ fontSize: "12.5px", padding: "6px 10px", height: "34px" }}
                    />
                  </div>

                  {/* Message */}
                  <div className="rv-form-field" style={{ marginBottom: "14px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <label htmlFor="global-ticket-message" className="rv-form-label" style={{ fontSize: "12px" }}>
                        Describe your issue <span style={{ color: "var(--rv-critical)" }}>*</span>
                      </label>
                      <span style={{ fontSize: "10.5px", color: "var(--rv-text-subdued)" }}>
                        {message.length} chars
                      </span>
                    </div>
                    <textarea
                      id="global-ticket-message"
                      name="message"
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      required
                      placeholder="Include details, product IDs, or questions..."
                      className="rv-textarea"
                      style={{ fontSize: "12.5px", minHeight: "84px", padding: "8px 10px" }}
                    />
                  </div>

                  {/* Submit Button */}
                  <button
                    type="submit"
                    disabled={isSubmitting || !subject.trim() || !message.trim()}
                    className="rv-btn rv-btn-primary"
                    style={{
                      width: "100%",
                      backgroundColor: "var(--rv-support-blue)",
                      borderColor: "var(--rv-support-blue)",
                      padding: "8px 16px",
                      fontSize: "13px",
                      cursor: isSubmitting ? "not-allowed" : "pointer",
                    }}
                  >
                    {isSubmitting ? (
                      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                        <span className="rv-spinner" />
                        Submitting Ticket...
                      </span>
                    ) : (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="22" y1="2" x2="11" y2="13" />
                          <polygon points="22 2 15 22 11 13 2 9 22 2" />
                        </svg>
                        Send Support Request
                      </span>
                    )}
                  </button>
                </fetcher.Form>
              )
            ) : (
              /* FAQ Search & Accordion Tab */
              <div>
                <div style={{ position: "relative", marginBottom: "12px" }}>
                  <input
                    type="text"
                    placeholder="Search help articles..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="rv-input"
                    style={{
                      width: "100%",
                      paddingLeft: "32px",
                      fontSize: "12.5px",
                      height: "34px",
                      boxSizing: "border-box",
                    }}
                  />
                  <span
                    style={{
                      position: "absolute",
                      left: "10px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      color: "var(--rv-text-subdued)",
                      display: "flex",
                      pointerEvents: "none",
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                  </span>
                </div>

                <div style={{ display: "flex", flexDirection: "column" }}>
                  {filteredFaqs.length === 0 ? (
                    <div style={{ textAlign: "center", padding: "24px 12px", color: "var(--rv-text-subdued)", fontSize: "12px" }}>
                      No matching articles found. Switch to the <strong>Submit Ticket</strong> tab to ask us directly!
                    </div>
                  ) : (
                    filteredFaqs.map((faq, idx) => {
                      const isExpanded = expandedFaq === idx;
                      return (
                        <div key={idx} className="rv-support-faq-item">
                          <button
                            type="button"
                            className="rv-support-faq-q"
                            onClick={() => setExpandedFaq(isExpanded ? null : idx)}
                            aria-expanded={isExpanded}
                          >
                            <span style={{ fontSize: "12px", lineHeight: 1.3 }}>{faq.title}</span>
                            <span style={{ color: "var(--rv-text-subdued)", flexShrink: 0 }}>
                              {isExpanded ? (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="18 15 12 9 6 15" />
                                </svg>
                              ) : (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="6 9 12 15 18 9" />
                                </svg>
                              )}
                            </span>
                          </button>
                          {isExpanded && <div className="rv-support-faq-ans">{faq.body}</div>}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Drawer Footer */}
          <div className="rv-support-drawer-footer">
            <span>
              Direct Email:{" "}
              <a href="mailto:support@revertly.app" target="_blank" rel="noreferrer">
                support@revertly.app
              </a>
            </span>
            <Link
              to="/app/support"
              onClick={() => setIsOpen(false)}
              style={{ fontWeight: 600 }}
            >
              Open Support Page &rarr;
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
