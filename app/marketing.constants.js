/**
 * Email marketing (ESP) constants shared by the server module and the UI.
 *
 * These live outside marketing.server.js because the Email Marketing page
 * renders provider labels and upgrade copy in the browser, and importing a
 * *.server.js module from component code pulls server-only dependencies into
 * the client bundle — the same reason billing.constants.js exists apart from
 * billing.server.js.
 */
export const MARKETING_PROVIDERS = {
  KLAVIYO: {
    id: "KLAVIYO",
    label: "Klaviyo",
    // What the provider itself calls the things we back up, for honest copy.
    listLabel: "Lists & Segments",
    flowLabel: "Flows",
    keyHint: "Private API key from Klaviyo → Settings → API Keys (starts with pk_)",
  },
  MAILCHIMP: {
    id: "MAILCHIMP",
    label: "Mailchimp",
    listLabel: "Audiences & Segments",
    flowLabel: "Journeys",
    keyHint: "API key from Mailchimp → Account → Extras → API keys (ends with -us1, -us2, …)",
  },
};

export const MARKETING_UPGRADE_MESSAGE =
  "Klaviyo & Mailchimp Backup is not included in the Free or Starter plans. Upgrade to Growth ($24), Business ($49), or Enterprise ($79) in Plans & Billing to back up your email marketing lists, segments and subscriber profiles.";

export const MARKETING_FLOWS_UPGRADE_MESSAGE =
  "Klaviyo Flows & Mailchimp Journeys backup is included from the Business plan. Your lists, segments and subscriber profiles are still being backed up on your current plan.";

/** A key beginning with this is served by the simulator, never the network. */
export const SIMULATED_KEY_PREFIX = "sim_";

export function getMarketingProvider(providerId) {
  return MARKETING_PROVIDERS[String(providerId || "").toUpperCase()] || null;
}
