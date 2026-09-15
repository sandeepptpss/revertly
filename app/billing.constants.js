export const PLAN_STARTER = "Starter";
export const PLAN_GROWTH = "Growth";
export const PLAN_BUSINESS = "Business";
export const PLAN_ENTERPRISE = "Enterprise";
export const PLAN_PRO = PLAN_GROWTH;

export const PLAN_TIERS = {
  free: { id: "free", name: "Free", price: 0, order: 0 },
  starter: { id: "starter", name: "Starter", price: 9, order: 1 },
  growth: { id: "growth", name: "Growth", price: 24, order: 2 },
  business: { id: "business", name: "Business", price: 49, order: 3 },
  enterprise: { id: "enterprise", name: "Enterprise", price: 79, order: 4 },
};
