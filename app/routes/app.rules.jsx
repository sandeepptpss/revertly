import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useRouteError, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { checkRuleLimit } from "../billing.server.js";
import {
  FilterIcon,
  Trash2Icon,
  SparklesIcon,
} from "../components/Icons.jsx";
import { Banner } from "../components/Banner.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";
import { HubNav } from "../components/HubNav.jsx";
import { Pagination, usePagination } from "../components/Pagination.jsx";
import { checkPermission, PERMISSIONS } from "../team.server.js";

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
  try {
    const { session } = await authenticate.admin(request);
    const shop = session.shop;

    const perm = await checkPermission(shop, session, PERMISSIONS.SETTINGS_WRITE);
    if (!perm.allowed) return { success: false, message: perm.message };

    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent === "create") {
      const limitCheck = await checkRuleLimit(shop);
      if (!limitCheck.allowed) {
        return {
          success: false,
          message: `Active Detection Rule Limit Reached (${limitCheck.activeCount} / ${limitCheck.limit}) for your ${limitCheck.plan.toUpperCase()} plan. Deactivate unused rules or upgrade your plan in Plans & Billing to create more active rules.`,
        };
      }

      const name = formData.get("name")?.trim();
      if (!name) {
        return { success: false, message: "Rule name is required." };
      }

      const field = formData.get("field") || "price";
      const condition = formData.get("condition") || "CHANGED";

      const rawThreshold = formData.get("threshold");
      const parsedThreshold = rawThreshold && String(rawThreshold).trim() !== "" ? parseFloat(String(rawThreshold).trim()) : null;
      const threshold = Number.isFinite(parsedThreshold) ? parsedThreshold : null;

      const rawMinProducts = formData.get("minProducts");
      const parsedMin = rawMinProducts && String(rawMinProducts).trim() !== "" ? parseInt(String(rawMinProducts).trim(), 10) : null;
      const minProducts = Number.isFinite(parsedMin) && parsedMin > 0 ? parsedMin : null;

      const rawWindow = formData.get("windowMinutes");
      const parsedWindow = rawWindow && String(rawWindow).trim() !== "" ? parseInt(String(rawWindow).trim(), 10) : 10;
      const windowMinutes = Number.isFinite(parsedWindow) && parsedWindow > 0 ? parsedWindow : 10;

      const severity = formData.get("severity") || "HIGH";

      await prisma.detectionRule.create({
        data: {
          shop,
          name,
          field,
          condition,
          threshold,
          minProducts,
          windowMinutes,
          severity,
          isActive: true,
        },
      });
      return { success: true, message: `Detection rule "${name}" created successfully.` };
    }

    if (intent === "toggle") {
      const rawRuleId = formData.get("ruleId");
      const ruleId = parseInt(String(rawRuleId || "").trim(), 10);
      if (!Number.isFinite(ruleId)) {
        return { success: false, message: "Invalid rule identifier." };
      }

      const rule = await prisma.detectionRule.findUnique({ where: { id: ruleId } });
      if (!rule || rule.shop !== shop) {
        return { success: false, message: "Detection rule not found." };
      }

      const willBeActive = !rule.isActive;

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
      return { success: true, message: `Rule "${rule.name}" is now ${willBeActive ? "Active" : "Disabled"}.` };
    }

    if (intent === "delete") {
      const rawRuleId = formData.get("ruleId");
      const ruleId = parseInt(String(rawRuleId || "").trim(), 10);
      if (!Number.isFinite(ruleId)) {
        return { success: false, message: "Invalid rule identifier." };
      }

      const rule = await prisma.detectionRule.findUnique({ where: { id: ruleId } });
      if (!rule || rule.shop !== shop) {
        return { success: false, message: "Detection rule not found." };
      }

      // Disconnect triggeredRuleId on any incidents first to satisfy foreign key constraint
      await prisma.incident.updateMany({
        where: { triggeredRuleId: ruleId },
        data: { triggeredRuleId: null },
      });
      await prisma.detectionRule.delete({ where: { id: ruleId } });
      return { success: true, message: `Rule "${rule.name}" deleted successfully.` };
    }

    if (intent === "seed_defaults") {
      const { seedDefaultDetectionRules } = await import("../monitor.server.js");
      const created = await seedDefaultDetectionRules(shop);
      return {
        success: true,
        message: created.length > 0
          ? `Created ${created.length} recommended detection rules.`
          : "Recommended rules are already configured.",
      };
    }

    return { success: false, message: "Unknown action intent." };
  } catch (err) {
    console.error("[Revertly Rules Error] Action failed:", err);
    return {
      success: false,
      message: `Failed to process rule request: ${err?.message || "An unexpected error occurred."}`,
    };
  }
};

const FIELDS = [
  { value: "price", label: "Price (Variant Price)" },
  { value: "compareAtPrice", label: "Compare-At Price" },
  { value: "inventory", label: "Inventory Quantity" },
  { value: "status", label: "Product Status (Active / Draft / Archived)" },
  { value: "title", label: "Product Title" },
  { value: "vendor", label: "Vendor" },
  { value: "tags", label: "Tags" },
  { value: "sku", label: "SKU" },
];
const CONDITIONS = ["CHANGED", "DECREASE_BY_PERCENT", "INCREASE_BY_PERCENT"];
const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

export default function Rules() {
  const { rules, limitInfo } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const isSaving = fetcher.state !== "idle";
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [selectedCondition, setSelectedCondition] = useState("CHANGED");
  const [deleteRuleTarget, setDeleteRuleTarget] = useState(null);

  const isDeletingRule = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "delete";

  useEffect(() => {
    if (result?.success && showCreateForm) {
      setShowCreateForm(false);
    }
    if (result && !isDeletingRule) {
      setDeleteRuleTarget(null);
    }
  }, [result, showCreateForm, isDeletingRule]);

  const handleDeleteRuleConfirm = () => {
    if (!deleteRuleTarget) return;
    fetcher.submit(
      { intent: "delete", ruleId: String(deleteRuleTarget.id) },
      { method: "POST" }
    );
  };

  const activeCount = limitInfo?.activeCount ?? 0;
  const maxLimit = limitInfo?.limit ?? Infinity;
  const isLimitReached = !limitInfo?.allowed;
  const quotaPercent = maxLimit === Infinity ? 0 : Math.min(100, Math.round((activeCount / maxLimit) * 100));

  const {
    currentPage,
    setCurrentPage,
    pageSize,
    setPageSize,
    paginatedItems: pagedRules,
    totalItems,
  } = usePagination(rules, 10);

  return (
    <s-page heading="Detection Rules" inlineSize="large">
      <HubNav hub="protection" activeTab="rules" />

      {/* ── Action Result Banner ── */}
      {result?.message && (
        <Banner
          tone={result.success ? "success" : "critical"}
          title={result.success ? "Rule Updated" : "Rule Error"}
        >
          {result.message}
        </Banner>
      )}

      {/* ── Limit Warning Banner ── */}
      {isLimitReached && (
        <Banner
          tone="warning"
          title={`Active Rule Limit Reached (${activeCount} / ${maxLimit})`}
          action={
            <Link to="/app/plan" className="rv-btn rv-btn-primary rv-btn-sm">
              Upgrade Plan
            </Link>
          }
        >
          You have reached the maximum active detection rules allowed for the {limitInfo?.plan?.toUpperCase()} plan. Deactivate unused rules or upgrade to a higher tier.
        </Banner>
      )}

      {/* ── Top Header Hero ── */}
      <div className="rv-hero-banner">
        <div style={{ maxWidth: "680px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px", flexWrap: "wrap" }}>
            <strong style={{ fontSize: "17px", color: "var(--rv-text)", fontWeight: 700 }}>
              Automated Anomaly &amp; Crash Detection
            </strong>
            <span className="rv-badge rv-badge-info">
              {maxLimit === Infinity ? "Unlimited Rules" : `${activeCount} / ${maxLimit} Active Rules Used`}
            </span>
          </div>
          <p style={{ margin: "0 0 10px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
            Define automated guardrails to instantly quarantine unauthorized price crashes, bulk inventory wipes, or accidental status changes.
          </p>

          {maxLimit !== Infinity && (
            <div style={{ maxWidth: "320px" }}>
              <div className="rv-progress-track">
                <div
                  className="rv-progress-fill"
                  style={{
                    width: `${quotaPercent}%`,
                    background: quotaPercent >= 100 ? "var(--rv-critical)" : quotaPercent >= 80 ? "var(--rv-warning)" : "var(--rv-primary)",
                  }}
                />
              </div>
            </div>
          )}
        </div>

        <div>
          <button
            type="button"
            disabled={isLimitReached}
            onClick={() => setShowCreateForm(!showCreateForm)}
            className={`rv-btn rv-btn-lg ${!isLimitReached ? "rv-btn-primary" : "rv-btn-secondary"}`}
          >
            <FilterIcon size={16} />
            <span>{showCreateForm ? "✕ Close Form" : "+ Create New Rule"}</span>
          </button>
        </div>
      </div>

      {/* ── Create Rule Form ── */}
      {showCreateForm && (
        <div className="rv-card" style={{ border: "2px solid var(--rv-info)", marginBottom: "24px" }}>
          <div className="rv-card-header" style={{ background: "var(--rv-info-surface)" }}>
            <h3 className="rv-card-title" style={{ color: "var(--rv-info-text)" }}>
              <SparklesIcon size={18} />
              <span>New Catalog Anomaly Rule</span>
            </h3>
            <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
              Evaluated automatically on every product update event
            </span>
          </div>

          <div className="rv-card-body">
            <fetcher.Form method="POST">
              <input type="hidden" name="intent" value="create" />

              <div className="rv-form-field">
                <label htmlFor="rule-name" className="rv-form-label">Rule Name *</label>
                <input
                  id="rule-name"
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
                  <label htmlFor="rule-field" className="rv-form-label">Monitored Field</label>
                  <select id="rule-field" name="field" className="rv-select">
                    {FIELDS.map((f) => (
                      <option key={f.value} value={f.value}>{f.label}</option>
                    ))}
                  </select>
                </div>

                <div className="rv-form-field">
                  <label htmlFor="rule-condition" className="rv-form-label">Trigger Condition</label>
                  <select
                    id="rule-condition"
                    name="condition"
                    className="rv-select"
                    value={selectedCondition}
                    onChange={(e) => setSelectedCondition(e.target.value)}
                  >
                    {CONDITIONS.map((c) => (
                      <option key={c} value={c}>{c.replace(/_/g, " ")}</option>
                    ))}
                  </select>
                </div>

                <div className="rv-form-field">
                  <label htmlFor="rule-severity" className="rv-form-label">Severity Level</label>
                  <select id="rule-severity" name="severity" className="rv-select" defaultValue="HIGH">
                    {SEVERITIES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="rv-form-grid" style={{ marginBottom: "20px" }}>
                <div className="rv-form-field">
                  <label htmlFor="rule-threshold" className="rv-form-label">
                    Threshold (%){selectedCondition === "CHANGED" ? " — Not applicable" : ""}
                  </label>
                  <input
                    id="rule-threshold"
                    type="number"
                    name="threshold"
                    placeholder={selectedCondition === "CHANGED" ? "N/A for direct changes" : "30"}
                    disabled={selectedCondition === "CHANGED"}
                    className="rv-input"
                  />
                  <span className="rv-form-help">
                    {selectedCondition === "CHANGED"
                      ? "Direct change detection triggers whenever the field is modified."
                      : "Triggers when percentage increase or decrease exceeds this value."}
                  </span>
                </div>

                <div className="rv-form-field">
                  <label htmlFor="rule-minProducts" className="rv-form-label">Min Affected Products</label>
                  <input
                    id="rule-minProducts"
                    type="number"
                    name="minProducts"
                    placeholder="1"
                    min="1"
                    className="rv-input"
                  />
                  <span className="rv-form-help">Leave blank or set to 1 for instant single-product anomaly alerts; set higher (e.g. 5) for bulk-only aggregation.</span>
                </div>

                <div className="rv-form-field">
                  <label htmlFor="rule-windowMinutes" className="rv-form-label">Time Window (Minutes)</label>
                  <input
                    id="rule-windowMinutes"
                    type="number"
                    name="windowMinutes"
                    defaultValue="10"
                    min="1"
                    className="rv-input"
                  />
                  <span className="rv-form-help">Aggregation window in minutes.</span>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "12px", paddingTop: "8px", borderTop: "1px solid var(--rv-border)" }}>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="rv-btn rv-btn-primary rv-btn-lg"
                >
                  <FilterIcon size={15} />
                  <span>{isSaving ? "Saving Rule..." : "Save Detection Rule"}</span>
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
        <EmptyState
          icon={<FilterIcon size={28} style={{ color: "var(--rv-info)" }} />}
          title="No Custom Detection Rules Configured"
          description="Detection rules monitor your store 24/7 for sudden price drops, unauthorized product deletions, or bulk changes by external apps."
          action={
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", justifyContent: "center" }}>
              <fetcher.Form method="POST">
                <input type="hidden" name="intent" value="seed_defaults" />
                <button
                  type="submit"
                  disabled={isSaving}
                  className="rv-btn rv-btn-primary"
                >
                  <SparklesIcon size={15} />
                  <span>{isSaving ? "Adding..." : "Add Recommended Rules"}</span>
                </button>
              </fetcher.Form>
              <button
                type="button"
                onClick={() => setShowCreateForm(true)}
                className="rv-btn rv-btn-secondary"
              >
                <FilterIcon size={15} />
                <span>Create Custom Rule</span>
              </button>
            </div>
          }
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {pagedRules.map((rule) => {
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
                        className={`rv-badge rv-badge-sm ${
                          rule.severity === "CRITICAL"
                            ? "rv-badge-critical"
                            : rule.severity === "HIGH"
                            ? "rv-badge-warning"
                            : "rv-badge-info"
                        }`}
                      >
                        {rule.severity}
                      </span>
                      <span className={`rv-badge rv-badge-sm ${rule.isActive ? "rv-badge-success" : "rv-badge-neutral"}`}>
                        {rule.isActive ? "Active" : "Disabled"}
                      </span>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginTop: "2px" }}>
                      <span className="rv-badge rv-badge-neutral rv-badge-sm">Field: {rule.field}</span>
                      <span className="rv-badge rv-badge-warning rv-badge-sm">
                        Condition: {rule.condition.replace(/_/g, " ")}
                        {rule.condition !== "CHANGED" && rule.threshold != null ? ` (≥ ${rule.threshold}%)` : ""}
                      </span>
                      {rule.minProducts && (
                        <span className="rv-badge rv-badge-neutral rv-badge-sm">{rule.minProducts}+ products</span>
                      )}
                      {rule.windowMinutes && (
                        <span className="rv-badge rv-badge-neutral rv-badge-sm">within {rule.windowMinutes}m</span>
                      )}
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <fetcher.Form method="POST" style={{ display: "inline" }}>
                      <input type="hidden" name="intent" value="toggle" />
                      <input type="hidden" name="ruleId" value={rule.id} />
                      <button
                        type="submit"
                        className="rv-btn rv-btn-secondary rv-btn-sm"
                      >
                        {rule.isActive ? "Disable" : "Enable"}
                      </button>
                    </fetcher.Form>

                    <button
                      type="button"
                      onClick={() => setDeleteRuleTarget(rule)}
                      className="rv-btn rv-btn-subtle rv-btn-sm"
                      style={{ color: "var(--rv-critical)" }}
                    >
                      <Trash2Icon size={14} />
                      <span>Delete</span>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}

          <Pagination
            currentPage={currentPage}
            totalItems={totalItems}
            pageSize={pageSize}
            onPageChange={setCurrentPage}
            onPageSizeChange={setPageSize}
            itemLabel="rules"
          />
        </div>
      )}

      {/* ── Delete Detection Rule Modal ── */}
      <ConfirmModal
        isOpen={Boolean(deleteRuleTarget)}
        title="Delete Detection Rule"
        message={
          deleteRuleTarget ? (
            <>
              Are you sure you want to delete the detection rule{" "}
              <strong>&ldquo;{deleteRuleTarget.name}&rdquo;</strong>?
            </>
          ) : null
        }
        dangerNote="Automated anomaly checks for this rule will immediately stop running. Any previously logged incidents will remain in your activity feed."
        confirmLabel="Delete Rule"
        submittingLabel="Deleting..."
        tone="critical"
        isSubmitting={isDeletingRule}
        onConfirm={handleDeleteRuleConfirm}
        onClose={() => {
          if (!isDeletingRule) setDeleteRuleTarget(null);
        }}
      />

    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
