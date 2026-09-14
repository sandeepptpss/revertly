import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { sendIncidentAlert } from "../monitor.server.js";

export const action = async ({ request }) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic !== "PRODUCTS_DELETE") {
    return new Response("Unhandled topic", { status: 200 });
  }

  try {
    const settings = await prisma.appSettings.findUnique({ where: { shop } });
    if (settings && !settings.monitoringEnabled) {
      return new Response("Monitoring disabled", { status: 200 });
    }

    const numericId = String(payload.id);
    const prevRecord = await prisma.productSnapshot.findUnique({
      where: { shop_productId: { shop, productId: numericId } },
    });

    const productTitle = prevRecord?.title || `Product #${numericId}`;

    if (prevRecord) {
      // Mark as deleted in snapshot table
      await prisma.productSnapshot.update({
        where: { shop_productId: { shop, productId: numericId } },
        data: {
          isDeleted: true,
          deletedAt: new Date(),
          status: "DELETED",
        },
      });

      // Log change event
      const event = await prisma.changeEvent.create({
        data: {
          shop,
          productId: numericId,
          productTitle,
          fieldName: "status",
          oldValue: prevRecord.status,
          newValue: "DELETED",
        },
      });

      // Create an Incident for immediate visibility
      const incident = await prisma.incident.create({
        data: {
          shop,
          name: `Product Deleted: ${productTitle}`,
          severity: "HIGH",
          affectedCount: 1,
          status: "OPEN",
          notes: "Product was deleted from Shopify catalog. Complete product snapshot is preserved and can be restored.",
        },
      });

      // Link change event to incident
      await prisma.changeEvent.update({
        where: { id: event.id },
        data: { incidentId: incident.id },
      });

      // Send alerts (Email & Slack)
      await sendIncidentAlert(shop, incident, settings);
    } else {
      // If we did not have a prior snapshot, still log change event for audit trail
      await prisma.changeEvent.create({
        data: {
          shop,
          productId: numericId,
          productTitle,
          fieldName: "status",
          oldValue: "ACTIVE",
          newValue: "DELETED",
        },
      });
    }

    return new Response("Product deletion processed", { status: 200 });
  } catch (error) {
    console.error("[Revertly] Error handling product deletion webhook:", error);
    return new Response("Internal error", { status: 500 });
  }
};
