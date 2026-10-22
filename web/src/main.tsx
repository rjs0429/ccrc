import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App.tsx";
import { startLang } from "./i18n/device.ts";
import { onLang } from "./i18n/index.ts";
import { registerServiceWorker, syncPushLang } from "./push.ts";
import { getState, loadMe } from "./state.ts";
import { trackViewport } from "./viewport.ts";

trackViewport();
startLang();
onLang(() => void (getState().me?.loggedIn && syncPushLang().catch(() => {})));
createRoot(document.getElementById("root")!).render(<App />);
void loadMe();
registerServiceWorker();
