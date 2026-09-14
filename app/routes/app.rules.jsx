import { useState } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const rules = await prisma.detectionRule.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
  });

  return { rules };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "create") {
    await prisma.detectionRule.create({
      data: {
        shop,
        name: formData.get("name"),
        field: formData.get("field"),
        condition: formData.get("condition"),
        threshold: formData.get("threshold") ? parseFloat(formData.get("threshold")) : null,
        minProducts: formData.get("minProducts") ? parseInt(formData.get("minProducts")) : null,
        windowMinutes: formData.get("windowMinutes") ? parseInt(formData.get("windowMinutes")) : 10,
        severity: formData.get("severity") || "HIGH",
        isActive: true,
      },
    });
    return { success: true, message: "Rule created." };
  }

  if (intent === "toggle") {
    const ruleId = parseInt(formData.get("ruleId"));
    const rule = await prisma.detectionRule.findUnique({ where: { id: ruleId } });
    if (rule && rule.shop === shop) {
      await prisma.detectionRule.update({
        where: { id: ruleId },
        data: { isActive: !rule.isActive },
      });
      return { success: true, message: `Rule "${rule.name}" is now ${!rule.isActive ? "Active" : "Inactive"}.` };
    }
    return { success: true, message: "Rule status updated." };
  }

  if (intent === "delete") {
    const ruleId = parseInt(formData.get("ruleId"));
    const rule = await prisma.detectionRule.findUnique({ where: { id: ruleId } });
    if (rule && rule.shop === shop) {
      await prisma.detectionRule.delete({ where: { id: ruleId } });
    }
    return { success: true, message: "Rule deleted." };
  }

  return { success: false, message: "Action failed." };
};

const FIELDS = ["price", "compareAtPrice", "title", "status", "vendor", "tags", "sku", "inventory"];
const CONDITIONS = ["CHANGED", "DECREASE_BY_PERCENT", "INCREASE_BY_PERCENT"];
const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

export default function Rules() {
  const { rules } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const isSaving = fetcher.state !== "idle";
  const [showCreateForm, setShowCreateForm] = useState(false);

  return (
    <s-page heading="Detection Rules" inlineSize="large">
      {result?.message && (
        <s-section>
          <s-banner tone={result.success ? "success" : "critical"}>
            {result.message}
          </s-banner>
        </s-section>
      )}

      {/* Create Rule Header / Form */}
      <s-section>
        {!showCreateForm ? (
          <s-stack direction="inline" align="space-between" align-items="center">
            <s-text tone="subdued">
              Define automated rules to alert and prevent malicious or accidental catalog changes.
            </s-text>
            <s-button variant="primary" onClick={() => setShowCreateForm(true)}>
              + Create New Rule
            </s-button>
          </s-stack>
        ) : (
          <s-card>
            <s-box padding="base">
              <s-stack direction="block" gap="base">
                <s-stack direction="inline" align="space-between" align-items="center">
                  <s-text fontWeight="bold" variant="headingMd">Create New Detection Rule</s-text>
                  <s-button variant="tertiary" onClick={() => setShowCreateForm(false)}>
                    Close
                  </s-button>
                </s-stack>
                <fetcher.Form method="POST" onSubmit={() => setShowCreateForm(false)}>
                  <input type="hidden" name="intent" value="create" />
                  <s-form-layout>
                    <s-form-layout-group>
                      <s-text-field
                        name="name"
                        label="Rule Name"
                        placeholder="e.g. Critical Price Drop (>30%)"
                        required
                      />
                    </s-form-layout-group>
                    <s-form-layout-group condensed>
                      <s-select name="field" label="Monitor Field">
                        {FIELDS.map((f) => (
                          <s-option key={f} value={f}>{f}</s-option>
                        ))}
                      </s-select>
                      <s-select name="condition" label="Condition">
                        {CONDITIONS.map((c) => (
                          <s-option key={c} value={c}>{c.replace(/_/g, " ")}</s-option>
                        ))}
                      </s-select>
                      <s-select name="severity" label="Severity">
                        {SEVERITIES.map((s) => (
                          <s-option key={s} value={s}>{s}</s-option>
                        ))}
                      </s-select>
                    </s-form-layout-group>
                    <s-form-layout-group condensed>
                      <s-text-field
                        name="threshold"
                        label="Threshold (%)"
                        type="number"
                        placeholder="30"
                        helpText="For percent-based conditions"
                      />
                      <s-text-field
                        name="minProducts"
                        label="Min Products"
                        type="number"
                        placeholder="20"
                        helpText="Trigger when N+ products affected"
                      />
                      <s-text-field
                        name="windowMinutes"
                        label="Time Window (min)"
                        type="number"
                        placeholder="10"
                        helpText="Within time window"
                      />
                    </s-form-layout-group>
                    <s-stack direction="inline" gap="tight">
                      <s-button submit variant="primary" {...(isSaving ? { loading: true } : {})}>
                        Save Rule
                      </s-button>
                      <s-button variant="secondary" onClick={() => setShowCreateForm(false)}>
                        Cancel
                      </s-button>
                    </s-stack>
                  </s-form-layout>
                </fetcher.Form>
              </s-stack>
            </s-box>
          </s-card>
        )}
      </s-section>

      {/* Rules List */}
      <s-section heading={`${rules.length} detection rule${rules.length !== 1 ? "s" : ""}`}>
        {rules.length === 0 ? (
          <s-empty-state heading="No rules yet">
            <s-paragraph>
              Create detection rules to automatically identify suspicious product changes.
            </s-paragraph>
          </s-empty-state>
        ) : (
          <s-resource-list>
            {rules.map((rule) => (
              <s-resource-item key={rule.id} id={String(rule.id)}>
                <s-stack direction="block" gap="tight">
                  <s-stack direction="inline" align="space-between">
                    <s-stack direction="block" gap="tight">
                      <s-text fontWeight="bold" variant="bodyMd">{rule.name}</s-text>
                      <s-stack direction="inline" gap="tight" blockAlign="center" wrap>
                        <s-badge tone="info">{rule.field}</s-badge>
                        <s-badge tone="attention">{rule.condition.replace(/_/g, " ")}{rule.threshold ? ` (${rule.threshold}%)` : ""}</s-badge>
                        {rule.minProducts ? <s-badge tone="subdued">{rule.minProducts}+ products</s-badge> : null}
                        {rule.windowMinutes ? <s-badge tone="subdued">within {rule.windowMinutes}m</s-badge> : null}
                      </s-stack>
                    </s-stack>
                    <s-stack direction="inline" gap="tight">
                      <s-badge
                        tone={
                          {
                            CRITICAL: "critical",
                            HIGH: "warning",
                            MEDIUM: "attention",
                            LOW: "success",
                          }[rule.severity]
                        }
                      >
                        {rule.severity}
                      </s-badge>
                      <s-badge tone={rule.isActive ? "success" : "subdued"}>
                        {rule.isActive ? "Active" : "Inactive"}
                      </s-badge>
                    </s-stack>
                  </s-stack>
                  <s-stack direction="inline" gap="tight">
                    <fetcher.Form method="POST">
                      <input type="hidden" name="intent" value="toggle" />
                      <input type="hidden" name="ruleId" value={rule.id} />
                      <s-button submit variant="secondary">
                        {rule.isActive ? "Disable" : "Enable"}
                      </s-button>
                    </fetcher.Form>
                    <fetcher.Form method="POST">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="ruleId" value={rule.id} />
                      <s-button submit tone="critical" variant="tertiary">
                        Delete
                      </s-button>
                    </fetcher.Form>
                  </s-stack>
                </s-stack>
              </s-resource-item>
            ))}
          </s-resource-list>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
