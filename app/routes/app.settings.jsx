import { useState } from "react";
import { useLoaderData, useFetcher, useRouteError, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { getOrCreateSettings } from "../monitor.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { checkFeatureAccess } from "../billing.server.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [settings, cbAccess, slackAccess] = await Promise.all([
    getOrCreateSettings(shop),
    checkFeatureAccess(shop, "circuitBreaker"),
    checkFeatureAccess(shop, "slack"),
  ]);

  return {
    settings,
    hasCircuitBreakerAccess: cbAccess.allowed,
    hasSlackAccess: slackAccess.allowed,
    plan: cbAccess.plan,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "testSlack") {
    const slackCheck = await checkFeatureAccess(shop, "slack");
    if (!slackCheck.allowed) {
      return {
        success: false,
        message: `Slack Alerts require the Business ($49) or Enterprise ($79) plan. Please upgrade your plan in Plans & Billing to enable Slack webhooks.`,
      };
    }

    const slackUrl = formData.get("slackWebhookUrl");
    if (!slackUrl) {
      return { success: false, message: "Please provide a Slack Webhook URL first." };
    }
    try {
      const resp = await fetch(slackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "*[Revertly Test Notification]*",
          attachments: [
            {
              color: "#008060",
              title: "Slack Alerts Connected Successfully!",
              text: `Revertly is active for ${shop}. Critical price drops and anomaly incidents will be delivered to this channel in real time.`,
              footer: "Revertly Product Guard",
              ts: Math.floor(Date.now() / 1000),
            },
          ],
        }),
      });
      if (resp.ok) {
        return { success: true, message: "Test Slack alert delivered successfully!" };
      } else {
        return { success: false, message: `Slack webhook responded with status ${resp.status}` };
      }
    } catch (err) {
      return { success: false, message: `Failed to deliver Slack alert: ${err.message}` };
    }
  }

  const [cbCheck, slackCheck] = await Promise.all([
    checkFeatureAccess(shop, "circuitBreaker"),
    checkFeatureAccess(shop, "slack"),
  ]);

  const requestedCb = formData.get("circuitBreakerEnabled") === "true";
  if (requestedCb && !cbCheck.allowed) {
    return {
      success: false,
      message: `Emergency Circuit Breaker is only available on Business ($49) and Enterprise ($79) plans. Upgrade your plan to enable automatic protection.`,
    };
  }

  const requestedSlack = Boolean(formData.get("slackWebhookUrl") && formData.get("slackWebhookUrl").trim() !== "");
  if (requestedSlack && !slackCheck.allowed) {
    return {
      success: false,
      message: `Slack Webhook Alerts are only available on Business ($49) and Enterprise ($79) plans. Upgrade your plan to connect Slack channels.`,
    };
  }

  await prisma.appSettings.update({
    where: { shop },
    data: {
      alertEmail: formData.get("alertEmail") || null,
      alertOnCritical: formData.get("alertOnCritical") === "true",
      alertOnHigh: formData.get("alertOnHigh") === "true",
      alertOnMedium: formData.get("alertOnMedium") === "true",
      monitoringEnabled: formData.get("monitoringEnabled") === "true",
      bulkThreshold: parseInt(formData.get("bulkThreshold") || "20"),
      bulkWindowMinutes: parseInt(formData.get("bulkWindowMinutes") || "10"),
      slackWebhookUrl: slackCheck.allowed ? (formData.get("slackWebhookUrl") || null) : null,
      circuitBreakerEnabled: cbCheck.allowed ? requestedCb : false,
      circuitBreakerThreshold: parseInt(formData.get("circuitBreakerThreshold") || "50"),
      circuitBreakerAction: formData.get("circuitBreakerAction") || "DRAFT",
    },
  });

  return { success: true, message: "Settings saved successfully." };
};

export default function Settings() {
  const { settings } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const isSaving = fetcher.state !== "idle";
  const [slackUrl, setSlackUrl] = useState(settings.slackWebhookUrl || "");

  return (
    <s-page heading="Settings" inlineSize="large">

      {/* ── Action Result Banner ── */}
      {result?.message && (
        <div
          style={{
            background: result.success ? "var(--rv-primary-surface)" : "var(--rv-critical-surface)",
            border: `1px solid ${result.success ? "var(--rv-primary-border)" : "var(--rv-critical-border)"}`,
            color: result.success ? "var(--rv-primary)" : "var(--rv-critical)",
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
          <span>{result.success ? "✅" : "⚠️"}</span>
          <span>{result.message}</span>
        </div>
      )}

      <fetcher.Form method="POST">
        <input type="hidden" name="intent" value="save" />

        {/* ── Top Header & Save CTA ── */}
        <div className="rv-hero-banner">
          <div>
            <strong style={{ fontSize: "16px", color: "var(--rv-text)" }}>
              Protection Configuration &amp; Alert Routing
            </strong>
            <p style={{ margin: "4px 0 0", fontSize: "13px", color: "var(--rv-text-subdued)" }}>
              Configure automatic catalog watchdog filters, price crash circuit breakers, and emergency alert channels.
            </p>
          </div>
          <button
            type="submit"
            disabled={isSaving}
            className="rv-btn rv-btn-primary"
            style={{ fontWeight: 600, padding: "10px 22px" }}
          >
            {isSaving ? "Saving..." : "Save All Settings"}
          </button>
        </div>

        {/* ── 1. Catalog Monitoring ── */}
        <div className="rv-card">
          <div className="rv-card-header">
            <h3 className="rv-card-title">
              <span>📡</span> Real-Time Catalog Monitoring
            </h3>
          </div>
          <div className="rv-card-body">
            <label className="rv-toggle-row" style={{ background: "#ffffff", padding: "14px 16px" }}>
              <input
                type="checkbox"
                name="monitoringEnabled"
                value="true"
                defaultChecked={settings.monitoringEnabled}
                style={{ width: "18px", height: "18px", marginTop: "2px" }}
              />
              <div>
                <strong style={{ fontSize: "14px", color: "var(--rv-text)" }}>
                  Enable Real-Time Catalog Monitoring
                </strong>
                <p style={{ margin: "4px 0 0", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                  When enabled, Revertly listens to instant Shopify product updates and deletion events to capture baseline drifts, unauthorized price changes, and inventory discrepancies in real time.
                </p>
              </div>
            </label>
          </div>
        </div>

        {/* ── 2. Emergency Circuit Breaker ── */}
        <div className="rv-card" style={{ opacity: hasCircuitBreakerAccess ? 1 : 0.85 }}>
          <div className="rv-card-header">
            <h3 className="rv-card-title">
              <span>⚡</span> Emergency Circuit Breaker (Price Crash Guard)
            </h3>
            {hasCircuitBreakerAccess ? (
              <span className="rv-badge rv-badge-warning">Revenue Protection</span>
            ) : (
              <span className="rv-badge rv-badge-neutral">Requires Business Plan ($49/mo)</span>
            )}
          </div>
          <div className="rv-card-body">
            {!hasCircuitBreakerAccess && (
              <div
                style={{
                  background: "#fff4f2",
                  border: "1px solid #fed2cd",
                  borderRadius: "var(--rv-radius-sm)",
                  padding: "10px 14px",
                  fontSize: "12px",
                  color: "#d72c0d",
                  marginBottom: "16px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <span>🔒 Emergency Circuit Breaker requires the Business or Enterprise tier to automate product auto-drafting.</span>
                <Link to="/app/plan" className="rv-btn rv-btn-primary" style={{ fontSize: "11px", padding: "4px 10px" }}>
                  Upgrade
                </Link>
              </div>
            )}

            <p style={{ fontSize: "13px", color: "var(--rv-text-subdued)", margin: "0 0 16px", lineHeight: 1.5 }}>
              Protect your store from catastrophic revenue loss. If a bulk CSV upload, third-party pricing app, or staff mistake drops prices below safe margins, the circuit breaker triggers immediate defensive action.
            </p>

            <label className="rv-toggle-row" style={{ background: "#ffffff", padding: "14px 16px", marginBottom: "16px", cursor: hasCircuitBreakerAccess ? "pointer" : "not-allowed" }}>
              <input
                type="checkbox"
                name="circuitBreakerEnabled"
                value="true"
                disabled={!hasCircuitBreakerAccess}
                defaultChecked={hasCircuitBreakerAccess && settings.circuitBreakerEnabled}
                style={{ width: "18px", height: "18px", marginTop: "2px" }}
              />
              <div>
                <strong style={{ fontSize: "14px", color: "var(--rv-text)" }}>
                  Activate Price Crash Circuit Breaker
                </strong>
                <p style={{ margin: "4px 0 0", fontSize: "13px", color: "var(--rv-text-subdued)" }}>
                  Immediately intervene when a sudden price drop exceeds your defined safety percentage.
                </p>
              </div>
            </label>

            <div className="rv-form-grid" style={{ opacity: hasCircuitBreakerAccess ? 1 : 0.6 }}>
              <div className="rv-form-field">
                <label className="rv-form-label">Price Crash Trigger Threshold (%)</label>
                <input
                  type="number"
                  name="circuitBreakerThreshold"
                  disabled={!hasCircuitBreakerAccess}
                  defaultValue={String(settings.circuitBreakerThreshold || 50)}
                  className="rv-input"
                />
                <span className="rv-form-help">Trigger when variant price drops by this percentage or more.</span>
              </div>

              <div className="rv-form-field">
                <label className="rv-form-label">Emergency Defensive Action</label>
                <select
                  name="circuitBreakerAction"
                  disabled={!hasCircuitBreakerAccess}
                  defaultValue={settings.circuitBreakerAction || "DRAFT"}
                  className="rv-select"
                >
                  <option value="DRAFT">Set Product to DRAFT (Hide from storefront instantly)</option>
                  <option value="AUTO_REVERT">Auto-Revert Price (Restore previous baseline price)</option>
                </select>
                <span className="rv-form-help">Action taken automatically when a crash is detected.</span>
              </div>
            </div>
          </div>
        </div>

        {/* ── 3. Bulk Change Detection ── */}
        <div className="rv-card">
          <div className="rv-card-header">
            <h3 className="rv-card-title">
              <span>📦</span> Bulk Change Anomaly Detection
            </h3>
          </div>
          <div className="rv-card-body">
            <p style={{ fontSize: "13px", color: "var(--rv-text-subdued)", margin: "0 0 16px" }}>
              Automatically create a high-priority incident when more than the threshold of products are modified within a short burst window.
            </p>

            <div className="rv-form-grid">
              <div className="rv-form-field">
                <label className="rv-form-label">Bulk Product Threshold</label>
                <input
                  type="number"
                  name="bulkThreshold"
                  defaultValue={String(settings.bulkThreshold)}
                  className="rv-input"
                />
                <span className="rv-form-help">Trigger incident if this many products change...</span>
              </div>

              <div className="rv-form-field">
                <label className="rv-form-label">Time Window (Minutes)</label>
                <input
                  type="number"
                  name="bulkWindowMinutes"
                  defaultValue={String(settings.bulkWindowMinutes)}
                  className="rv-input"
                />
                <span className="rv-form-help">...within this number of minutes.</span>
              </div>
            </div>
          </div>
        </div>

        {/* ── 4. Alert Routing (Email & Slack) ── */}
        <div className="rv-card">
          <div className="rv-card-header">
            <h3 className="rv-card-title">
              <span>🔔</span> Alert Channels &amp; Notifications
            </h3>
          </div>
          <div className="rv-card-body">
            <div className="rv-form-field" style={{ marginBottom: "20px" }}>
              <label className="rv-form-label">Alert Email Address</label>
              <input
                type="email"
                name="alertEmail"
                defaultValue={settings.alertEmail || ""}
                placeholder="merchant@example.com"
                className="rv-input"
                style={{ maxWidth: "420px" }}
              />
              <span className="rv-form-help">Incidents and circuit breaker activations will be sent here.</span>
            </div>

            {/* Slack Webhook */}
            <div className="rv-form-field" style={{ marginBottom: "20px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                <label className="rv-form-label" style={{ margin: 0 }}>Slack Incoming Webhook URL</label>
                {!hasSlackAccess && (
                  <span className="rv-badge rv-badge-neutral" style={{ fontSize: "10px" }}>
                    Requires Business Plan ($49/mo)
                  </span>
                )}
              </div>

              {!hasSlackAccess ? (
                <div
                  style={{
                    background: "#fff4f2",
                    border: "1px solid #fed2cd",
                    borderRadius: "var(--rv-radius-sm)",
                    padding: "10px 14px",
                    fontSize: "12px",
                    color: "#d72c0d",
                    maxWidth: "600px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span>🔒 Real-time Slack Webhook alerts require the Business or Enterprise tier.</span>
                  <Link to="/app/plan" className="rv-btn rv-btn-primary" style={{ fontSize: "11px", padding: "4px 10px" }}>
                    Upgrade
                  </Link>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", maxWidth: "600px" }}>
                  <input
                    type="url"
                    name="slackWebhookUrl"
                    value={slackUrl}
                    onChange={(e) => setSlackUrl(e.target.value)}
                    placeholder="https://hooks.slack.com/services/T.../B.../..."
                    className="rv-input"
                    style={{ flexGrow: 1 }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      fetcher.submit(
                        { intent: "testSlack", slackWebhookUrl: slackUrl },
                        { method: "POST" }
                      );
                    }}
                    className="rv-btn rv-btn-secondary"
                  >
                    🔔 Send Test Alert
                  </button>
                </div>
              )}
              <span className="rv-form-help">Receive real-time notifications directly into your team&apos;s Slack channel.</span>
            </div>

            {/* Severity Checkboxes */}
            <div>
              <label className="rv-form-label" style={{ marginBottom: "8px", display: "block" }}>
                Notify on Incidents of Severity:
              </label>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    name="alertOnCritical"
                    value="true"
                    defaultChecked={settings.alertOnCritical}
                  />
                  <span>
                    <span className="rv-badge rv-badge-critical" style={{ marginRight: "6px" }}>CRITICAL</span>
                    Price crashes, mass deletions, and catastrophic errors
                  </span>
                </label>

                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    name="alertOnHigh"
                    value="true"
                    defaultChecked={settings.alertOnHigh}
                  />
                  <span>
                    <span className="rv-badge rv-badge-warning" style={{ marginRight: "6px" }}>HIGH</span>
                    Bulk discount anomalies and sudden variant updates
                  </span>
                </label>

                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    name="alertOnMedium"
                    value="true"
                    defaultChecked={settings.alertOnMedium}
                  />
                  <span>
                    <span className="rv-badge rv-badge-info" style={{ marginRight: "6px" }}>MEDIUM</span>
                    Moderate catalog changes exceeding defined rules
                  </span>
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* ── Bottom Save Button ── */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "32px" }}>
          <button
            type="submit"
            disabled={isSaving}
            className="rv-btn rv-btn-primary"
            style={{ fontWeight: 600, padding: "12px 28px", fontSize: "14px" }}
          >
            {isSaving ? "Saving Settings..." : "Save Settings"}
          </button>
        </div>

      </fetcher.Form>

    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
