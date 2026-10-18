import { g1 } from "./g1.ts";
import { g2 } from "./g2.ts";
import { g3 } from "./g3.ts";
import { g4 } from "./g4.ts";
import { g5 } from "./g5.ts";

// Each group of screens keeps its English in its own file so the groups are translated apart. A sentence that several
// groups show is kept once, in the lowest of them.
export const en: Readonly<Record<string, string>> = { ...g1, ...g2, ...g3, ...g4, ...g5 };
