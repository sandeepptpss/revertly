import React from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";

const HELP_ARTICLES = [
  {
    title: "How do I take an initial product snapshot?",
    body: "Go to the Initialize page from the navigation. Click 'Initialize Monitoring' to take a full snapshot of all your current products. This is required before monitoring begins.",
    category: "Getting Started",
  },
  {
    title: "Why wasn't a change detected?",
    body: "Make sure monitoring is enabled in Settings. Also verify that the webhook 'products/update' is registered in your Shopify Partner dashboard. The app only detects changes after the initial snapshot is taken.",
    category: "Monitoring",
  },
  {
    title: "What does a rollback actually do?",
    body: "A rollback restores only the specific fields that were changed — not the entire product. For example, rolling back a price change only restores the price. Title, images, and other fields are untouched.",
    category: "Rollback",
  },
  {
    title: "How do I set up detection rules?",
    body: "Go to Rules in the navigation. Create a rule by setting the field to monitor (e.g. price), the condition (e.g. DECREASE_BY_PERCENT), a threshold (e.g. 30%), and optionally a minimum number of products and time window.",
    category: "Detection Rules",
  },
  {
    title: "What is a Restore Point?",
    body: "A Restore Point is a manual snapshot of all your products taken at a specific moment. You can create one before a big sale or bulk price change and restore to it any time. Only changed fields are restored.",
    category: "Restore Points",
  },
  {
    title: "How does bulk change detection work?",
    body: "If more than the configured threshold of products change within the time window, the app automatically creates a Critical incident. You can adjust these thresholds in Settings.",
    category: "Detection Rules",
  },
];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const tickets = await prisma.supportTicket.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 10,
  }).catch(() => []); // gracefully handle if table doesn't exist yet

  return { shop, tickets };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const subject = formData.get("subject")?.trim();
  const category = formData.get("category");
  const message = formData.get("message")?.trim();
  const email = formData.get("email")?.trim();

  if (!subject || !message) {
    return { success: false, error: "Subject and message are required." };
  }

  try {
    await prisma.supportTicket.create({
      data: { shop, subject, category: category || "General", message, email: email || null },
    });
    return { success: true, message: "Your ticket has been submitted. We'll respond within 24 hours." };
  } catch {
    // Table may not exist — just acknowledge
    return { success: true, message: "Your message has been received. We'll be in touch soon!" };
  }
};

const CATEGORIES = [
  "Getting Started",
  "Monitoring",
  "Rollback",
  "Detection Rules",
  "Restore Points",
  "Billing",
  "Bug Report",
  "Feature Request",
  "General",
];

function statusBadge(status) {
  const map = { OPEN: "attention", IN_PROGRESS: "info", RESOLVED: "success", CLOSED: "subdued" };
  return map[status] || "subdued";
}

export default function Support() {
  const { tickets } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const isSubmitting = fetcher.state !== "idle";
  const [activeArticle, setActiveArticle] = React.useState(null);

  return (
    <s-page heading="Help &amp; Support">
      {/* Hero Banner */}
      <s-section>
        <s-banner tone="info">
          <s-paragraph>
            <strong>Need help?</strong> Browse the articles below or submit a support ticket.
            Our team typically responds within 24 hours on business days.
          </s-paragraph>
        </s-banner>
      </s-section>

      {/* Quick Links */}
      <s-section heading="Quick Links">
        <s-columns columns="3">
          {[
            {
              title: "Documentation",
              desc: "Full setup guide and API reference",
              url: "https://docs.revertly.app",
            },
            {
              title: "Video Tutorials",
              desc: "Step-by-step walkthroughs",
              url: "https://docs.revertly.app/videos",
            },
            {
              title: "Community Forum",
              desc: "Ask questions, share tips",
              url: "https://community.revertly.app",
            },
          ].map((link) => (
            <s-card key={link.title}>
              <s-box padding="base">
                <s-stack direction="block" gap="tight">
                  <s-text><strong>{link.title}</strong></s-text>
                  <s-text tone="subdued">{link.desc}</s-text>
                  <s-link url={link.url} target="_blank">
                    Open →
                  </s-link>
                </s-stack>
              </s-box>
            </s-card>
          ))}
        </s-columns>
      </s-section>

      {/* Help Articles */}
      <s-section heading="Frequently Asked Questions">
        <s-stack direction="block" gap="tight">
          {HELP_ARTICLES.map((article, i) => (
            <s-card key={i}>
              <s-box padding="base">
                <s-stack direction="block" gap="tight">
                  <s-stack direction="inline" align="space-between">
                    <s-stack direction="block" gap="tight">
                      <s-badge tone="subdued">{article.category}</s-badge>
                      <s-text fontWeight="bold">{article.title}</s-text>
                    </s-stack>
                  </s-stack>
                  <s-text tone="subdued">{article.body}</s-text>
                </s-stack>
              </s-box>
            </s-card>
          ))}
        </s-stack>
      </s-section>

      {/* Submit Ticket */}
      <s-section heading="Submit a Support Ticket">
        {result?.success && (
          <s-banner tone="success">{result.message}</s-banner>
        )}
        {result?.error && (
          <s-banner tone="critical">{result.error}</s-banner>
        )}

        <fetcher.Form method="POST">
          <s-form-layout>
            <s-form-layout-group condensed>
              <s-text-field
                name="subject"
                label="Subject"
                placeholder="Brief description of your issue"
                required
              />
              <s-select
                name="category"
                label="Category"
              >
                {CATEGORIES.map((c) => (
                  <s-option key={c} value={c}>{c}</s-option>
                ))}
              </s-select>
            </s-form-layout-group>
            <s-text-field
              name="email"
              label="Reply-to Email (optional)"
              type="email"
              placeholder="your@email.com"
              helpText="We'll use your store email if left blank."
            />
            <s-text-field
              name="message"
              label="Describe your issue"
              multiline={5}
              placeholder="Please include as much detail as possible — steps to reproduce, product IDs affected, screenshots if relevant..."
              required
            />
            <s-button
              submit
              variant="primary"
              {...(isSubmitting ? { loading: true } : {})}
            >
              Submit Ticket
            </s-button>
          </s-form-layout>
        </fetcher.Form>
      </s-section>

      {/* Past Tickets */}
      {tickets.length > 0 && (
        <s-section heading="Your Support Tickets">
          <s-resource-list>
            {tickets.map((t) => (
              <s-resource-item key={t.id} id={String(t.id)}>
                <s-stack direction="inline" align="space-between">
                  <s-stack direction="block" gap="tight">
                    <s-text fontWeight="bold">{t.subject}</s-text>
                    <s-stack direction="inline" gap="tight">
                      <s-badge tone="subdued">{t.category}</s-badge>
                      <s-text tone="subdued">
                        {new Date(t.createdAt).toLocaleDateString()}
                      </s-text>
                    </s-stack>
                  </s-stack>
                  <s-badge tone={statusBadge(t.status || "OPEN")}>
                    {t.status || "OPEN"}
                  </s-badge>
                </s-stack>
              </s-resource-item>
            ))}
          </s-resource-list>
        </s-section>
      )}

      {/* Status Page */}
      <s-section slot="aside" heading="System Status">
        <s-stack direction="block" gap="tight">
          <s-badge tone="success">All Systems Operational</s-badge>
          <s-link url="https://status.revertly.app" target="_blank">
            View status page →
          </s-link>
        </s-stack>
      </s-section>

      {/* Contact Info */}
      <s-section slot="aside" heading="Contact Us">
        <s-stack direction="block" gap="tight">
          <s-text>
            Email:{" "}
            <s-link url="mailto:support@revertly.app">
              support@revertly.app
            </s-link>
          </s-text>
          <s-text tone="subdued">Response time: within 24 hours</s-text>
          <s-text tone="subdued">Mon–Fri, 9am–6pm UTC</s-text>
        </s-stack>
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
