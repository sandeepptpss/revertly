/**
 * Product snapshot and comparison utilities for Revertly
 */
import prisma from "./db.server.js";
import { checkFeatureAccess } from "./billing.server.js";

// Fields we monitor on products
export const MONITORED_PRODUCT_FIELDS = [
  "title",
  "status",
  "vendor",
  "productType",
  "tags",
  "handle",
  "bodyHtml",
  "publishedAt",
];

// Fields we monitor on variants
export const MONITORED_VARIANT_FIELDS = [
  "price",
  "compareAtPrice",
  "sku",
  "inventoryQuantity",
  "weight",
  "weightUnit",
  "barcode",
];

/**
 * Fetch a product's full data via Shopify Admin GraphQL
 */
export async function fetchProductData(admin, productId) {
  const numericId = productId.replace("gid://shopify/Product/", "");
  const gid = productId.startsWith("gid://")
    ? productId
    : `gid://shopify/Product/${numericId}`;

  const response = await admin.graphql(
    `#graphql
    query getProduct($id: ID!) {
      product(id: $id) {
        id
        title
        status
        vendor
        productType
        tags
        handle
        bodyHtml
        publishedAt
        metafields(first: 50) {
          edges {
            node {
              id
              namespace
              key
              value
              type
            }
          }
        }
        variants(first: 100) {
          edges {
            node {
              id
              title
              price
              compareAtPrice
              sku
              inventoryQuantity
              barcode
              inventoryItem {
                measurement {
                  weight {
                    value
                    unit
                  }
                }
              }
            }
          }
        }
      }
    }`,
    { variables: { id: gid } },
  );
  const json = await response.json();
  return json.data?.product;
}

/**
 * Build a flat snapshot object from Shopify product data
 */
export function buildSnapshot(product) {
  const variants = (product.variants?.edges || []).map((e) => {
    const node = e.node || {};
    const weightVal = node.inventoryItem?.measurement?.weight?.value ?? node.weight ?? null;
    const weightUnit = node.inventoryItem?.measurement?.weight?.unit ?? node.weightUnit ?? null;
    return {
      id: node.id,
      title: node.title,
      price: node.price,
      compareAtPrice: node.compareAtPrice,
      sku: node.sku,
      inventoryQuantity: node.inventoryQuantity,
      weight: weightVal,
      weightUnit: weightUnit,
      barcode: node.barcode,
    };
  });

  const metafields = (product.metafields?.edges || []).map((e) => ({
    id: e.node.id,
    namespace: e.node.namespace,
    key: e.node.key,
    value: e.node.value,
    type: e.node.type,
  }));

  return {
    id: product.id,
    title: product.title,
    status: product.status,
    vendor: product.vendor,
    productType: product.productType,
    tags: Array.isArray(product.tags)
      ? product.tags.join(", ")
      : product.tags || "",
    handle: product.handle,
    bodyHtml: product.bodyHtml,
    publishedAt: product.publishedAt,
    variants,
    metafields,
  };
}

/**
 * Helper to determine if a field value has changed, normalizing dates and numeric fields.
 */
export function hasFieldChanged(fieldName, val1, val2) {
  const cleanField = fieldName.replace("variant.", "");
  if (["price", "compareAtPrice", "weight", "inventoryQuantity"].includes(cleanField)) {
    const n1 = parseFloat(val1);
    const n2 = parseFloat(val2);
    if (!isNaN(n1) && !isNaN(n2)) {
      return n1 !== n2;
    }
  }
  if (cleanField === "publishedAt") {
    if (!val1 && !val2) return false;
    if (!val1 || !val2) return true;
    const d1 = new Date(val1).getTime();
    const d2 = new Date(val2).getTime();
    if (!isNaN(d1) && !isNaN(d2)) {
      return d1 !== d2;
    }
  }
  return String(val1 ?? "") !== String(val2 ?? "");
}

/**
 * Compare old snapshot with new product data and return list of changes
 */
export function compareSnapshots(oldSnapshot, newSnapshot) {
  const changes = [];

  // Compare product-level fields
  for (const field of MONITORED_PRODUCT_FIELDS) {
    const oldVal = oldSnapshot[field];
    const newVal = newSnapshot[field];
    if (hasFieldChanged(field, oldVal, newVal)) {
      changes.push({
        fieldName: field,
        variantId: null,
        oldValue: oldVal != null ? String(oldVal) : "",
        newValue: newVal != null ? String(newVal) : "",
      });
    }
  }

  // Compare variant-level fields
  const oldVariants = oldSnapshot.variants || [];
  const newVariants = newSnapshot.variants || [];

  for (const newVariant of newVariants) {
    const oldVariant = oldVariants.find((v) => v.id === newVariant.id);
    if (!oldVariant) continue; // new variant added — skip for now

    for (const field of MONITORED_VARIANT_FIELDS) {
      const oldVal = oldVariant[field];
      const newVal = newVariant[field];
      if (hasFieldChanged(`variant.${field}`, oldVal, newVal)) {
        changes.push({
          fieldName: `variant.${field}`,
          variantId: newVariant.id,
          oldValue: oldVal != null ? String(oldVal) : "",
          newValue: newVal != null ? String(newVal) : "",
          variantTitle: newVariant.title,
        });
      }
    }
  }

  // Compare metafields
  const oldMetafields = oldSnapshot.metafields || [];
  const newMetafields = newSnapshot.metafields || [];
  for (const newMf of newMetafields) {
    if (!newMf.namespace || !newMf.key) continue;
    const oldMf = oldMetafields.find((m) => m.namespace === newMf.namespace && m.key === newMf.key);
    const oldVal = oldMf ? String(oldMf.value ?? "") : "";
    const newVal = String(newMf.value ?? "");
    if (oldMf && oldVal !== newVal) {
      changes.push({
        fieldName: `metafield.${newMf.namespace}.${newMf.key}`,
        variantId: null,
        oldValue: oldVal,
        newValue: newVal,
      });
    } else if (!oldMf && newVal !== "") {
      changes.push({
        fieldName: `metafield.${newMf.namespace}.${newMf.key}`,
        variantId: null,
        oldValue: "",
        newValue: newVal,
      });
    }
  }
  for (const oldMf of oldMetafields) {
    if (!oldMf.namespace || !oldMf.key) continue;
    const stillExists = newMetafields.some((m) => m.namespace === oldMf.namespace && m.key === oldMf.key);
    if (!stillExists && oldMf.value) {
      changes.push({
        fieldName: `metafield.${oldMf.namespace}.${oldMf.key}`,
        variantId: null,
        oldValue: String(oldMf.value),
        newValue: "(deleted)",
      });
    }
  }

  return changes;
}

/**
 * Save or update a product snapshot in the database
 */
export async function upsertSnapshot(shop, product) {
  const snapshot = buildSnapshot(product);
  const numericId = product.id.replace("gid://shopify/Product/", "");

  return prisma.productSnapshot.upsert({
    where: { shop_productId: { shop, productId: numericId } },
    create: {
      shop,
      productId: numericId,
      title: product.title || "",
      status: product.status || "ACTIVE",
      vendor: product.vendor || "",
      productType: product.productType || "",
      tags: Array.isArray(product.tags)
        ? product.tags.join(", ")
        : product.tags || "",
      bodyHtml: product.bodyHtml || "",
      handle: product.handle || "",
      publishedAt: product.publishedAt ? new Date(product.publishedAt) : null,
      snapshotData: snapshot,
    },
    update: {
      title: product.title || "",
      status: product.status || "ACTIVE",
      vendor: product.vendor || "",
      productType: product.productType || "",
      tags: Array.isArray(product.tags)
        ? product.tags.join(", ")
        : product.tags || "",
      bodyHtml: product.bodyHtml || "",
      handle: product.handle || "",
      publishedAt: product.publishedAt ? new Date(product.publishedAt) : null,
      snapshotData: snapshot,
    },
  });
}

/**
 * Get previous snapshot for a product
 */
export async function getPreviousSnapshot(shop, productId) {
  const numericId = String(productId).replace("gid://shopify/Product/", "");
  return prisma.productSnapshot.findUnique({
    where: { shop_productId: { shop, productId: numericId } },
  });
}

/**
 * Save change events to the database
 */
export async function saveChangeEvents(shop, product, changes, incidentId) {
  const numericId = product.id.replace("gid://shopify/Product/", "");
  const events = changes.map((c) => ({
    shop,
    productId: numericId,
    productTitle: product.title || "",
    fieldName: c.fieldName,
    variantId: c.variantId
      ? c.variantId.replace("gid://shopify/ProductVariant/", "")
      : null,
    oldValue: c.oldValue,
    newValue: c.newValue,
    incidentId: incidentId || null,
  }));

  if (events.length > 0) {
    await prisma.changeEvent.createMany({ data: events });
  }
  return events;
}

/**
 * Check detection rules and create an incident if needed
 */
export async function checkDetectionRules(shop, changes) {
  const rules = await prisma.detectionRule.findMany({
    where: { shop, isActive: true },
  });

  if (rules.length === 0) return null;

  const now = new Date();

  for (const rule of rules) {
    const matchingChange = changes.find((c) => {
      // Match field (support "price" matching "variant.price")
      return (
        c.fieldName === rule.field || c.fieldName.endsWith(`.${rule.field}`)
      );
    });

    if (!matchingChange) continue;

    // Check condition
    let conditionMet = false;
    if (rule.condition === "CHANGED") {
      conditionMet = true;
    } else if (
      rule.condition === "DECREASE_BY_PERCENT" &&
      rule.threshold != null
    ) {
      const old = parseFloat(matchingChange.oldValue);
      const nw = parseFloat(matchingChange.newValue);
      if (!isNaN(old) && !isNaN(nw) && old > 0) {
        const pct = ((old - nw) / old) * 100;
        conditionMet = pct >= rule.threshold;
      }
    } else if (
      rule.condition === "INCREASE_BY_PERCENT" &&
      rule.threshold != null
    ) {
      const old = parseFloat(matchingChange.oldValue);
      const nw = parseFloat(matchingChange.newValue);
      if (!isNaN(old) && !isNaN(nw) && old > 0) {
        const pct = ((nw - old) / old) * 100;
        conditionMet = pct >= rule.threshold;
      }
    }

    if (!conditionMet) continue;

    // Check min products in time window
    if (rule.minProducts && rule.windowMinutes) {
      const windowStart = new Date(
        now.getTime() - rule.windowMinutes * 60 * 1000,
      );
      const recentCount = await prisma.changeEvent.groupBy({
        by: ["productId"],
        where: {
          shop,
          fieldName: {
            contains: rule.field,
          },
          changedAt: { gte: windowStart },
        },
      });
      if (recentCount.length < rule.minProducts) continue;
    }

    return rule;
  }

  return null;
}

/**
 * Check for bulk changes and potentially group into incident
 */
export async function checkBulkChanges(shop, settings) {
  const windowMinutes = settings?.bulkWindowMinutes || 10;
  const threshold = settings?.bulkThreshold || 20;
  const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);

  // Count unique products changed in window
  const recentChanges = await prisma.changeEvent.groupBy({
    by: ["productId"],
    where: {
      shop,
      changedAt: { gte: windowStart },
      incidentId: null, // not already in an incident
    },
  });

  return recentChanges.length >= threshold ? recentChanges : null;
}

/**
 * Create an incident for suspicious/bulk changes
 */
export async function createIncident(
  shop,
  name,
  severity,
  affectedCount,
  ruleId,
  changeEventIds,
) {
  const incident = await prisma.incident.create({
    data: {
      shop,
      name,
      severity,
      affectedCount,
      triggeredRuleId: ruleId || null,
    },
  });

  // Link change events to incident
  if (changeEventIds && changeEventIds.length > 0) {
    await prisma.changeEvent.updateMany({
      where: { id: { in: changeEventIds } },
      data: { incidentId: incident.id },
    });
  }

  return incident;
}

/**
 * Execute rollback for a specific product/fields from change events
 * Only restores the affected fields, not the entire product
 */
export async function rollbackProductFields(admin, shop, productId, changeEventIds) {
  // Get the change events
  const events = await prisma.changeEvent.findMany({
    where: {
      id: { in: changeEventIds },
      shop,
      productId: String(productId),
    },
  });

  if (events.length === 0) return { success: false, error: "No events found" };

  const productTitle = events[0]?.productTitle || productId;
  const restoredFields = {};
  const variantUpdates = {};

  for (const event of events) {
    if (event.fieldName.startsWith("variant.")) {
      const field = event.fieldName.replace("variant.", "");
      const varId = event.variantId;
      if (!variantUpdates[varId]) variantUpdates[varId] = {};
      variantUpdates[varId][field] = event.oldValue;
    } else {
      restoredFields[event.fieldName] = event.oldValue;
    }
  }

  const gid = `gid://shopify/Product/${productId}`;

  try {
    // Update product-level fields
    if (Object.keys(restoredFields).length > 0) {
      const productInput = { id: gid };
      if (restoredFields.title !== undefined)
        productInput.title = restoredFields.title;
      if (restoredFields.status !== undefined)
        productInput.status = restoredFields.status;
      if (restoredFields.vendor !== undefined)
        productInput.vendor = restoredFields.vendor;
      if (restoredFields.tags !== undefined)
        productInput.tags = restoredFields.tags.split(", ").filter(Boolean);
      if (restoredFields.bodyHtml !== undefined)
        productInput.bodyHtml = restoredFields.bodyHtml;
      if (restoredFields.handle !== undefined)
        productInput.handle = restoredFields.handle;

      const resp = await admin.graphql(
        `#graphql
        mutation updateProduct($input: ProductInput!) {
          productUpdate(input: $input) {
            product { id title }
            userErrors { field message }
          }
        }`,
        { variables: { input: productInput } },
      );
      const json = await resp.json();
      if (json.data?.productUpdate?.userErrors?.length > 0) {
        return {
          success: false,
          error: json.data.productUpdate.userErrors
            .map((e) => e.message)
            .join(", "),
        };
      }
    }

    // Update variant-level fields
    for (const [varId, fields] of Object.entries(variantUpdates)) {
      const varGid = `gid://shopify/ProductVariant/${varId}`;
      const variantInput = { id: varGid };
      if (fields.price !== undefined) variantInput.price = fields.price;
      if (fields.compareAtPrice !== undefined)
        variantInput.compareAtPrice = fields.compareAtPrice;
      if (fields.sku !== undefined) variantInput.sku = fields.sku;
      if (fields.barcode !== undefined) variantInput.barcode = fields.barcode;

      const resp = await admin.graphql(
        `#graphql
        mutation updateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id price }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            productId: gid,
            variants: [variantInput],
          },
        },
      );
      const json = await resp.json();
      if (json.data?.productVariantsBulkUpdate?.userErrors?.length > 0) {
        return {
          success: false,
          error: json.data.productVariantsBulkUpdate.userErrors
            .map((e) => e.message)
            .join(", "),
        };
      }
    }

    await syncSnapshotAfterRollback(shop, productId, restoredFields, variantUpdates);

    return {
      success: true,
      productTitle,
      restoredFields: {
        ...restoredFields,
        ...Object.fromEntries(
          Object.entries(variantUpdates).map(([k, v]) => [`variant:${k}`, v]),
        ),
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Update the local ProductSnapshot baseline to match a rollback's restored values.
 * Without this, Shopify's own products/update webhook triggered by the rollback
 * mutation would compare the restored value against the stale pre-rollback
 * snapshot and record it as a brand-new (spurious) change.
 */
async function syncSnapshotAfterRollback(shop, productId, restoredFields, variantUpdates) {
  const numericId = String(productId);
  const record = await prisma.productSnapshot.findUnique({
    where: { shop_productId: { shop, productId: numericId } },
  });
  if (!record) return;

  const snap = record.snapshotData || {};
  const updatedSnap = { ...snap, ...restoredFields };

  if (Array.isArray(snap.variants) && Object.keys(variantUpdates).length > 0) {
    updatedSnap.variants = snap.variants.map((v) => {
      const varNumericId = String(v.id).replace("gid://shopify/ProductVariant/", "");
      const update = variantUpdates[varNumericId];
      return update ? { ...v, ...update } : v;
    });
  }

  const flatUpdate = {};
  for (const field of ["title", "status", "vendor", "tags", "bodyHtml"]) {
    if (restoredFields[field] !== undefined) flatUpdate[field] = restoredFields[field];
  }

  await prisma.productSnapshot.update({
    where: { shop_productId: { shop, productId: numericId } },
    data: { ...flatUpdate, snapshotData: updatedSnap },
  });
}

/**
 * Get or create app settings for a shop
 */
export async function getOrCreateSettings(shop) {
  let settings = await prisma.appSettings.findUnique({ where: { shop } });
  if (!settings) {
    settings = await prisma.appSettings.create({
      data: { shop },
    });
  }
  return settings;
}

/**
 * Slack webhook URLs are merchant-supplied strings that the SERVER later makes
 * outbound POSTs to — both from the "Test" button and from every incident
 * alert. Without a host allowlist that is a stored SSRF primitive: a staff
 * account could point it at cloud metadata endpoints or internal services and
 * read the outcome back from the banner. `type="url"` on the input is a
 * client-side hint and guarantees nothing.
 *
 * Returns { ok: true, url } or { ok: false, message }.
 */
export function validateSlackWebhookUrl(raw) {
  const value = String(raw ?? "").trim();
  if (!value) {
    return { ok: false, message: "Please provide a Slack Webhook URL first." };
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, message: "That doesn't look like a valid URL. Paste the full https://hooks.slack.com/services/... address." };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, message: "Slack webhooks must use https://." };
  }
  if (parsed.hostname.toLowerCase() !== "hooks.slack.com") {
    return { ok: false, message: "Only Slack incoming webhooks are accepted. The URL must start with https://hooks.slack.com/services/." };
  }
  if (!parsed.pathname.startsWith("/services/")) {
    return { ok: false, message: "That Slack URL is missing the /services/ path. Copy the full webhook URL from Slack." };
  }

  return { ok: true, url: parsed.toString() };
}

/**
 * Is this incident's severity one the merchant asked to be notified about?
 *
 * Unknown severities fail OPEN: dropping an alert we don't recognise is the
 * worse failure, because the merchant never learns the incident happened.
 */
export function isSeverityAlertEnabled(severity, settings) {
  switch (severity) {
    case "CRITICAL":
      return Boolean(settings?.alertOnCritical);
    case "HIGH":
      return Boolean(settings?.alertOnHigh);
    case "MEDIUM":
      return Boolean(settings?.alertOnMedium);
    case "LOW":
      return Boolean(settings?.alertOnLow);
    default:
      return true;
  }
}

/**
 * Send a merchant alert email & Slack notification for an incident.
 * Respects the shop's alertEmail, slackWebhookUrl, and toggles.
 * Alerting is non-fatal and must never break the webhook that triggered it.
 */
export async function sendIncidentAlert(shop, incident, settings) {
  // The severity toggles gate BOTH channels. Checking this before the Slack
  // block (rather than only before the email) is the whole point — a merchant
  // who unticks MEDIUM must stop getting MEDIUM pings in Slack too.
  if (!isSeverityAlertEnabled(incident.severity, settings)) return;

  const appUrl = process.env.SHOPIFY_APP_URL;
  const incidentLink = appUrl ? `${appUrl}/app/incidents/${incident.id}` : null;

  // 1. Slack notification. Re-validated at send time so a URL stored before
  // the allowlist existed can never be dialled.
  const slackTarget = validateSlackWebhookUrl(settings?.slackWebhookUrl);
  if (settings?.slackWebhookUrl && !slackTarget.ok) {
    console.warn(`[Revertly] Refusing to POST to non-Slack webhook for ${shop}: ${slackTarget.message}`);
  }
  if (slackTarget.ok) {
    try {
      const color =
        incident.severity === "CRITICAL"
          ? "#D82C0D"
          : incident.severity === "HIGH"
            ? "#E57800"
            : "#008060";

      await fetch(slackTarget.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `*[Revertly Alert]* ${incident.severity}: ${incident.name}`,
          attachments: [
            {
              color,
              title: incident.name,
              title_link: incidentLink || undefined,
              fields: [
                { title: "Store", value: shop, short: true },
                { title: "Severity", value: incident.severity, short: true },
                { title: "Affected Products", value: String(incident.affectedCount), short: true },
                { title: "Status", value: incident.status, short: true },
              ],
              footer: "Revertly Product Guard",
              ts: Math.floor(Date.now() / 1000),
            },
          ],
        }),
      });
    } catch (slackErr) {
      console.error("[Revertly] Slack alert error:", slackErr);
    }
  }

  // 2. Email alert via Resend — delivered to the shop alert address plus every
  // active team member who opted in, so multi-user stores are all notified.
  const { getAlertRecipients } = await import("./team.server.js");
  const recipients = await getAlertRecipients(shop, settings);
  if (recipients.length === 0) return;

  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !fromEmail) {
    console.error(
      "[Revertly] Cannot send incident alert: RESEND_API_KEY or RESEND_FROM_EMAIL is not configured",
    );
    return;
  }

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: recipients,
        subject: `[Revertly] ${incident.severity} incident detected — ${incident.name}`,
        html: `
          <p><strong>${incident.name}</strong></p>
          <p>Severity: ${incident.severity}</p>
          <p>Shop: ${shop}</p>
          <p>Affected products: ${incident.affectedCount}</p>
          ${incidentLink ? `<p><a href="${incidentLink}">Review this incident in Revertly</a></p>` : ""}
        `,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[Revertly] Resend alert email failed (${resp.status}): ${text}`);
    }
  } catch (err) {
    console.error("[Revertly] Error sending incident alert email", err);
  }
}

/**
 * Emergency Circuit Breaker: Automatically set product to DRAFT or auto-revert price
 * when a rapid crash exceeds the safety threshold.
 */
export async function triggerCircuitBreaker(admin, shop, productId, productTitle, priceChange, settings) {
  if (!settings?.circuitBreakerEnabled) return null;

  // Entitlement is re-checked at execution time, not just when the merchant
  // saves Settings. A downgrade leaves circuitBreakerEnabled=true in the row,
  // and this function MUTATES the catalog — drafting products or rewriting
  // prices for a shop that no longer pays for the feature.
  const access = await checkFeatureAccess(shop, "circuitBreaker");
  if (!access.allowed) {
    console.warn(
      `[CircuitBreaker] Skipped for ${shop}: plan "${access.plan}" no longer includes this feature.`,
    );
    return null;
  }

  const threshold = settings.circuitBreakerThreshold || 50;
  const oldPrice = parseFloat(priceChange.oldValue);
  const newPrice = parseFloat(priceChange.newValue);
  if (isNaN(oldPrice) || isNaN(newPrice) || oldPrice <= 0) return null;

  const dropPct = ((oldPrice - newPrice) / oldPrice) * 100;
  if (dropPct < threshold) return null;

  const actionType = settings.circuitBreakerAction || "DRAFT";
  const gid = productId.startsWith("gid://") ? productId : `gid://shopify/Product/${productId}`;

  try {
    if (actionType === "DRAFT") {
      const resp = await admin.graphql(
        `#graphql
        mutation draftProduct($input: ProductInput!) {
          productUpdate(input: $input) {
            product { id status }
            userErrors { field message }
          }
        }`,
        { variables: { input: { id: gid, status: "DRAFT" } } }
      );
      const json = await resp.json();
      if (json.data?.productUpdate?.userErrors?.length > 0) {
        console.error("[CircuitBreaker] Error setting to draft:", json.data.productUpdate.userErrors);
        return null;
      }
      return {
        triggered: true,
        action: "DRAFT",
        productTitle,
        dropPct: dropPct.toFixed(1),
        message: `Product automatically set to DRAFT because price dropped by ${dropPct.toFixed(1)}% (Threshold: ${threshold}%).`,
      };
    } else if (actionType === "AUTO_REVERT" && priceChange.variantId) {
      const varGid = priceChange.variantId.startsWith("gid://")
        ? priceChange.variantId
        : `gid://shopify/ProductVariant/${priceChange.variantId}`;

      const resp = await admin.graphql(
        `#graphql
        mutation autoRevertPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id price }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            productId: gid,
            variants: [{ id: varGid, price: priceChange.oldValue }],
          },
        }
      );
      const json = await resp.json();
      if (json.data?.productVariantsBulkUpdate?.userErrors?.length > 0) {
        console.error("[CircuitBreaker] Error reverting price:", json.data.productVariantsBulkUpdate.userErrors);
        return null;
      }
      return {
        triggered: true,
        action: "AUTO_REVERT",
        productTitle,
        dropPct: dropPct.toFixed(1),
        message: `Price automatically reverted back to $${priceChange.oldValue} from $${priceChange.newValue} (${dropPct.toFixed(1)}% drop).`,
      };
    }
  } catch (err) {
    console.error("[CircuitBreaker] Execution failed:", err);
  }
  return null;
}

/**
 * Recreate a deleted product in Shopify using stored snapshot data.
 */
export async function restoreDeletedProduct(admin, shop, productId) {
  const numericId = String(productId).replace("gid://shopify/Product/", "");
  const record = await prisma.productSnapshot.findUnique({
    where: { shop_productId: { shop, productId: numericId } },
  });

  if (!record || !record.snapshotData) {
    return { success: false, error: "Snapshot data not found for this product." };
  }

  const snap = record.snapshotData;
  const tagsList = Array.isArray(snap.tags)
    ? snap.tags
    : typeof snap.tags === "string"
      ? snap.tags.split(",").map((t) => t.trim()).filter(Boolean)
      : [];

  try {
    const productInput = {
      title: snap.title || "Restored Product",
      descriptionHtml: snap.bodyHtml || "",
      vendor: snap.vendor || "",
      productType: snap.productType || "",
      tags: tagsList,
      status: "DRAFT", // Restore as DRAFT so merchant can verify
    };

    const resp = await admin.graphql(
      `#graphql
      mutation recreateProduct($input: ProductInput!) {
        productCreate(input: $input) {
          product {
            id
            title
            status
            variants(first: 10) {
              edges {
                node { id price }
              }
            }
          }
          userErrors { field message }
        }
      }`,
      { variables: { input: productInput } }
    );

    const json = await resp.json();
    const userErrors = json.data?.productCreate?.userErrors;
    if (userErrors && userErrors.length > 0) {
      return { success: false, error: userErrors.map((e) => e.message).join(", ") };
    }

    const createdProduct = json.data?.productCreate?.product;
    const newGid = createdProduct?.id;
    const newNumericId = newGid?.replace("gid://shopify/Product/", "");

    // Update default variant if snapshot had pricing
    if (snap.variants && snap.variants.length > 0 && createdProduct?.variants?.edges?.length > 0) {
      const defaultVariantGid = createdProduct.variants.edges[0].node.id;
      const firstOldVar = snap.variants[0];
      const variantInput = { id: defaultVariantGid };
      if (firstOldVar.price) variantInput.price = String(firstOldVar.price);
      if (firstOldVar.compareAtPrice) variantInput.compareAtPrice = String(firstOldVar.compareAtPrice);
      if (firstOldVar.sku) variantInput.sku = firstOldVar.sku;
      if (firstOldVar.barcode) variantInput.barcode = firstOldVar.barcode;

      await admin.graphql(
        `#graphql
        mutation updateCreatedVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id price }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            productId: newGid,
            variants: [variantInput],
          },
        }
      );
    }

    // Mark current snapshot restored
    await prisma.productSnapshot.update({
      where: { shop_productId: { shop, productId: numericId } },
      data: {
        isDeleted: false,
        deletedAt: null,
        status: "DRAFT",
      },
    });

    // Record change event
    await prisma.changeEvent.create({
      data: {
        shop,
        productId: newNumericId || numericId,
        productTitle: snap.title,
        fieldName: "status",
        oldValue: "DELETED",
        newValue: "RESTORED_DRAFT",
      },
    });

    return {
      success: true,
      newProductId: newNumericId,
      title: snap.title,
    };
  } catch (err) {
    console.error("[Revertly] restoreDeletedProduct error:", err);
    return { success: false, error: err.message };
  }
}
