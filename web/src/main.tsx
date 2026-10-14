import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App.tsx";
import { registerServiceWorker } from "./push.ts";
import { loadMe, toast } from "./state.ts";
import { trackViewport } from "./viewport.ts";

trackViewport();
createRoot(document.getElementById("root")!).render(<App />);
loadMe().catch(() => toast("서버에 연결할 수 없습니다"));
registerServiceWorker();
