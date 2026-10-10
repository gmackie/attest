import React from "react";
import { createRoot } from "react-dom/client";
import { Toasty } from "@cloudflare/kumo";
import "./styles.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Toasty>
      <App />
    </Toasty>
  </React.StrictMode>
);
