export const PLAN_STARTER = "Starter";
export const PLAN_GROWTH = "Growth";
export const PLAN_BUSINESS = "Business";
export const PLAN_ENTERPRISE = "Enterprise";
export const PLAN_PRO = PLAN_GROWTH;

export const PLAN_STARTER_ANNUAL = "Starter (Annual)";
export const PLAN_GROWTH_ANNUAL = "Growth (Annual)";
export const PLAN_BUSINESS_ANNUAL = "Business (Annual)";
export const PLAN_ENTERPRISE_ANNUAL = "Enterprise (Annual)";

// A negotiated Custom Enterprise Plus subscription. It has its own Shopify
// plan name so a $249 custom charge can be told apart from a standard $99
// Enterprise one — only this name may mark a custom offer as paid for.
export const PLAN_ENTERPRISE_CUSTOM = "Enterprise Plus (Custom)";

// Every subscription name this app bills under. `billing.check` only reports
// subscriptions whose name is in the list it is given, so any check that must
// see all of a store's charges has to pass exactly this list.
export const ALL_BILLING_PLAN_NAMES = [
  PLAN_STARTER,
  PLAN_GROWTH,
  PLAN_BUSINESS,
  PLAN_ENTERPRISE,
  PLAN_STARTER_ANNUAL,
  PLAN_GROWTH_ANNUAL,
  PLAN_BUSINESS_ANNUAL,
  PLAN_ENTERPRISE_ANNUAL,
  PLAN_ENTERPRISE_CUSTOM,
];

export const INTERVAL_MONTHLY = "EVERY_30_DAYS";
export const INTERVAL_ANNUAL = "ANNUAL";

export const PLAN_TIERS = {
  free: {
    id: "free",
    name: "Free",
    price: 0,
    monthlyPrice: 0,
    yearlyPrice: 0,
    yearlyMonthlyEquivalent: 0,
    order: 0,
  },
  starter: {
    id: "starter",
    name: "Starter",
    price: 9,
    monthlyPrice: 9,
    yearlyPrice: 108,
    yearlyMonthlyEquivalent: 9,
    order: 1,
  },
  growth: {
    id: "growth",
    name: "Growth",
    price: 24,
    monthlyPrice: 24,
    yearlyPrice: 288,
    yearlyMonthlyEquivalent: 24,
    order: 2,
  },
  business: {
    id: "business",
    name: "Business",
    price: 49,
    monthlyPrice: 49,
    yearlyPrice: 588,
    yearlyMonthlyEquivalent: 49,
    order: 3,
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    price: 99,
    monthlyPrice: 99,
    yearlyPrice: 990,
    yearlyMonthlyEquivalent: 82.5,
    order: 4,
  },
};

