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

// Aliases for backwards compatibility
export const PLAN_PRO = PLAN_GROWTH;

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
          amount: 79,
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
          amount: 948,
          currencyCode: "USD",
          interval: BillingInterval.Annual,
        },
      ],
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
