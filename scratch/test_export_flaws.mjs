import assert from "node:assert";
import prisma from "../app/db.server.js";

const TEST_SHOP = "quickstart-749ac396.myshopify.com";

async function verifyFlaws() {
  console.log("Testing export flaw scenarios directly on DB data...");

  // Scenario A: User selects "Latest Live Store Data" (rpIdParam = null)
  let rpIdParam = null;
  let latestRp = null;
  if (rpIdParam) {
    latestRp = await prisma.restorePoint.findFirst({
      where: { id: parseInt(rpIdParam, 10), shop: TEST_SHOP },
    });
  }
  if (!latestRp) {
    latestRp = await prisma.restorePoint.findFirst({
      where: { shop: TEST_SHOP, status: "READY" },
      orderBy: { createdAt: "desc" },
    });
  }

  console.log("Scenario A (Live store selected):");
  console.log("  latestRp found:", latestRp ? `RP #${latestRp.id} (${latestRp.name})` : "None");
  console.log("  Did it mistakenly grab historical RP instead of live store?", latestRp !== null);
  assert(latestRp !== null, "Proves bug: live store selection is hijacked by existing restore point");

  // Scenario B: User selects RP #508 (Pages & Menus Backup - 0 products, 0 themes, 0 collections)
  // Check what products_csv does
  const rp508 = await prisma.restorePoint.findFirst({
    where: { shop: TEST_SHOP, backupType: "PAGES" },
    orderBy: { createdAt: "desc" },
  });
  if (rp508) {
    console.log(`\nScenario B (Selected RP #${rp508.id}, type: ${rp508.backupType}):`);
    let products = [];
    if (rp508.snapshotData && Array.isArray(rp508.snapshotData)) products = rp508.snapshotData;
    console.log("  RP products count:", products.length);
    if (products.length === 0) {
      products = await prisma.productSnapshot.findMany({
        where: { shop: TEST_SHOP, isDeleted: false },
        orderBy: { updatedAt: "desc" },
      });
    }
    console.log("  Products returned after fallback:", products.length);
    console.log("  Did it silently inject live products into RP export?", products.length > 0);
  }

  console.log("\nFlaw verification completed.");
}

verifyFlaws().then(() => prisma.$disconnect());
