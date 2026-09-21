import { Fragment, useState, useEffect } from "react";
import { useLoaderData, useFetcher, useRouteError, redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { isPlatformAdmin, getSessionEmail, PLATFORM_ADMIN_SHOP } from "../platformAdmin.server.js";
import {
  computeExpiry,
  getPlatformSettings,
  getActiveGlobalDiscount,
  isStoreDiscountInForce,
} from "../storeDiscount.server.js";
import { getFreeGrowthStatus } from "../freeGrowth.server.js";
import {
  DISCOUNT_DURATION_MONTHS,
  normalizeTier,
  TIER_STANDARD,
  TIER_VIP,
} from "../discount.constants.js";
import { PLAN_TIERS } from "../billing.constants.js";
import { normalizePlanId } from "../billing.server.js";
import { Banner } from "../components/Banner.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";
import {
  ShieldCheckIcon,
  DatabaseIcon,
  SparklesIcon,
  Trash2Icon,
  HistoryIcon,
  MailIcon,
  CheckCircleIcon,
  AlertTriangleIcon,
  ClockIcon,
  SaveIcon,
  XIcon,
  ExternalLinkIcon,
} from "../components/Icons.jsx";

/**
 * Platform Admin Panel.
 *
 * Cross-merchant view, intentionally unlike every other route in this app —
 * everything else is scoped to `session.shop`. Gated by isPlatformAdmin(),
 * checked in BOTH the loader (page access) and the action (write access),
 * because a route guard on the page alone would not stop a direct POST.
 */
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  if (!isPlatformAdmin(shop, session)) {
    // Deliberately a quiet redirect rather than a 403 page: this route's
    // existence is not something an ordinary merchant needs to know about.
    throw redirect("/app");
  }

  const [
    settingsRows,
    installedShops,
    discounts,
    restorePointCounts,
    openIncidentCounts,
    platformSettings,
    freeGrowth,
    freeGrowthGrants,
    supportTickets,
    productCounts,
  ] = await Promise.all([
    prisma.appSettings.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.session.findMany({ distinct: ["shop"], select: { shop: true } }),
    prisma.storeDiscount.findMany(),
    prisma.restorePoint.groupBy({ by: ["shop"], _count: { _all: true } }),
    prisma.incident.groupBy({ by: ["shop"], _count: { _all: true }, where: { status: "OPEN" } }),
    getPlatformSettings(),
    getFreeGrowthStatus(),
    prisma.freeGrowthGrant.findMany(),
    prisma.supportTicket.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.productSnapshot.groupBy({ by: ["shop"], _count: { _all: true } }),
  ]);

  const productCountByShop = new Map(productCounts.map((p) => [p.shop, p._count._all]));

  // AppSettings rows are written lazily, so a store can be installed without
  // one. Union the two lists so a freshly-installed merchant is still visible
  // here — and therefore still grantable.
  const settingsByShop = new Map(settingsRows.map((s) => [s.shop, s]));
  const merchants = [
    ...settingsRows,
    ...installedShops.filter((s) => !settingsByShop.has(s.shop)).map((s) => ({ shop: s.shop })),
  ];

  const discountByShop = new Map(discounts.map((d) => [d.shop, d]));
  const restoreCountByShop = new Map(restorePointCounts.map((r) => [r.shop, r._count._all]));
  const incidentCountByShop = new Map(openIncidentCounts.map((r) => [r.shop, r._count._all]));
  const freeGrowthByShop = new Map(freeGrowthGrants.map((g) => [g.shop, g]));

  const now = Date.now();
  const globalDiscount = await getActiveGlobalDiscount(platformSettings);

  const rows = merchants.map((m) => {
    const discount = discountByShop.get(m.shop) || null;
    // An unclaimed VIP offer discounts nothing, so it must not count here
    // either — the admin's "Effective" column has to match what the merchant
    // is actually charged.
    const discountActive = isStoreDiscountInForce(discount);
    const awaitingClaim = Boolean(
      discount?.isActive && normalizeTier(discount.tier) === TIER_VIP && !discount.claimedAt,
    );
    const seat = freeGrowthByShop.get(m.shop) || null;
    const seatActive = Boolean(seat && new Date(seat.expiresAt).getTime() > now);

    // Mirrors resolveBestDiscount(): store discount applies to monthly & yearly, global discount applies to yearly.
    const storePercent = discountActive ? discount.discountPercent : 0;
    const globalPercent = globalDiscount ? globalDiscount.percent : 0;
    const storeTier = normalizeTier(discount?.tier);
    const yearlyEffective =
      storePercent === 0 && globalPercent === 0
        ? null
        : storePercent >= globalPercent
          ? { percent: storePercent, source: storeTier }
          : { percent: globalPercent, source: "GLOBAL" };
    const monthlyEffective =
      storePercent > 0
        ? { percent: storePercent, source: storeTier }
        : null;

    const effective = yearlyEffective
      ? {
          percent: yearlyEffective.percent,
          source: yearlyEffective.source,
          yearly: yearlyEffective,
          monthly: monthlyEffective,
        }
      : null;

    const normPlan = normalizePlanId(m.planId);
    const planOrder = PLAN_TIERS[normPlan]?.order ?? 0;
    const effectivePlanId = seatActive && planOrder < (PLAN_TIERS.growth?.order ?? 2) ? "growth" : normPlan;

    return {
      shop: m.shop,
      planId: effectivePlanId,
      hasUsedTrial: Boolean(m.hasUsedTrial),
      trialEndsAt: m.trialEndsAt ?? null,
      monitoringEnabled: Boolean(m.monitoringEnabled),
      circuitBreakerEnabled: Boolean(m.circuitBreakerEnabled),
      alertEmail: m.alertEmail ?? null,
      lastAutoBackupAt: m.lastAutoBackupAt ?? null,
      firstSeenAt: m.createdAt ?? null,
      restorePointCount: restoreCountByShop.get(m.shop) || 0,
      openIncidentCount: incidentCountByShop.get(m.shop) || 0,
      productCount: productCountByShop.get(m.shop) || 0,
      customProductLimit: m.customProductLimit ?? null,
      customPlanNote: m.customPlanNote ?? null,
      customPriceAmount: m.customPriceAmount ?? null,
      customBillingMethod: m.customBillingMethod ?? "SHOPIFY",
      customPriceStatus: m.customPriceStatus ?? null,
      discount: discount
        ? {
            percent: discount.discountPercent,
            tier: normalizeTier(discount.tier),
            note: discount.note,
            isActive: discountActive,
            awaitingClaim,
            claimedAt: discount.claimedAt,
            expiresAt: discount.expiresAt,
            updatedByEmail: discount.updatedByEmail,
            updatedAt: discount.updatedAt,
          }
        : null,
      effectiveDiscount: effective,
      freeGrowthSeat: seat ? { expiresAt: seat.expiresAt, isActive: seatActive } : null,
    };
  });

  return {
    merchants: rows,
    tickets: supportTickets.map((t) => ({
      id: t.id,
      shop: t.shop,
      subject: t.subject,
      category: t.category,
      message: t.message,
      email: t.email,
      status: t.status,
      priority: t.priority,
      planTier: t.planTier,
      createdAt: t.createdAt.toISOString(),
    })),
    adminShop: PLATFORM_ADMIN_SHOP,
    durationMonths: DISCOUNT_DURATION_MONTHS,
    global: {
      percent: platformSettings.globalDiscountPercent,
      note: platformSettings.globalDiscountNote,
      isActive: Boolean(globalDiscount),
      expiresAt: platformSettings.globalDiscountExpiresAt,
    },
    freeGrowth,
  };
};

/** Strict 1-100 whole percent, or null. parseInt would accept "50abc"/"1e9". */
function parsePercent(raw) {
  const s = String(raw ?? "").trim();
  const n = /^\d{1,3}$/.test(s) ? Number(s) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
}

/**
 * Truncate by code point: slicing UTF-16 units can split an emoji's surrogate
 * pair, which MySQL rejects outright.
 */
function truncateNote(raw) {
  return Array.from(String(raw || "").trim()).slice(0, 500).join("") || null;
}

/**
 * Platform-wide audit entries have no single merchant to file under, so they
 * are recorded against the operator's own store.
 */
async function writeAdminAudit(action, adminEmail, details) {
  await prisma.auditLog
    .create({
      data: {
        shop: PLATFORM_ADMIN_SHOP,
        userEmail: adminEmail || null,
        userName: "Platform Admin",
        action,
        resourceType: "PlatformSettings",
        details,
      },
    })
    .catch(() => {});
}

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Re-checked here independently of the loader: a direct POST to this route
  // must be refused even if it never rendered the page.
  if (!isPlatformAdmin(shop, session)) {
    return { success: false, message: "You do not have access to this action." };
  }

  const formData = await request.formData();
  const intent = formData.get("intent");
  const targetShop = String(formData.get("targetShop") || "").trim().toLowerCase();
  const adminEmail = getSessionEmail(session);

  // ── Platform-wide intents (no target store) ──────────────────────────────

  if (intent === "setGlobalDiscount") {
    const percent = parsePercent(formData.get("globalDiscountPercent"));
    if (percent === null) {
      return { success: false, message: "Global discount must be a whole number percentage between 1 and 100." };
    }
    const note = truncateNote(formData.get("globalNote"));
    const expiresAt = computeExpiry();

    await prisma.platformSettings.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        globalDiscountPercent: percent,
        globalDiscountNote: note,
        globalDiscountActive: true,
        globalDiscountExpiresAt: expiresAt,
        updatedByEmail: adminEmail || null,
      },
      update: {
        globalDiscountPercent: percent,
        globalDiscountNote: note,
        globalDiscountActive: true,
        globalDiscountExpiresAt: expiresAt,
        updatedByEmail: adminEmail || null,
      },
    });

    await writeAdminAudit("ADMIN_GLOBAL_DISCOUNT_SET", adminEmail, {
      discountPercent: percent,
      note,
      expiresAt,
    });

    return {
      success: true,
      message: `${percent}% global discount is now live for every store, until ${formatDate(expiresAt)}.`,
    };
  }

  if (intent === "clearGlobalDiscount") {
    const current = await prisma.platformSettings.findUnique({ where: { id: 1 } });
    if (!current?.globalDiscountActive) {
      return { success: false, message: "There is no active global discount to turn off." };
    }
    await prisma.platformSettings.update({
      where: { id: 1 },
      data: { globalDiscountActive: false, updatedByEmail: adminEmail || null },
    });
    await writeAdminAudit("ADMIN_GLOBAL_DISCOUNT_CLEARED", adminEmail, {
      previousPercent: current.globalDiscountPercent,
    });
    return { success: true, message: "Global discount turned off. Store-specific discounts are unaffected." };
  }

  if (intent === "updateFreeGrowth") {
    const rawLimit = String(formData.get("freeGrowthSeatLimit") ?? "").trim();
    const limit = /^\d{1,4}$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000) {
      return { success: false, message: "Seat limit must be a whole number between 0 and 1000." };
    }

    const rawMonths = String(formData.get("freeGrowthDurationMonths") ?? "2").trim();
    const durationMonths = /^\d{1,2}$/.test(rawMonths) ? Number(rawMonths) : NaN;
    if (!Number.isInteger(durationMonths) || durationMonths < 1 || durationMonths > 36) {
      return { success: false, message: "Free offer duration must be a whole number between 1 and 36 months." };
    }

    const enabled = formData.get("freeGrowthEnabled") === "1";

    const used = await prisma.freeGrowthGrant.count();
    if (limit < used) {
      return {
        success: false,
        message: `${used} seats are already awarded, so the limit cannot be lowered to ${limit}. Existing seats are never revoked automatically.`,
      };
    }

    try {
      await prisma.platformSettings.upsert({
        where: { id: 1 },
        create: {
          id: 1,
          freeGrowthEnabled: enabled,
          freeGrowthSeatLimit: limit,
          freeGrowthDurationMonths: durationMonths,
          updatedByEmail: adminEmail || null,
        },
        update: {
          freeGrowthEnabled: enabled,
          freeGrowthSeatLimit: limit,
          freeGrowthDurationMonths: durationMonths,
          updatedByEmail: adminEmail || null,
        },
      });
    } catch (upsertErr) {
      if (upsertErr?.message?.includes("freeGrowthDurationMonths")) {
        // Fallback for long-running Node/Vite processes caching older Prisma Client definitions
        await prisma.$executeRawUnsafe(
          `INSERT INTO PlatformSettings (id, freeGrowthEnabled, freeGrowthSeatLimit, freeGrowthDurationMonths, updatedByEmail, updatedAt) 
           VALUES (1, ?, ?, ?, ?, NOW()) 
           ON DUPLICATE KEY UPDATE freeGrowthEnabled = VALUES(freeGrowthEnabled), freeGrowthSeatLimit = VALUES(freeGrowthSeatLimit), freeGrowthDurationMonths = VALUES(freeGrowthDurationMonths), updatedByEmail = VALUES(updatedByEmail), updatedAt = NOW()`,
          enabled ? 1 : 0,
          limit,
          durationMonths,
          adminEmail || null
        );
      } else {
        throw upsertErr;
      }
    }

    await writeAdminAudit("ADMIN_FREE_GROWTH_UPDATED", adminEmail, { enabled, seatLimit: limit, durationMonths });

    return {
      success: true,
      message: enabled
        ? `Free Growth promotion is on: ${durationMonths}-month free offer for the first ${limit} merchants (${used} claimed, ${Math.max(0, limit - used)} left).`
        : "Free Growth promotion is off. Stores that already hold a seat keep it until it expires.",
    };
  }

  if (intent === "updateTicketStatus") {
    const ticketId = parseInt(formData.get("ticketId"), 10);
    const status = String(formData.get("status") || "RESOLVED").toUpperCase();
    if (!ticketId) {
      return { success: false, message: "Invalid ticket ID." };
    }
    const updated = await prisma.supportTicket.update({
      where: { id: ticketId },
      data: { status },
    });
    await writeAdminAudit("ADMIN_TICKET_STATUS_UPDATED", adminEmail, { ticketId, status, shop: updated.shop });
    return { success: true, message: `Ticket #${ticketId} status updated to ${status}.` };
  }

  // ── Store-scoped intents ─────────────────────────────────────────────────

  if (!targetShop) {
    return { success: false, message: "Choose a merchant store first." };
  }

  // Mirrors the loader's union: a store with a live session but no settings
  // row yet is still a real merchant.
  const [merchantSettings, merchantSession] = await Promise.all([
    prisma.appSettings.findUnique({ where: { shop: targetShop } }),
    prisma.session.findFirst({ where: { shop: targetShop }, select: { id: true } }),
  ]);
  if (!merchantSettings && !merchantSession) {
    return { success: false, message: `"${targetShop}" is not a known merchant store.` };
  }

  if (intent === "setCustomQuota") {
    const customLimit = parseInt(formData.get("customProductLimit"), 10);
    if (!customLimit || customLimit < 1000) {
      return { success: false, message: "Custom product limit must be a valid number of at least 1,000 products." };
    }
    const billingMethod =
      String(formData.get("customBillingMethod") || "SHOPIFY").toUpperCase() === "EXTERNAL"
        ? "EXTERNAL"
        : "SHOPIFY";
    const rawPrice = formData.get("customPriceAmount");
    const customPrice = rawPrice ? parseInt(rawPrice, 10) : null;
    if (customPrice !== null && (isNaN(customPrice) || customPrice < 0 || customPrice > 10000)) {
      return { success: false, message: "Custom monthly price must be a valid dollar amount (e.g. 199, 249)." };
    }
    const note = truncateNote(formData.get("customPlanNote"));

    // If EXTERNAL (Direct Invoice / Contract), mark as ACTIVE immediately.
    // If SHOPIFY:
    // - If switching from EXTERNAL to SHOPIFY, mark as OFFERED so merchant approves via Shopify.
    // - If price or limit changed, mark as OFFERED for merchant approval.
    // - Otherwise retain existing status (ACTIVE or OFFERED).
    const priceStatus =
      billingMethod === "EXTERNAL"
        ? "ACTIVE"
        : merchantSettings?.customBillingMethod === "EXTERNAL"
        ? "OFFERED"
        : merchantSettings?.customPriceAmount !== customPrice || merchantSettings?.customProductLimit !== customLimit
        ? "OFFERED"
        : merchantSettings?.customPriceStatus || "OFFERED";

    await prisma.appSettings.upsert({
      where: { shop: targetShop },
      create: {
        shop: targetShop,
        customProductLimit: customLimit,
        customPlanNote: note,
        customPriceAmount: customPrice,
        customBillingMethod: billingMethod,
        customPriceStatus: priceStatus,
        productLimitReachedAt: null,
      },
      update: {
        customProductLimit: customLimit,
        customPlanNote: note,
        customPriceAmount: customPrice,
        customBillingMethod: billingMethod,
        customPriceStatus: priceStatus,
        productLimitReachedAt: null,
      },
    });
    await prisma.auditLog.create({
      data: {
        shop: targetShop,
        userEmail: adminEmail || null,
        userName: "Platform Admin",
        action: "ADMIN_CUSTOM_QUOTA_GRANTED",
        resourceType: "AppSettings",
        details: {
          customProductLimit: customLimit,
          customPlanNote: note,
          customPriceAmount: customPrice,
          customBillingMethod: billingMethod,
          customPriceStatus: priceStatus,
        },
      },
    });
    const priceLabel = customPrice
      ? ` at $${customPrice}/mo (${billingMethod === "EXTERNAL" ? "External Contract" : "Shopify Billing"})`
      : "";
    return {
      success: true,
      message: `Custom quota of ${customLimit.toLocaleString()} products${priceLabel} configured for ${targetShop}.`,
    };
  }

  if (intent === "resetCustomQuota") {
    await prisma.appSettings.update({
      where: { shop: targetShop },
      data: {
        customProductLimit: null,
        customPlanNote: null,
        customPriceAmount: null,
        customBillingMethod: "SHOPIFY",
        customPriceStatus: null,
      },
    });
    await prisma.auditLog.create({
      data: {
        shop: targetShop,
        userEmail: adminEmail || null,
        userName: "Platform Admin",
        action: "ADMIN_CUSTOM_QUOTA_REMOVED",
        resourceType: "AppSettings",
        details: { resetBy: adminEmail },
      },
    });
    return { success: true, message: `Custom quota reset to plan default for ${targetShop}.` };
  }

  if (intent === "setDiscount") {
    const percent = parsePercent(formData.get("discountPercent"));
    if (percent === null) {
      return { success: false, message: "Discount must be a whole number percentage between 1 and 100." };
    }
    const tier = normalizeTier(formData.get("tier"));
    const note = truncateNote(formData.get("note"));
    const expiresAt = computeExpiry();

    const existing = await prisma.storeDiscount.findUnique({ where: { shop: targetShop } });

    await prisma.storeDiscount.upsert({
      where: { shop: targetShop },
      create: {
        shop: targetShop,
        tier,
        discountPercent: percent,
        note,
        isActive: true,
        expiresAt,
        createdByEmail: adminEmail || null,
        updatedByEmail: adminEmail || null,
      },
      update: {
        tier,
        discountPercent: percent,
        note,
        isActive: true,
        expiresAt,
        updatedByEmail: adminEmail || null,
      },
    });

    await prisma.auditLog.create({
      data: {
        shop: targetShop,
        userEmail: adminEmail || null,
        userName: "Platform Admin",
        action: existing ? "ADMIN_DISCOUNT_UPDATED" : "ADMIN_DISCOUNT_GRANTED",
        resourceType: "StoreDiscount",
        details: { discountPercent: percent, tier, note, expiresAt, durationMonths: DISCOUNT_DURATION_MONTHS },
      },
    }).catch(() => {});

    return {
      success: true,
      message: `${percent}% ${tier === TIER_VIP ? "VIP " : ""}discount ${existing ? "updated" : "granted"} for ${targetShop}, valid until ${formatDate(expiresAt)}.`,
    };
  }

  if (intent === "removeDiscount") {
    const existing = await prisma.storeDiscount.findUnique({ where: { shop: targetShop } });
    if (!existing || !existing.isActive) {
      return { success: false, message: `${targetShop} has no active discount to remove.` };
    }

    // Soft-disable rather than delete, so the grant/removal history survives
    // for the audit trail — consistent with how the rest of this app treats
    // removal (suspended team members, disconnected cloud sync, etc).
    await prisma.storeDiscount.update({
      where: { shop: targetShop },
      data: { isActive: false, updatedByEmail: adminEmail || null },
    });

    await prisma.auditLog.create({
      data: {
        shop: targetShop,
        userEmail: adminEmail || null,
        userName: "Platform Admin",
        action: "ADMIN_DISCOUNT_REMOVED",
        resourceType: "StoreDiscount",
        details: { previousPercent: existing.discountPercent },
      },
    }).catch(() => {});

    return { success: true, message: `Discount removed for ${targetShop}.` };
  }

  return { success: false, message: "Unknown action." };
};

const EFFECTIVE_LABELS = {
  VIP: "VIP",
  STANDARD: "store",
  GLOBAL: "global",
};

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toISOString().slice(0, 10);
}

export default function AdminPanel() {
  const { merchants, tickets = [], durationMonths, global: globalDiscount, freeGrowth } = useLoaderData();
  const globalFetcher = useFetcher();
  const freeGrowthFetcher = useFetcher();
  const storeFetcher = useFetcher();
  const ticketFetcher = useFetcher();
  const quotaFetcher = useFetcher();

  const isGlobalBusy = globalFetcher.state !== "idle";
  const isFreeGrowthBusy = freeGrowthFetcher.state !== "idle";
  const isStoreBusy = storeFetcher.state !== "idle";
  const isTicketBusy = ticketFetcher.state !== "idle";
  const isQuotaBusy = quotaFetcher.state !== "idle";

  // Display the result message from whichever action was triggered
  const result =
    globalFetcher.data ||
    freeGrowthFetcher.data ||
    storeFetcher.data ||
    ticketFetcher.data ||
    quotaFetcher.data;

  const [editingShop, setEditingShop] = useState(null);
  const [percentDraft, setPercentDraft] = useState("10");
  const [noteDraft, setNoteDraft] = useState("");
  const [tierDraft, setTierDraft] = useState(TIER_STANDARD);

  const [globalPercentDraft, setGlobalPercentDraft] = useState(String(globalDiscount.percent ?? 10));
  const [globalNoteDraft, setGlobalNoteDraft] = useState(globalDiscount.note ?? "");
  const [seatLimitDraft, setSeatLimitDraft] = useState(String(freeGrowth.limit));
  const [durationMonthsDraft, setDurationMonthsDraft] = useState(String(freeGrowth.durationMonths || 2));
  const [freeGrowthOn, setFreeGrowthOn] = useState(freeGrowth.enabled);

  const [removeDiscountTarget, setRemoveDiscountTarget] = useState(null);
  const [showClearGlobalModal, setShowClearGlobalModal] = useState(false);

  // Ticket management state
  const [viewingTicket, setViewingTicket] = useState(null);
  const [ticketFilter, setTicketFilter] = useState("ALL");

  // Custom quota & pricing state
  const [quotaTargetShop, setQuotaTargetShop] = useState(null);
  const [customLimitDraft, setCustomLimitDraft] = useState("350000");
  const [customPriceDraft, setCustomPriceDraft] = useState("249");
  const [customBillingMethodDraft, setCustomBillingMethodDraft] = useState("SHOPIFY");
  const [customNoteDraft, setCustomNoteDraft] = useState("");

  const isClearingGlobal = globalFetcher.state !== "idle" && globalFetcher.formData?.get("intent") === "clearGlobalDiscount";
  const isRemovingDiscount = storeFetcher.state !== "idle" && storeFetcher.formData?.get("intent") === "removeDiscount";

  useEffect(() => {
    if (globalFetcher.data && !isClearingGlobal) {
      setShowClearGlobalModal(false);
    }
  }, [globalFetcher.data, isClearingGlobal]);

  useEffect(() => {
    if (storeFetcher.data && !isRemovingDiscount) {
      setRemoveDiscountTarget(null);
    }
  }, [storeFetcher.data, isRemovingDiscount]);

  useEffect(() => {
    if (quotaFetcher.data?.success) {
      setQuotaTargetShop(null);
    }
  }, [quotaFetcher.data]);

  useEffect(() => {
    if (ticketFetcher.data?.success && viewingTicket) {
      const updatedId = ticketFetcher.formData?.get("ticketId");
      const updatedStatus = ticketFetcher.formData?.get("status");
      if (updatedId && updatedStatus && viewingTicket.id === Number(updatedId)) {
        setViewingTicket((prev) => (prev ? { ...prev, status: updatedStatus } : null));
      }
    }
  }, [ticketFetcher.data, ticketFetcher.formData, viewingTicket]);

  function startEditing(row) {
    setEditingShop(row.shop);
    setPercentDraft(String(row.discount?.percent ?? 10));
    setNoteDraft(row.discount?.note ?? "");
    setTierDraft(row.discount?.tier ?? TIER_STANDARD);
  }

  function startQuotaEdit(row) {
    setQuotaTargetShop(row);
    setCustomLimitDraft(String(row.customProductLimit || Math.max(300000, (row.productCount || 0) + 50000)));
    setCustomPriceDraft(String(row.customPriceAmount || 249));
    setCustomBillingMethodDraft(row.customBillingMethod || "SHOPIFY");
    setCustomNoteDraft(row.customPlanNote || "");
  }

  function updateTicketStatus(ticketId, status) {
    ticketFetcher.submit(
      { intent: "updateTicketStatus", ticketId: String(ticketId), status },
      { method: "POST" }
    );
  }

  const seatPct = freeGrowth.limit > 0 ? Math.min(100, (freeGrowth.used / freeGrowth.limit) * 100) : 0;

  const filteredTickets = tickets.filter((t) => {
    if (ticketFilter === "ALL") return true;
    if (ticketFilter === "OPEN") return t.status === "OPEN";
    if (ticketFilter === "IN_PROGRESS") return t.status === "IN_PROGRESS";
    if (ticketFilter === "RESOLVED") return t.status === "RESOLVED";
    if (ticketFilter === "BILLING") {
      return (
        t.category?.toLowerCase() === "billing" ||
        t.subject?.toLowerCase().includes("custom") ||
        t.subject?.toLowerCase().includes("enterprise") ||
        t.subject?.toLowerCase().includes("quote") ||
        t.subject?.toLowerCase().includes("200k")
      );
    }
    return true;
  });

  const openTicketCount = tickets.filter((t) => t.status === "OPEN").length;
  const inProgressTicketCount = tickets.filter((t) => t.status === "IN_PROGRESS").length;
  const billingTicketCount = tickets.filter(
    (t) =>
      t.category?.toLowerCase() === "billing" ||
      t.subject?.toLowerCase().includes("custom") ||
      t.subject?.toLowerCase().includes("enterprise") ||
      t.subject?.toLowerCase().includes("quote") ||
      t.subject?.toLowerCase().includes("200k")
  ).length;

  return (
    <s-page heading="Platform Admin" inlineSize="large">
      <div className="rv-settings-wrapper">
        <Banner tone="info" title="Operator-only panel" className="rv-fade-in">
          This page is visible only to the platform admin&apos;s login. Merchants never see this — anything
          you set here shows up automatically on the affected store&apos;s own Plans &amp; Billing page.
        </Banner>

        {result?.message && (
          <Banner tone={result.success ? "success" : "critical"} title={result.success ? "Done" : "Could not complete"} className="rv-fade-in">
            {result.message}
          </Banner>
        )}

        {/* ── Global Yearly Discount ── */}
        <div className="rv-card" style={{ margin: "20px 0" }}>
          <div className="rv-card-header">
            <div className="rv-card-icon-title">
              <div className="rv-card-icon-badge info">
                <SparklesIcon size={20} />
              </div>
              <div>
                <h3 className="rv-card-title" style={{ margin: 0, fontSize: "16px" }}>Global Yearly Discount</h3>
                <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Applies to every store at once. A store with a bigger discount of its own keeps that instead —
                  discounts never stack.
                </p>
              </div>
            </div>
            {globalDiscount.isActive ? (
              <span className="rv-badge rv-badge-success" style={{ fontWeight: 700 }}>
                Live · {globalDiscount.percent}% until {formatDate(globalDiscount.expiresAt)}
              </span>
            ) : (
              <span className="rv-badge rv-badge-neutral">Off</span>
            )}
          </div>

          <div className="rv-card-body">
            <globalFetcher.Form method="POST" style={{ display: "flex", alignItems: "flex-end", gap: "14px", flexWrap: "wrap" }}>
              <input type="hidden" name="intent" value="setGlobalDiscount" />
              <div className="rv-form-field" style={{ maxWidth: "160px" }}>
                <label className="rv-form-label" htmlFor="global-percent">Discount %</label>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <input
                    id="global-percent"
                    type="number"
                    min="1"
                    max="100"
                    required
                    name="globalDiscountPercent"
                    value={globalPercentDraft}
                    onChange={(e) => setGlobalPercentDraft(e.target.value)}
                    className="rv-input"
                  />
                  <span style={{ fontSize: "13px", color: "var(--rv-text-subdued)" }}>%</span>
                </div>
              </div>
              <div className="rv-form-field" style={{ flex: 1, minWidth: "220px" }}>
                <label className="rv-form-label" htmlFor="global-note">Internal note (optional)</label>
                <input
                  id="global-note"
                  type="text"
                  name="globalNote"
                  placeholder="e.g. Black Friday campaign"
                  value={globalNoteDraft}
                  onChange={(e) => setGlobalNoteDraft(e.target.value)}
                  className="rv-input"
                />
              </div>
              <button type="submit" disabled={isGlobalBusy} className="rv-btn rv-btn-primary rv-btn-sm">
                <SparklesIcon size={14} />
                <span>{isGlobalBusy ? "Saving..." : `Apply to all stores (${durationMonths} months)`}</span>
              </button>
            </globalFetcher.Form>

            {globalDiscount.isActive && (
              <div style={{ marginTop: "12px" }}>
                <button
                  type="button"
                  disabled={isGlobalBusy}
                  className="rv-btn rv-btn-secondary rv-btn-sm"
                  onClick={() => setShowClearGlobalModal(true)}
                >
                  Turn off global discount
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ── Free Growth promotion ── */}
        <div className="rv-card" style={{ margin: "20px 0" }}>
          <div className="rv-card-header">
            <div className="rv-card-icon-title">
              <div className="rv-card-icon-badge success">
                <ShieldCheckIcon size={20} />
              </div>
              <div>
                <h3 className="rv-card-title" style={{ margin: 0, fontSize: "16px" }}>
                  Free Growth for the first {freeGrowth.limit} stores to claim ({freeGrowth.durationMonths} Months Free)
                </h3>
                <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Offered to every installed store while places remain. A place is taken only when the
                  merchant claims it, giving full Growth features at no charge for {freeGrowth.durationMonths} months
                  with no Shopify subscription created.
                </p>
              </div>
            </div>
            <span className={`rv-badge ${freeGrowth.enabled ? (freeGrowth.remaining > 0 ? "rv-badge-success" : "rv-badge-warning") : "rv-badge-neutral"}`} style={{ fontWeight: 700 }}>
              {!freeGrowth.enabled ? "Paused" : freeGrowth.remaining > 0 ? "Running" : "Fully Claimed"}
            </span>
          </div>

          <div className="rv-card-body">
            <div style={{ marginBottom: "14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", marginBottom: "6px" }}>
                <strong>{freeGrowth.used} of {freeGrowth.limit} seats claimed</strong>
                <span style={{ color: "var(--rv-text-subdued)", fontWeight: 600 }}>
                  {freeGrowth.remaining > 0 ? `${freeGrowth.remaining} left` : "Limit reached (Offer closed to new users)"}
                </span>
              </div>
              <div style={{ height: "8px", borderRadius: "999px", background: "var(--rv-surface-subdued)", overflow: "hidden" }}>
                <div style={{ width: `${seatPct}%`, height: "100%", background: freeGrowth.remaining === 0 ? "var(--rv-warning)" : "var(--rv-primary)" }} />
              </div>
            </div>

            <freeGrowthFetcher.Form method="POST" style={{ display: "flex", alignItems: "flex-end", gap: "14px", flexWrap: "wrap" }}>
              <input type="hidden" name="intent" value="updateFreeGrowth" />
              <input type="hidden" name="freeGrowthEnabled" value={freeGrowthOn ? "1" : "0"} />
              <div className="rv-form-field" style={{ maxWidth: "160px" }}>
                <label className="rv-form-label" htmlFor="seat-limit">Eligible merchants</label>
                <input
                  id="seat-limit"
                  type="number"
                  min={freeGrowth.used}
                  max="1000"
                  required
                  name="freeGrowthSeatLimit"
                  value={seatLimitDraft}
                  onChange={(e) => setSeatLimitDraft(e.target.value)}
                  className="rv-input"
                />
              </div>
              <div className="rv-form-field" style={{ maxWidth: "160px" }}>
                <label className="rv-form-label" htmlFor="duration-months">Free duration (months)</label>
                <input
                  id="duration-months"
                  type="number"
                  min="1"
                  max="36"
                  required
                  name="freeGrowthDurationMonths"
                  value={durationMonthsDraft}
                  onChange={(e) => setDurationMonthsDraft(e.target.value)}
                  className="rv-input"
                />
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", paddingBottom: "8px" }}>
                <input
                  type="checkbox"
                  checked={freeGrowthOn}
                  onChange={(e) => setFreeGrowthOn(e.target.checked)}
                />
                <span>Offer seats to merchants</span>
              </label>
              <button type="submit" disabled={isFreeGrowthBusy} className="rv-btn rv-btn-primary rv-btn-sm">
                <HistoryIcon size={14} />
                <span>{isFreeGrowthBusy ? "Saving..." : "Save promotion"}</span>
              </button>
            </freeGrowthFetcher.Form>

            <p style={{ margin: "12px 0 0", fontSize: "12px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
              Stores that install but never claim take up nothing, so you always give away{" "}
              {freeGrowth.limit} real activations. A seat returns to the pool when that store uninstalls.
              Seats are never revoked automatically, so the total cannot be lowered below {freeGrowth.used}.
              Once all {freeGrowth.limit} places are claimed, the offer automatically closes to new users.
            </p>
          </div>
        </div>

        {/* ── Support Tickets & Custom Tier Inquiries ── */}
        <div className="rv-card" style={{ margin: "20px 0" }}>
          <div className="rv-card-header" style={{ flexWrap: "wrap", gap: "12px" }}>
            <div className="rv-card-icon-title">
              <div className="rv-card-icon-badge info">
                <MailIcon size={20} />
              </div>
              <div>
                <h3 className="rv-card-title" style={{ margin: 0, fontSize: "16px" }}>
                  Support Tickets &amp; Inquiries ({tickets.length})
                </h3>
                <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Merchant support inquiries, billing questions, and Custom Enterprise Plus quote requests.
                </p>
              </div>
            </div>

            {/* Filter Pills */}
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
              <button
                type="button"
                className={`rv-btn rv-btn-sm ${ticketFilter === "ALL" ? "rv-btn-primary" : "rv-btn-secondary"}`}
                onClick={() => setTicketFilter("ALL")}
              >
                All ({tickets.length})
              </button>
              <button
                type="button"
                className={`rv-btn rv-btn-sm ${ticketFilter === "OPEN" ? "rv-btn-primary" : "rv-btn-secondary"}`}
                onClick={() => setTicketFilter("OPEN")}
              >
                Open ({openTicketCount})
              </button>
              <button
                type="button"
                className={`rv-btn rv-btn-sm ${ticketFilter === "IN_PROGRESS" ? "rv-btn-primary" : "rv-btn-secondary"}`}
                onClick={() => setTicketFilter("IN_PROGRESS")}
              >
                In Progress ({inProgressTicketCount})
              </button>
              <button
                type="button"
                className={`rv-btn rv-btn-sm ${ticketFilter === "BILLING" ? "rv-btn-primary" : "rv-btn-secondary"}`}
                onClick={() => setTicketFilter("BILLING")}
              >
                Billing / Custom ({billingTicketCount})
              </button>
              <button
                type="button"
                className={`rv-btn rv-btn-sm ${ticketFilter === "RESOLVED" ? "rv-btn-primary" : "rv-btn-secondary"}`}
                onClick={() => setTicketFilter("RESOLVED")}
              >
                Resolved ({tickets.filter((t) => t.status === "RESOLVED").length})
              </button>
            </div>
          </div>

          <div className="rv-card-body">
            {filteredTickets.length === 0 ? (
              <EmptyState
                icon={<MailIcon size={22} />}
                title="No inquiries found"
                description={
                  ticketFilter === "ALL"
                    ? "No support tickets have been submitted yet."
                    : `No tickets match the "${ticketFilter}" filter.`
                }
              />
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="rv-table" style={{ width: "100%" }}>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Store &amp; Email</th>
                      <th>Subject &amp; Category</th>
                      <th>Priority</th>
                      <th>Status</th>
                      <th>Submitted</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTickets.map((t) => {
                      const isCustomPlus =
                        t.category?.toLowerCase() === "billing" ||
                        t.subject?.toLowerCase().includes("custom") ||
                        t.subject?.toLowerCase().includes("200k") ||
                        t.subject?.toLowerCase().includes("enterprise");
                      const matchingMerchant = merchants.find((m) => m.shop === t.shop);

                      return (
                        <tr key={t.id}>
                          <td>
                            <strong>#{t.id}</strong>
                          </td>
                          <td>
                            <strong>{t.shop}</strong>
                            <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                              {t.email || "No email provided"}
                            </div>
                          </td>
                          <td>
                            <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                              <span style={{ fontWeight: 600 }}>{t.subject}</span>
                              {isCustomPlus && (
                                <span className="rv-badge rv-badge-warning rv-badge-sm" style={{ fontWeight: 700 }}>
                                  Custom Plus Request
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)", marginTop: "2px" }}>
                              <span style={{ textTransform: "capitalize" }}>{t.category}</span>
                              {" · "}
                              <span>Plan: {t.planTier || "Unknown"}</span>
                              {matchingMerchant && (
                                <span> · Catalog: {matchingMerchant.productCount.toLocaleString()} products</span>
                              )}
                            </div>
                          </td>
                          <td>
                            <span
                              className={`rv-badge rv-badge-sm ${
                                t.priority === "URGENT" || t.priority === "HIGH"
                                  ? "rv-badge-critical"
                                  : "rv-badge-neutral"
                              }`}
                              style={{ fontWeight: 700 }}
                            >
                              {t.priority}
                            </span>
                          </td>
                          <td>
                            <span
                              className={`rv-badge ${
                                t.status === "RESOLVED"
                                  ? "rv-badge-success"
                                  : t.status === "IN_PROGRESS"
                                  ? "rv-badge-info"
                                  : "rv-badge-warning"
                              }`}
                              style={{ fontWeight: 700 }}
                            >
                              {t.status === "RESOLVED" ? (
                                <CheckCircleIcon size={12} />
                              ) : t.status === "IN_PROGRESS" ? (
                                <ClockIcon size={12} />
                              ) : (
                                <AlertTriangleIcon size={12} />
                              )}{" "}
                              {t.status}
                            </span>
                          </td>
                          <td style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                            {formatDate(t.createdAt)}
                          </td>
                          <td>
                            <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                              <button
                                type="button"
                                className="rv-btn rv-btn-secondary rv-btn-sm"
                                onClick={() => setViewingTicket(t)}
                              >
                                View
                              </button>
                              {matchingMerchant && isCustomPlus && (
                                <button
                                  type="button"
                                  className="rv-btn rv-btn-primary rv-btn-sm"
                                  onClick={() => startQuotaEdit(matchingMerchant)}
                                  title="Configure custom catalog limit for this merchant"
                                >
                                  <DatabaseIcon size={12} />
                                  <span>Grant Quota</span>
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="rv-card" style={{ margin: "20px 0" }}>
          <div className="rv-card-header">
            <div className="rv-card-icon-title">
              <div className="rv-card-icon-badge info">
                <DatabaseIcon size={20} />
              </div>
              <div>
                <h3 className="rv-card-title" style={{ margin: 0, fontSize: "16px" }}>
                  Merchant Stores ({merchants.length})
                </h3>
                <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Every store that has installed the app. Manage custom product limits or yearly discounts.
                </p>
              </div>
            </div>
          </div>

          <div className="rv-card-body">
            {merchants.length === 0 ? (
              <EmptyState
                icon={<DatabaseIcon size={22} />}
                title="No merchant stores yet"
                description="Stores will appear here once they install the app."
              />
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="rv-table" style={{ width: "100%" }}>
                  <thead>
                    <tr>
                      <th>Store</th>
                      <th>Plan</th>
                      <th>Quota / Catalog</th>
                      <th>Store discount</th>
                      <th>Effective</th>
                      <th>Backups</th>
                      <th>Open Incidents</th>
                      <th>First seen</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {merchants.map((row) => (
                      <Fragment key={row.shop}>
                        <tr>
                          <td>
                            <strong>{row.shop}</strong>
                            {row.alertEmail && (
                              <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>{row.alertEmail}</div>
                            )}
                          </td>
                          <td>
                            <span className="rv-badge rv-badge-neutral" style={{ textTransform: "uppercase", fontWeight: 700 }}>
                              {PLAN_TIERS[row.planId]?.name || row.planId}
                            </span>
                            {row.freeGrowthSeat?.isActive && (
                              <div style={{ marginTop: "4px" }}>
                                <span className="rv-badge rv-badge-success rv-badge-sm" style={{ fontWeight: 700 }}>
                                  Free Growth · to {formatDate(row.freeGrowthSeat.expiresAt)}
                                </span>
                              </div>
                            )}
                          </td>
                          <td>
                            <div style={{ fontWeight: 600 }}>{row.productCount.toLocaleString()} products</div>
                            {row.customProductLimit ? (
                              <div style={{ marginTop: "4px" }}>
                                <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", alignItems: "center" }}>
                                  <span className="rv-badge rv-badge-success rv-badge-sm" style={{ fontWeight: 700 }}>
                                    Custom: {row.customProductLimit.toLocaleString()}
                                  </span>
                                  {row.customPriceAmount && (
                                    <span
                                      className={`rv-badge rv-badge-sm ${
                                        row.customPriceStatus === "ACTIVE" ? "rv-badge-success" : "rv-badge-warning"
                                      }`}
                                      style={{ fontWeight: 700 }}
                                    >
                                      ${row.customPriceAmount}/mo ·{" "}
                                      {row.customBillingMethod === "EXTERNAL"
                                        ? "Contract"
                                        : row.customPriceStatus === "ACTIVE"
                                        ? "Active"
                                        : "Offered"}
                                    </span>
                                  )}
                                </div>
                                {row.customPlanNote && (
                                  <div
                                    style={{ fontSize: "11px", color: "var(--rv-text-subdued)", marginTop: "2px" }}
                                    title={row.customPlanNote}
                                  >
                                    {row.customPlanNote}
                                  </div>
                                )}
                              </div>
                            ) : row.planId === "enterprise" ? (
                              <div style={{ fontSize: "11px", color: "var(--rv-text-subdued)", marginTop: "2px" }}>
                                Plan cap: 200,000
                              </div>
                            ) : null}
                          </td>
                          <td>
                            {row.discount?.awaitingClaim ? (
                              <span className="rv-badge rv-badge-warning" style={{ fontWeight: 700 }}>
                                VIP {row.discount.percent}% · awaiting claim
                              </span>
                            ) : row.discount?.isActive ? (
                              <span
                                className={`rv-badge ${row.discount.tier === TIER_VIP ? "rv-badge-info" : "rv-badge-success"}`}
                                style={{ fontWeight: 700 }}
                              >
                                <SparklesIcon size={12} />{" "}
                                {row.discount.tier === TIER_VIP ? "VIP " : ""}
                                {row.discount.percent}% until {formatDate(row.discount.expiresAt)}
                              </span>
                            ) : (
                              <span className="rv-badge rv-badge-neutral">None</span>
                            )}
                          </td>
                          <td>
                            {row.effectiveDiscount ? (
                              row.effectiveDiscount.monthly &&
                              row.effectiveDiscount.yearly &&
                              row.effectiveDiscount.monthly.percent !== row.effectiveDiscount.yearly.percent ? (
                                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                                  <span className="rv-badge rv-badge-success" style={{ fontWeight: 700 }}>
                                    {row.effectiveDiscount.yearly.percent}%
                                    <span style={{ fontWeight: 500, marginLeft: "4px" }}>
                                      ({EFFECTIVE_LABELS[row.effectiveDiscount.yearly.source]} · yr)
                                    </span>
                                  </span>
                                  <span className="rv-badge rv-badge-info" style={{ fontWeight: 700, fontSize: "11px" }}>
                                    {row.effectiveDiscount.monthly.percent}%
                                    <span style={{ fontWeight: 500, marginLeft: "4px" }}>
                                      ({EFFECTIVE_LABELS[row.effectiveDiscount.monthly.source]} · mo)
                                    </span>
                                  </span>
                                </div>
                              ) : (
                                <span className="rv-badge rv-badge-success" style={{ fontWeight: 700 }}>
                                  {row.effectiveDiscount.percent}%
                                  <span style={{ fontWeight: 500, marginLeft: "4px" }}>
                                    ({EFFECTIVE_LABELS[row.effectiveDiscount.source]})
                                  </span>
                                </span>
                              )
                            ) : (
                              <span className="rv-badge rv-badge-neutral">—</span>
                            )}
                          </td>
                          <td>{row.restorePointCount}</td>
                          <td>
                            {row.openIncidentCount > 0 ? (
                              <span className="rv-badge rv-badge-critical">{row.openIncidentCount}</span>
                            ) : (
                              <span className="rv-badge rv-badge-neutral">0</span>
                            )}
                          </td>
                          <td>{formatDate(row.firstSeenAt)}</td>
                          <td>
                            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                              <button
                                type="button"
                                className="rv-btn rv-btn-secondary rv-btn-sm"
                                onClick={() => (editingShop === row.shop ? setEditingShop(null) : startEditing(row))}
                              >
                                <SparklesIcon size={14} />
                                <span>{row.discount?.isActive || row.discount?.awaitingClaim ? "Edit" : "Grant"}</span>
                              </button>
                              <button
                                type="button"
                                className="rv-btn rv-btn-secondary rv-btn-sm"
                                onClick={() => startQuotaEdit(row)}
                                title="Configure custom product quota for this store"
                              >
                                <DatabaseIcon size={13} />
                                <span>{row.customProductLimit ? "Edit Quota" : "Quota"}</span>
                              </button>
                              {(row.discount?.isActive || row.discount?.awaitingClaim) && (
                                <button
                                  type="button"
                                  disabled={isStoreBusy}
                                  className="rv-btn rv-btn-critical rv-btn-sm"
                                  onClick={() => setRemoveDiscountTarget(row)}
                                  title="Remove discount"
                                >
                                  <Trash2Icon size={14} />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>

                        {editingShop === row.shop && (
                          <tr>
                            <td colSpan={9} style={{ background: "var(--rv-surface-subdued)" }}>
                              <storeFetcher.Form
                                method="POST"
                                style={{ display: "flex", alignItems: "flex-end", gap: "14px", flexWrap: "wrap", padding: "12px 4px" }}
                                onSubmit={() => setEditingShop(null)}
                              >
                                <input type="hidden" name="intent" value="setDiscount" />
                                <input type="hidden" name="targetShop" value={row.shop} />
                                <div className="rv-form-field" style={{ maxWidth: "150px" }}>
                                  <label className="rv-form-label" htmlFor={`tier-${row.shop}`}>
                                    Discount type
                                  </label>
                                  <select
                                    id={`tier-${row.shop}`}
                                    name="tier"
                                    value={tierDraft}
                                    onChange={(e) => setTierDraft(e.target.value)}
                                    className="rv-input"
                                  >
                                    <option value={TIER_STANDARD}>Standard</option>
                                    <option value={TIER_VIP}>VIP</option>
                                  </select>
                                </div>
                                <div className="rv-form-field" style={{ maxWidth: "160px" }}>
                                  <label className="rv-form-label" htmlFor={`percent-${row.shop}`}>
                                    Discount %
                                  </label>
                                  <div className="rv-input-group">
                                    <input
                                      id={`percent-${row.shop}`}
                                      type="number"
                                      min="1"
                                      max="100"
                                      required
                                      name="discountPercent"
                                      value={percentDraft}
                                      onChange={(e) => setPercentDraft(e.target.value)}
                                      className="rv-input"
                                    />
                                    <span className="rv-input-suffix">%</span>
                                  </div>
                                </div>
                                <div className="rv-form-field" style={{ flex: 1, minWidth: "220px" }}>
                                  <label className="rv-form-label" htmlFor={`note-${row.shop}`}>
                                    Internal note (optional)
                                  </label>
                                  <input
                                    id={`note-${row.shop}`}
                                    type="text"
                                    name="note"
                                    value={noteDraft}
                                    onChange={(e) => setNoteDraft(e.target.value)}
                                    placeholder="e.g. Loyalty renewal, partner deal"
                                    className="rv-input"
                                    style={{ width: "100%" }}
                                  />
                                </div>
                                <button type="submit" disabled={isStoreBusy} className="rv-btn rv-btn-primary rv-btn-sm">
                                  <HistoryIcon size={14} />
                                  <span>{isStoreBusy ? "Saving..." : `Apply (valid ${durationMonths} months)`}</span>
                                </button>
                                <button
                                  type="button"
                                  className="rv-btn rv-btn-secondary rv-btn-sm"
                                  onClick={() => setEditingShop(null)}
                                >
                                  Cancel
                                </button>
                              </storeFetcher.Form>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="rv-card" style={{ margin: "20px 0" }}>
          <div className="rv-card-header">
            <div className="rv-card-icon-title">
              <div className="rv-card-icon-badge success">
                <ShieldCheckIcon size={20} />
              </div>
              <div>
                <h3 className="rv-card-title" style={{ margin: 0, fontSize: "16px" }}>How this works</h3>
              </div>
            </div>
          </div>
          <div className="rv-card-body" style={{ fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.6 }}>
            <ul style={{ margin: 0, paddingLeft: "18px" }}>
              <li>A discount is always granted for {durationMonths} months from the moment you set or update it.</li>
              <li>The merchant sees it immediately on their own Plans &amp; Billing page — no separate sync step.</li>
              <li>
                <strong>Discounts never stack.</strong> A store gets the single largest one it qualifies for —
                its own VIP or standard grant, or the global discount, whichever is bigger. The
                &ldquo;Effective&rdquo; column shows which one actually applies.
              </li>
              <li>
                <strong>VIP is a label on the store&apos;s own grant</strong>, not a second discount. Switching a
                store between Standard and VIP changes how it is badged for the merchant, not how many
                discounts they hold.
              </li>
              <li>
                <strong>A VIP grant is an offer the merchant must claim.</strong> It discounts nothing and
                shows as &ldquo;awaiting claim&rdquo; until they accept it on their own Plans &amp; Billing
                page. Their {durationMonths} months start from the claim, not from when you granted it, so
                there is no penalty for them deciding later. Standard and global discounts apply
                immediately, with no claim step.
              </li>
              <li>
                <strong>Free Growth is separate from discounts</strong>, and is also claimed by the merchant.
                It gives Growth features at no charge and creates no Shopify subscription. A seat holder who
                upgrades to Business or Enterprise pays for that plan, with their best discount applied.
              </li>
              <li>It reaches the real Shopify charge only when they start or switch to a paid plan, and then lasts {durationMonths} billing cycles.</li>
              <li>
                A merchant already on a paid plan keeps paying their current price until they apply it —
                their Plans &amp; Billing page prompts them to do so.
              </li>
              <li>Removing a discount here disables it immediately; it does not retroactively change a subscription that already applied it.</li>
            </ul>
          </div>
        </div>
      </div>

      {/* ── Clear Global Discount Modal ── */}
      <ConfirmModal
        isOpen={showClearGlobalModal}
        title="Turn Off Global Discount"
        message="Are you sure you want to turn off the global yearly discount for every store?"
        dangerNote="New merchants and stores without individual discounts will no longer receive a promotional discount when upgrading to annual plans."
        confirmLabel="Turn Off Global Discount"
        submittingLabel="Turning Off..."
        tone="critical"
        isSubmitting={isClearingGlobal}
        onConfirm={() => {
          globalFetcher.submit({ intent: "clearGlobalDiscount" }, { method: "POST" });
        }}
        onClose={() => {
          if (!isClearingGlobal) setShowClearGlobalModal(false);
        }}
      />

      {/* ── Remove Store Discount Modal ── */}
      <ConfirmModal
        isOpen={Boolean(removeDiscountTarget)}
        title="Remove Store Discount"
        message={
          removeDiscountTarget ? (
            <>
              Are you sure you want to remove the{" "}
              <strong>{removeDiscountTarget.discount?.percent}% discount</strong> for{" "}
              <strong>{removeDiscountTarget.shop}</strong>?
            </>
          ) : null
        }
        dangerNote="The store will revert to standard plan pricing or the global discount if active. Existing active Shopify subscriptions will not be retroactively changed."
        confirmLabel="Remove Discount"
        submittingLabel="Removing..."
        tone="critical"
        isSubmitting={isRemovingDiscount}
        onConfirm={() => {
          if (!removeDiscountTarget) return;
          storeFetcher.submit(
            { intent: "removeDiscount", targetShop: removeDiscountTarget.shop },
            { method: "POST" }
          );
        }}
        onClose={() => {
          if (!isRemovingDiscount) setRemoveDiscountTarget(null);
        }}
      />

      {/* ── Viewing Ticket Details Modal ── */}
      {viewingTicket && (
        <div
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isTicketBusy) setViewingTicket(null);
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.45)",
            backdropFilter: "blur(2px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 99999,
            padding: "20px",
            animation: "rvFadeIn 0.15s ease-out",
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="ticket-modal-title"
            style={{
              background: "#ffffff",
              borderRadius: "var(--rv-radius-md, 10px)",
              maxWidth: "560px",
              width: "100%",
              padding: "24px",
              boxShadow: "var(--rv-shadow-lg, 0 10px 25px -5px rgba(0, 0, 0, 0.1))",
              border: "1px solid var(--rv-border, #e1e3e5)",
              position: "relative",
              animation: "rvModalPop 0.18s cubic-bezier(0.16, 1, 0.3, 1)",
            }}
          >
            <button
              type="button"
              onClick={() => setViewingTicket(null)}
              disabled={isTicketBusy}
              aria-label="Close dialog"
              style={{
                position: "absolute",
                top: "16px",
                right: "16px",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                color: "var(--rv-text-subdued, #6d7175)",
                padding: "4px",
                borderRadius: "4px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <XIcon size={18} />
            </button>

            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "14px" }}>
              <span
                className={`rv-badge ${
                  viewingTicket.status === "RESOLVED"
                    ? "rv-badge-success"
                    : viewingTicket.status === "IN_PROGRESS"
                    ? "rv-badge-info"
                    : "rv-badge-warning"
                }`}
                style={{ fontWeight: 700 }}
              >
                #{viewingTicket.id} · {viewingTicket.status}
              </span>
              <span
                className={`rv-badge rv-badge-sm ${
                  viewingTicket.priority === "URGENT" || viewingTicket.priority === "HIGH"
                    ? "rv-badge-critical"
                    : "rv-badge-neutral"
                }`}
              >
                {viewingTicket.priority} Priority
              </span>
            </div>

            <h3 id="ticket-modal-title" style={{ margin: "0 0 12px", fontSize: "18px", fontWeight: 700 }}>
              {viewingTicket.subject}
            </h3>

            <div
              style={{
                background: "var(--rv-surface-subdued)",
                padding: "12px 16px",
                borderRadius: "8px",
                fontSize: "13px",
                marginBottom: "16px",
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                gap: "8px",
              }}
            >
              <div>
                <strong style={{ color: "var(--rv-text-subdued)", fontSize: "11px", display: "block" }}>STORE</strong>
                <span>{viewingTicket.shop}</span>
              </div>
              <div>
                <strong style={{ color: "var(--rv-text-subdued)", fontSize: "11px", display: "block" }}>EMAIL</strong>
                {viewingTicket.email ? (
                  <a
                    href={`mailto:${viewingTicket.email}?subject=Re: ${encodeURIComponent(viewingTicket.subject)}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      color: "var(--rv-primary)",
                      textDecoration: "underline",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                    }}
                  >
                    <span>{viewingTicket.email}</span>
                    <ExternalLinkIcon size={12} />
                  </a>
                ) : (
                  <span>—</span>
                )}
              </div>
              <div>
                <strong style={{ color: "var(--rv-text-subdued)", fontSize: "11px", display: "block" }}>CATEGORY</strong>
                <span style={{ textTransform: "capitalize" }}>{viewingTicket.category}</span>
              </div>
              <div>
                <strong style={{ color: "var(--rv-text-subdued)", fontSize: "11px", display: "block" }}>SUBMITTED</strong>
                <span>{new Date(viewingTicket.createdAt).toLocaleString()}</span>
              </div>
            </div>

            <div style={{ marginBottom: "18px" }}>
              <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--rv-text-subdued)", marginBottom: "6px" }}>
                MERCHANT MESSAGE
              </div>
              <div
                style={{
                  background: "#ffffff",
                  border: "1px solid var(--rv-border)",
                  borderRadius: "8px",
                  padding: "14px",
                  fontSize: "13px",
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  maxHeight: "220px",
                  overflowY: "auto",
                }}
              >
                {viewingTicket.message}
              </div>
            </div>

            {/* Status updates & quick actions */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--rv-text-subdued)" }}>Set Status:</span>
                {viewingTicket.status !== "IN_PROGRESS" && (
                  <button
                    type="button"
                    disabled={isTicketBusy}
                    className="rv-btn rv-btn-secondary rv-btn-sm"
                    onClick={() => updateTicketStatus(viewingTicket.id, "IN_PROGRESS")}
                  >
                    In Progress
                  </button>
                )}
                {viewingTicket.status !== "RESOLVED" && (
                  <button
                    type="button"
                    disabled={isTicketBusy}
                    className="rv-btn rv-btn-primary rv-btn-sm"
                    onClick={() => updateTicketStatus(viewingTicket.id, "RESOLVED")}
                  >
                    <CheckCircleIcon size={14} />
                    <span>Resolve</span>
                  </button>
                )}
                {viewingTicket.status !== "OPEN" && (
                  <button
                    type="button"
                    disabled={isTicketBusy}
                    className="rv-btn rv-btn-secondary rv-btn-sm"
                    onClick={() => updateTicketStatus(viewingTicket.id, "OPEN")}
                  >
                    Reopen
                  </button>
                )}
              </div>

              {merchants.some((m) => m.shop === viewingTicket.shop) && (
                <button
                  type="button"
                  className="rv-btn rv-btn-secondary rv-btn-sm"
                  onClick={() => {
                    const m = merchants.find((row) => row.shop === viewingTicket.shop);
                    if (m) {
                      setViewingTicket(null);
                      startQuotaEdit(m);
                    }
                  }}
                >
                  <DatabaseIcon size={14} />
                  <span>Configure Store Quota</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Custom Quota Management Modal ── */}
      {quotaTargetShop && (
        <div
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isQuotaBusy) setQuotaTargetShop(null);
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.45)",
            backdropFilter: "blur(2px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 99999,
            padding: "20px",
            animation: "rvFadeIn 0.15s ease-out",
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="quota-modal-title"
            style={{
              background: "#ffffff",
              borderRadius: "var(--rv-radius-md, 10px)",
              maxWidth: "520px",
              width: "100%",
              padding: "24px",
              boxShadow: "var(--rv-shadow-lg, 0 10px 25px -5px rgba(0, 0, 0, 0.1))",
              border: "1px solid var(--rv-border, #e1e3e5)",
              position: "relative",
              animation: "rvModalPop 0.18s cubic-bezier(0.16, 1, 0.3, 1)",
            }}
          >
            <button
              type="button"
              onClick={() => setQuotaTargetShop(null)}
              disabled={isQuotaBusy}
              aria-label="Close dialog"
              style={{
                position: "absolute",
                top: "16px",
                right: "16px",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                color: "var(--rv-text-subdued, #6d7175)",
                padding: "4px",
                borderRadius: "4px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <XIcon size={18} />
            </button>

            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
              <div className="rv-card-icon-badge info" style={{ width: "32px", height: "32px" }}>
                <DatabaseIcon size={18} />
              </div>
              <h3 id="quota-modal-title" style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>
                Custom Product Quota
              </h3>
            </div>

            <p style={{ margin: "0 0 16px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
              Grant <strong>{quotaTargetShop.shop}</strong> a custom product catalog limit beyond standard plan tiers (e.g. Enterprise Plus for &gt; 200,000 products). This quota will be enforced on backups and displayed in their dashboard.
            </p>

            <div
              style={{
                background: "var(--rv-surface-subdued)",
                padding: "12px 16px",
                borderRadius: "8px",
                fontSize: "13px",
                marginBottom: "16px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "8px",
              }}
            >
              <div>
                <strong style={{ color: "var(--rv-text-subdued)", fontSize: "11px", display: "block" }}>STORE CATALOG</strong>
                <span>{quotaTargetShop.productCount.toLocaleString()} products</span>
              </div>
              <div>
                <strong style={{ color: "var(--rv-text-subdued)", fontSize: "11px", display: "block" }}>CURRENT ACTIVE QUOTA</strong>
                <span>
                  {quotaTargetShop.customProductLimit
                    ? `${quotaTargetShop.customProductLimit.toLocaleString()} (Custom)`
                    : `${(PLAN_TIERS[quotaTargetShop.planId]?.limits?.products || 200000).toLocaleString()} (Plan)`}
                </span>
              </div>
              <div>
                <strong style={{ color: "var(--rv-text-subdued)", fontSize: "11px", display: "block" }}>PLAN TIER</strong>
                <span style={{ textTransform: "capitalize" }}>{quotaTargetShop.planId}</span>
              </div>
            </div>

            <quotaFetcher.Form method="POST">
              <input type="hidden" name="intent" value="setCustomQuota" />
              <input type="hidden" name="targetShop" value={quotaTargetShop.shop} />

              <div className="rv-form-field" style={{ marginBottom: "14px" }}>
                <label className="rv-form-label" htmlFor="customProductLimit">
                  Custom Product Limit
                </label>
                <input
                  id="customProductLimit"
                  name="customProductLimit"
                  type="number"
                  min="1000"
                  max="5000000"
                  step="1000"
                  required
                  value={customLimitDraft}
                  onChange={(e) => setCustomLimitDraft(e.target.value)}
                  className="rv-input"
                  style={{ width: "100%" }}
                />
                {/* Presets */}
                <div style={{ display: "flex", gap: "6px", marginTop: "6px", flexWrap: "wrap" }}>
                  {[250000, 350000, 500000, 1000000].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className="rv-btn rv-btn-secondary rv-btn-sm"
                      style={{ fontSize: "11px", padding: "2px 8px" }}
                      onClick={() => setCustomLimitDraft(String(preset))}
                    >
                      {preset >= 1000000 ? `${preset / 1000000}M` : `${preset / 1000}k`}
                    </button>
                  ))}
                  {quotaTargetShop.productCount > 0 && (
                    <button
                      type="button"
                      className="rv-btn rv-btn-secondary rv-btn-sm"
                      style={{ fontSize: "11px", padding: "2px 8px" }}
                      onClick={() =>
                        setCustomLimitDraft(String(Math.ceil((quotaTargetShop.productCount + 50000) / 10000) * 10000))
                      }
                    >
                      +50k over store
                    </button>
                  )}
                </div>
              </div>

              {/* ── Billing Method ── */}
              <div className="rv-form-field" style={{ marginBottom: "14px" }}>
                <div className="rv-form-label">Billing Method</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                  <label
                    style={{
                      border: `1px solid ${
                        customBillingMethodDraft === "SHOPIFY" ? "var(--rv-primary)" : "var(--rv-border)"
                      }`,
                      background:
                        customBillingMethodDraft === "SHOPIFY" ? "rgba(99, 102, 241, 0.06)" : "transparent",
                      borderRadius: "8px",
                      padding: "10px",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <input
                        type="radio"
                        name="customBillingMethod"
                        value="SHOPIFY"
                        checked={customBillingMethodDraft === "SHOPIFY"}
                        onChange={() => setCustomBillingMethodDraft("SHOPIFY")}
                      />
                      <strong style={{ fontSize: "13px" }}>Shopify Billing</strong>
                    </div>
                    <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", paddingLeft: "20px" }}>
                      Merchant receives in-app prompt to approve monthly charge
                    </span>
                  </label>

                  <label
                    style={{
                      border: `1px solid ${
                        customBillingMethodDraft === "EXTERNAL" ? "var(--rv-primary)" : "var(--rv-border)"
                      }`,
                      background:
                        customBillingMethodDraft === "EXTERNAL" ? "rgba(99, 102, 241, 0.06)" : "transparent",
                      borderRadius: "8px",
                      padding: "10px",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <input
                        type="radio"
                        name="customBillingMethod"
                        value="EXTERNAL"
                        checked={customBillingMethodDraft === "EXTERNAL"}
                        onChange={() => setCustomBillingMethodDraft("EXTERNAL")}
                      />
                      <strong style={{ fontSize: "13px" }}>Direct Contract</strong>
                    </div>
                    <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", paddingLeft: "20px" }}>
                      Paid offline (Wire / Stripe invoice) — activates immediately
                    </span>
                  </label>
                </div>
              </div>

              {/* ── Custom Monthly Price ── */}
              <div className="rv-form-field" style={{ marginBottom: "14px" }}>
                <label className="rv-form-label" htmlFor="customPriceAmount">
                  Custom Monthly Price ($ USD)
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ fontSize: "15px", fontWeight: 700, color: "var(--rv-text-subdued)" }}>$</span>
                  <input
                    id="customPriceAmount"
                    name="customPriceAmount"
                    type="number"
                    min="1"
                    max="10000"
                    step="1"
                    placeholder="e.g. 249"
                    value={customPriceDraft}
                    onChange={(e) => setCustomPriceDraft(e.target.value)}
                    className="rv-input"
                    style={{ width: "100%" }}
                  />
                  <span style={{ fontSize: "13px", color: "var(--rv-text-subdued)" }}>/mo</span>
                </div>
                {/* Price Presets */}
                <div style={{ display: "flex", gap: "6px", marginTop: "6px", flexWrap: "wrap" }}>
                  {[149, 199, 249, 299, 499].map((p) => (
                    <button
                      key={p}
                      type="button"
                      className="rv-btn rv-btn-secondary rv-btn-sm"
                      style={{ fontSize: "11px", padding: "2px 8px" }}
                      onClick={() => setCustomPriceDraft(String(p))}
                    >
                      ${p}/mo
                    </button>
                  ))}
                </div>
              </div>

              <div className="rv-form-field" style={{ marginBottom: "20px" }}>
                <label className="rv-form-label" htmlFor="customPlanNote">
                  Internal Note / Agreement (optional)
                </label>
                <input
                  id="customPlanNote"
                  name="customPlanNote"
                  type="text"
                  placeholder="e.g. Enterprise Plus agreement — $249/mo negotiated invoice"
                  value={customNoteDraft}
                  onChange={(e) => setCustomNoteDraft(e.target.value)}
                  className="rv-input"
                  style={{ width: "100%" }}
                />
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button type="submit" disabled={isQuotaBusy} className="rv-btn rv-btn-primary">
                    <SaveIcon size={14} />
                    <span>{isQuotaBusy ? "Saving..." : "Save Custom Quota"}</span>
                  </button>
                  <button
                    type="button"
                    disabled={isQuotaBusy}
                    className="rv-btn rv-btn-secondary"
                    onClick={() => setQuotaTargetShop(null)}
                  >
                    Cancel
                  </button>
                </div>

                {quotaTargetShop.customProductLimit && (
                  <button
                    type="button"
                    disabled={isQuotaBusy}
                    className="rv-btn rv-btn-critical rv-btn-sm"
                    onClick={() => {
                      quotaFetcher.submit(
                        { intent: "resetCustomQuota", targetShop: quotaTargetShop.shop },
                        { method: "POST" }
                      );
                    }}
                  >
                    Reset to Plan Default
                  </button>
                )}
              </div>
            </quotaFetcher.Form>
          </div>
        </div>
      )}
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
