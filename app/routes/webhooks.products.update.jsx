import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import {
  compareSnapshots,
  sendIncidentAlert,
  triggerCircuitBreaker,
  isFieldMatch,
  isConditionMet,
} from "../monitor.server.js";
import { getEffectiveLimits } from "../billing.server.js";

function buildSnapshotFromPayload(product) {
  return {
    id: `gid://shopify/Product/${product.id}`,
    title: product.title,
    status: (product.status || "ACTIVE").toUpperCase(),
    vendor: product.vendor || "",
    productType: product.product_type || "",
    tags: Array.isArray(product.tags) ? product.tags.join(", ") : (product.tags || ""),
    handle: product.handle || "",
    bodyHtml: product.body_html || "",
    templateSuffix: product.template_suffix || product.templateSuffix || "",
    publishedAt: product.published_at || null,
    images: (product.images || []).map((img) => ({
      id: String(img.id),
      url: img.src,
      altText: img.alt || "",
    })),
    variants: (product.variants || []).map((v) => ({
      id: `gid://shopify/ProductVariant/${v.id}`,
      title: v.title,
      price: v.price,
      compareAtPrice: v.compare_at_price,
      sku: v.sku,
      inventoryQuantity: v.inventory_quantity,
      weight: v.weight,
      weightUnit: v.weight_unit,
      barcode: v.barcode,
    })),
  };
}

export const action = async ({ request }) => {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);

  if (topic !== "PRODUCTS_UPDATE") {
    return new Response("Unhandled topic", { status: 200 });
  }

  try {
    const settings = await prisma.appSettings.findUnique({ where: { shop } });
    if (settings && !settings.monitoringEnabled) {
      return new Response("Monitoring disabled", { status: 200 });
    }

    const product = payload;
    const numericId = String(product.id);

    const prevRecord = await prisma.productSnapshot.findUnique({
      where: { shop_productId: { shop, productId: numericId } },
    });

    let liveMetafields = Array.isArray(product.metafields)
      ? product.metafields
      : prevRecord?.snapshotData?.metafields || [];

    if (admin) {
      try {
        const mfRes = await admin.graphql(
          `#graphql
          query getProductMetafields($id: ID!) {
            product(id: $id) {
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
            }
          }`,
          { variables: { id: `gid://shopify/Product/${numericId}` } }
        );
        const mfJson = await mfRes.json();
        const edges = mfJson.data?.product?.metafields?.edges || [];
        if (edges.length > 0) {
          liveMetafields = edges.map((e) => ({
            id: e.node.id,
            namespace: e.node.namespace,
            key: e.node.key,
            value: e.node.value,
            type: e.node.type,
          }));
        }
      } catch (mfErr) {
        console.warn(`[Webhook] Real-time metafield fetch note for product ${numericId}:`, mfErr?.message);
      }
    }

    const newSnap = {
      ...buildSnapshotFromPayload(product),
      metafields: liveMetafields,
    };

    const upsertData = {
      shop,
      productId: numericId,
      title: product.title || "",
      status: (product.status || "ACTIVE").toUpperCase(),
      vendor: product.vendor || "",
      productType: product.product_type || "",
      tags: Array.isArray(product.tags) ? product.tags.join(", ") : (product.tags || ""),
      bodyHtml: product.body_html || "",
      handle: product.handle || "",
      publishedAt: product.published_at ? new Date(product.published_at) : null,
      snapshotData: newSnap,
      isDeleted: false,
      deletedAt: null,
    };

    const limits = await getEffectiveLimits(shop, settings);

    if (!prevRecord) {
      if (limits.products !== Infinity) {
        const currentCount = await prisma.productSnapshot.count({ where: { shop } });
        if (currentCount >= limits.products) {
          console.log(`[Revertly Webhook] Monitored product limit reached (${currentCount}/${limits.products}) for ${shop}`);
          await prisma.appSettings.upsert({
            where: { shop },
            create: { shop, productLimitReachedAt: new Date() },
            update: { productLimitReachedAt: new Date() },
          });
          return new Response("Product limit reached for current plan", { status: 200 });
        }
      }

      await prisma.productSnapshot.create({ data: upsertData });
      return new Response("First snapshot saved", { status: 200 });
    }

    // Enforce change-history retention for this plan: prune change events
    // older than the plan's retention window so old history doesn't linger
    // (and isn't queryable) past what the shop is entitled to.
    if (Number.isFinite(limits.retentionDays)) {
      const cutoff = new Date(Date.now() - limits.retentionDays * 24 * 60 * 60 * 1000);
      await prisma.changeEvent.deleteMany({
        where: { shop, changedAt: { lt: cutoff } },
      });
    }

    const oldSnap = prevRecord.snapshotData;
    const changes = compareSnapshots(oldSnap, newSnap);

    if (changes.length === 0) {
      return new Response("No changes", { status: 200 });
    }

    // Save change events, capturing each created ID directly (createMany
    // doesn't return IDs, and re-querying by a recent timestamp window risks
    // picking up unrelated concurrent events for the same product)
    const eventIds = [];
    for (const c of changes) {
      const created = await prisma.changeEvent.create({
        data: {
          shop,
          productId: numericId,
          productTitle: product.title || "",
          fieldName: c.fieldName,
          variantId: c.variantId
            ? String(c.variantId).replace("gid://shopify/ProductVariant/", "")
            : null,
          oldValue: c.oldValue,
          newValue: c.newValue,
        },
        select: { id: true },
      });
      eventIds.push(created.id);
    }

    // Update snapshot
    await prisma.productSnapshot.update({
      where: { shop_productId: { shop, productId: numericId } },
      data: { ...upsertData },
    });

    // Check Emergency Circuit Breaker on price changes
    let circuitBreakerInfo = null;
    const priceChange = changes.find(
      (c) => c.fieldName === "variant.price" || c.fieldName === "price"
    );
    if (priceChange && admin && settings?.circuitBreakerEnabled) {
      circuitBreakerInfo = await triggerCircuitBreaker(
        admin,
        shop,
        numericId,
        product.title || numericId,
        priceChange,
        settings
      );
    }

    // Check detection rules
    const rules = await prisma.detectionRule.findMany({ where: { shop, isActive: true } });
    for (const rule of rules) {
      const match = changes.find((c) => isFieldMatch(c.fieldName, rule.field));
      if (!match) continue;

      if (!isConditionMet(rule.condition, rule.threshold, match.oldValue, match.newValue)) {
        continue;
      }

      // Check min products window (if minProducts > 1)
      const minRequired = rule.minProducts && rule.minProducts > 1 ? rule.minProducts : 1;
      if (minRequired > 1) {
        const windowMinutes = rule.windowMinutes || 10;
        const ws = new Date(Date.now() - windowMinutes * 60 * 1000);
        const pastEvents = await prisma.changeEvent.findMany({
          where: { shop, changedAt: { gte: ws } },
          select: { productId: true, fieldName: true },
        });
        const matchingProductIds = new Set(
          pastEvents
            .filter((e) => isFieldMatch(e.fieldName, rule.field))
            .map((e) => e.productId)
        );
        matchingProductIds.add(numericId);
        if (matchingProductIds.size < minRequired) continue;
      }

      // Check if there is an active open incident for this rule created within the last 10 minutes
      const activeIncident = await prisma.incident.findFirst({
        where: {
          shop,
          triggeredRuleId: rule.id,
          status: "OPEN",
          createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) },
        },
      });

      if (activeIncident) {
        if (eventIds.length > 0) {
          await prisma.changeEvent.updateMany({
            where: { id: { in: eventIds } },
            data: { incidentId: activeIncident.id },
          });
        }
        const uniqueProducts = await prisma.changeEvent.groupBy({
          by: ["productId"],
          where: { incidentId: activeIncident.id },
        });
        const updated = await prisma.incident.update({
          where: { id: activeIncident.id },
          data: {
            affectedCount: uniqueProducts.length,
            ...(circuitBreakerInfo?.message ? { notes: circuitBreakerInfo.message } : {}),
          },
        });
        await sendIncidentAlert(shop, updated, settings);
        return new Response(`Event linked to active incident ${activeIncident.id}`, { status: 200 });
      }

      // Find all unlinked events for this field inside the rule window to group them
      const ws = rule.windowMinutes
        ? new Date(Date.now() - rule.windowMinutes * 60 * 1000)
        : new Date(Date.now() - 10 * 60 * 1000);

      const candidateEvents = await prisma.changeEvent.findMany({
        where: {
          shop,
          changedAt: { gte: ws },
          incidentId: null,
        },
      });
      const unlinkedEvents = candidateEvents.filter((e) => isFieldMatch(e.fieldName, rule.field));

      const uniqueProductIds = new Set([numericId, ...unlinkedEvents.map((e) => e.productId)]);
      const affectedCount = uniqueProductIds.size;

      const incident = await prisma.incident.create({
        data: {
          shop,
          name: `${rule.name}: ${affectedCount} product${affectedCount > 1 ? "s" : ""} affected`,
          severity: rule.severity,
          affectedCount,
          triggeredRuleId: rule.id,
          notes: circuitBreakerInfo?.message || null,
        },
      });

      const allEventIds = Array.from(new Set([...eventIds, ...unlinkedEvents.map((e) => e.id)]));
      if (allEventIds.length > 0) {
        await prisma.changeEvent.updateMany({
          where: { id: { in: allEventIds } },
          data: { incidentId: incident.id },
        });
      }
      await sendIncidentAlert(shop, incident, settings);
      return new Response(`Incident ${incident.id} created`, { status: 200 });
    }

    // Bulk detection
    const bulkThreshold = settings?.bulkThreshold || 20;
    const bulkWindow = settings?.bulkWindowMinutes || 10;
    const windowStart = new Date(Date.now() - bulkWindow * 60 * 1000);
    const bulkProducts = await prisma.changeEvent.groupBy({
      by: ["productId"],
      where: { shop, changedAt: { gte: windowStart }, incidentId: null },
    });

    if (bulkProducts.length >= bulkThreshold) {
      const activeBulkIncident = await prisma.incident.findFirst({
        where: {
          shop,
          name: "Mass Product Change Detected",
          status: "OPEN",
          createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) },
        },
      });

      if (activeBulkIncident) {
        const bulkEvents = await prisma.changeEvent.findMany({
          where: { shop, changedAt: { gte: windowStart }, incidentId: null },
          select: { id: true },
        });
        if (bulkEvents.length > 0) {
          await prisma.changeEvent.updateMany({
            where: { id: { in: bulkEvents.map((e) => e.id) } },
            data: { incidentId: activeBulkIncident.id },
          });
        }
        const uniqueProducts = await prisma.changeEvent.groupBy({
          by: ["productId"],
          where: { incidentId: activeBulkIncident.id },
        });
        const updated = await prisma.incident.update({
          where: { id: activeBulkIncident.id },
          data: { affectedCount: uniqueProducts.length },
        });
        await sendIncidentAlert(shop, updated, settings);
      } else {
        const bulkEvents = await prisma.changeEvent.findMany({
          where: { shop, changedAt: { gte: windowStart }, incidentId: null },
          select: { id: true },
        });
        const incident = await prisma.incident.create({
          data: { shop, name: "Mass Product Change Detected", severity: "CRITICAL", affectedCount: bulkProducts.length },
        });
        if (bulkEvents.length > 0) {
          await prisma.changeEvent.updateMany({
            where: { id: { in: bulkEvents.map((e) => e.id) } },
            data: { incidentId: incident.id },
          });
        }
        await sendIncidentAlert(shop, incident, settings);
      }
    }

    // Standalone Circuit Breaker incident if triggered without matching custom rule
    if (circuitBreakerInfo?.triggered) {
      const cbIncident = await prisma.incident.create({
        data: {
          shop,
          name: `Emergency Circuit Breaker: ${product.title || numericId}`,
          severity: "CRITICAL",
          affectedCount: 1,
          notes: circuitBreakerInfo.message,
        },
      });
      if (eventIds.length > 0) {
        await prisma.changeEvent.updateMany({
          where: { id: { in: eventIds } },
          data: { incidentId: cbIncident.id },
        });
      }
      await sendIncidentAlert(shop, cbIncident, settings);
      return new Response(`Circuit breaker executed: ${circuitBreakerInfo.action}`, { status: 200 });
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("[PRODUCTS_UPDATE webhook error]", err);
    return new Response("Internal error", { status: 500 });
  }
};
