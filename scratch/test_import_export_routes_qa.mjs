/**
 * QA: Import & Export Hub — route-level end-to-end verification.
 *
 * Drives the real `app/routes/app.export.jsx` loader and the real
 * `app/routes/app.import-export.jsx` action, with a stubbed Shopify
 * authentication layer, over genuine multipart/form-data requests — the same
 * shape the browser sends.
 *
 * Run with Node 22:
 *   ~/.nvm/versions/node/v22.23.2/bin/node --import ./scratch/_qa_route_register.mjs \
 *     scratch/test_import_export_routes_qa.mjs
 */
import prisma from "../app/db.server.js";
import { setMockShop, getMockAdmin } from "./_qa_mock_admin.mjs";
import { loader as exportLoader } from "../app/routes/app.export.jsx";
import { action as importAction } from "../app/routes/app.import-export.jsx";
import { loader as hubLoader } from "../app/routes/app.import-export.jsx";

const SHOP = "qa-impexp-route.myshopify.com";
setMockShop(SHOP);

let pass = 0;
let fail = 0;
const failures = [];
function check(label, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function exportOf(type, rpId = null) {
  const url = `http://localhost/app/export?type=${type}${rpId ? `&rpId=${rpId}` : ""}`;
  try {
    const res = await exportLoader({ request: new Request(url) });
    return { res, text: await res.text() };
  } catch (thrown) {
    if (thrown instanceof Response) return { res: thrown, text: await thrown.text(), threw: true };
    throw thrown;
  }
}

/** Submits a file exactly as the Import tab does: the File itself, multipart. */
async function importViaRoute(content, mode = "SAVE_AS_RESTORE_POINT", filename = "backup.json") {
  const fd = new FormData();
  fd.append("intent", "import");
  fd.append("importMode", mode);
  fd.append("backupFile", new File([content], filename, { type: "application/octet-stream" }));
  const request = new Request("http://localhost/app/import-export", { method: "POST", body: fd });
  return importAction({ request });
}

/** Legacy path: the text of the file in a plain form field. Must keep working. */
async function importViaTextField(content, mode = "SAVE_AS_RESTORE_POINT") {
  const fd = new FormData();
  fd.append("intent", "import");
  fd.append("importMode", mode);
  fd.append("backupFileContent", content);
  const request = new Request("http://localhost/app/import-export", { method: "POST", body: fd });
  return importAction({ request });
}

const EXPORT_TYPES = [
  ["full_json", "application/json", ".json"],
  ["products_csv", "text/csv", ".csv"],
  ["products_json", "application/json", ".json"],
  ["themes_json", "application/json", ".json"],
  ["collections_csv", "text/csv", ".csv"],
  ["collections_json", "application/json", ".json"],
  ["pages_csv", "text/csv", ".csv"],
  ["pages_json", "application/json", ".json"],
  ["blogs_csv", "text/csv", ".csv"],
  ["blogs_json", "application/json", ".json"],
  ["menus_csv", "text/csv", ".csv"],
  ["menus_json", "application/json", ".json"],
];

async function run() {
  console.log("=".repeat(78));
  console.log("  IMPORT & EXPORT HUB — ROUTE-LEVEL QA");
  console.log("=".repeat(78));

  // ── 1. Every export button produces a downloadable file ─────────────────────
  console.log("\n[1] Export loader: every offered format returns a real download");
  const exported = {};
  for (const [type, ctype, ext] of EXPORT_TYPES) {
    const { res, text } = await exportOf(type);
    exported[type] = text;
    check(`${type}: HTTP 200`, res.status === 200, `status=${res.status}`);
    check(`${type}: Content-Type ${ctype}`, (res.headers.get("Content-Type") || "").includes(ctype), res.headers.get("Content-Type"));
    check(`${type}: attachment filename ends ${ext}`,
      (res.headers.get("Content-Disposition") || "").includes(`${ext}"`), res.headers.get("Content-Disposition"));
    check(`${type}: Content-Disposition is exposed to the browser fetch()`,
      (res.headers.get("Access-Control-Expose-Headers") || "").includes("Content-Disposition"),
      res.headers.get("Access-Control-Expose-Headers"));
    check(`${type}: body is non-empty`, text.length > 20, `len=${text.length}`);
  }

  // ── 2. Every exported file imports back ─────────────────────────────────────
  console.log("\n[2] Export → Import: every exported file is importable");
  const createdIds = [];
  for (const [type] of EXPORT_TYPES) {
    const res = await importViaRoute(exported[type]);
    check(`${type}: re-imports successfully`, res.success === true, res.message);
    if (res.restorePoint?.id) createdIds.push(res.restorePoint.id);
  }

  // ── 3. Full archive round trip keeps its counts ─────────────────────────────
  console.log("\n[3] Full archive round trip preserves asset counts");
  const full = JSON.parse(exported.full_json);
  const res3 = await importViaRoute(exported.full_json);
  if (res3.restorePoint?.id) createdIds.push(res3.restorePoint.id);
  check("full archive import succeeds", res3.success, res3.message);
  if (res3.success) {
    check("products preserved", res3.summary.products === full.storeAssets.products.length, `${res3.summary.products} vs ${full.storeAssets.products.length}`);
    check("collections preserved", res3.summary.collections === full.storeAssets.collections.length);
    check("pages preserved", res3.summary.pages === full.storeAssets.pages.length);
    check("menus preserved", res3.summary.menus === full.storeAssets.menus.length);
    check("articles preserved", res3.summary.articles === (full.storeAssets.blogsAndArticles?.articles?.length || 0));
    check("themes preserved", res3.summary.themes === 1);
  }

  // ── 4. Snapshot export of an imported restore point re-imports ──────────────
  console.log("\n[4] Snapshot export of an imported archive re-imports cleanly");
  if (res3.restorePoint?.id) {
    const { res: sres, text: stext } = await exportOf("full_json", res3.restorePoint.id);
    check("snapshot export returns 200", sres.status === 200, `status=${sres.status}`);
    const res4 = await importViaRoute(stext);
    if (res4.restorePoint?.id) createdIds.push(res4.restorePoint.id);
    check("snapshot archive re-imports", res4.success, res4.message);
    if (res4.success) {
      check("second-generation counts identical",
        res4.summary.products === res3.summary.products &&
        res4.summary.collections === res3.summary.collections &&
        res4.summary.pages === res3.summary.pages &&
        res4.summary.menus === res3.summary.menus &&
        res4.summary.articles === res3.summary.articles &&
        res4.summary.themes === res3.summary.themes,
        `${JSON.stringify(res4.summary)} vs ${JSON.stringify(res3.summary)}`);
      check("re-import does not double-prefix the archive name",
        (res4.restorePoint.name.match(/\[Imported\]/g) || []).length <= 1, res4.restorePoint.name);
    }
  }

  // ── 5. Bad input over the wire ──────────────────────────────────────────────
  console.log("\n[5] Route rejects bad input with a clear message");
  const badCases = [
    ["no file field at all", null],
    ["empty file", ""],
    ["malformed JSON", '{"storeAssets":'],
    ["unknown CSV", "A,B\r\n1,2"],
    ["empty JSON object", "{}"],
  ];
  for (const [label, content] of badCases) {
    let res;
    if (content === null) {
      const fd = new FormData();
      fd.append("intent", "import");
      fd.append("importMode", "SAVE_AS_RESTORE_POINT");
      res = await importAction({ request: new Request("http://localhost/app/import-export", { method: "POST", body: fd }) });
    } else {
      res = await importViaRoute(content);
    }
    check(`${label}: rejected`, res.success === false, JSON.stringify(res));
    check(`${label}: message is user-readable`,
      typeof res.message === "string" && res.message.length > 10 && !/\[object|undefined|Cannot read/i.test(res.message),
      res.message);
  }

  // ── 6. Unknown intent ───────────────────────────────────────────────────────
  console.log("\n[6] Unknown intent handled");
  const fdU = new FormData();
  fdU.append("intent", "bogus");
  const resU = await importAction({ request: new Request("http://localhost/app/import-export", { method: "POST", body: fdU }) });
  check("unknown intent returns a failure, not a crash", resU.success === false, JSON.stringify(resU));

  // ── 7. Live restore through the route records a rollback job ────────────────
  console.log("\n[7] RESTORE_NOW through the route");
  const resL = await importViaRoute(exported.full_json, "RESTORE_NOW");
  if (resL.restorePoint?.id) createdIds.push(resL.restorePoint.id);
  check("live restore succeeds", resL.success, resL.message);
  if (resL.success) {
    const jobs = await prisma.rollbackJob.findMany({ where: { shop: SHOP }, include: { results: true } });
    check("a rollback job is recorded for the import", jobs.length >= 1, `jobs=${jobs.length}`);
    const job = jobs[jobs.length - 1];
    if (job) {
      const lr = resL.summary.liveResults || {};
      const expectedTotal = (lr.collections || 0) + (lr.pages || 0) + (lr.menus || 0) + (lr.articles || 0) +
        (lr.products || 0) + (lr.metafields || 0) + (lr.themeStagingCreated ? 1 : 0);
      check("rollback job totals match what was actually restored",
        job.totalProducts === expectedTotal && job.successCount === expectedTotal,
        `job=${job.totalProducts}/${job.successCount} expected=${expectedTotal} liveResults=${JSON.stringify(lr)}`);
      check("rollback job has a result row per restored resource type",
        job.results.length > 0, `results=${job.results.length}`);
      check("rollback history mentions products when products were synced",
        (lr.products || 0) === 0 || job.results.some((r) => /product/i.test(r.productTitle)),
        `results=${JSON.stringify(job.results.map((r) => r.productTitle))}`);
    }
  }

  // ── 7b. Both upload shapes are accepted ─────────────────────────────────────
  console.log("\n[7b] File part and text field are both accepted");
  const resFile = await importViaRoute(exported.collections_csv, "SAVE_AS_RESTORE_POINT", "backup.csv");
  check("uploaded File part imports", resFile.success, resFile.message);
  const resText = await importViaTextField(exported.collections_csv);
  check("legacy text field still imports", resText.success, resText.message);
  check("both paths produce the same summary",
    JSON.stringify({ ...resFile.summary, restorePointId: 0 }) === JSON.stringify({ ...resText.summary, restorePointId: 0 }),
    `${JSON.stringify(resFile.summary)} vs ${JSON.stringify(resText.summary)}`);
  check("import action response does not echo the whole archive back",
    resFile.restorePoint && !("snapshotData" in resFile.restorePoint) && !("themeData" in resFile.restorePoint),
    Object.keys(resFile.restorePoint || {}).join(","));

  // ── 7c. Plan-gated export refusal carries a readable reason ────────────────
  console.log("\n[7c] Plan-gated metafield export explains itself");
  const mf = await exportOf("metafields_json");
  if (mf.res.status === 200) {
    check("metafields JSON export returns a file when entitled", mf.text.length > 20);
    const resMf = await importViaRoute(mf.text);
    check("metafields JSON re-imports", resMf.success, resMf.message);
  } else {
    check("refusal uses 403", mf.res.status === 403, `status=${mf.res.status}`);
    check("refusal body is a readable sentence, not a bare code",
      /upgrade|plan/i.test(mf.text) && mf.text.length > 20, mf.text.slice(0, 120));
  }

  // ── 8. Hub loader surfaces the imported restore points ──────────────────────
  console.log("\n[8] Hub loader lists what was imported");
  const hub = await hubLoader({ request: new Request("http://localhost/app/import-export") });
  check("loader returns restore points", Array.isArray(hub.restorePoints) && hub.restorePoints.length > 0,
    `count=${hub.restorePoints?.length}`);
  const totalRp = await prisma.restorePoint.count({ where: { shop: SHOP } });
  check("loader list is not silently truncated below the real total",
    hub.restorePoints.length === totalRp,
    `loader=${hub.restorePoints.length} db=${totalRp}`);

  // ── Cleanup ─────────────────────────────────────────────────────────────────
  await prisma.rollbackResult.deleteMany({ where: { rollbackJob: { shop: SHOP } } }).catch(() => {});
  await prisma.rollbackJob.deleteMany({ where: { shop: SHOP } }).catch(() => {});
  await prisma.restorePoint.deleteMany({ where: { shop: SHOP } });
  await prisma.productSnapshot.deleteMany({ where: { shop: SHOP } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { shop: SHOP } }).catch(() => {});

  console.log("\n" + "=".repeat(78));
  console.log(`  RESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("\n  FAILURES:");
    failures.forEach((f, i) => console.log(`   ${i + 1}. ${f}`));
  }
  console.log("=".repeat(78));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(async (e) => {
  console.error("HARNESS CRASH:", e);
  await prisma.$disconnect();
  process.exit(2);
});
