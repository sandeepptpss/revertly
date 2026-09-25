/* global globalThis */
// Test double for the react-router hooks a route component calls, so a route's
// default export can be rendered with renderToStaticMarkup. Everything that is
// not a hook (redirect, data, …) is the real implementation.
import { createElement } from "react";
export * from "react-router";

export function useLoaderData() {
  return globalThis.__qaLoaderData;
}
export function useActionData() {
  return undefined;
}
export function useRouteError() {
  return null;
}
export function useSearchParams() {
  return [new URLSearchParams(globalThis.__qaSearchParams || ""), (val) => val];
}

// Fetchers are handed out in the order the component asks for them, from
// globalThis.__qaFetchers; call __qaResetFetchers() before each render.
let fetcherIndex = 0;
export function __qaResetFetchers() {
  fetcherIndex = 0;
}
export function useFetcher() {
  const override = globalThis.__qaFetchers?.[fetcherIndex++] || {};
  return {
    state: "idle",
    data: undefined,
    formData: undefined,
    submit() {},
    Form: (props) => createElement("form", props),
    ...override,
  };
}
