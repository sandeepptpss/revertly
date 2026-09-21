/**
 * Multi-user support: team roster, role-based access control, and audit trail.
 *
 * Shopify authenticates the *store*, not the individual person, so app-level
 * roles are layered on top of the Shopify session. The session's staff email is
 * matched against the TeamMember roster to resolve the acting user.
 *
 * This depends on `useOnlineTokens: true` in shopify.server.js. An offline
 * session carries no `associated_user`, so without it sessionEmail() is always
 * null, the roster is never consulted, and every caller lands on the unlisted
 * ADMIN branch — silently making every assigned role unenforceable.
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


/**
 * The signed-in staff member's address, or null when the request carries no
 * user identity (an offline session, which identifies only the store).
 *
 * Requires `useOnlineTokens` in shopify.server.js — without it this is always
 * null and every caller falls through to the unlisted-ADMIN branch below.
 */
function sessionEmail(session) {
  const raw = session?.onlineAccessInfo?.associated_user?.email ?? session?.email ?? "";
  const email = String(raw).trim().toLowerCase();
  // The Prisma session store stringifies absent columns, so a row without a
  // user can surface the literal "null"/"undefined" instead of an address.
  if (!email || email === "null" || email === "undefined") return null;
  return email;
}

function sessionName(session) {
  const user = session?.onlineAccessInfo?.associated_user;
  const first = user?.first_name ?? session?.firstName;
  const last = user?.last_name ?? session?.lastName;
  const name = [first, last]
    .map((p) => (p == null ? "" : String(p)))
    .filter((p) => p && p !== "null" && p !== "undefined")
    .join(" ")
    .trim();
  return name || null;
}

/** Whether this session belongs to the store's Shopify account owner. */
function sessionIsAccountOwner(session) {
  return Boolean(
    session?.onlineAccessInfo?.associated_user?.account_owner ?? session?.accountOwner,
  );
}

/**
 * Address used for the OWNER row when the very first caller could not be
 * identified. It is a placeholder nobody can ever sign in as, so the real
 * account owner adopts it on their first identified visit.
 */
function placeholderOwnerEmail(shop) {
  return `owner@${shop}`;
}

/**
 * Resolves the acting user for a request, provisioning the first caller of a
 * shop as its OWNER.
 */
export async function resolveActor(shop, session) {
  const email = sessionEmail(session);
  const name = sessionName(session);

  const memberCount = await prisma.teamMember.count({ where: { shop } });

  // First ever caller becomes OWNER so the shop always has one.
  if (memberCount === 0) {
    const owner = await prisma.teamMember.create({
      data: {
        shop,
        email: email || placeholderOwnerEmail(shop),
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

    // The Shopify account owner always holds OWNER. They own the store and its
    // subscription, so no app-level roster row may demote them — otherwise a
    // stale EDITOR/VIEWER entry (or the placeholder below) locks the store out
    // of its own billing, which only OWNER can manage.
    if (sessionIsAccountOwner(session)) {
      return await ensureAccountOwner(shop, email, name, member);
    }

    if (member) {
      if (member.status === "SUSPENDED") {
        return { member, role: "NONE", email, suspended: true };
      }
      // Signing in accepts a pending invitation.
      const activated = member.status === "INVITED";
      prisma.teamMember
        .update({
          where: { id: member.id },
          data: {
            lastActiveAt: new Date(),
            ...(activated ? { status: "ACTIVE" } : {}),
            ...(name && !member.name ? { name } : {}),
          },
        })
        .catch(() => { });
      return { member, role: member.role, email, activated };
    }

  } else {
    // Fail-open, but never silently: the roster cannot restrict anyone while
    // requests arrive without a user identity.
    console.warn(
      `[Revertly Team] Request for ${shop} carried no staff identity — granting ADMIN. ` +
      `Check that useOnlineTokens is enabled in shopify.server.js.`,
    );
  }

  // Authenticated Shopify staff not on the roster: treat as ADMIN, not OWNER.
  return { member: null, role: "ADMIN", email, unlisted: true };
}

/**
 * Guarantees the Shopify account owner holds OWNER on the roster, retiring the
 * placeholder row left by installs that predate online tokens.
 */
async function ensureAccountOwner(shop, email, name, member) {
  let actor;

  if (member?.role === "OWNER" && member.status === "ACTIVE") {
    prisma.teamMember
      .update({ where: { id: member.id }, data: { lastActiveAt: new Date() } })
      .catch(() => { });
    actor = { member, role: "OWNER", email };
  } else if (member) {
    const promoted = await prisma.teamMember.update({
      where: { id: member.id },
      data: {
        role: "OWNER",
        status: "ACTIVE",
        name: name || member.name,
        lastActiveAt: new Date(),
      },
    });
    actor = { member: promoted, role: "OWNER", email, accountOwnerRestored: true };
  } else {
    const created = await prisma.teamMember.create({
      data: {
        shop,
        email,
        name: name || "Store Owner",
        role: "OWNER",
        status: "ACTIVE",
        lastActiveAt: new Date(),
      },
    });
    actor = { member: created, role: "OWNER", email, accountOwnerRestored: true };
  }

  // Retire the unclaimable placeholder only once a real OWNER exists, so the
  // shop is never momentarily left without one.
  const placeholderEmail = placeholderOwnerEmail(shop);
  if (email !== placeholderEmail) {
    await prisma.teamMember
      .deleteMany({ where: { shop, email: placeholderEmail } })
      .catch(() => { });
  }

  return actor;
}

/**
 * Throws a 403 Response unless the acting user holds `permission`.
 * Returns the resolved actor so callers can attribute the action.
 */
export async function requirePermission(shop, session, permission) {
  const actor = await resolveActor(shop, session);

  if (actor.suspended) {
    throw new Response(
      JSON.stringify({
        success: false,
        message: "Your account has been suspended. Please contact a store Owner.",
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }

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

  if (actor.suspended) {
    return {
      allowed: false,
      actor,
      message: "Your account has been suspended. Please contact a store Owner.",
    };
  }

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
