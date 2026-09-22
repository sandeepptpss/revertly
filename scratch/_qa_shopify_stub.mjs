// Test double for app/shopify.server.js so route loaders/actions can be invoked
// directly without a live Shopify session token.
import { getMockAdmin, getMockShop } from "./_qa_mock_admin.mjs";

export const authenticate = {
  admin: async () => ({
    session: { shop: getMockShop(), id: "offline_" + getMockShop() },
    admin: getMockAdmin(),
  }),
};
export const apiVersion = "2025-07";
export const login = async () => ({});
export const registerWebhooks = async () => ({});
export const unauthenticated = { admin: async () => ({ admin: getMockAdmin() }) };
export const sessionStorage = {};
export const addDocumentResponseHeaders = () => {};
const shopify = { authenticate, unauthenticated, apiVersion };
export default shopify;
