export const PLAN_STARTER = "Starter";
export const PLAN_GROWTH = "Growth";
export const PLAN_BUSINESS = "Business";
export const PLAN_ENTERPRISE = "Enterprise";
export const PLAN_PRO = PLAN_GROWTH;

export const PLAN_STARTER_ANNUAL = "Starter (Annual)";
export const PLAN_GROWTH_ANNUAL = "Growth (Annual)";
export const PLAN_BUSINESS_ANNUAL = "Business (Annual)";
export const PLAN_ENTERPRISE_ANNUAL = "Enterprise (Annual)";

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

