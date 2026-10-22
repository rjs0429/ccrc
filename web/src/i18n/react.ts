import { createElement, Fragment, useSyncExternalStore, type ReactNode } from "react";
import { langKey, onLang, translate } from "./index.ts";

export function useLangKey(): string {
  return useSyncExternalStore(onLang, langKey);
}

// t() for a sentence with elements in it: `{name}` takes vars.name, which may be an element.
export function tNode(ko: string, vars: Record<string, ReactNode>): ReactNode {
  const parts = translate(ko).split(/\{(\w+)\}/);
  return createElement(Fragment, null, ...parts.map((p, i) => (i % 2 === 0 ? p : Object.hasOwn(vars, p) ? vars[p] : `{${p}}`)));
}
