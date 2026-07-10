import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "highlight.js/styles/github.css";
import "./theme.css";

createRoot(document.getElementById("root")!).render(<App />);
console.log("[boot] renderer mounted ok");
