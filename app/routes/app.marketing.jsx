import { useState } from "react";
import { useLoaderData, useFetcher, useRouteError, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
// Provider labels and upgrade copy render in the browser, so they come from
// the constants module rather than the server one.
import {
  MARKETING_PROVIDERS,
  MARKETING_UPGRADE_MESSAGE,
  MARKETING_FLOWS_UPGRADE_MESSAGE,
} from "../marketing.constants.js";
import {
  checkMarketingAccess,
  saveMarketingConnection,
  disconnectMarketingProvider,
  backupMarketingProvider,
  backupAllMarketingProviders,
  restoreMarketingList,
  reimportMarketingSubscribers,
  getMarketingStats,
} from "../marketing.server.js";
import {
  MailIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  ZapIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
} from "../components/Icons.jsx";
import { Banner } from "../components/Banner.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import { PillNav } from "../components/PillNav.jsx";
import { HubNav } from "../components/HubNav.jsx";
import { Pagination, usePagination } from "../components/Pagination.jsx";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const access = await checkMarketingAccess(shop);
  if (!access.allowed) {
    return {
      isLocked: true,
      plan: access.plan,
      maxProfiles: access.maxProfiles,
      flowsIncluded: access.flowsIncluded,
      stats: null,
      lists: [],
      profiles: [],
      flows: [],
      search: "",
      shop,
    };
  }

  const url = new URL(request.url);
  const search = url.searchParams.get("search") || "";

  const [stats, lists, profiles, flows] = await Promise.all([
    getMarketingStats(shop),
    prisma.marketingList.findMany({
      where: { shop },
      orderBy: [{ provider: "asc" }, { listType: "asc" }, { name: "asc" }],
    }),
    prisma.marketingProfile.findMany({
      where: {
        shop,
        ...(search
          ? {
            OR: [
              { email: { contains: search } },
              { firstName: { contains: search } },
              { lastName: { contains: search } },
            ],
          }
          : {}),
      },
      orderBy: { id: "asc" },
      take: 50,
    }),
    prisma.marketingFlow.findMany({
      where: { shop },
      orderBy: [{ provider: "asc" }, { name: "asc" }],
    }),
  ]);

  return {
    isLocked: false,
    plan: access.plan,
    // Infinity does not survive JSON, so the unlimited cap crosses the wire as
    // null and the UI renders it as "Unlimited".
    maxProfiles: access.maxProfiles === Infinity ? null : access.maxProfiles,
    flowsIncluded: access.flowsIncluded,
    stats,
    lists,
    profiles,
    flows,
    search,
    shop,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const access = await checkMarketingAccess(shop);
  if (!access.allowed) {
    return { success: false, message: MARKETING_UPGRADE_MESSAGE };
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "connect") {
    return saveMarketingConnection(
      shop,
      String(formData.get("provider") || ""),
      String(formData.get("apiKey") || "").trim(),
    );
  }

  if (intent === "disconnect") {
    return disconnectMarketingProvider(shop, String(formData.get("provider") || ""));
  }

  if (intent === "backup") {
    return backupMarketingProvider(shop, String(formData.get("provider") || ""));
  }

  if (intent === "backupAll") {
    return backupAllMarketingProviders(shop);
  }

  if (intent === "restoreList") {
    return restoreMarketingList(shop, formData.get("listRowId"));
  }

  if (intent === "reimport") {
    return reimportMarketingSubscribers(shop, formData.get("listRowId"));
  }

  if (intent === "toggleAutoBackup") {
    const enabled = formData.get("enabled") === "true";
    await prisma.appSettings.upsert({
      where: { shop },
      create: { shop, marketingAutoBackup: enabled },
      update: { marketingAutoBackup: enabled },
    });
    return {
      success: true,
      message: enabled
        ? "Klaviyo & Mailchimp will now be captured in every scheduled backup."
        : "Automatic email marketing capture turned off.",
    };
  }

  return { success: false, message: "Unrecognised action." };
};

function formatDateTime(d) {
  if (!d) return "Never";
  return new Date(d).toLocaleString();
}

export default function Marketing() {
  const {
    isLocked,
    plan,
    maxProfiles,
    flowsIncluded,
    stats,
    lists,
    profiles,
    flows,
    search,
  } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const isSubmitting = fetcher.state !== "idle";
  const [tab, setTab] = useState("lists");
  const [keyDraft, setKeyDraft] = useState({ KLAVIYO: "", MAILCHIMP: "" });

  const listsPagination = usePagination(lists, 10);
  const profilesPagination = usePagination(profiles, 10);
  const flowsPagination = usePagination(flows, 10);

  if (isLocked) {
    return (
      <s-page heading="Email Marketing Backup" inlineSize="large">
        <HubNav hub="backups" activeTab="marketing" />
        <Banner tone="info" title={`Not included in the ${String(plan).toUpperCase()} plan`}>
          {MARKETING_UPGRADE_MESSAGE}
        </Banner>
        <EmptyState
          icon={<MailIcon size={40} />}
          title="Back up Klaviyo & Mailchimp"
          description="Keep an independent copy of your lists, audiences, segments and subscriber profiles, so a deleted list or a wiped audience is recoverable. Included from the Growth plan."
        />
        <div style={{ textAlign: "center", paddingBottom: "24px" }}>
          <Link to="/app/plan" className="rv-btn rv-btn-primary">
            View Plans &amp; Billing →
          </Link>
        </div>
      </s-page>
    );
  }

  const profileCapLabel = maxProfiles === null ? "Unlimited" : maxProfiles.toLocaleString();
  const anyConnected = stats.klaviyo.connected || stats.mailchimp.connected;

  return (
    <s-page heading="Email Marketing Backup" inlineSize="large">
      <HubNav hub="backups" activeTab="marketing" />
      {result?.message && (
        <Banner
          tone={result.success ? "success" : "critical"}
          title={result.success ? "Done" : "Could not complete"}
        >
          {result.message}
        </Banner>
      )}

      {/* A simulated connection must never be mistaken for a live one. */}
      {(stats.klaviyo.simulated || stats.mailchimp.simulated) && (
        <Banner tone="warning" title="Simulation mode">
          {[
            stats.klaviyo.simulated && "Klaviyo",
            stats.mailchimp.simulated && "Mailchimp",
          ]
            .filter(Boolean)
            .join(" and ")}{" "}
          {stats.klaviyo.simulated && stats.mailchimp.simulated ? "are" : "is"} connected with a
          simulated key (<code>sim_…</code>). Backups contain generated sample data and restores do
          not touch a live account. Replace the key with a real API key to back up your actual
          audience.
        </Banner>
      )}

      {!flowsIncluded && anyConnected && (
        <Banner tone="info" title="Flows & Journeys are a Business feature">
          {MARKETING_FLOWS_UPGRADE_MESSAGE}
        </Banner>
      )}

      {/* ── Summary ── */}
      <div className="rv-hero-banner" style={{ marginBottom: "24px" }}>
        <div>
          <div style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", color: "var(--rv-text-subdued)", letterSpacing: "0.5px", marginBottom: "4px" }}>
            EMAIL MARKETING BACKUP
          </div>
          <h2 style={{ margin: "0 0 6px", fontSize: "22px", fontWeight: 800, color: "var(--rv-text)" }}>
            Klaviyo &amp; Mailchimp
          </h2>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
            Last backup: {formatDateTime(stats.lastBackupAt)} · Plan cap {profileCapLabel} profiles
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "24px", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>Lists / Audiences</div>
            <strong style={{ fontSize: "15px" }}>{stats.lists.toLocaleString()}</strong>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>Segments</div>
            <strong style={{ fontSize: "15px" }}>{stats.segments.toLocaleString()}</strong>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>Profiles</div>
            <strong style={{ fontSize: "15px" }}>
              {stats.profiles.toLocaleString()} / {profileCapLabel}
            </strong>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>Flows / Journeys</div>
            <strong style={{ fontSize: "15px" }}>
              {flowsIncluded ? stats.flows.toLocaleString() : "Not in Plan"}
            </strong>
          </div>
        </div>
      </div>

      {/* ── Connections ── */}
      <div className="rv-card" style={{ marginBottom: "24px" }}>
        <div className="rv-card-body">
          <h3 style={{ margin: "0 0 14px", fontSize: "16px", fontWeight: 700 }}>Connections</h3>

          {Object.values(MARKETING_PROVIDERS).map((provider) => {
            const state = provider.id === "KLAVIYO" ? stats.klaviyo : stats.mailchimp;
            return (
              <div
                key={provider.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "14px",
                  flexWrap: "wrap",
                  padding: "14px 0",
                  borderTop: "1px solid var(--rv-border-subtle)",
                }}
              >
                <div style={{ flex: 1, minWidth: "240px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <strong style={{ fontSize: "14px" }}>{provider.label}</strong>
                    {state.connected ? (
                      <span className="rv-badge rv-badge-success rv-badge-sm">
                        {state.simulated ? "Simulated" : "Connected"}
                      </span>
                    ) : (
                      <span className="rv-badge rv-badge-neutral rv-badge-sm">Not linked</span>
                    )}
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)", marginTop: "2px" }}>
                    {state.connected
                      ? `${state.accountName} · backs up ${provider.listLabel.toLowerCase()}${flowsIncluded ? ` and ${provider.flowLabel.toLowerCase()}` : ""}`
                      : provider.keyHint}
                  </div>
                </div>

                {state.connected ? (
                  <div style={{ display: "flex", gap: "8px" }}>
                    <fetcher.Form method="POST">
                      <input type="hidden" name="intent" value="backup" />
                      <input type="hidden" name="provider" value={provider.id} />
                      <button type="submit" disabled={isSubmitting} className="rv-btn rv-btn-primary">
                        <RefreshCwIcon size={14} />
                        <span>{isSubmitting ? "Working…" : "Back up now"}</span>
                      </button>
                    </fetcher.Form>
                    <fetcher.Form method="POST">
                      <input type="hidden" name="intent" value="disconnect" />
                      <input type="hidden" name="provider" value={provider.id} />
                      <button type="submit" disabled={isSubmitting} className="rv-btn rv-btn-secondary">
                        <Trash2Icon size={14} />
                        <span>Disconnect</span>
                      </button>
                    </fetcher.Form>
                  </div>
                ) : (
                  <fetcher.Form method="POST" style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    <input type="hidden" name="intent" value="connect" />
                    <input type="hidden" name="provider" value={provider.id} />
                    <input
                      type="password"
                      name="apiKey"
                      value={keyDraft[provider.id]}
                      onChange={(e) => setKeyDraft((d) => ({ ...d, [provider.id]: e.target.value }))}
                      placeholder={`${provider.label} API key (or sim_demo to try it)`}
                      className="rv-input"
                      style={{ minWidth: "280px" }}
                      autoComplete="off"
                    />
                    <button
                      type="submit"
                      disabled={isSubmitting || !keyDraft[provider.id]}
                      className="rv-btn rv-btn-primary"
                    >
                      <ShieldCheckIcon size={14} />
                      <span>Connect</span>
                    </button>
                  </fetcher.Form>
                )}
              </div>
            );
          })}

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              flexWrap: "wrap",
              paddingTop: "14px",
              borderTop: "1px solid var(--rv-border-subtle)",
            }}
          >
            <div>
              <strong style={{ fontSize: "13px" }}>Capture in scheduled backups</strong>
              <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                Include Klaviyo &amp; Mailchimp every time a scheduled backup runs.
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <fetcher.Form method="POST">
                <input type="hidden" name="intent" value="toggleAutoBackup" />
                <input type="hidden" name="enabled" value={stats.autoBackup ? "false" : "true"} />
                <button
                  type="submit"
                  disabled={isSubmitting || !anyConnected}
                  className={stats.autoBackup ? "rv-btn rv-btn-secondary" : "rv-btn rv-btn-primary"}
                >
                  <ZapIcon size={14} />
                  <span>{stats.autoBackup ? "Turn off" : "Turn on"}</span>
                </button>
              </fetcher.Form>
              {anyConnected && (
                <fetcher.Form method="POST">
                  <input type="hidden" name="intent" value="backupAll" />
                  <button type="submit" disabled={isSubmitting} className="rv-btn rv-btn-secondary">
                    <RefreshCwIcon size={14} />
                    <span>Back up all</span>
                  </button>
                </fetcher.Form>
              )}
            </div>
          </div>
        </div>
      </div>

      {!anyConnected ? (
        <EmptyState
          icon={<MailIcon size={40} />}
          title="No email marketing account connected"
          description="Connect Klaviyo or Mailchimp above to start backing up your lists, segments and subscriber profiles. To try the flow without a live account, connect with a key beginning sim_ — it produces sample data and never touches a real ESP."
        />
      ) : (
        <>
          <PillNav
            items={[
              { id: "lists", label: `Lists & Segments (${lists.length})` },
              { id: "profiles", label: `Profiles (${stats.profiles.toLocaleString()})` },
              {
                id: "flows",
                label: flowsIncluded ? `Flows & Journeys (${flows.length})` : "Flows & Journeys (Business)",
              },
            ]}
            activeId={tab}
            onChange={setTab}
          />

          {tab === "lists" && (
            <div className="rv-card">
              <div className="rv-card-body">
                {lists.length === 0 ? (
                  <EmptyState
                    icon={<MailIcon size={36} />}
                    title="Nothing captured yet"
                    description="Run “Back up now” to capture your lists, audiences and segments."
                  />
                ) : (
                  <table className="rv-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Provider</th>
                        <th>Type</th>
                        <th>Members</th>
                        <th>Captured</th>
                        <th style={{ textAlign: "right" }}>Recovery</th>
                      </tr>
                    </thead>
                    <tbody>
                      {listsPagination.paginatedItems.map((row) => (
                        <tr key={row.id}>
                          <td><strong>{row.name}</strong></td>
                          <td>{MARKETING_PROVIDERS[row.provider]?.label || row.provider}</td>
                          <td>
                            <span className="rv-badge rv-badge-neutral rv-badge-sm">
                              {row.listType === "SEGMENT" ? "Segment" : "List"}
                            </span>
                          </td>
                          <td>{row.memberCount.toLocaleString()}</td>
                          <td style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                            {formatDateTime(row.capturedAt)}
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <div style={{ display: "inline-flex", gap: "6px" }}>
                              <fetcher.Form method="POST">
                                <input type="hidden" name="intent" value="restoreList" />
                                <input type="hidden" name="listRowId" value={row.id} />
                                <button type="submit" disabled={isSubmitting} className="rv-btn rv-btn-secondary rv-btn-sm">
                                  Recreate list
                                </button>
                              </fetcher.Form>
                              <fetcher.Form method="POST">
                                <input type="hidden" name="intent" value="reimport" />
                                <input type="hidden" name="listRowId" value={row.id} />
                                <button type="submit" disabled={isSubmitting} className="rv-btn rv-btn-primary rv-btn-sm">
                                  <UploadIcon size={12} />
                                  <span>Re-import subscribers</span>
                                </button>
                              </fetcher.Form>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <Pagination
                  currentPage={listsPagination.currentPage}
                  totalItems={listsPagination.totalItems}
                  pageSize={listsPagination.pageSize}
                  onPageChange={listsPagination.setCurrentPage}
                  onPageSizeChange={listsPagination.setPageSize}
                  itemLabel="lists"
                />
              </div>
            </div>
          )}

          {tab === "profiles" && (
            <div className="rv-card">
              <div className="rv-card-body">
                <form method="GET" style={{ display: "flex", gap: "8px", marginBottom: "14px" }}>
                  <input
                    type="search"
                    name="search"
                    defaultValue={search}
                    placeholder="Search by email or name"
                    className="rv-input"
                    style={{ maxWidth: "320px" }}
                  />
                  <button type="submit" className="rv-btn rv-btn-secondary">
                    <SearchIcon size={14} />
                    <span>Search</span>
                  </button>
                </form>

                {profiles.length === 0 ? (
                  <EmptyState
                    icon={<MailIcon size={36} />}
                    title={search ? "No matching profiles" : "No profiles captured yet"}
                    description={
                      search
                        ? "No backed-up subscriber matches that search."
                        : "Run “Back up now” to capture subscriber profiles."
                    }
                  />
                ) : (
                  <>
                    <table className="rv-table">
                      <thead>
                        <tr>
                          <th>Email</th>
                          <th>Name</th>
                          <th>Provider</th>
                          <th>Status</th>
                          <th>Captured</th>
                        </tr>
                      </thead>
                      <tbody>
                        {profilesPagination.paginatedItems.map((p) => (
                          <tr key={p.id}>
                            <td>{p.email || "—"}</td>
                            <td>{[p.firstName, p.lastName].filter(Boolean).join(" ") || "—"}</td>
                            <td>{MARKETING_PROVIDERS[p.provider]?.label || p.provider}</td>
                            <td>
                              <span
                                className={`rv-badge rv-badge-sm ${p.status === "subscribed" ? "rv-badge-success" : "rv-badge-neutral"}`}
                              >
                                {p.status || "unknown"}
                              </span>
                            </td>
                            <td style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                              {formatDateTime(p.capturedAt)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)", marginTop: "10px" }}>
                      Showing {profiles.length} of {stats.profiles.toLocaleString()} backed-up profiles
                      {maxProfiles !== null && stats.profiles >= maxProfiles && (
                        <>
                          {" "}— your {plan} plan caps profile backup at {maxProfiles.toLocaleString()}.{" "}
                          <Link to="/app/plan" style={{ color: "var(--rv-info)" }}>Upgrade →</Link>
                        </>
                      )}
                    </div>
                    <Pagination
                      currentPage={profilesPagination.currentPage}
                      totalItems={profilesPagination.totalItems}
                      pageSize={profilesPagination.pageSize}
                      onPageChange={profilesPagination.setCurrentPage}
                      onPageSizeChange={profilesPagination.setPageSize}
                      itemLabel="profiles"
                    />
                  </>
                )}
              </div>
            </div>
          )}

          {tab === "flows" && (
            <div className="rv-card">
              <div className="rv-card-body">
                {!flowsIncluded ? (
                  <EmptyState
                    icon={<ZapIcon size={36} />}
                    title="Flows & Journeys backup is a Business feature"
                    description={MARKETING_FLOWS_UPGRADE_MESSAGE}
                    action={
                      <Link to="/app/plan" className="rv-btn rv-btn-primary">
                        View Plans &amp; Billing →
                      </Link>
                    }
                  />
                ) : flows.length === 0 ? (
                  <EmptyState
                    icon={<ZapIcon size={36} />}
                    title="No flows captured yet"
                    description="Run “Back up now” to capture your Klaviyo flows and Mailchimp journeys."
                  />
                ) : (
                  <table className="rv-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Provider</th>
                        <th>Status</th>
                        <th>Trigger</th>
                        <th>Captured</th>
                      </tr>
                    </thead>
                    <tbody>
                      {flowsPagination.paginatedItems.map((f) => (
                        <tr key={f.id}>
                          <td><strong>{f.name}</strong></td>
                          <td>{MARKETING_PROVIDERS[f.provider]?.label || f.provider}</td>
                          <td>
                            <span
                              className={`rv-badge rv-badge-sm ${f.status === "live" ? "rv-badge-success" : "rv-badge-neutral"}`}
                            >
                              {f.status || "unknown"}
                            </span>
                          </td>
                          <td style={{ fontSize: "12px" }}>{f.triggerType || "—"}</td>
                          <td style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                            {formatDateTime(f.capturedAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <Pagination
                  currentPage={flowsPagination.currentPage}
                  totalItems={flowsPagination.totalItems}
                  pageSize={flowsPagination.pageSize}
                  onPageChange={flowsPagination.setCurrentPage}
                  onPageSizeChange={flowsPagination.setPageSize}
                  itemLabel="flows"
                />
              </div>
            </div>
          )}
        </>
      )}

      <div style={{ textAlign: "center", padding: "16px 20px", color: "var(--rv-text-subdued)", fontSize: "12px" }}>
        Backed-up subscribers that were unsubscribed or cleaned are never re-imported, so a recovery
        cannot resubscribe someone who opted out.
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
