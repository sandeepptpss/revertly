import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { getOrCreateSettings } from "../monitor.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await getOrCreateSettings(shop);
  return { settings };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "testSlack") {
    const slackUrl = formData.get("slackWebhookUrl");
    if (!slackUrl) {
      return { success: false, message: "Please provide a Slack Webhook URL first." };
    }
    try {
      const resp = await fetch(slackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "*[Revertly Test Notification]*",
          attachments: [
            {
              color: "#008060",
              title: "Slack Alerts Connected Successfully!",
              text: `Revertly is active for ${shop}. Critical price drops and anomaly incidents will be delivered to this channel in real time.`,
              footer: "Revertly Product Guard",
              ts: Math.floor(Date.now() / 1000),
            },
          ],
        }),
      });
      if (resp.ok) {
        return { success: true, message: "Test Slack alert delivered successfully!" };
      } else {
        return { success: false, message: `Slack webhook responded with status ${resp.status}` };
      }
    } catch (err) {
      return { success: false, message: `Failed to deliver Slack alert: ${err.message}` };
    }
  }

  await prisma.appSettings.update({
    where: { shop },
    data: {
      alertEmail: formData.get("alertEmail") || null,
      alertOnCritical: formData.get("alertOnCritical") === "true",
      alertOnHigh: formData.get("alertOnHigh") === "true",
      alertOnMedium: formData.get("alertOnMedium") === "true",
      monitoringEnabled: formData.get("monitoringEnabled") === "true",
      bulkThreshold: parseInt(formData.get("bulkThreshold") || "20"),
      bulkWindowMinutes: parseInt(formData.get("bulkWindowMinutes") || "10"),
      slackWebhookUrl: formData.get("slackWebhookUrl") || null,
      circuitBreakerEnabled: formData.get("circuitBreakerEnabled") === "true",
      circuitBreakerThreshold: parseInt(formData.get("circuitBreakerThreshold") || "50"),
      circuitBreakerAction: formData.get("circuitBreakerAction") || "DRAFT",
    },
  });

  return { success: true, message: "Settings saved successfully." };
};

export default function Settings() {
  const { settings } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;

  return (
    <s-page heading="Settings">
      {result?.message && (
        <s-section>
          <s-banner tone={result.success ? "success" : "critical"}>
            {result.message}
          </s-banner>
        </s-section>
      )}

      <fetcher.Form method="POST">
        <input type="hidden" name="intent" value="save" />

        {/* Monitoring */}
        <s-section heading="Monitoring">
          <s-form-layout>
            <s-checkbox
              name="monitoringEnabled"
              value="true"
              label="Enable product change monitoring"
              defaultChecked={settings.monitoringEnabled}
            />
          </s-form-layout>
        </s-section>

        {/* Emergency Circuit Breaker */}
        <s-section heading="Emergency Circuit Breaker (Price Crash Guard)">
          <s-paragraph>
            Protect your store from catastrophic revenue loss. Automatically pause selling or revert prices if an app, staff, or CSV causes a sudden crash.
          </s-paragraph>
          <s-form-layout>
            <s-checkbox
              name="circuitBreakerEnabled"
              value="true"
              label="Enable Emergency Circuit Breaker"
              defaultChecked={settings.circuitBreakerEnabled}
            />
            <s-form-layout-group condensed>
              <s-text-field
                name="circuitBreakerThreshold"
                label="Crash Trigger Threshold (%)"
                type="number"
                defaultValue={String(settings.circuitBreakerThreshold || 50)}
                helpText="Trigger when variant price drops by this percentage or more"
              />
              <s-select
                name="circuitBreakerAction"
                label="Emergency Protective Action"
                value={settings.circuitBreakerAction || "DRAFT"}
              >
                <s-option value="DRAFT">Set Product to DRAFT (Hide instantly)</s-option>
                <s-option value="AUTO_REVERT">Auto-Revert Price (Restore previous price)</s-option>
              </s-select>
            </s-form-layout-group>
          </s-form-layout>
        </s-section>

        {/* Bulk Detection */}
        <s-section heading="Bulk Change Detection">
          <s-paragraph>
            Create an incident when too many products change in a short period.
          </s-paragraph>
          <s-form-layout>
            <s-form-layout-group condensed>
              <s-text-field
                name="bulkThreshold"
                label="Products Threshold"
                type="number"
                defaultValue={String(settings.bulkThreshold)}
                helpText="Trigger incident if this many products change"
              />
              <s-text-field
                name="bulkWindowMinutes"
                label="Time Window (minutes)"
                type="number"
                defaultValue={String(settings.bulkWindowMinutes)}
                helpText="Within this time window"
              />
            </s-form-layout-group>
          </s-form-layout>
        </s-section>

        {/* Alerts */}
        <s-section heading="Alert Settings (Email & Slack)">
          <s-form-layout>
            <s-text-field
              name="alertEmail"
              label="Alert Email"
              type="email"
              defaultValue={settings.alertEmail || ""}
              placeholder="merchant@example.com"
              helpText="Receive email alerts when incidents are created"
            />
            <s-stack direction="inline" gap="tight" blockAlign="end">
              <div style={{ flex: 1 }}>
                <s-text-field
                  name="slackWebhookUrl"
                  label="Slack Incoming Webhook URL"
                  type="url"
                  defaultValue={settings.slackWebhookUrl || ""}
                  placeholder="https://hooks.slack.com/services/..."
                  helpText="Receive real-time instant alerts directly in your Slack channel"
                />
              </div>
              <s-button
                type="button"
                onClick={() => {
                  const input = document.querySelector('input[name="slackWebhookUrl"]');
                  fetcher.submit(
                    { intent: "testSlack", slackWebhookUrl: input?.value || "" },
                    { method: "POST" }
                  );
                }}
              >
                Test Slack
              </s-button>
            </s-stack>
            <s-checkbox
              name="alertOnCritical"
              value="true"
              label="Alert on Critical incidents"
              defaultChecked={settings.alertOnCritical}
            />
            <s-checkbox
              name="alertOnHigh"
              value="true"
              label="Alert on High severity incidents"
              defaultChecked={settings.alertOnHigh}
            />
            <s-checkbox
              name="alertOnMedium"
              value="true"
              label="Alert on Medium severity incidents"
              defaultChecked={settings.alertOnMedium}
            />
          </s-form-layout>
        </s-section>

        <s-section>
          <s-stack direction="inline" gap="300">
            <s-button submit variant="primary">
              Save Settings
            </s-button>
          </s-stack>
        </s-section>
      </fetcher.Form>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
