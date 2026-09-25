/**
 * Email Marketing (ESP) Backup for Revertly — Klaviyo & Mailchimp.
 *
 * Architecture, mirroring cloudSync.server.js:
 *  - Credentials live in AppSettings (klaviyoApiKey / mailchimpApiKey). Both
 *    providers issue long-lived private API keys, so there is no OAuth dance
 *    and no refresh cycle to manage.
 *  - A capture pulls lists/audiences, segments, subscriber profiles and (on
 *    Business and above) flows/journeys into MarketingList / MarketingProfile
 *    / MarketingFlow, upserting by remote id so a re-run updates in place.
 *  - A restore pushes a captured list, or its subscribers, back to the ESP.
 *
 * The plan gate lives here rather than in the route, for the same reason it
 * does for cloud sync: capture is reachable from the Marketing page, the
 * scheduler and a hand-crafted POST, and all three must be guarded.
 */
import prisma from "./db.server.js";
import { checkMarketingBackupAccess } from "./billing.server.js";
import { encrypt, decrypt } from "./crypto.server.js";
import {
  MARKETING_PROVIDERS,
  MARKETING_UPGRADE_MESSAGE,
  MARKETING_FLOWS_UPGRADE_MESSAGE,
  SIMULATED_KEY_PREFIX,
  getMarketingProvider,
} from "./marketing.constants.js";

const KLAVIYO_API = "https://a.klaviyo.com/api";
// Klaviyo requires an explicit API revision on every request; without it the
// API answers with whatever is current and the response shape can shift.
const KLAVIYO_REVISION = "2024-10-15";

export {
  MARKETING_PROVIDERS,
  MARKETING_UPGRADE_MESSAGE,
  MARKETING_FLOWS_UPGRADE_MESSAGE,
  SIMULATED_KEY_PREFIX,
  getMarketingProvider,
};

/** Plan entitlement: whether ESP backup is available, its cap, and flows. */
export async function checkMarketingAccess(shop) {
  return checkMarketingBackupAccess(shop);
}

/**
 * Simulation mode. The app already models a store whose billing never touched
 * Shopify (`sim_` subscriptions); an ESP connection needs the same, so that
 * the whole capture → browse → restore path can be exercised without a live
 * Klaviyo or Mailchimp account. A key beginning `sim_` is served by the
 * generator below instead of the network, and the UI labels it as simulated.
 */
export function isSimulatedKey(apiKey) {
  return Boolean(apiKey && String(apiKey).startsWith(SIMULATED_KEY_PREFIX));
}

/** Mailchimp encodes its datacenter in the key suffix; that is the API host. */
export function parseMailchimpServerPrefix(apiKey) {
  const match = String(apiKey || "").match(/-([a-z]{2}\d+)$/i);
  return match ? match[1].toLowerCase() : null;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function klaviyoRequest(apiKey, path, { method = "GET", body } = {}) {
  const res = await fetch(`${KLAVIYO_API}${path}`, {
    method,
    headers: {
      Authorization: `Klaviyo-API-Key ${apiKey}`,
      revision: KLAVIYO_REVISION,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Klaviyo ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  // A 204 carries no body; callers treat that as success with nothing to read.
  return res.status === 204 ? null : res.json();
}

async function mailchimpRequest(apiKey, serverPrefix, path, { method = "GET", body } = {}) {
  const dc = serverPrefix || parseMailchimpServerPrefix(apiKey);
  if (!dc) {
    throw new Error(
      "That Mailchimp API key has no datacenter suffix. Copy the whole key, including the trailing -us1, -us2 and so on.",
    );
  }

  const res = await fetch(`https://${dc}.api.mailchimp.com/3.0${path}`, {
    method,
    headers: {
      // Mailchimp accepts HTTP Basic with any username and the key as password.
      Authorization: `Basic ${Buffer.from(`anystring:${apiKey}`).toString("base64")}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Mailchimp ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

// ── Connection ──────────────────────────────────────────────────────────────

/**
 * Verifies a key and returns the account name to show in the UI. Done before
 * anything is stored, so a typo is reported at the point of entry rather than
 * surfacing later as an empty backup.
 */
export async function verifyMarketingConnection(providerId, apiKey) {
  const provider = getMarketingProvider(providerId);
  if (!provider) return { ok: false, error: "Unknown provider." };
  if (!apiKey) return { ok: false, error: "Enter an API key." };

  if (isSimulatedKey(apiKey)) {
    return {
      ok: true,
      simulated: true,
      accountName: `${provider.label} Simulator`,
      serverPrefix: provider.id === "MAILCHIMP" ? "sim" : null,
    };
  }

  try {
    if (provider.id === "KLAVIYO") {
      const json = await klaviyoRequest(apiKey, "/accounts/");
      const account = json?.data?.[0];
      const orgName = account?.attributes?.contact_information?.organization_name;
      return {
        ok: true,
        accountName: orgName || account?.id || "Klaviyo account",
        serverPrefix: null,
      };
    }

    const serverPrefix = parseMailchimpServerPrefix(apiKey);
    const json = await mailchimpRequest(apiKey, serverPrefix, "/");
    return {
      ok: true,
      accountName: json?.account_name || "Mailchimp account",
      serverPrefix,
    };
  } catch (err) {
    return { ok: false, error: err?.message || "Could not reach the provider." };
  }
}

/** Stores a verified connection. Returns the saved account name. */
export async function saveMarketingConnection(shop, providerId, apiKey) {
  const provider = getMarketingProvider(providerId);
  if (!provider) return { success: false, message: "Unknown provider." };

  const access = await checkMarketingAccess(shop);
  if (!access.allowed) return { success: false, message: MARKETING_UPGRADE_MESSAGE };

  const verified = await verifyMarketingConnection(provider.id, apiKey);
  if (!verified.ok) {
    return { success: false, message: `Could not connect to ${provider.label}: ${verified.error}` };
  }

  const data =
    provider.id === "KLAVIYO"
      ? { klaviyoConnected: true, klaviyoApiKey: encrypt(apiKey), klaviyoAccountName: verified.accountName }
      : {
          mailchimpConnected: true,
          mailchimpApiKey: encrypt(apiKey),
          mailchimpServerPrefix: verified.serverPrefix,
          mailchimpAccountName: verified.accountName,
        };

  await prisma.appSettings.upsert({
    where: { shop },
    create: { shop, ...data },
    update: data,
  });

  return {
    success: true,
    simulated: Boolean(verified.simulated),
    accountName: verified.accountName,
    message: `${provider.label} connected${verified.simulated ? " in simulation mode" : ""} as ${verified.accountName}.`,
  };
}

/**
 * Forgets a connection. Captured backups are deliberately kept: disconnecting
 * an ESP is how a merchant rotates a key, and it must not destroy the archive
 * that is the whole point of the feature.
 */
export async function disconnectMarketingProvider(shop, providerId) {
  const provider = getMarketingProvider(providerId);
  if (!provider) return { success: false, message: "Unknown provider." };

  const data =
    provider.id === "KLAVIYO"
      ? { klaviyoConnected: false, klaviyoApiKey: null, klaviyoAccountName: null }
      : {
          mailchimpConnected: false,
          mailchimpApiKey: null,
          mailchimpServerPrefix: null,
          mailchimpAccountName: null,
        };

  await prisma.appSettings.update({ where: { shop }, data }).catch(() => {});
  return {
    success: true,
    message: `${provider.label} disconnected. Backups already captured are kept and stay browsable.`,
  };
}

// ── Simulation fixtures ─────────────────────────────────────────────────────

/**
 * Deterministic fake ESP data, so a simulated connection behaves like a real
 * one: stable ids across runs (an upsert must update, not duplicate) and
 * enough profiles to exercise the plan cap.
 */
function simulatedPayload(providerId, profileTarget) {
  const p = providerId === "KLAVIYO" ? "kl" : "mc";
  const lists = [
    { id: `${p}_list_newsletter`, name: "Newsletter", listType: "LIST", memberCount: 4820 },
    { id: `${p}_list_vip`, name: "VIP Customers", listType: "LIST", memberCount: 612 },
    { id: `${p}_seg_engaged_30d`, name: "Engaged (30 days)", listType: "SEGMENT", memberCount: 2140 },
    { id: `${p}_seg_lapsed`, name: "Lapsed Buyers", listType: "SEGMENT", memberCount: 903 },
  ];
  const flows = [
    { id: `${p}_flow_welcome`, name: "Welcome Series", status: "live", triggerType: "list_subscribe" },
    { id: `${p}_flow_abandoned`, name: "Abandoned Checkout", status: "live", triggerType: "metric" },
    { id: `${p}_flow_winback`, name: "Win-Back", status: "draft", triggerType: "segment_entry" },
  ];

  // Capped to keep a simulation fast; enough to prove the cap is enforced.
  const count = Math.min(profileTarget, 250);
  const statuses = ["subscribed", "subscribed", "subscribed", "unsubscribed", "cleaned"];
  const profiles = Array.from({ length: count }, (_, i) => ({
    id: `${p}_profile_${i + 1}`,
    email: `subscriber${i + 1}@example-store.test`,
    firstName: `Sim${i + 1}`,
    lastName: i % 2 ? "Taylor" : "Morgan",
    phone: i % 5 === 0 ? `+1555010${String(i).padStart(4, "0")}` : null,
    status: statuses[i % statuses.length],
    listIds: [lists[i % 2].id],
  }));

  return { lists, flows, profiles };
}

// ── Fetch: Klaviyo ──────────────────────────────────────────────────────────

async function fetchKlaviyo(apiKey, maxProfiles, includeFlows) {
  const lists = [];

  const listJson = await klaviyoRequest(apiKey, "/lists/");
  for (const node of listJson?.data || []) {
    lists.push({
      id: node.id,
      name: node.attributes?.name || "Untitled list",
      listType: "LIST",
      memberCount: 0,
      raw: node,
    });
  }

  const segJson = await klaviyoRequest(apiKey, "/segments/");
  for (const node of segJson?.data || []) {
    lists.push({
      id: node.id,
      name: node.attributes?.name || "Untitled segment",
      listType: "SEGMENT",
      memberCount: 0,
      raw: node,
    });
  }

  // Profiles are cursor-paginated; stop as soon as the plan cap is reached so
  // an over-cap account is not pulled down in full and then discarded.
  const profiles = [];
  let next = `/profiles/?page[size]=100`;
  while (next && profiles.length < maxProfiles) {
    const json = await klaviyoRequest(apiKey, next);
    for (const node of json?.data || []) {
      if (profiles.length >= maxProfiles) break;
      const a = node.attributes || {};
      profiles.push({
        id: node.id,
        email: a.email || null,
        firstName: a.first_name || null,
        lastName: a.last_name || null,
        phone: a.phone_number || null,
        status: a.subscriptions?.email?.marketing?.consent || null,
        listIds: null,
        raw: node,
      });
    }
    const nextUrl = json?.links?.next;
    next = nextUrl ? nextUrl.replace(KLAVIYO_API, "") : null;
  }

  const flows = [];
  if (includeFlows) {
    // Flows are cursor-paginated like profiles. Reading only the first page
    // silently dropped every flow after it from the backup.
    let nextFlows = "/flows/";
    let pages = 0;
    while (nextFlows && pages < 100) {
      const flowJson = await klaviyoRequest(apiKey, nextFlows);
      for (const node of flowJson?.data || []) {
        flows.push({
          id: node.id,
          name: node.attributes?.name || "Untitled flow",
          status: node.attributes?.status || null,
          triggerType: node.attributes?.trigger_type || null,
          raw: node,
        });
      }
      const nextUrl = flowJson?.links?.next;
      nextFlows = nextUrl ? nextUrl.replace(KLAVIYO_API, "") : null;
      pages += 1;
    }
  }

  return { lists, profiles, flows };
}

// ── Fetch: Mailchimp ────────────────────────────────────────────────────────

async function fetchMailchimp(apiKey, serverPrefix, maxProfiles, includeFlows) {
  const req = (path) => mailchimpRequest(apiKey, serverPrefix, path);
  const lists = [];

  const audJson = await req("/lists?count=1000");
  const audiences = audJson?.lists || [];
  for (const a of audiences) {
    lists.push({
      id: a.id,
      name: a.name || "Untitled audience",
      listType: "LIST",
      memberCount: a.stats?.member_count ?? 0,
      raw: a,
    });

    // Segments are nested under their audience in the Mailchimp API.
    const segJson = await req(`/lists/${a.id}/segments?count=1000`).catch(() => null);
    for (const s of segJson?.segments || []) {
      lists.push({
        id: `${a.id}:${s.id}`,
        name: s.name || "Untitled segment",
        listType: "SEGMENT",
        memberCount: s.member_count ?? 0,
        raw: { ...s, audienceId: a.id },
      });
    }
  }

  // Members are per-audience and offset-paginated. The cap is global across
  // audiences, so it is checked in both loops.
  const profiles = [];
  for (const a of audiences) {
    let offset = 0;
    while (profiles.length < maxProfiles) {
      const pageSize = Math.min(1000, maxProfiles - profiles.length);
      const memJson = await req(`/lists/${a.id}/members?count=${pageSize}&offset=${offset}`);
      const members = memJson?.members || [];
      if (members.length === 0) break;

      for (const m of members) {
        if (profiles.length >= maxProfiles) break;
        profiles.push({
          id: m.id,
          email: m.email_address || null,
          firstName: m.merge_fields?.FNAME || null,
          lastName: m.merge_fields?.LNAME || null,
          phone: m.merge_fields?.PHONE || null,
          status: m.status || null,
          listIds: [a.id],
          raw: m,
        });
      }
      offset += members.length;
      if (members.length < pageSize) break;
    }
    if (profiles.length >= maxProfiles) break;
  }

  const flows = [];
  if (includeFlows) {
    const journeyJson = await req("/automations?count=1000").catch(() => null);
    for (const j of journeyJson?.automations || []) {
      flows.push({
        id: j.id,
        name: j.settings?.title || j.recipients?.list_name || "Untitled journey",
        status: j.status || null,
        triggerType: j.trigger_settings?.workflow_type || null,
        raw: j,
      });
    }
  }

  return { lists, profiles, flows };
}

// ── Capture ─────────────────────────────────────────────────────────────────

/**
 * Backs up one connected provider, honouring the plan's profile cap and the
 * flows entitlement.
 *
 * `capReached` is reported separately from an error: hitting the cap is a
 * successful backup of everything the plan allows, and the UI says so rather
 * than presenting it as a failure.
 */
export async function backupMarketingProvider(shop, providerId) {
  const provider = getMarketingProvider(providerId);
  if (!provider) return { success: false, message: "Unknown provider." };

  const access = await checkMarketingAccess(shop);
  if (!access.allowed) return { success: false, message: MARKETING_UPGRADE_MESSAGE };

  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  const rawKey = provider.id === "KLAVIYO" ? settings?.klaviyoApiKey : settings?.mailchimpApiKey;
  const apiKey = decrypt(rawKey);
  const connected =
    provider.id === "KLAVIYO" ? settings?.klaviyoConnected : settings?.mailchimpConnected;

  if (!connected || !apiKey) {
    return { success: false, message: `${provider.label} is not connected yet.` };
  }

  // Infinity has no meaning to a fetch loop or a page size, so the unlimited
  // Enterprise cap becomes a large finite ceiling.
  // The allowance is per store, not per provider: a store connected to both
  // Klaviyo and Mailchimp shares one cap between them, so what the other
  // provider already holds comes off this capture's share.
  const heldElsewhere =
    access.maxProfiles === Infinity
      ? 0
      : await prisma.marketingProfile.count({ where: { shop, provider: { not: provider.id } } });
  const maxProfiles =
    access.maxProfiles === Infinity ? 1_000_000 : Math.max(0, access.maxProfiles - heldElsewhere);
  const includeFlows = access.flowsIncluded;

  let payload;
  try {
    if (isSimulatedKey(apiKey)) {
      const sim = simulatedPayload(provider.id, maxProfiles);
      payload = {
        lists: sim.lists.map((l) => ({ ...l, raw: { ...l, simulated: true } })),
        profiles: sim.profiles.map((p) => ({ ...p, raw: { ...p, simulated: true } })),
        flows: includeFlows ? sim.flows.map((f) => ({ ...f, raw: { ...f, simulated: true } })) : [],
      };
    } else if (provider.id === "KLAVIYO") {
      payload = await fetchKlaviyo(apiKey, maxProfiles, includeFlows);
    } else {
      payload = await fetchMailchimp(apiKey, settings.mailchimpServerPrefix, maxProfiles, includeFlows);
    }
  } catch (err) {
    console.error(`[Revertly Marketing] ${provider.label} capture failed:`, err?.message || err);
    return { success: false, message: `${provider.label} backup failed: ${err?.message || "unknown error"}` };
  }

  const capturedAt = new Date();

  for (const list of payload.lists) {
    await prisma.marketingList.upsert({
      where: { shop_provider_listId: { shop, provider: provider.id, listId: String(list.id) } },
      create: {
        shop,
        provider: provider.id,
        listId: String(list.id),
        name: String(list.name).slice(0, 500),
        listType: list.listType,
        memberCount: list.memberCount || 0,
        listData: list.raw ?? list,
        capturedAt,
      },
      update: {
        name: String(list.name).slice(0, 500),
        listType: list.listType,
        memberCount: list.memberCount || 0,
        listData: list.raw ?? list,
        capturedAt,
      },
    });
  }

  for (const prof of payload.profiles) {
    await prisma.marketingProfile.upsert({
      where: { shop_provider_profileId: { shop, provider: provider.id, profileId: String(prof.id) } },
      create: {
        shop,
        provider: provider.id,
        profileId: String(prof.id),
        email: prof.email,
        firstName: prof.firstName,
        lastName: prof.lastName,
        phone: prof.phone,
        status: prof.status,
        listIds: prof.listIds ?? undefined,
        profileData: prof.raw ?? prof,
        capturedAt,
      },
      update: {
        email: prof.email,
        firstName: prof.firstName,
        lastName: prof.lastName,
        phone: prof.phone,
        status: prof.status,
        listIds: prof.listIds ?? undefined,
        profileData: prof.raw ?? prof,
        capturedAt,
      },
    });
  }

  // Captures are upserts, so profiles that dropped out of the account (or
  // past the cap) would otherwise pile up across runs. Keep this provider's
  // newest captures within its share of the store's allowance.
  if (Number.isFinite(maxProfiles)) {
    const overflow = await prisma.marketingProfile.findMany({
      where: { shop, provider: provider.id },
      orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
      skip: maxProfiles,
      select: { id: true },
    });
    if (overflow.length > 0) {
      await prisma.marketingProfile.deleteMany({ where: { id: { in: overflow.map((r) => r.id) } } });
    }
  }

  for (const flow of payload.flows) {
    await prisma.marketingFlow.upsert({
      where: { shop_provider_flowId: { shop, provider: provider.id, flowId: String(flow.id) } },
      create: {
        shop,
        provider: provider.id,
        flowId: String(flow.id),
        name: String(flow.name).slice(0, 500),
        status: flow.status,
        triggerType: flow.triggerType,
        flowData: flow.raw ?? flow,
        capturedAt,
      },
      update: {
        name: String(flow.name).slice(0, 500),
        status: flow.status,
        triggerType: flow.triggerType,
        flowData: flow.raw ?? flow,
        capturedAt,
      },
    });
  }

  await prisma.appSettings
    .update({ where: { shop }, data: { lastMarketingBackupAt: capturedAt } })
    .catch(() => {});

  await prisma.auditLog
    .create({
      data: {
        shop,
        userEmail: null,
        userName: "Revertly",
        action: "MARKETING_BACKUP",
        resourceType: "MarketingBackup",
        details: {
          provider: provider.id,
          lists: payload.lists.length,
          profiles: payload.profiles.length,
          flows: payload.flows.length,
          plan: access.plan,
          profileCap: access.maxProfiles === Infinity ? "unlimited" : access.maxProfiles,
          flowsIncluded: includeFlows,
          simulated: isSimulatedKey(apiKey),
        },
      },
    })
    .catch(() => {});

  const capReached = payload.profiles.length >= maxProfiles;

  return {
    success: true,
    provider: provider.id,
    simulated: isSimulatedKey(apiKey),
    counts: {
      lists: payload.lists.filter((l) => l.listType === "LIST").length,
      segments: payload.lists.filter((l) => l.listType === "SEGMENT").length,
      profiles: payload.profiles.length,
      flows: payload.flows.length,
    },
    capReached,
    flowsIncluded: includeFlows,
    plan: access.plan,
    message: [
      `${provider.label} backup complete:`,
      `${payload.lists.length} list(s) & segment(s),`,
      `${payload.profiles.length.toLocaleString()} profile(s)`,
      includeFlows ? `and ${payload.flows.length} ${provider.flowLabel.toLowerCase()}.` : "(flows not in plan).",
      capReached
        ? `Your ${access.plan} plan caps profile backup at ${maxProfiles.toLocaleString()} — upgrade to capture more.`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/** Backs up every provider a store has connected. */
export async function backupAllMarketingProviders(shop) {
  const access = await checkMarketingAccess(shop);
  if (!access.allowed) return { success: false, message: MARKETING_UPGRADE_MESSAGE, results: [] };

  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  const targets = [
    settings?.klaviyoConnected && "KLAVIYO",
    settings?.mailchimpConnected && "MAILCHIMP",
  ].filter(Boolean);

  if (targets.length === 0) {
    return {
      success: false,
      message: "Connect Klaviyo or Mailchimp first, then run a backup.",
      results: [],
    };
  }

  const results = [];
  for (const t of targets) results.push(await backupMarketingProvider(shop, t));

  return {
    success: results.some((r) => r.success),
    results,
    message: results.map((r) => r.message).join(" "),
  };
}

// ── Restore ─────────────────────────────────────────────────────────────────

/**
 * Recreates a captured list/audience in the ESP. This is the "restore a
 * deleted list" half of the promise on the plan page.
 *
 * Mailchimp segments live inside an audience and cannot be recreated
 * standalone, so that combination is refused with an explanation rather than
 * failing opaquely at the API.
 */
export async function restoreMarketingList(shop, listRowId) {
  const access = await checkMarketingAccess(shop);
  if (!access.allowed) return { success: false, message: MARKETING_UPGRADE_MESSAGE };

  const row = await prisma.marketingList.findFirst({
    where: { id: Number(listRowId), shop },
  });
  if (!row) return { success: false, message: "That backed-up list is no longer available." };

  const provider = getMarketingProvider(row.provider);
  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  const rawKey = row.provider === "KLAVIYO" ? settings?.klaviyoApiKey : settings?.mailchimpApiKey;
  const apiKey = decrypt(rawKey);
  if (!apiKey) return { success: false, message: `${provider.label} is not connected.` };

  const saved = row.listData || {};

  try {
    if (isSimulatedKey(apiKey)) {
      // Nothing to call, but the outcome must be reported as a simulation so
      // the merchant is never told a live list was rebuilt when none was.
      return {
        success: true,
        simulated: true,
        message: `Simulated restore: "${row.name}" would be recreated in ${provider.label} with ${row.memberCount.toLocaleString()} member(s).`,
      };
    }

    if (row.provider === "KLAVIYO") {
      const created = await klaviyoRequest(apiKey, "/lists/", {
        method: "POST",
        body: { data: { type: "list", attributes: { name: row.name } } },
      });
      return {
        success: true,
        newRemoteId: created?.data?.id || null,
        message: `Recreated the list "${row.name}" in Klaviyo. Use Re-import subscribers to repopulate it.`,
      };
    }

    if (row.listType === "SEGMENT") {
      return {
        success: false,
        message:
          "A Mailchimp segment belongs to an audience and cannot be recreated on its own. Restore its audience first, then rebuild the segment from the saved definition shown below.",
      };
    }

    const created = await mailchimpRequest(apiKey, settings.mailchimpServerPrefix, "/lists", {
      method: "POST",
      body: {
        name: row.name,
        // Mailchimp rejects an audience without these, so the captured values
        // are replayed and only fall back when the backup predates them.
        contact: saved.contact || {
          company: shop,
          address1: "—",
          city: "—",
          state: "—",
          zip: "—",
          country: "US",
        },
        permission_reminder: saved.permission_reminder || "You subscribed to updates from our store.",
        campaign_defaults: saved.campaign_defaults || {
          from_name: shop,
          from_email: settings?.alertEmail || `no-reply@${shop}`,
          subject: "",
          language: "en",
        },
        email_type_option: Boolean(saved.email_type_option),
      },
    });

    return {
      success: true,
      newRemoteId: created?.id || null,
      message: `Recreated the audience "${row.name}" in Mailchimp. Use Re-import subscribers to repopulate it.`,
    };
  } catch (err) {
    console.error("[Revertly Marketing] list restore failed:", err?.message || err);
    return { success: false, message: `Restore failed: ${err?.message || "unknown error"}` };
  }
}

/**
 * Pushes captured subscribers back into a list — the "re-import lost
 * subscribers" half of the promise.
 *
 * Only profiles whose captured status was subscribed are sent: re-importing an
 * unsubscribed or cleaned contact would resubscribe someone who opted out,
 * which is both a compliance problem and not what "lost subscribers" means.
 */
export async function reimportMarketingSubscribers(shop, listRowId) {
  const access = await checkMarketingAccess(shop);
  if (!access.allowed) return { success: false, message: MARKETING_UPGRADE_MESSAGE };

  const row = await prisma.marketingList.findFirst({ where: { id: Number(listRowId), shop } });
  if (!row) return { success: false, message: "That backed-up list is no longer available." };

  const provider = getMarketingProvider(row.provider);
  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  const rawKey = row.provider === "KLAVIYO" ? settings?.klaviyoApiKey : settings?.mailchimpApiKey;
  const apiKey = decrypt(rawKey);
  if (!apiKey) return { success: false, message: `${provider.label} is not connected.` };

  // Every captured profile, not the first 500: the old `take: 500` sent the
  // same 500 people back on every run and never reached the rest. Only the
  // columns the push needs are read.
  const allCaptured = await prisma.marketingProfile.findMany({
    where: { shop, provider: row.provider, email: { not: null } },
    orderBy: { id: "asc" },
    select: { email: true, firstName: true, lastName: true, phone: true, status: true, listIds: true },
  });

  // Where the provider recorded membership (Mailchimp stores each profile's
  // audience), only this list's former members go back into it. Klaviyo
  // captures record none, so every captured subscriber is sent — the result
  // message says so rather than implying a list-exact restore.
  const memberKey = row.listType === "SEGMENT" ? String(row.listId).split(":")[0] : String(row.listId);
  const membershipKnown = allCaptured.some((p) => Array.isArray(p.listIds) && p.listIds.length > 0);
  const candidates = membershipKnown
    ? allCaptured.filter((p) => Array.isArray(p.listIds) && p.listIds.map(String).includes(memberKey))
    : allCaptured;

  const subscribed = candidates.filter((p) =>
    ["subscribed", "SUBSCRIBED", "opted_in"].includes(String(p.status || "")),
  );
  const skipped = candidates.length - subscribed.length;

  if (subscribed.length === 0) {
    return {
      success: false,
      message: `No subscribed profiles are held for ${provider.label}. ${skipped} backed-up profile(s) were unsubscribed or cleaned and are deliberately not re-imported.`,
    };
  }

  if (isSimulatedKey(apiKey)) {
    return {
      success: true,
      simulated: true,
      imported: subscribed.length,
      skipped,
      message: `Simulated re-import: ${subscribed.length.toLocaleString()} subscribed profile(s) would be pushed back into "${row.name}". ${skipped} unsubscribed/cleaned profile(s) were correctly skipped.`,
    };
  }

  let imported = 0;
  const failures = [];

  try {
    if (row.provider === "KLAVIYO") {
      // Klaviyo takes a bulk job of up to 10,000 profiles per request.
      for (let i = 0; i < subscribed.length; i += 1000) {
        const batch = subscribed.slice(i, i + 1000);
        await klaviyoRequest(apiKey, "/profile-bulk-import-jobs/", {
          method: "POST",
          body: {
            data: {
              type: "profile-bulk-import-job",
              attributes: {
                profiles: {
                  data: batch.map((p) => ({
                    type: "profile",
                    attributes: {
                      email: p.email,
                      first_name: p.firstName || undefined,
                      last_name: p.lastName || undefined,
                      phone_number: p.phone || undefined,
                    },
                  })),
                },
              },
              relationships: { lists: { data: [{ type: "list", id: row.listId }] } },
            },
          },
        });
        imported += batch.length;
      }
    } else {
      // A Mailchimp segment id is stored as "audienceId:segmentId"; members are
      // added to the audience, which is what actually holds contacts.
      const audienceId = row.listType === "SEGMENT" ? String(row.listId).split(":")[0] : row.listId;
      for (let i = 0; i < subscribed.length; i += 500) {
        const batch = subscribed.slice(i, i + 500);
        const res = await mailchimpRequest(
          apiKey,
          settings.mailchimpServerPrefix,
          `/lists/${audienceId}`,
          {
            method: "POST",
            body: {
              members: batch.map((p) => ({
                email_address: p.email,
                status: "subscribed",
                merge_fields: {
                  ...(p.firstName ? { FNAME: p.firstName } : {}),
                  ...(p.lastName ? { LNAME: p.lastName } : {}),
                },
              })),
              update_existing: true,
            },
          },
        );
        imported += res?.total_created ?? batch.length;
        for (const e of res?.errors || []) failures.push(`${e.email_address}: ${e.error}`);
      }
    }
  } catch (err) {
    console.error("[Revertly Marketing] re-import failed:", err?.message || err);
    return {
      success: false,
      message: `Re-import failed after ${imported} profile(s): ${err?.message || "unknown error"}`,
    };
  }

  await prisma.auditLog
    .create({
      data: {
        shop,
        userEmail: null,
        userName: "Merchant",
        action: "MARKETING_REIMPORT",
        resourceType: "MarketingList",
        details: { provider: row.provider, list: row.name, imported, skipped, failures: failures.length },
      },
    })
    .catch(() => {});

  return {
    success: true,
    imported,
    skipped,
    message: `Re-imported ${imported.toLocaleString()} subscriber(s) into "${row.name}". ${skipped} unsubscribed/cleaned profile(s) were skipped.${failures.length ? ` ${failures.length} address(es) were rejected by ${provider.label}.` : ""}${membershipKnown ? "" : ` ${provider.label} backups don't record which list each subscriber was on, so every captured subscriber was added to this list.`}`,
  };
}

// ── Stats ───────────────────────────────────────────────────────────────────

/** Counts for the Marketing page and the dashboard tile. */
export async function getMarketingStats(shop) {
  const [lists, segments, profiles, flows, settings] = await Promise.all([
    prisma.marketingList.count({ where: { shop, listType: "LIST" } }),
    prisma.marketingList.count({ where: { shop, listType: "SEGMENT" } }),
    prisma.marketingProfile.count({ where: { shop } }),
    prisma.marketingFlow.count({ where: { shop } }),
    prisma.appSettings.findUnique({ where: { shop } }),
  ]);

  return {
    lists,
    segments,
    profiles,
    flows,
    lastBackupAt: settings?.lastMarketingBackupAt || null,
    klaviyo: {
      connected: Boolean(settings?.klaviyoConnected),
      accountName: settings?.klaviyoAccountName || null,
      simulated: isSimulatedKey(decrypt(settings?.klaviyoApiKey)),
    },
    mailchimp: {
      connected: Boolean(settings?.mailchimpConnected),
      accountName: settings?.mailchimpAccountName || null,
      simulated: isSimulatedKey(decrypt(settings?.mailchimpApiKey)),
    },
    autoBackup: Boolean(settings?.marketingAutoBackup),
  };
}

/** CSV of backed-up subscriber profiles, for offline portability. */
export function generateMarketingProfilesCsv(profiles = []) {
  const header = ["Provider", "Profile ID", "Email", "First Name", "Last Name", "Phone", "Status", "Captured At"];
  const escape = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = profiles.map((p) =>
    [p.provider, p.profileId, p.email, p.firstName, p.lastName, p.phone, p.status, p.capturedAt?.toISOString?.() || p.capturedAt]
      .map(escape)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}
