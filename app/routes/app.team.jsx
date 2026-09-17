import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { resolveActor, checkPermission, logAudit, assertNotLastOwner } from "../team.server.js";
import { ROLES, PERMISSIONS, permissionsForRole, roleCan } from "../team.constants.js";
import {
  ShieldCheckIcon,
  Trash2Icon,
  SparklesIcon,
  HistoryIcon,
  BellIcon,
  CheckCircleIcon,
} from "../components/Icons.jsx";
import { Banner } from "../components/Banner.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";
import { HubNav } from "../components/HubNav.jsx";
import { Pagination, usePagination } from "../components/Pagination.jsx";

const ROLE_DESCRIPTIONS = {
  OWNER: "Full control, including billing and team management.",
  ADMIN: "Everything except billing. Can restore, back up, and manage the team.",
  EDITOR: "Can create backups and run restores, but not change settings or the team.",
  VIEWER: "Read-only access to backups, incidents, and history.",
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const actor = await resolveActor(shop, session);

  const [members, auditLogs] = await Promise.all([
    prisma.teamMember.findMany({ where: { shop }, orderBy: [{ role: "asc" }, { createdAt: "asc" }] }),
    prisma.auditLog.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);

  return {
    members,
    auditLogs,
    actor: { email: actor.email, role: actor.role, unlisted: Boolean(actor.unlisted) },
    canManage: roleCan(actor.role, PERMISSIONS.TEAM_MANAGE),
    rolePermissions: Object.fromEntries(ROLES.map((r) => [r, permissionsForRole(r)])),
  };
};

export const action = async ({ request }) => {
  try {
    const { session } = await authenticate.admin(request);
    const shop = session.shop;
    const formData = await request.formData();
    const intent = formData.get("intent");

    const perm = await checkPermission(shop, session, PERMISSIONS.TEAM_MANAGE);
    if (!perm.allowed) return { success: false, message: perm.message };

    if (intent === "invite") {
      const email = formData.get("email")?.trim().toLowerCase();
      const name = formData.get("name")?.trim() || null;
      const role = formData.get("role") || "VIEWER";

      if (!email || !email.includes("@")) {
        return { success: false, message: "Enter a valid email address." };
      }
      if (!ROLES.includes(role)) {
        return { success: false, message: "Unknown role." };
      }
      // Only an OWNER may mint another OWNER.
      if (role === "OWNER" && perm.actor.role !== "OWNER") {
        return { success: false, message: "Only an Owner can grant the Owner role." };
      }

      const existing = await prisma.teamMember.findUnique({ where: { shop_email: { shop, email } } });
      if (existing) {
        return { success: false, message: `${email} is already on the team.` };
      }

      const member = await prisma.teamMember.create({
        data: { shop, email, name, role, status: "INVITED" },
      });

      await logAudit(shop, perm.actor, "TEAM_MEMBER_INVITED", {
        resourceType: "TeamMember",
        resourceId: member.id,
        details: { email, role },
        request,
      });

      return { success: true, message: `${email} added to the team as ${role}.` };
    }

    if (intent === "updateRole") {
      const memberId = parseInt(formData.get("memberId"), 10);
      const role = formData.get("role");
      if (!memberId || !ROLES.includes(role)) {
        return { success: false, message: "Invalid role change request." };
      }

      const member = await prisma.teamMember.findFirst({ where: { id: memberId, shop } });
      if (!member) return { success: false, message: "Team member not found." };

      if (role === "OWNER" && perm.actor.role !== "OWNER") {
        return { success: false, message: "Only an Owner can grant the Owner role." };
      }

      // Demoting the final owner would leave the shop with nobody who can
      // manage billing or ownership.
      if (member.role === "OWNER" && role !== "OWNER") {
        const guard = await assertNotLastOwner(shop, memberId);
        if (!guard.ok) return { success: false, message: guard.message };
      }

      await prisma.teamMember.update({ where: { id: memberId }, data: { role } });
      await logAudit(shop, perm.actor, "TEAM_ROLE_CHANGED", {
        resourceType: "TeamMember",
        resourceId: memberId,
        details: { email: member.email, from: member.role, to: role },
        request,
      });

      return { success: true, message: `${member.email} is now ${role}.` };
    }

    if (intent === "toggleAlerts") {
      const memberId = parseInt(formData.get("memberId"), 10);
      const member = await prisma.teamMember.findFirst({ where: { id: memberId, shop } });
      if (!member) return { success: false, message: "Team member not found." };

      const updated = await prisma.teamMember.update({
        where: { id: memberId },
        data: { alertsEnabled: !member.alertsEnabled },
      });

      return {
        success: true,
        message: `Alerts ${updated.alertsEnabled ? "enabled" : "disabled"} for ${member.email}.`,
      };
    }

    if (intent === "remove") {
      const memberId = parseInt(formData.get("memberId"), 10);
      const member = await prisma.teamMember.findFirst({ where: { id: memberId, shop } });
      if (!member) return { success: false, message: "Team member not found." };

      if (member.role === "OWNER") {
        const guard = await assertNotLastOwner(shop, memberId);
        if (!guard.ok) return { success: false, message: guard.message };
      }

      await prisma.teamMember.delete({ where: { id: memberId } });
      await logAudit(shop, perm.actor, "TEAM_MEMBER_REMOVED", {
        resourceType: "TeamMember",
        resourceId: memberId,
        details: { email: member.email, role: member.role },
        request,
      });

      return { success: true, message: `${member.email} removed from the team.` };
    }

    return { success: false, message: "Unknown action." };
  } catch (error) {
    console.error("Team action error:", error);
    return { success: false, message: error?.message || "An unexpected error occurred." };
  }
};

const ROLE_TONE = {
  OWNER: "rv-badge-success",
  ADMIN: "rv-badge-info",
  EDITOR: "rv-badge-info",
  VIEWER: "rv-badge-neutral",
};

export default function Team() {
  const { members, auditLogs, actor, canManage, rolePermissions } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const busy = fetcher.state !== "idle";
  const [showInvite, setShowInvite] = useState(false);
  const [removeMemberTarget, setRemoveMemberTarget] = useState(null);

  const {
    currentPage,
    setCurrentPage,
    pageSize,
    setPageSize,
    paginatedItems: pagedAuditLogs,
    totalItems: totalAuditLogs,
  } = usePagination(auditLogs, 10);

  const isRemovingMember = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "remove";

  useEffect(() => {
    if (result && !isRemovingMember) {
      setRemoveMemberTarget(null);
    }
  }, [result, isRemovingMember]);

  const handleRemoveMemberConfirm = () => {
    if (!removeMemberTarget) return;
    fetcher.submit(
      { intent: "remove", memberId: String(removeMemberTarget.id) },
      { method: "POST" }
    );
  };

  const owners = members.filter((m) => m.role === "OWNER" && m.status === "ACTIVE");

  return (
    <s-page heading="Team & Access Control" inlineSize="large">
      <HubNav hub="settings" activeTab="team" />
      {result?.message && (
        <Banner tone={result.success ? "success" : "critical"}>{result.message}</Banner>
      )}

      <div className="rv-hero-banner">
        <div style={{ maxWidth: "680px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px", flexWrap: "wrap" }}>
            <strong style={{ fontSize: "17px", color: "var(--rv-text)", fontWeight: 700 }}>
              Multi-User Access &amp; Audit Trail
            </strong>
            <span className="rv-badge rv-badge-info">
              Signed in as {actor.email || "unknown"} &middot; {actor.role}
            </span>
          </div>
          <p style={{ margin: "0 0 10px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
            Give each teammate only the access they need. Destructive actions — restores and backup
            deletion — are blocked for roles that lack permission, and every one is recorded below.
          </p>
        </div>

        {canManage && (
          <div>
            <button
              type="button"
              onClick={() => setShowInvite(!showInvite)}
              className="rv-btn rv-btn-lg rv-btn-primary"
            >
              <SparklesIcon size={16} />
              <span>{showInvite ? "✕ Close" : "+ Add Team Member"}</span>
            </button>
          </div>
        )}
      </div>

      {!canManage && (
        <Banner tone="info" title="Read-only view">
          Your role ({actor.role}) can view the team and audit trail but cannot change membership.
        </Banner>
      )}

      {showInvite && canManage && (
        <div className="rv-card" style={{ border: "2px solid var(--rv-info)", marginBottom: "24px" }}>
          <div className="rv-card-header" style={{ background: "var(--rv-info-surface)" }}>
            <h3 className="rv-card-title" style={{ color: "var(--rv-info-text)" }}>
              <ShieldCheckIcon size={18} />
              <span>Add Team Member</span>
            </h3>
          </div>
          <div className="rv-card-body">
            <fetcher.Form method="POST" onSubmit={() => setShowInvite(false)}>
              <input type="hidden" name="intent" value="invite" />
              <div className="rv-form-grid" style={{ marginBottom: "16px" }}>
                <div className="rv-form-field">
                  <label htmlFor="tm-email" className="rv-form-label">Email *</label>
                  <input id="tm-email" type="email" name="email" required placeholder="teammate@store.com" className="rv-input" />
                  <span className="rv-form-help">Must match the staff account email they sign in with.</span>
                </div>
                <div className="rv-form-field">
                  <label htmlFor="tm-name" className="rv-form-label">Name</label>
                  <input id="tm-name" type="text" name="name" placeholder="Jordan Lee" className="rv-input" />
                </div>
                <div className="rv-form-field">
                  <label htmlFor="tm-role" className="rv-form-label">Role</label>
                  <select id="tm-role" name="role" className="rv-select" defaultValue="VIEWER">
                    {ROLES.filter((r) => r !== "OWNER" || actor.role === "OWNER").map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </div>
              </div>
              <button type="submit" disabled={busy} className="rv-btn rv-btn-primary">
                {busy ? "Adding…" : "Add Member"}
              </button>
            </fetcher.Form>
          </div>
        </div>
      )}

      {/* ── Roster ── */}
      <div className="rv-card" style={{ marginBottom: "24px" }}>
        <div className="rv-card-header">
          <h3 className="rv-card-title">
            <ShieldCheckIcon size={18} />
            <span>Team Members ({members.length})</span>
          </h3>
        </div>
        <div className="rv-card-body">
          {members.length === 0 ? (
            <EmptyState title="No team members yet">
              Add teammates to give them scoped access to backups and restores.
            </EmptyState>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="rv-table" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Alerts</th>
                    <th>Last active</th>
                    {canManage && <th>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <strong>{m.name || m.email}</strong>
                        {m.name && <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>{m.email}</div>}
                      </td>
                      <td>
                        {canManage ? (
                          <fetcher.Form method="POST" style={{ display: "inline" }}>
                            <input type="hidden" name="intent" value="updateRole" />
                            <input type="hidden" name="memberId" value={m.id} />
                            <select
                              name="role"
                              className="rv-select"
                              defaultValue={m.role}
                              onChange={(e) => e.target.form.requestSubmit()}
                              disabled={busy}
                              aria-label={`Role for ${m.email}`}
                            >
                              {ROLES.filter((r) => r !== "OWNER" || actor.role === "OWNER" || m.role === "OWNER").map((r) => (
                                <option key={r} value={r}>{r}</option>
                              ))}
                            </select>
                          </fetcher.Form>
                        ) : (
                          <span className={`rv-badge ${ROLE_TONE[m.role] || "rv-badge-neutral"}`}>{m.role}</span>
                        )}
                      </td>
                      <td>
                        <span className={`rv-badge ${m.status === "ACTIVE" ? "rv-badge-success" : "rv-badge-neutral"}`}>
                          {m.status}
                        </span>
                      </td>
                      <td>
                        {canManage ? (
                          <fetcher.Form method="POST" style={{ display: "inline" }}>
                            <input type="hidden" name="intent" value="toggleAlerts" />
                            <input type="hidden" name="memberId" value={m.id} />
                            <button type="submit" disabled={busy} className="rv-btn rv-btn-sm rv-btn-secondary">
                              <BellIcon size={14} />
                              <span>{m.alertsEnabled ? "On" : "Off"}</span>
                            </button>
                          </fetcher.Form>
                        ) : (
                          <span>{m.alertsEnabled ? "On" : "Off"}</span>
                        )}
                      </td>
                      <td style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                        {m.lastActiveAt ? new Date(m.lastActiveAt).toLocaleString() : "—"}
                      </td>
                      {canManage && (
                        <td>
                          <button
                            type="button"
                            onClick={() => setRemoveMemberTarget(m)}
                            disabled={busy || (m.role === "OWNER" && owners.length <= 1)}
                            title={m.role === "OWNER" && owners.length <= 1 ? "The last owner cannot be removed" : "Remove member"}
                            className="rv-btn rv-btn-sm rv-btn-critical"
                          >
                            <Trash2Icon size={14} />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ── Role reference ── */}
      <div className="rv-card" style={{ marginBottom: "24px" }}>
        <div className="rv-card-header">
          <h3 className="rv-card-title">
            <CheckCircleIcon size={18} />
            <span>What each role can do</span>
          </h3>
        </div>
        <div className="rv-card-body">
          {ROLES.map((r) => (
            <div key={r} style={{ marginBottom: "12px" }}>
              <span className={`rv-badge ${ROLE_TONE[r]}`}>{r}</span>{" "}
              <span style={{ fontSize: "13px", color: "var(--rv-text-subdued)" }}>{ROLE_DESCRIPTIONS[r]}</span>
              <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)", marginTop: "4px" }}>
                {Object.entries(rolePermissions[r])
                  .filter(([, allowed]) => allowed)
                  .map(([p]) => p)
                  .join(" · ")}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Audit trail ── */}
      <div className="rv-card">
        <div className="rv-card-header">
          <h3 className="rv-card-title">
            <HistoryIcon size={18} />
            <span>Audit Trail</span>
          </h3>
          <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
            Last {auditLogs.length} recorded actions
          </span>
        </div>
        <div className="rv-card-body">
          {auditLogs.length === 0 ? (
            <EmptyState title="No recorded activity yet">
              Restores, backups, and team changes will appear here.
            </EmptyState>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="rv-table" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Who</th>
                    <th>Action</th>
                    <th>Resource</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedAuditLogs.map((log) => (
                    <tr key={log.id}>
                      <td style={{ fontSize: "12px", whiteSpace: "nowrap" }}>
                        {new Date(log.createdAt).toLocaleString()}
                      </td>
                      <td style={{ fontSize: "12px" }}>{log.userName || log.userEmail || "system"}</td>
                      <td><span className="rv-badge rv-badge-info">{log.action}</span></td>
                      <td style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                        {log.resourceType ? `${log.resourceType} #${log.resourceId ?? "—"}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Pagination
            currentPage={currentPage}
            totalItems={totalAuditLogs}
            pageSize={pageSize}
            onPageChange={setCurrentPage}
            onPageSizeChange={setPageSize}
            itemLabel="audit logs"
          />
        </div>
      </div>

      {/* ── Remove Team Member Modal ── */}
      <ConfirmModal
        isOpen={Boolean(removeMemberTarget)}
        title="Remove Team Member"
        message={
          removeMemberTarget ? (
            <>
              Are you sure you want to remove{" "}
              <strong>
                {removeMemberTarget.name
                  ? `${removeMemberTarget.name} (${removeMemberTarget.email})`
                  : removeMemberTarget.email}
              </strong>{" "}
              from your Revertly team?
            </>
          ) : null
        }
        dangerNote="This user will immediately lose access to your store's backups, restore operations, and Revertly settings."
        confirmLabel="Remove Member"
        submittingLabel="Removing..."
        tone="critical"
        isSubmitting={isRemovingMember}
        onConfirm={handleRemoveMemberConfirm}
        onClose={() => {
          if (!isRemovingMember) setRemoveMemberTarget(null);
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
