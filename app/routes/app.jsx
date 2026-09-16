import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
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

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app" rel="home">Dashboard</s-link>
        <s-link href="/app/activity">Activity</s-link>
        <s-link href="/app/incidents">Incidents</s-link>
        <s-link href="/app/restore-points">Restore Points</s-link>
        <s-link href="/app/import-export">Import &amp; Export</s-link>
        <s-link href="/app/vault">Data Vault</s-link>
        <s-link href="/app/rollback-history">Rollback History</s-link>
        <s-link href="/app/rules">Rules</s-link>
        <s-link href="/app/monitoring">Uptime</s-link>
        <s-link href="/app/qa">Health Check</s-link>
        <s-link href="/app/team">Team</s-link>
        <s-link href="/app/settings">Settings</s-link>
        <s-link href="/app/plan">Plans &amp; Billing</s-link>
        <s-link href="/app/support">Support</s-link>
        {showAdminLink && <s-link href="/app/admin">Admin Panel</s-link>}
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
