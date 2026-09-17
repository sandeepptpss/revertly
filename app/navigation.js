/**
 * Sidebar (s-app-nav) active-state resolution.
 *
 * IMPORTANT: <s-link> has no working `active`/`selected` attribute. Looking
 * at the shipped App Bridge web components bundle, `s-app-nav` only ever
 * forwards `{label, url, rel}` per item to the Shopify Admin frame (see the
 * `navMenu.set(...)` call in its connectedCallback flow) — the
 * `selectedMenuItemId()` method that reads a link's `active` attribute is
 * dead code with no call site once App Bridge navigation v2 is active, which
 * it is here. Admin decides which item is highlighted purely by comparing
 * its own current URL against each item's `url`, via exact string match.
 *
 * Since every hub tab and detail page lives on its own path (e.g.
 * /app/rollback-history, /app/incidents/42), none of those ever equals the
 * hub's canonical href (/app/restore-points, /app/incidents), so Admin can't
 * match them and falls back to highlighting the app root.
 *
 * The fix: render the *owning* section's <s-link href> as the current
 * pathname while we're anywhere inside that section, so it exactly matches
 * what Admin is comparing against. Every other link keeps its canonical
 * (clickable, stable) href.
 *
 * `exact` paths match only themselves; `prefixes` also match nested routes
 * (e.g. /app/restore-points/:id). The longest match wins, so a section can
 * safely own a prefix of another section's path.
 */
const NAV_SECTIONS = [
  {
    href: "/app/desktop",
    exact: ["/app"],
    prefixes: ["/app/desktop"],
  },
  {
    // Backups & Recovery hub: Restore Points, Rollback History, and Data Vault.
    href: "/app/restore-points",
    prefixes: [
      "/app/restore-points",
      "/app/rollback-history",
      "/app/vault",
    ],
  },
  {
    // Import & Export section
    href: "/app/import-export",
    prefixes: ["/app/import-export", "/app/export"],
  },
  {
    // Marketing Backups section
    href: "/app/marketing",
    prefixes: ["/app/marketing"],
  },
  {
    // Store Protection hub: every tab in HUB_CONFIG.protection plus the
    // incident detail route.
    href: "/app/incidents",
    prefixes: [
      "/app/incidents",
      "/app/activity",
      "/app/rules",
      "/app/monitoring",
      "/app/qa",
    ],
  },
  {
    // Settings & Team hub: every tab in HUB_CONFIG.settings.
    href: "/app/settings",
    prefixes: ["/app/settings", "/app/team"],
  },
  { href: "/app/plan", prefixes: ["/app/plan"] },
  { href: "/app/support", prefixes: ["/app/support"] },
  { href: "/app/admin", prefixes: ["/app/admin"] },
];

/**
 * Returns the href of the nav entry that owns `pathname`, or null when no
 * entry does (the app root item stays highlighted, as it does today for
 * onboarding).
 */
export function getActiveNavHref(pathname) {
  const path =
    pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

  let activeHref = null;
  let matchLength = -1;

  for (const section of NAV_SECTIONS) {
    for (const exact of section.exact || []) {
      if (path === exact && exact.length > matchLength) {
        activeHref = section.href;
        matchLength = exact.length;
      }
    }
    for (const prefix of section.prefixes || []) {
      const matches = path === prefix || path.startsWith(`${prefix}/`);
      if (matches && prefix.length > matchLength) {
        activeHref = section.href;
        matchLength = prefix.length;
      }
    }
  }

  return activeHref;
}

/**
 * The href to actually render for a nav item with canonical link
 * `canonicalHref`, given the current `pathname`. Returns `pathname` itself
 * (so it exactly matches what Admin highlights against) when this item owns
 * the current route, otherwise returns `canonicalHref` unchanged.
 */
export function resolveNavHref(canonicalHref, pathname) {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return getActiveNavHref(pathname) === canonicalHref ? path : canonicalHref;
}

export { NAV_SECTIONS };
