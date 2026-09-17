import { Outlet, useLoaderData, useLocation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { resolveNavHref } from "../navigation.js";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { isPlatformAdmin } from "../platformAdmin.server.js";
import { getEffectivePlanId } from "../billing.server.js";
import { GlobalSupportWidget } from "../components/GlobalSupportWidget.jsx";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let defaultEmail = "";
  let planTier = "Free";

  try {
    const settings = await prisma.appSettings.findUnique({
      where: { shop },
      select: { alertEmail: true, planId: true },
    });
    if (settings?.alertEmail) defaultEmail = settings.alertEmail;
    planTier = await getEffectivePlanId(shop, settings);
  } catch {
    // Graceful fallback
  }

  // eslint-disable-next-line no-undef
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    // The nav link is just a convenience — access is enforced by the admin
    // route's own loader/action, not by hiding the link.
    showAdminLink: isPlatformAdmin(session.shop, session),
    shop,
    defaultEmail,
    planTier,
  };
};

export default function App() {
  const { apiKey, showAdminLink, shop, defaultEmail, planTier } = useLoaderData();
  const { pathname } = useLocation();

  // <s-link> has no working active/selected attribute — Admin highlights an
  // item purely by matching its own current URL against each item's href.
  // We render the owning section's href as the *current* pathname so it
  // matches exactly while inside that section (hub tabs, detail pages);
  // every other link keeps its stable, canonical destination. See
  // navigation.js for the full explanation.
  const navHref = (canonicalHref) => resolveNavHref(canonicalHref, pathname);

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href={navHref("/app/desktop")}>Desktop</s-link>
        <s-link href={navHref("/app/restore-points")}>
          Backups &amp; Recovery
        </s-link>
        <s-link href={navHref("/app/incidents")}>Store Protection</s-link>
        <s-link href={navHref("/app/settings")}>Settings &amp; Team</s-link>
        <s-link href={navHref("/app/plan")}>Plans &amp; Billing</s-link>
        <s-link href={navHref("/app/support")}>Support</s-link>
        {showAdminLink && (
          <s-link href={navHref("/app/admin")}>Admin Panel</s-link>
        )}
      </s-app-nav>
      <Outlet />
      <GlobalSupportWidget shop={shop} defaultEmail={defaultEmail} planTier={planTier} />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
