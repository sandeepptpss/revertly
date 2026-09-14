import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server.js";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app" rel="home">Dashboard</s-link>
        <s-link href="/app/activity">Activity</s-link>
        <s-link href="/app/incidents">Incidents</s-link>
        <s-link href="/app/restore-points">Restore Points</s-link>
        <s-link href="/app/rollback-history">Rollback History</s-link>
        <s-link href="/app/rules">Rules</s-link>
        <s-link href="/app/settings">Settings</s-link>
        <s-link href="/app/plan">Plans &amp; Billing</s-link>
        <s-link href="/app/support">Support</s-link>
      </s-app-nav>
      <Outlet />
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
