import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/highlight.css";

document.documentElement.dataset.theme = window.desktop.boot.theme.resolved;
createRoot(document.getElementById("root")!).render(<App />);
