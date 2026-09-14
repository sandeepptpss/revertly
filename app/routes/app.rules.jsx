import { useState } from "react";
import { useLoaderData, useFetcher, useRouteError, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { checkRuleLimit } from "../billing.server.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [rules, limitInfo] = await Promise.all([
    prisma.detectionRule.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
    }),
    checkRuleLimit(shop),
  ]);

  return { rules, limitInfo };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "create") {
    // 1. Enforce Plan Limits
    const limitCheck = await checkRuleLimit(shop);
    if (!limitCheck.allowed) {
      return {
        success: false,
        message: `Active Detection Rule Limit Reached (${limitCheck.activeCount} / ${limitCheck.limit}) for your ${limitCheck.plan.toUpperCase()} plan. Deactivate unused rules or upgrade your plan in Plans & Billing to create more active rules.`,
      };
    }

    await prisma.detectionRule.create({
      data: {
        shop,
        name: formData.get("name"),
        field: formData.get("field"),
        condition: formData.get("condition"),
        threshold: formData.get("threshold") ? parseFloat(formData.get("threshold")) : null,
        minProducts: formData.get("minProducts") ? parseInt(formData.get("minProducts")) : null,
        windowMinutes: formData.get("windowMinutes") ? parseInt(formData.get("windowMinutes")) : 10,
        severity: formData.get("severity") || "HIGH",
        isActive: true,
      },
    });
    return { success: true, message: "Rule created successfully." };
  }

  if (intent === "toggle") {
    const ruleId = parseInt(formData.get("ruleId"));
    const rule = await prisma.detectionRule.findUnique({ where: { id: ruleId } });
    if (rule && rule.shop === shop) {
      const willBeActive = !rule.isActive;

      // Check limit before activating an inactive rule
      if (willBeActive) {
        const limitCheck = await checkRuleLimit(shop);
        if (!limitCheck.allowed) {
          return {
            success: false,
            message: `Active Detection Rule Limit Reached (${limitCheck.activeCount} / ${limitCheck.limit}) for your ${limitCheck.plan.toUpperCase()} plan. Deactivate another rule or upgrade your plan to activate this rule.`,
          };
        }
      }

      await prisma.detectionRule.update({
        where: { id: ruleId },
        data: { isActive: willBeActive },
      });
      return { success: true, message: `Rule "${rule.name}" is now ${willBeActive ? "Active" : "Inactive"}.` };
    }
    return { success: true, message: "Rule status updated." };
  }

  if (intent === "delete") {
    const ruleId = parseInt(formData.get("ruleId"));
    const rule = await prisma.detectionRule.findUnique({ where: { id: ruleId } });
    if (rule && rule.shop === shop) {
      await prisma.detectionRule.delete({ where: { id: ruleId } });
    }
    return { success: true, message: "Rule deleted." };
  }

  return { success: false, message: "Action failed." };
};

const FIELDS = ["price", "compareAtPrice", "title", "status", "vendor", "tags", "sku", "inventory"];
const CONDITIONS = ["CHANGED", "DECREASE_BY_PERCENT", "INCREASE_BY_PERCENT"];
const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

export default function Rules() {
  const { rules, limitInfo } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const isSaving = fetcher.state !== "idle";
  const [showCreateForm, setShowCreateForm] = useState(false);

  return (
    <s-page heading="Detection Rules" inlineSize="large">

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

      {/* ── Limit Warning Banner ── */}
      {!limitInfo?.allowed && (
        <div
          style={{
            background: "#fff4f2",
            border: "1px solid #fed2cd",
            color: "#d72c0d",
            padding: "12px 18px",
            borderRadius: "var(--rv-radius-md)",
            marginBottom: "20px",
            fontSize: "13px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <strong>Active Rule Limit Reached ({limitInfo.activeCount} / {limitInfo.limit}):</strong> You have reached the maximum active detection rules allowed for the {limitInfo.plan.toUpperCase()} plan. Deactivate unused rules or upgrade to a higher tier.
          </div>
          <Link to="/app/plan" className="rv-btn rv-btn-primary" style={{ fontSize: "12px", padding: "6px 12px" }}>
            Upgrade Plan
          </Link>
        </div>
      )}

      {/* ── Top Header Hero ── */}
      <div className="rv-hero-banner">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
            <strong style={{ fontSize: "16px", color: "var(--rv-text)" }}>
              Automated Anomaly &amp; Crash Detection
            </strong>
            <span className="rv-badge rv-badge-info">
              {limitInfo?.activeCount} / {limitInfo?.limit === Infinity ? "Unlimited" : limitInfo?.limit} Active Rules Used
            </span>
          </div>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
            Define automated guardrails to instantly detect unauthorized price cuts, bulk tag wipes, or accidental status changes.
          </p>
        </div>

        <button
          type="button"
          disabled={!limitInfo?.allowed}
          onClick={() => setShowCreateForm(!showCreateForm)}
          className={`rv-btn ${limitInfo?.allowed ? "rv-btn-primary" : "rv-btn-secondary"}`}
          title={!limitInfo?.allowed ? "Plan limit reached" : ""}
        >
          {showCreateForm ? "✕ Close Form" : !limitInfo?.allowed ? "Limit Reached" : "+ Create New Rule"}
        </button>
      </div>

      {/* ── Create Rule Form ── */}
      {showCreateForm && (
        <div className="rv-card" style={{ border: "2px solid #005bd3", marginBottom: "24px" }}>
          <div className="rv-card-header" style={{ background: "var(--rv-info-surface)" }}>
            <h3 className="rv-card-title" style={{ color: "#0045a1" }}>
              <span>⚙️</span> New Catalog Anomaly Rule
            </h3>
            <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
              Evaluated on every product update event
            </span>
          </div>

          <div className="rv-card-body">
            <fetcher.Form method="POST" onSubmit={() => setShowCreateForm(false)}>
              <input type="hidden" name="intent" value="create" />

              <div className="rv-form-field">
                <label className="rv-form-label">Rule Name *</label>
                <input
                  type="text"
                  name="name"
                  required
                  placeholder="e.g. Severe Price Crash (≥ 30% drop)"
                  className="rv-input"
                />
                <span className="rv-form-help">Clear label describing the trigger condition.</span>
              </div>

              <div className="rv-form-grid" style={{ marginBottom: "16px" }}>
                <div className="rv-form-field">
                  <label className="rv-form-label">Monitored Field</label>
                  <select name="field" className="rv-select">
                    {FIELDS.map((f) => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                </div>

                <div className="rv-form-field">
                  <label className="rv-form-label">Trigger Condition</label>
                  <select name="condition" className="rv-select">
                    {CONDITIONS.map((c) => (
                      <option key={c} value={c}>{c.replace(/_/g, " ")}</option>
                    ))}
                  </select>
                </div>

                <div className="rv-form-field">
                  <label className="rv-form-label">Severity Level</label>
                  <select name="severity" className="rv-select" defaultValue="HIGH">
                    {SEVERITIES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="rv-form-grid" style={{ marginBottom: "20px" }}>
                <div className="rv-form-field">
                  <label className="rv-form-label">Threshold (%)</label>
                  <input
                    type="number"
                    name="threshold"
                    placeholder="30"
                    className="rv-input"
                  />
                  <span className="rv-form-help">For percentage increases or drops.</span>
                </div>

                <div className="rv-form-field">
                  <label className="rv-form-label">Min Affected Products</label>
                  <input
                    type="number"
                    name="minProducts"
                    placeholder="10"
                    className="rv-input"
                  />
                  <span className="rv-form-help">Minimum products to trigger incident.</span>
                </div>

                <div className="rv-form-field">
                  <label className="rv-form-label">Time Window (Minutes)</label>
                  <input
                    type="number"
                    name="windowMinutes"
                    defaultValue="10"
                    className="rv-input"
                  />
                  <span className="rv-form-help">Aggregation window in minutes.</span>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="rv-btn rv-btn-primary"
                  style={{ fontWeight: 600, padding: "10px 20px" }}
                >
                  {isSaving ? "Saving Rule..." : "Save Detection Rule"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="rv-btn rv-btn-secondary"
                >
                  Cancel
                </button>
              </div>
            </fetcher.Form>
          </div>
        </div>
      )}

      {/* ── Rules List / Empty State ── */}
      {rules.length === 0 ? (
        <div className="rv-empty-state">
          <div className="rv-empty-icon-circle">⚙️</div>
          <div className="rv-empty-title">No Custom Detection Rules Configured</div>
          <div className="rv-empty-desc">
            Detection rules monitor for sudden price drops, unauthorized product deletions, or bulk changes by apps.
          </div>
          <button
            type="button"
            onClick={() => setShowCreateForm(true)}
            className="rv-btn rv-btn-primary"
          >
            + Create Your First Detection Rule
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {rules.map((rule) => {
            const isCritical = rule.severity === "CRITICAL";

            return (
              <div
                key={rule.id}
                className="rv-card"
                style={{
                  borderLeft: `4px solid ${
                    isCritical ? "var(--rv-critical)" : rule.isActive ? "var(--rv-primary)" : "var(--rv-border)"
                  }`,
                  margin: 0,
                  opacity: rule.isActive ? 1 : 0.75,
                }}
              >
                <div
                  className="rv-card-body"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: "16px",
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                      <strong style={{ fontSize: "15px", color: "var(--rv-text)" }}>
                        {rule.name}
                      </strong>
                      <span
                        className={`rv-badge ${
                          rule.severity === "CRITICAL"
                            ? "rv-badge-critical"
                            : rule.severity === "HIGH"
                            ? "rv-badge-warning"
                            : "rv-badge-info"
                        }`}
                      >
                        {rule.severity}
                      </span>
                      <span className={`rv-badge ${rule.isActive ? "rv-badge-success" : "rv-badge-neutral"}`}>
                        {rule.isActive ? "Active" : "Disabled"}
                      </span>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginTop: "2px" }}>
                      <span className="rv-badge rv-badge-neutral">Field: {rule.field}</span>
                      <span className="rv-badge rv-badge-warning">
                        Condition: {rule.condition.replace(/_/g, " ")}{rule.threshold ? ` (≥ ${rule.threshold}%)` : ""}
                      </span>
                      {rule.minProducts && (
                        <span className="rv-badge rv-badge-neutral">{rule.minProducts}+ products</span>
                      )}
                      {rule.windowMinutes && (
                        <span className="rv-badge rv-badge-neutral">within {rule.windowMinutes}m</span>
                      )}
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <fetcher.Form method="POST" style={{ display: "inline" }}>
                      <input type="hidden" name="intent" value="toggle" />
                      <input type="hidden" name="ruleId" value={rule.id} />
                      <button
                        type="submit"
                        className="rv-btn rv-btn-secondary"
                        style={{ fontSize: "13px" }}
                      >
                        {rule.isActive ? "⏸️ Disable" : "▶️ Enable"}
                      </button>
                    </fetcher.Form>

                    <fetcher.Form method="POST" style={{ display: "inline" }}>
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="ruleId" value={rule.id} />
                      <button
                        type="submit"
                        onClick={(e) => {
                          if (!confirm(`Delete rule "${rule.name}"?`)) {
                            e.preventDefault();
                          }
                        }}
                        className="rv-btn rv-btn-subtle"
                        style={{ fontSize: "13px", color: "var(--rv-critical)" }}
                      >
                        Delete
                      </button>
                    </fetcher.Form>
                  </div>
                </div>
              </div>
            );
          })}
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
