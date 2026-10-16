// Claude Code 2.1.300 and later offer SendUserFile without Remote Control once CLAUDE_CODE_ATTACHMENTS_BY_PATH is set,
// and hand back the files' paths instead of uploading them; earlier versions ignore it. Broker and VS Code sessions get
// it unless their environment sets it already or turns it off with CCRC_SEND_FILES=0.
export function sendFilesEnv(base: NodeJS.ProcessEnv): { CLAUDE_CODE_ATTACHMENTS_BY_PATH?: string } {
  if (base.CLAUDE_CODE_ATTACHMENTS_BY_PATH !== undefined || base.CCRC_SEND_FILES === "0") return {};
  return { CLAUDE_CODE_ATTACHMENTS_BY_PATH: "1" };
}
