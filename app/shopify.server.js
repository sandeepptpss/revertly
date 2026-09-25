import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  BillingReplacementBehavior,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server.js";

export const PLAN_STARTER = "Starter";
export const PLAN_GROWTH = "Growth";
export const PLAN_BUSINESS = "Business";
export const PLAN_ENTERPRISE = "Enterprise";

export const PLAN_STARTER_ANNUAL = "Starter (Annual)";
export const PLAN_GROWTH_ANNUAL = "Growth (Annual)";
export const PLAN_BUSINESS_ANNUAL = "Business (Annual)";
export const PLAN_ENTERPRISE_ANNUAL = "Enterprise (Annual)";
export const PLAN_ENTERPRISE_CUSTOM = "Enterprise Plus (Custom)";

// Aliases for backwards compatibility
export const PLAN_PRO = PLAN_GROWTH;

// Webhook HMACs are verified with the API secret. Falling back to a literal
// that is committed to this repo would let anyone forge a webhook — including
// shop/redact (wipes a store's data) or app_subscriptions/update (grants a
// plan). A missing secret in production is a deploy fault, not a default.
if (process.env.NODE_ENV === "production" && !process.env.SHOPIFY_API_SECRET) {
  throw new Error(
    "SHOPIFY_API_SECRET is not set. Refusing to start in production with the placeholder secret, " +
      "which would accept forged webhooks.",
  );
}

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY || "1aa2f8043b53bd114b8814fc368663fd",
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "dummy_secret_key_for_testing",
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(",") || [
    "read_products",
    "write_products",
    "read_inventory",
    "read_themes",
    "write_themes",
    "read_content",
    "write_content",
    "read_online_store_navigation",
    "write_online_store_navigation",
  ],
  appUrl: process.env.SHOPIFY_APP_URL || "https://example.com",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  // Required for team roles to mean anything. An offline session identifies the
  // *store*, not the person, so without this every request arrives anonymous and
  // team.server.js has to fall back to ADMIN for everyone — making an assigned
  // VIEWER or EDITOR role unenforceable. Token exchange still stores the offline
  // session alongside it, so `unauthenticated.admin()` (scheduler, cron) is
  // unaffected.
  useOnlineTokens: true,
  future: {
    expiringOfflineAccessTokens: true,
  },
  billing: {
    [PLAN_STARTER]: {
      trialDays: 14,
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          amount: 9,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
    [PLAN_STARTER_ANNUAL]: {
      trialDays: 14,
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          amount: 108,
          currencyCode: "USD",
          interval: BillingInterval.Annual,
        },
      ],
    },
    [PLAN_GROWTH]: {
      trialDays: 14,
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          amount: 24,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
    [PLAN_GROWTH_ANNUAL]: {
      trialDays: 14,
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          amount: 288,
          currencyCode: "USD",
          interval: BillingInterval.Annual,
        },
      ],
    },
    [PLAN_BUSINESS]: {
      trialDays: 14,
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          amount: 49,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
    [PLAN_BUSINESS_ANNUAL]: {
      trialDays: 14,
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          amount: 588,
          currencyCode: "USD",
          interval: BillingInterval.Annual,
        },
      ],
    },
    [PLAN_ENTERPRISE]: {
      trialDays: 14,
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          amount: 99,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
    [PLAN_ENTERPRISE_ANNUAL]: {
      trialDays: 14,
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          amount: 990,
          currencyCode: "USD",
          interval: BillingInterval.Annual,
        },
      ],
    },
    // The amount is a placeholder: every request for this plan overrides it
    // with the store's negotiated price (app.plan.jsx, activateCustomPlus).
    [PLAN_ENTERPRISE_CUSTOM]: {
      trialDays: 0,
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          amount: 249,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
  },
  hooks: {
    // Runs on every token exchange, which online tokens make at least daily
    // per staff member. Keeps the stored Partner-development flag current so
    // the entitlement gates (which have no admin client) can honour it.
    afterAuth: async ({ session, admin }) => {
      try {
        const { refreshPartnerDevelopmentFlag } = await import("./billing.server.js");
        await refreshPartnerDevelopmentFlag(session.shop, admin);
      } catch (err) {
        console.warn("[Revertly Billing] Partner-development check skipped:", err?.message || err);
      }
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
