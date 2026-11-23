/** Last bytes of stderr kept for the account screen. Older bytes are dropped. */
export const STDERR_TAIL_BYTES = 4 * 1024;

const MAX_LINES = 5;
const MAX_LINE_CHARS = 200;

export function rememberStderr(
  current: Uint8Array,
  chunk: Uint8Array,
  limit = STDERR_TAIL_BYTES,
): { buffer: Uint8Array; truncated: boolean } {
  const combined = current.length === 0 ? chunk : Buffer.concat([current, chunk]);
  if (combined.length <= limit) return { buffer: combined, truncated: false };
  return { buffer: combined.subarray(combined.length - limit), truncated: true };
}

function homeForms(home: string): string[] {
  const forms = new Set<string>([home]);
  const windows = home.match(/^([A-Za-z]):[/\\](.*)$/);
  if (windows) {
    const drive = windows[1];
    const rest = windows[2].replace(/\\/g, "/");
    forms.add(`${drive.toUpperCase()}:\\${rest.replace(/\//g, "\\")}`);
    forms.add(`${drive.toLowerCase()}:\\${rest.replace(/\//g, "\\")}`);
    forms.add(`${drive.toUpperCase()}:/${rest}`);
    forms.add(`${drive.toLowerCase()}:/${rest}`);
    forms.add(`/${drive.toLowerCase()}/${rest}`);
    forms.add(`/${drive.toUpperCase()}/${rest}`);
  }
  const gitBash = home.match(/^\/([A-Za-z])\/(.*)$/);
  if (gitBash) {
    const drive = gitBash[1];
    const rest = gitBash[2];
    forms.add(`${drive.toUpperCase()}:\\${rest.replace(/\//g, "\\")}`);
    forms.add(`${drive.toLowerCase()}:\\${rest.replace(/\//g, "\\")}`);
    forms.add(`${drive.toUpperCase()}:/${rest}`);
    forms.add(`${drive.toLowerCase()}:/${rest}`);
    forms.add(`/${drive.toLowerCase()}/${rest}`);
  }
  return [...forms].filter((form) => form.length > 1).sort((a, b) => b.length - a.length);
}

function replaceAll(text: string, needle: string, value: string): string {
  if (needle.length < 4 || !text.includes(needle)) return text;
  return text.split(needle).join(value);
}

function clip(line: string): string {
  const chars = [...line];
  if (chars.length <= MAX_LINE_CHARS) return line;
  return `${chars.slice(0, MAX_LINE_CHARS - 1).join("")}…`;
}

/**
 * Turns the installer's stderr into a few short lines safe to show on the account screen.
 * The result is not written to the record and not written to the log.
 */
export function sanitizeOutput(
  raw: Uint8Array,
  opts: { secrets: string[]; home: string; truncated: boolean },
): string[] {
  let text = new TextDecoder("utf-8", { fatal: false }).decode(raw);
  text = text.replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  if (opts.truncated) {
    const breakAt = text.search(/\r?\n/);
    text = breakAt === -1 ? "" : text.slice(breakAt).replace(/^\r?\n/, "");
  }
  const secrets = [...opts.secrets].filter((secret) => secret.length >= 4).sort((a, b) => b.length - a.length);
  for (const secret of secrets) text = replaceAll(text, secret, "***");
  text = text.replace(/Bearer\s+\S+/gi, "Bearer ***");
  text = text.replace(/AGENT_MEMORY_KEY=\S+/g, "AGENT_MEMORY_KEY=***");
  text = text.replace(/\b(?:key|token)=\S+/gi, (match) => `${match.slice(0, match.indexOf("="))}=***`);
  text = text.replace(/apiKey:\s*\S+/g, "apiKey: ***");
  text = text.replace(/(https?:\/\/[^\s?#]*)\?[^\s#]*/g, "$1");
  text = text.replace(/(\/antigravity\/[^/\s?#]+)\/[^/\s?#]+(?:\/[^/\s?#]+)*/g, "$1/***");
  for (const form of homeForms(opts.home)) text = replaceAll(text, form, "~");
  text = text.replace(/~\\/g, "~/");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-MAX_LINES)
    .map(clip);
}
