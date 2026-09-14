import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Revertly Catalog &amp; Store Shield</h1>
        <p className={styles.text}>
          Real-time product change detection, automated price crash circuit breakers, and 1-click catalog and theme rollback for Shopify merchants.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Real-Time Catalog Watchdog</strong>. Detects unauthorized price drops, mass CSV mistakes, and app conflicts the second they happen.
          </li>
          <li>
            <strong>Emergency Circuit Breaker</strong>. Automatically puts crashed products into draft or restores previous prices to prevent catastrophic revenue loss.
          </li>
          <li>
            <strong>1-Click Theme &amp; Catalog Restore</strong>. Take multi-resource snapshots of products, theme Liquid code, and smart collections with instant rollback.
          </li>
        </ul>
      </div>
    </div>
  );
}
