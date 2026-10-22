import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// M0 demo: prefer dark globe launch if unset
if (!localStorage.getItem("tiphys-theme")) localStorage.setItem("tiphys-theme", "dark");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
