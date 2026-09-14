import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData } from "react-router";
import revertlyStyles from "./styles/revertly.css?url";
import "./styles/revertly.css";

export const links = () => [
  { rel: "stylesheet", href: revertlyStyles },
];

export const loader = async () => {
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
  };
};

export default function App() {
  const { apiKey } = useLoaderData() || {};

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        {apiKey && <meta name="shopify-api-key" content={apiKey} />}
        <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
        <script src="https://cdn.shopify.com/shopifycloud/polaris.js"></script>
        <Meta />
        <Links />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              html, body, :root {
                width: 100% !important;
                max-width: 100% !important;
                min-width: 100% !important;
                margin: 0 !important;
                padding: 0 !important;
                box-sizing: border-box !important;
                --pc-page-max-inline-size: 100% !important;
                --p-page-max-width: 100% !important;
              }
              *, *:before, *:after {
                box-sizing: inherit;
              }
              s-page {
                width: 100% !important;
                max-width: 100% !important;
                min-width: 100% !important;
                margin: 0 !important;
                padding: 16px 24px 48px !important;
                box-sizing: border-box !important;
                display: block !important;
              }
              s-page::part(page), s-page::part(content), s-page::part(main) {
                max-width: 100% !important;
                width: 100% !important;
              }
            `,
          }}
        />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

