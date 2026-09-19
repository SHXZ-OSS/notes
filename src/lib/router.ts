import { writable } from "svelte/store";

export interface Route {
  path: string;
  query: URLSearchParams;
}

function read(): Route {
  return {
    path: window.location.pathname,
    query: new URLSearchParams(window.location.search),
  };
}

export const route = writable(read());

window.addEventListener("popstate", () => route.set(read()));

export function navigate(to: string, replace = false): void {
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  route.set(read());
}
