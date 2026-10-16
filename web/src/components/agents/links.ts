import { createContext } from "react";

// A subagent's transcript to open: by its id when known, else by the Agent call that started it.
export interface TranscriptRef {
  agentId?: string;
  toolUseId?: string;
  title: string;
}

// Opens the transcript of the subagent an Agent card stands for; where it is absent, Agent cards offer none.
export const AgentLinks = createContext<((ref: TranscriptRef) => void) | null>(null);
