/**
 * Pure role/permission definitions.
 *
 * Kept free of prisma so route components can import them for rendering without
 * dragging server-only code into the client bundle. team.server.js re-exports
 * these alongside the database-backed helpers.
 */
export const ROLES = ["OWNER", "ADMIN", "EDITOR", "VIEWER"];

export const PERMISSIONS = {
  VIEW: "view",
  RESTORE: "restore",
  BACKUP_CREATE: "backup:create",
  BACKUP_DELETE: "backup:delete",
  SETTINGS_WRITE: "settings:write",
  TEAM_MANAGE: "team:manage",
  BILLING_MANAGE: "billing:manage",
};

const ROLE_PERMISSIONS = {
  OWNER: new Set(Object.values(PERMISSIONS)),
  ADMIN: new Set([
    PERMISSIONS.VIEW,
    PERMISSIONS.RESTORE,
    PERMISSIONS.BACKUP_CREATE,
    PERMISSIONS.BACKUP_DELETE,
    PERMISSIONS.SETTINGS_WRITE,
    PERMISSIONS.TEAM_MANAGE,
  ]),
  EDITOR: new Set([PERMISSIONS.VIEW, PERMISSIONS.RESTORE, PERMISSIONS.BACKUP_CREATE]),
  VIEWER: new Set([PERMISSIONS.VIEW]),
};

export function roleCan(role, permission) {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/** Permission map for a role, for rendering the UI without guessing. */
export function permissionsForRole(role) {
  return Object.fromEntries(Object.values(PERMISSIONS).map((p) => [p, roleCan(role, p)]));
}
