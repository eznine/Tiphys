import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initNativeShell } from "./lib/nativeShell";
// Desktop keeps the dark globe launch; a phone opening TIPHYS for the first time
// starts in the light-blue mobile system.
if (!localStorage.getItem("tiphys-theme")) {
  const mobile = window.matchMedia("(max-width: 860px)").matches;
  localStorage.setItem("tiphys-theme", mobile ? "light" : "dark");
}

const bootTheme = (() => {
  const saved = localStorage.getItem("tiphys-theme");
  if (saved === "dark" || saved === "light") return saved;
  if (saved === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return window.matchMedia("(max-width: 860px)").matches ? "light" : "dark";
})() as "light" | "dark";

void initNativeShell(bootTheme);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
