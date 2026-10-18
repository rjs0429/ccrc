import { createContext } from "react";

// Items drawn from the phone's copy, which keeps no tool input or output: what needs the laptop says so instead.
export const OfflineView = createContext(false);

export const NOT_KEPT = "휴대폰에는 저장하지 않았습니다. 노트북에 연결되면 볼 수 있습니다.";
export const LAPTOP_ONLY = "노트북에 연결되면 열 수 있습니다";
