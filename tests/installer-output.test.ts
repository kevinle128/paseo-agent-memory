import { describe, expect, it } from "vitest";
import { rememberStderr, sanitizeOutput } from "../server/installer-output";

const KEY = "fake-device-key-0001";

function shown(text: string, opts: { home?: string; truncated?: boolean; secrets?: string[] } = {}): string {
  return sanitizeOutput(Buffer.from(text), {
    secrets: opts.secrets ?? [KEY],
    home: opts.home ?? "/Users/an",
    truncated: opts.truncated ?? false,
  }).join("\n");
}

function prefixes(secret: string): string[] {
  const found: string[] = [];
  for (let length = 4; length <= secret.length; length += 1) found.push(secret.slice(0, length));
  return found;
}

describe("sanitizeOutput", () => {
  it("hides a key in the middle of a line", () => {
    const result = shown(`error at ${KEY} done`);
    expect(result).toBe("error at *** done");
    expect(result).not.toContain(KEY);
  });

  it("hides a key split across two stderr chunks", () => {
    const first = rememberStderr(Buffer.alloc(0), Buffer.from(`before ${KEY.slice(0, 8)}`));
    const second = rememberStderr(first.buffer, Buffer.from(`${KEY.slice(8)} after\n`));
    const result = sanitizeOutput(second.buffer, {
      secrets: [KEY],
      home: "/Users/an",
      truncated: first.truncated || second.truncated,
    }).join("\n");
    expect(result).toContain("***");
    expect(result).not.toContain(KEY);
    expect(result).not.toContain(KEY.slice(0, 8));
  });

  it("drops the cut-off first line so a partial key cannot remain", () => {
    const raw = `${KEY.slice(0, 8)} leftover\nsafe line here\n`;
    const lines = sanitizeOutput(Buffer.from(raw), { secrets: [KEY], home: "/Users/an", truncated: true });
    expect(lines).toEqual(["safe line here"]);
    const text = lines.join("\n");
    for (const prefix of prefixes(KEY)) expect(text).not.toContain(prefix);
  });

  it("hides bearer tokens, assignment values, gateway keys and query strings", () => {
    const samples = [
      `Authorization: Bearer abc.def.ghi`,
      `key=${KEY}`,
      "token=sekret-value",
      `AGENT_MEMORY_KEY=${KEY}`,
      `apiKey: ${KEY}`,
      `https://proxy.example/antigravity/default/${KEY}?token=abc`,
      "https://proxy.example/setup/hooks.sh?x=1",
    ];
    const result = samples.map((sample) => shown(sample)).join("\n");
    expect(result).not.toContain(KEY);
    expect(result).not.toContain("abc.def.ghi");
    expect(result).not.toContain("sekret-value");
    expect(result).not.toContain("token=abc");
    expect(result).not.toContain("?x=1");
    expect(result).toContain("Bearer ***");
    expect(result).toContain("key=***");
    expect(result).toContain("token=***");
    expect(result).toContain("AGENT_MEMORY_KEY=***");
    expect(result).toContain("apiKey: ***");
    expect(result).toContain("/antigravity/default/***");
    expect(result).toContain("https://proxy.example/setup/hooks.sh");
  });

  it("replaces a home directory in Windows, Git Bash and POSIX forms", () => {
    const windows = shown("C:\\Users\\an\\tool and /c/Users/an/tool and C:/Users/an/tool", {
      home: "C:\\Users\\an",
      secrets: [],
    });
    expect(windows).toBe("~/tool and ~/tool and ~/tool");
    expect(windows).not.toContain("Users");
    const mac = shown("/Users/an/Library/tool", { home: "/Users/an", secrets: [] });
    expect(mac).toBe("~/Library/tool");
  });

  it("strips ANSI codes, accepts CRLF and broken UTF-8, and does not throw", () => {
    const raw = Buffer.concat([
      Buffer.from("\u001b[31mred\u001b[0m\r\n"),
      Buffer.from([0xff, 0xfe]),
      Buffer.from(" tail\n"),
    ]);
    const lines = sanitizeOutput(raw, { secrets: [], home: "/Users/an", truncated: false });
    expect(lines[0]).toBe("red");
    expect(lines[1]).toContain("tail");
    expect(lines.join("\n")).not.toContain("\u001b");
  });

  it("keeps the last five lines and shortens a long line", () => {
    const many = Array.from({ length: 12 }, (_, index) => `line-${index}`).join("\n");
    expect(sanitizeOutput(Buffer.from(many), { secrets: [], home: "/Users/an", truncated: false })).toEqual([
      "line-7",
      "line-8",
      "line-9",
      "line-10",
      "line-11",
    ]);
    const long = "a".repeat(500);
    const clipped = sanitizeOutput(Buffer.from(long), { secrets: [], home: "/Users/an", truncated: false })[0];
    expect(clipped).toHaveLength(200);
    expect(clipped.endsWith("…")).toBe(true);
  });

  it("returns nothing for empty stderr", () => {
    expect(sanitizeOutput(Buffer.alloc(0), { secrets: [KEY], home: "/Users/an", truncated: false })).toEqual([]);
  });
});
