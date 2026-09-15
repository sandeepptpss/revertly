/**
 * Multi-user support: team roster, role-based access control, and audit trail.
 *
 * Shopify authenticates the *store*, not the individual person, so app-level
 * roles are layered on top of the Shopify session. The session's staff email is
 * matched against the TeamMember roster to resolve the acting user.
 *
 * Fail-safe rule: if a shop has no roster yet, the current session is treated as
 * the OWNER and provisioned as such. A shop must never be able to lock itself
 * out of its own backups, so an unrecognised session in a shop that HAS a roster
 * is still granted ADMIN — the roster restricts named members, it is not an
 * allow-list for store staff generally.
 */
import prisma from "./db.server.js";
import { ROLES, PERMISSIONS, roleCan, permissionsForRole } from "./team.constants.js";

export { ROLES, PERMISSIONS, roleCan, permissionsForRole };

function sessionEmail(session) {
  return (session?.email || "").trim().toLowerCase() || null;
}

/**
 * Resolves the acting user for a request, provisioning the first caller of a
 * shop as its OWNER.
 */
export async function resolveActor(shop, session) {
  const email = sessionEmail(session);
  const name =
    [session?.firstName, session?.lastName].filter(Boolean).join(" ").trim() || null;

  const memberCount = await prisma.teamMember.count({ where: { shop } });

  // First ever caller becomes OWNER so the shop always has one.
  if (memberCount === 0) {
    const owner = await prisma.teamMember.create({
      data: {
        shop,
        email: email || `owner@${shop}`,
        name: name || "Store Owner",
        role: "OWNER",
        status: "ACTIVE",
        lastActiveAt: new Date(),
      },
    });
    return { member: owner, role: "OWNER", email: owner.email, provisioned: true };
  }

  if (email) {
    const member = await prisma.teamMember.findUnique({
      where: { shop_email: { shop, email } },
    });
    if (member) {
      if (member.status === "SUSPENDED") {
        return { member, role: "VIEWER", email, suspended: true };
      }
      // Touch activity without blocking the request on it.
      prisma.teamMember
        .update({ where: { id: member.id }, data: { lastActiveAt: new Date() } })
        .catch(() => {});
      return { member, role: member.role, email };
    }
  }

  // Authenticated Shopify staff not on the roster: treat as ADMIN, not OWNER.
  return { member: null, role: "ADMIN", email, unlisted: true };
}

/**
 * Throws a 403 Response unless the acting user holds `permission`.
 * Returns the resolved actor so callers can attribute the action.
 */
export async function requirePermission(shop, session, permission) {
  const actor = await resolveActor(shop, session);

  if (!roleCan(actor.role, permission)) {
    throw new Response(
      JSON.stringify({
        success: false,
        message: `Your role (${actor.role}) is not permitted to perform this action.`,
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }

  return actor;
}

/**
 * Non-throwing variant for actions that return a result object rather than a
 * thrown Response.
 *
 * @returns {{allowed: boolean, actor: object, message?: string}}
 */
export async function checkPermission(shop, session, permission) {
  const actor = await resolveActor(shop, session);
  if (!roleCan(actor.role, permission)) {
    return {
      allowed: false,
      actor,
      message: `Your role (${actor.role}) is not permitted to perform this action.`,
    };
  }
  return { allowed: true, actor };
}

/** Writes an audit entry. Never throws — auditing must not break the action. */
export async function logAudit(shop, actor, action, { resourceType, resourceId, details, request } = {}) {
  try {
    let ipAddress = null;
    if (request) {
      ipAddress =
        request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
        request.headers.get("x-real-ip") ||
        null;
    }

    await prisma.auditLog.create({
      data: {
        shop,
        userEmail: actor?.email || null,
        userName: actor?.member?.name || null,
        action,
        resourceType: resourceType || null,
        resourceId: resourceId != null ? String(resourceId) : null,
        details: details || undefined,
        ipAddress,
      },
    });
  } catch (err) {
    console.warn(`[Audit] Could not record ${action} for ${shop}:`, err?.message);
  }
}

/**
 * Email addresses that should receive alerts: the shop-wide alert address plus
 * every active member who opted in, de-duplicated.
 */
export async function getAlertRecipients(shop, settings) {
  const recipients = new Set();
  if (settings?.alertEmail) recipients.add(settings.alertEmail.trim().toLowerCase());

  try {
    const members = await prisma.teamMember.findMany({
      where: { shop, status: "ACTIVE", alertsEnabled: true },
      select: { email: true },
    });
    for (const m of members) {
      if (m.email && m.email.includes("@")) recipients.add(m.email.trim().toLowerCase());
    }
  } catch (err) {
    console.warn(`[Team] Could not load alert recipients for ${shop}:`, err?.message);
  }

  return [...recipients];
}

/** Guards against demoting or removing the last OWNER of a shop. */
export async function assertNotLastOwner(shop, memberId) {
  const owners = await prisma.teamMember.findMany({
    where: { shop, role: "OWNER", status: "ACTIVE" },
    select: { id: true },
  });
  if (owners.length <= 1 && owners.some((o) => o.id === memberId)) {
    return { ok: false, message: "This is the only owner. Promote another member to Owner first." };
  }
  return { ok: true };
}
