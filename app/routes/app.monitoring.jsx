import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { checkService, validateServiceUrl, ensureDefaultServices } from "../uptime.server.js";
import { SERVICE_TYPES } from "../monitoring.constants.js";
import { checkPermission, logAudit, PERMISSIONS } from "../team.server.js";
import {
  ZapIcon,
  Trash2Icon,
  RefreshCwIcon,
  SparklesIcon,
  CheckCircleIcon,
  AlertTriangleIcon,
} from "../components/Icons.jsx";
import { Banner } from "../components/Banner.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  await ensureDefaultServices(shop);

  const services = await prisma.monitoredService.findMany({
    where: { shop },
    orderBy: { createdAt: "asc" },
  });

  const recentChecks = await prisma.downtimeCheck.findMany({
    where: { shop, isUp: false },
    orderBy: { checkedAt: "desc" },
    take: 25,
    include: { service: { select: { name: true } } },
  });

  return { services, recentChecks };
};

export const action = async ({ request }) => {
  try {
    const { session } = await authenticate.admin(request);
    const shop = session.shop;
    const formData = await request.formData();
    const intent = formData.get("intent");

    // Monitoring config is a settings-level change.
    const perm = await checkPermission(shop, session, PERMISSIONS.SETTINGS_WRITE);
    if (!perm.allowed) return { success: false, message: perm.message };

    if (intent === "add") {
      const name = formData.get("name")?.trim();
      const url = formData.get("url")?.trim();
      const serviceType = formData.get("serviceType") || "CUSTOM";
      const interval = parseInt(formData.get("checkIntervalMinutes"), 10) || 5;

      if (!name || !url) {
        return { success: false, message: "Name and URL are required." };
      }
      if (!SERVICE_TYPES.includes(serviceType)) {
        return { success: false, message: "Unknown service type." };
      }

      // Reject private/internal targets before they are ever stored.
      const validation = await validateServiceUrl(url);
      if (!validation.ok) {
        return { success: false, message: validation.error };
      }

      const service = await prisma.monitoredService.create({
        data: {
          shop,
          name,
          url: validation.url,
          serviceType,
          checkIntervalMinutes: Math.min(Math.max(interval, 1), 1440),
        },
      });

      await logAudit(shop, perm.actor, "MONITOR_SERVICE_ADDED", {
        resourceType: "MonitoredService",
        resourceId: service.id,
        details: { name, url: validation.url },
        request,
      });

      return { success: true, message: `Now monitoring "${name}".` };
    }

    if (intent === "check") {
      const id = parseInt(formData.get("serviceId"), 10);
      const service = await prisma.monitoredService.findFirst({ where: { id, shop } });
      if (!service) return { success: false, message: "Service not found." };

      const res = await checkService(service);
      return {
        success: true,
        message: `${service.name}: ${res.status}${
          res.statusCode ? ` (HTTP ${res.statusCode}, ${res.responseTimeMs}ms)` : ""
        }${res.errorMessage ? ` — ${res.errorMessage}` : ""}`,
      };
    }

    if (intent === "remove") {
      const id = parseInt(formData.get("serviceId"), 10);
      const service = await prisma.monitoredService.findFirst({ where: { id, shop } });
      if (!service) return { success: false, message: "Service not found." };

      // Checks cascade on delete via the schema relation.
      await prisma.monitoredService.delete({ where: { id } });
      await logAudit(shop, perm.actor, "MONITOR_SERVICE_REMOVED", {
        resourceType: "MonitoredService",
        resourceId: id,
        details: { name: service.name },
        request,
      });

      return { success: true, message: `Stopped monitoring "${service.name}".` };
    }

    return { success: false, message: "Unknown action." };
  } catch (error) {
    console.error("Monitoring action error:", error);
    return { success: false, message: error?.message || "An unexpected error occurred." };
  }
};

const STATUS_TONE = {
  OPERATIONAL: "rv-badge-success",
  DEGRADED: "rv-badge-warning",
  DOWN: "rv-badge-critical",
};

export default function Monitoring() {
  const { services, recentChecks } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const busy = fetcher.state !== "idle";
  const [showAdd, setShowAdd] = useState(false);
  const [removeServiceTarget, setRemoveServiceTarget] = useState(null);

  const isRemovingService = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "remove";

  useEffect(() => {
    if (result && !isRemovingService) {
      setRemoveServiceTarget(null);
    }
  }, [result, isRemovingService]);

  const handleRemoveServiceConfirm = () => {
    if (!removeServiceTarget) return;
    fetcher.submit(
      { intent: "remove", serviceId: String(removeServiceTarget.id) },
      { method: "POST" }
    );
  };

  const down = services.filter((s) => s.status === "DOWN").length;
  const degraded = services.filter((s) => s.status === "DEGRADED").length;

  return (
    <s-page heading="Uptime Monitoring" inlineSize="large">
      {result?.message && (
        <Banner tone={result.success ? "success" : "critical"}>{result.message}</Banner>
      )}

      {down > 0 && (
        <Banner tone="critical" title={`${down} service${down > 1 ? "s" : ""} down`}>
          Revertly detected an outage. Check the affected services below.
        </Banner>
      )}

      <div className="rv-hero-banner">
        <div style={{ maxWidth: "680px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px", flexWrap: "wrap" }}>
            <strong style={{ fontSize: "17px", color: "var(--rv-text)", fontWeight: 700 }}>
              Store &amp; Third-Party App Downtime Monitoring
            </strong>
            <span className={`rv-badge ${down > 0 ? "rv-badge-critical" : degraded > 0 ? "rv-badge-warning" : "rv-badge-success"}`}>
              {down > 0 ? `${down} down` : degraded > 0 ? `${degraded} degraded` : "All operational"}
            </span>
          </div>
          <p style={{ margin: "0 0 10px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
            Revertly probes your storefront and critical third-party services on a schedule and
            alerts you when a status changes — once per transition, not on every failed check.
          </p>
        </div>

        <div>
          <button type="button" onClick={() => setShowAdd(!showAdd)} className="rv-btn rv-btn-lg rv-btn-primary">
            <SparklesIcon size={16} />
            <span>{showAdd ? "✕ Close" : "+ Monitor a Service"}</span>
          </button>
        </div>
      </div>

      {showAdd && (
        <div className="rv-card" style={{ border: "2px solid var(--rv-info)", marginBottom: "24px" }}>
          <div className="rv-card-header" style={{ background: "var(--rv-info-surface)" }}>
            <h3 className="rv-card-title">
              <ZapIcon size={18} />
              <span>Add Monitored Service</span>
            </h3>
          </div>
          <div className="rv-card-body">
            <fetcher.Form method="POST" onSubmit={() => setShowAdd(false)}>
              <input type="hidden" name="intent" value="add" />
              <div className="rv-form-grid" style={{ marginBottom: "16px" }}>
                <div className="rv-form-field">
                  <label htmlFor="ms-name" className="rv-form-label">Service Name *</label>
                  <input id="ms-name" type="text" name="name" required placeholder="Checkout API" className="rv-input" />
                </div>
                <div className="rv-form-field">
                  <label htmlFor="ms-url" className="rv-form-label">URL *</label>
                  <input id="ms-url" type="url" name="url" required placeholder="https://api.example.com/health" className="rv-input" />
                  <span className="rv-form-help">Public HTTPS endpoints only; internal addresses are rejected.</span>
                </div>
                <div className="rv-form-field">
                  <label htmlFor="ms-type" className="rv-form-label">Type</label>
                  <select id="ms-type" name="serviceType" className="rv-select" defaultValue="CUSTOM">
                    {SERVICE_TYPES.map((t) => (
                      <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
                    ))}
                  </select>
                </div>
                <div className="rv-form-field">
                  <label htmlFor="ms-interval" className="rv-form-label">Check every (minutes)</label>
                  <input id="ms-interval" type="number" name="checkIntervalMinutes" min="1" max="1440" defaultValue="5" className="rv-input" />
                </div>
              </div>
              <button type="submit" disabled={busy} className="rv-btn rv-btn-primary">
                {busy ? "Adding…" : "Start Monitoring"}
              </button>
            </fetcher.Form>
          </div>
        </div>
      )}

      <div className="rv-card" style={{ marginBottom: "24px" }}>
        <div className="rv-card-header">
          <h3 className="rv-card-title">
            <CheckCircleIcon size={18} />
            <span>Monitored Services ({services.length})</span>
          </h3>
        </div>
        <div className="rv-card-body">
          {services.length === 0 ? (
            <EmptyState title="No services monitored yet">
              Add your storefront or a third-party API to track its availability.
            </EmptyState>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="rv-table" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>Status</th>
                    <th>Uptime</th>
                    <th>Response</th>
                    <th>Last check</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {services.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <strong>{s.name}</strong>
                        <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)", wordBreak: "break-all" }}>{s.url}</div>
                      </td>
                      <td><span className={`rv-badge ${STATUS_TONE[s.status] || "rv-badge-neutral"}`}>{s.status}</span></td>
                      <td>{s.uptimePercent}%</td>
                      <td>{s.lastResponseTimeMs != null ? `${s.lastResponseTimeMs}ms` : "—"}</td>
                      <td style={{ fontSize: "12px", whiteSpace: "nowrap" }}>
                        {s.lastCheckAt ? new Date(s.lastCheckAt).toLocaleString() : "Never"}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <fetcher.Form method="POST" style={{ display: "inline" }}>
                          <input type="hidden" name="intent" value="check" />
                          <input type="hidden" name="serviceId" value={s.id} />
                          <button type="submit" disabled={busy} className="rv-btn rv-btn-sm rv-btn-secondary" title="Check now">
                            <RefreshCwIcon size={14} />
                          </button>
                        </fetcher.Form>{" "}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setRemoveServiceTarget(s)}
                          className="rv-btn rv-btn-sm rv-btn-critical"
                          title="Stop monitoring"
                        >
                          <Trash2Icon size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="rv-card">
        <div className="rv-card-header">
          <h3 className="rv-card-title">
            <AlertTriangleIcon size={18} />
            <span>Recent Downtime Events</span>
          </h3>
        </div>
        <div className="rv-card-body">
          {recentChecks.length === 0 ? (
            <EmptyState title="No downtime recorded">
              Every check so far has succeeded.
            </EmptyState>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="rv-table" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Service</th>
                    <th>Code</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {recentChecks.map((c) => (
                    <tr key={c.id}>
                      <td style={{ fontSize: "12px", whiteSpace: "nowrap" }}>{new Date(c.checkedAt).toLocaleString()}</td>
                      <td>{c.service?.name || `#${c.serviceId}`}</td>
                      <td>{c.statusCode ?? "—"}</td>
                      <td style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>{c.errorMessage || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ── Stop Monitoring Service Modal ── */}
      <ConfirmModal
        isOpen={Boolean(removeServiceTarget)}
        title="Stop Monitoring Service"
        message={
          removeServiceTarget ? (
            <>
              Are you sure you want to stop monitoring{" "}
              <strong>&ldquo;{removeServiceTarget.name}&rdquo;</strong>?
            </>
          ) : null
        }
        dangerNote="Revertly will no longer track health checks, response latency, or uptime for this service. Past downtime event logs will remain recorded."
        confirmLabel="Stop Monitoring"
        submittingLabel="Removing..."
        tone="critical"
        isSubmitting={isRemovingService}
        onConfirm={handleRemoveServiceConfirm}
        onClose={() => {
          if (!isRemovingService) setRemoveServiceTarget(null);
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
