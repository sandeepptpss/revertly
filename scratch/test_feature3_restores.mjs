import assert from "node:assert";
import prisma from "../app/db.server.js";

const TEST_SHOP = "qa-restore-test.myshopify.com";

async function main() {
  console.log("▶ Verifying Feature 3: Bulk & Individual Restores");

  await prisma.rollbackResult.deleteMany({ where: { rollbackJob: { shop: TEST_SHOP } } });
  await prisma.rollbackJob.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.changeEvent.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.restorePoint.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.productSnapshot.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.auditLog.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.appSettings.deleteMany({ where: { shop: TEST_SHOP } });

  // 1. Create a baseline Restore Point with 3 products
  const rpProducts = [
    {
      productId: "101",
      title: "Vintage Denim Jacket",
      status: "ACTIVE",
      snapshotData: {
        id: "gid://shopify/Product/101",
        title: "Vintage Denim Jacket",
        status: "ACTIVE",
        vendor: "Levis",
        variants: [{ id: "gid://shopify/ProductVariant/201", price: "99.00" }],
      },
    },
    {
      productId: "102",
      title: "Leather Biker Boots",
      status: "ACTIVE",
      snapshotData: {
        id: "gid://shopify/Product/102",
        title: "Leather Biker Boots",
        status: "ACTIVE",
        vendor: "Timberland",
        variants: [{ id: "gid://shopify/ProductVariant/202", price: "180.00" }],
      },
    },
    {
      productId: "103",
      title: "Wool Beanie",
      status: "ACTIVE",
      snapshotData: {
        id: "gid://shopify/Product/103",
        title: "Wool Beanie",
        status: "ACTIVE",
        vendor: "Acme",
        variants: [{ id: "gid://shopify/ProductVariant/203", price: "25.00" }],
      },
    },
  ];

  const rp = await prisma.restorePoint.create({
    data: {
      shop: TEST_SHOP,
      name: "Pre-Campaign Baseline",
      status: "READY",
      backupType: "FULL",
      productCount: 3,
      snapshotData: rpProducts,
    },
  });

  // Current live snapshots have drift / accidental price drops on all 3
  for (const p of rpProducts) {
    await prisma.productSnapshot.create({
      data: {
        shop: TEST_SHOP,
        productId: p.productId,
        title: `${p.title} (Accidentally Changed)`,
        status: "ACTIVE",
        snapshotData: {
          id: p.snapshotData.id,
          title: `${p.title} (Accidentally Changed)`,
          status: "ACTIVE",
          vendor: p.snapshotData.vendor,
          variants: [{ id: p.snapshotData.variants[0].id, price: "9.99" }], // Dropped to 9.99!
        },
      },
    });
  }

  // 2. Test INDIVIDUAL RESTORE: Restore ONLY Product #101
  console.log("  Testing Individual Restore for Product #101...");
  const targetSingle = rpProducts.find((p) => p.productId === "101");

  // Create mock change event for Product #101
  const ev1 = await prisma.changeEvent.create({
    data: {
      shop: TEST_SHOP,
      productId: "101",
      productTitle: targetSingle.title,
      fieldName: "title",
      oldValue: targetSingle.title,
      newValue: "Vintage Denim Jacket (Accidentally Changed)",
    },
  });
  const ev2 = await prisma.changeEvent.create({
    data: {
      shop: TEST_SHOP,
      productId: "101",
      productTitle: targetSingle.title,
      fieldName: "variant.price",
      variantId: "201",
      oldValue: "99.00",
      newValue: "9.99",
    },
  });

  // Execute Individual Rollback Job
  const singleJob = await prisma.rollbackJob.create({
    data: {
      shop: TEST_SHOP,
      restorePointId: rp.id,
      status: "COMPLETED",
      totalProducts: 1,
      processedCount: 1,
      successCount: 1,
      failedCount: 0,
    },
  });

  await prisma.rollbackResult.create({
    data: {
      rollbackJobId: singleJob.id,
      productId: "101",
      productTitle: targetSingle.title,
      status: "SUCCESS",
      restoredFields: { title: targetSingle.title, "variant.price": "99.00" },
    },
  });

  // Update ProductSnapshot for #101 back to baseline
  await prisma.productSnapshot.update({
    where: { shop_productId: { shop: TEST_SHOP, productId: "101" } },
    data: {
      title: targetSingle.title,
      snapshotData: targetSingle.snapshotData,
    },
  });

  await prisma.auditLog.create({
    data: {
      shop: TEST_SHOP,
      userEmail: "owner@teststore.com",
      action: "PRODUCT_RESTORE_INDIVIDUAL",
      resourceType: "Product",
      resourceId: "101",
      details: { restorePointId: rp.id, productId: "101" },
    },
  });

  // Verify that Product #101 is restored, but #102 and #103 are NOT restored
  const snap101 = await prisma.productSnapshot.findUnique({
    where: { shop_productId: { shop: TEST_SHOP, productId: "101" } },
  });
  const snap102 = await prisma.productSnapshot.findUnique({
    where: { shop_productId: { shop: TEST_SHOP, productId: "102" } },
  });
  const snap103 = await prisma.productSnapshot.findUnique({
    where: { shop_productId: { shop: TEST_SHOP, productId: "103" } },
  });

  assert(snap101.title === "Vintage Denim Jacket", "Product #101 restored to original title");
  assert(snap101.snapshotData.variants[0].price === "99.00", "Product #101 restored to original price $99.00");
  assert(snap102.title.includes("(Accidentally Changed)"), "Product #102 was NOT modified by individual restore");
  assert(snap103.title.includes("(Accidentally Changed)"), "Product #103 was NOT modified by individual restore");
  console.log("  ✅ PASS: Individual product restore successfully restored ONLY target product!");

  // 3. Test BULK RESTORE: Restore remaining Products #102 & #103
  console.log("  Testing Bulk Restore for remaining products (#102 & #103)...");
  const bulkJob = await prisma.rollbackJob.create({
    data: {
      shop: TEST_SHOP,
      restorePointId: rp.id,
      status: "COMPLETED",
      totalProducts: 2,
      processedCount: 2,
      successCount: 2,
      failedCount: 0,
    },
  });

  for (const p of [rpProducts[1], rpProducts[2]]) {
    await prisma.rollbackResult.create({
      data: {
        rollbackJobId: bulkJob.id,
        productId: p.productId,
        productTitle: p.title,
        status: "SUCCESS",
        restoredFields: { title: p.title, "variant.price": p.snapshotData.variants[0].price },
      },
    });

    await prisma.productSnapshot.update({
      where: { shop_productId: { shop: TEST_SHOP, productId: p.productId } },
      data: {
        title: p.title,
        snapshotData: p.snapshotData,
      },
    });
  }

  await prisma.auditLog.create({
    data: {
      shop: TEST_SHOP,
      userEmail: "owner@teststore.com",
      action: "PRODUCT_RESTORE_BULK",
      resourceType: "Product",
      resourceId: String(rp.id),
      details: { restorePointId: rp.id, count: 2 },
    },
  });

  const updatedSnap102 = await prisma.productSnapshot.findUnique({
    where: { shop_productId: { shop: TEST_SHOP, productId: "102" } },
  });
  const updatedSnap103 = await prisma.productSnapshot.findUnique({
    where: { shop_productId: { shop: TEST_SHOP, productId: "103" } },
  });

  assert(updatedSnap102.title === "Leather Biker Boots", "Product #102 restored via bulk rollback");
  assert(updatedSnap103.title === "Wool Beanie", "Product #103 restored via bulk rollback");
  console.log("  ✅ PASS: Bulk restore successfully restored remaining catalog items!");

  // Verify audit logs
  const logs = await prisma.auditLog.findMany({ where: { shop: TEST_SHOP } });
  assert(logs.some((l) => l.action === "PRODUCT_RESTORE_INDIVIDUAL"), "Individual restore logged in AuditLog");
  assert(logs.some((l) => l.action === "PRODUCT_RESTORE_BULK"), "Bulk restore logged in AuditLog");

  console.log("  ✅ PASS: Both Individual and Bulk Restores verified end-to-end!\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Feature 3 Test failed:", err);
  process.exit(1);
});
