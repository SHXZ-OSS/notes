import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";

(window as unknown as { __errs: string[] }).__errs = [];
window.addEventListener("error", (e) => {
  (window as unknown as { __errs: string[] }).__errs.push(
    String(e.error ?? e.message),
  );
});
window.addEventListener("unhandledrejection", (e) => {
  (window as unknown as { __errs: string[] }).__errs.push(
    `rejection: ${String(e.reason)}`,
  );
});

const target = document.getElementById("app")!;
mount(App, { target });
