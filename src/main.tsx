import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Desktop keeps the dark globe launch; a phone opening TIPHYS for the first time
// starts in the light-blue mobile system.
if (!localStorage.getItem("tiphys-theme")) {
  const mobile = window.matchMedia("(max-width: 860px)").matches;
  localStorage.setItem("tiphys-theme", mobile ? "light" : "dark");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
