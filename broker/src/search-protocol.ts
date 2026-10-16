// Shapes of the session search endpoint, shared by the broker and the web client.

export const SEARCH_QUERY_MAX = 200;
export const SEARCH_LIMIT_MAX = 50;

// [start, end) offsets of a match in the text it belongs to.
export type Mark = [number, number];

export interface SearchSnippet {
  // The conversation item the text belongs to, as the chat view keys it.
  itemId: string;
  role: "user" | "assistant";
  at?: number;
  text: string;
  marks: Mark[];
  // Whether text was left out before or after the snippet.
  cutStart: boolean;
  cutEnd: boolean;
  // Said before the session's last compaction, which the chat view no longer shows.
  earlier?: boolean;
}

export interface SearchResult {
  id: string;
  title: string;
  cwd: string;
  lastModified: number;
  titleMatch: boolean;
  titleMarks: Mark[];
  // Messages that matched, counted up to a limit.
  hits: number;
  snippets: SearchSnippet[];
  archived?: boolean;
}

export interface SearchResponse {
  results: SearchResult[];
  // Sessions that matched, beyond the results returned.
  total: number;
  // Transcripts not read yet; their sessions are matched on the title alone until a later search.
  pending: number;
}

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant";
  at?: number;
  text: string;
  // Also part of the current conversation.
  shared?: boolean;
}

// The text around a search hit the chat view does not hold, along the hit's own branch.
export interface Thread {
  messages: ThreadMessage[];
  focus: string;
  // The hit lies off the current conversation (a branch left by a rewind, or before a compaction).
  rewound: boolean;
}
