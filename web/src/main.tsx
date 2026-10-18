import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App.tsx";
import { registerServiceWorker } from "./push.ts";
import { loadMe } from "./state.ts";
import { trackViewport } from "./viewport.ts";

trackViewport();
createRoot(document.getElementById("root")!).render(<App />);
void loadMe();
registerServiceWorker();
