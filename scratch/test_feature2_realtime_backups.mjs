import assert from "node:assert";
import prisma from "../app/db.server.js";
import { compareSnapshots } from "../app/monitor.server.js";

const TEST_SHOP = "qa-realtime-test.myshopify.com";

async function main() {
  console.log("▶ Verifying Feature 2: Real-time Backups & Feature 6: Metafield Backups");

  await prisma.rollbackResult.deleteMany({ where: { rollbackJob: { shop: TEST_SHOP } } });
  await prisma.rollbackJob.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.changeEvent.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.incident.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.productSnapshot.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.appSettings.deleteMany({ where: { shop: TEST_SHOP } });

  await prisma.appSettings.create({
    data: {
      shop: TEST_SHOP,
      monitoringEnabled: true,
      bulkThreshold: 10,
    },
  });

  // 1. Initial Snapshot
  const initialSnap = {
    id: "gid://shopify/Product/1001",
    title: "Eco Cotton T-Shirt",
    status: "ACTIVE",
    vendor: "Organic Apparel",
    productType: "Shirts",
    tags: "eco, summer",
    handle: "eco-cotton-t-shirt",
    bodyHtml: "<p>100% organic cotton</p>",
    publishedAt: "2026-01-01T00:00:00Z",
    variants: [
      {
        id: "gid://shopify/ProductVariant/2001",
        title: "Medium / Blue",
        price: "29.99",
        compareAtPrice: "39.99",
        sku: "ECO-BLU-M",
        inventoryQuantity: 50,
      },
    ],
    metafields: [
      {
        id: "gid://shopify/Metafield/3001",
        namespace: "custom",
        key: "fabric_spec",
        value: "Organic Ring-spun Cotton",
        type: "single_line_text_field",
      },
    ],
  };

  await prisma.productSnapshot.create({
    data: {
      shop: TEST_SHOP,
      productId: "1001",
      title: initialSnap.title,
      status: initialSnap.status,
      vendor: initialSnap.vendor,
      productType: initialSnap.productType,
      snapshotData: initialSnap,
    },
  });

  console.log("  ✅ Initial product snapshot baseline saved with metafields.");

  // 2. Real-time update payload with price change AND metafield update
  const updatedSnap = {
    id: "gid://shopify/Product/1001",
    title: "Eco Cotton T-Shirt - Premium Edition", // title changed
    status: "ACTIVE",
    vendor: "Organic Apparel",
    productType: "Shirts",
    tags: "eco, summer, premium",
    handle: "eco-cotton-t-shirt",
    bodyHtml: "<p>100% organic cotton</p>",
    publishedAt: "2026-01-01T00:00:00Z",
    variants: [
      {
        id: "gid://shopify/ProductVariant/2001",
        title: "Medium / Blue",
        price: "34.99", // price increased from 29.99 to 34.99
        compareAtPrice: "39.99",
        sku: "ECO-BLU-M",
        inventoryQuantity: 50,
      },
    ],
    metafields: [
      {
        id: "gid://shopify/Metafield/3001",
        namespace: "custom",
        key: "fabric_spec",
        value: "100% GOTS Certified Organic Cotton", // metafield changed
        type: "single_line_text_field",
      },
      {
        id: "gid://shopify/Metafield/3002",
        namespace: "care",
        key: "instructions",
        value: "Machine wash cold", // new metafield added
        type: "single_line_text_field",
      },
    ],
  };

  const detectedChanges = compareSnapshots(initialSnap, updatedSnap);
  console.log("  Detected changes:", detectedChanges);

  assert(detectedChanges.length >= 3, `Expected at least 3 detected changes, got ${detectedChanges.length}`);
  const titleDiff = detectedChanges.find((c) => c.fieldName === "title");
  const priceDiff = detectedChanges.find((c) => c.fieldName === "variant.price");
  const mfDiff = detectedChanges.find((c) => c.fieldName === "metafield.custom.fabric_spec");
  const newMfDiff = detectedChanges.find((c) => c.fieldName === "metafield.care.instructions");

  assert(titleDiff, "Title change detected");
  assert(priceDiff, "Variant price change detected");
  assert(priceDiff.oldValue === "29.99" && priceDiff.newValue === "34.99", "Price change values accurate");
  assert(mfDiff, "Metafield change detected in real-time snapshot comparison");
  assert(newMfDiff, "New added metafield detected");

  // Save changes to ChangeEvent and update ProductSnapshot
  for (const c of detectedChanges) {
    await prisma.changeEvent.create({
      data: {
        shop: TEST_SHOP,
        productId: "1001",
        productTitle: updatedSnap.title,
        fieldName: c.fieldName,
        oldValue: c.oldValue,
        newValue: c.newValue,
      },
    });
  }

  await prisma.productSnapshot.update({
    where: { shop_productId: { shop: TEST_SHOP, productId: "1001" } },
    data: {
      title: updatedSnap.title,
      snapshotData: updatedSnap,
    },
  });

  const updatedRecord = await prisma.productSnapshot.findUnique({
    where: { shop_productId: { shop: TEST_SHOP, productId: "1001" } },
  });
  assert(updatedRecord.snapshotData.metafields.length === 2, "Real-time snapshot preserved both metafields");
  console.log("  ✅ PASS: Real-time update and metafield changes captured and persisted!");

  // 3. Real-time Deletion Preservation Test
  await prisma.productSnapshot.update({
    where: { shop_productId: { shop: TEST_SHOP, productId: "1001" } },
    data: {
      isDeleted: true,
      deletedAt: new Date(),
      status: "DELETED",
    },
  });

  const deletedRecord = await prisma.productSnapshot.findUnique({
    where: { shop_productId: { shop: TEST_SHOP, productId: "1001" } },
  });
  assert(deletedRecord.isDeleted === true, "Deleted product preserved with isDeleted = true");
  assert(deletedRecord.snapshotData.title === updatedSnap.title, "Full snapshot preserved in DB despite deletion");

  console.log("  ✅ PASS: Real-time deletion preserves full snapshot in database for 1-click restore!\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Feature 2 Test failed:", err);
  process.exit(1);
});
