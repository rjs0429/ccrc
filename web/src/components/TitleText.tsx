import { useLayoutEffect, useRef, useState } from "react";

// What Claude Code and VS Code put after the name of a session copied from another.
const COPY_MARK = / \(fork\)$/;

// A session's name on a line that cuts it short: a copy's mark stays in sight and the name before it gives way. Inline
// boxes only, so the line reads as one text.
export function TitleText({ text }: { text: string }) {
  const mark = COPY_MARK.exec(text)?.[0];
  const ref = useRef<HTMLSpanElement>(null);
  const [room, setRoom] = useState(0);
  useLayoutEffect(() => setRoom(ref.current?.offsetWidth ?? 0), [mark]);
  if (!mark) return text;
  return (
    <>
      <span className="inline-block truncate align-top" style={{ maxWidth: `calc(100% - ${room}px)` }}>
        {text.slice(0, -mark.length)}
      </span>
      <span ref={ref}>{mark}</span>
    </>
  );
}
