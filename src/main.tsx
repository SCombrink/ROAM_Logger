import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Bundled so the app looks the same on machines without Source Sans installed
import "@fontsource/source-sans-3/400.css";
import "@fontsource/source-sans-3/600.css";
import "@fontsource/source-sans-3/700.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <>
    <App />
  </>
);
