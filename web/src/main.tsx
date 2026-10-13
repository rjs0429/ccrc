import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App.tsx";
import { loadMe, toast } from "./state.ts";

createRoot(document.getElementById("root")!).render(<App />);
loadMe().catch(() => toast("서버에 연결할 수 없습니다"));
