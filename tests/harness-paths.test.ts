import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectHarnesses, resolvePaths } from "../server/harness-paths";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pam-home-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const noPath = { PATH: "/nonexistent-dir" };

describe("resolvePaths", () => {
  it("sets codexHome and ompDir only when the environment has them", () => {
    expect(resolvePaths({ SHELL: "/bin/zsh" }, home)).toEqual({ home, shell: "/bin/zsh" });
    expect(
      resolvePaths({ SHELL: "/bin/bash", CODEX_HOME: "/c", PI_CODING_AGENT_DIR: "/o" }, home),
    ).toEqual({ home, codexHome: "/c", ompDir: "/o", shell: "/bin/bash" });
  });
});

describe("detectHarnesses", () => {
  it("counts a client whose config directory exists", async () => {
    await mkdir(join(home, ".claude"));
    await mkdir(join(home, ".omp", "agent"), { recursive: true });
    await mkdir(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    const found = await detectHarnesses(resolvePaths({ SHELL: "/bin/zsh" }, home), noPath);
    expect(found).toEqual(expect.arrayContaining(["claude", "omp", "agy"]));
  });

  it("uses CODEX_HOME for the codex directory", async () => {
    const custom = join(home, "custom-codex");
    await mkdir(custom);
    const paths = resolvePaths({ SHELL: "/bin/zsh", CODEX_HOME: custom }, home);
    expect(await detectHarnesses(paths, noPath)).toContain("codex");
  });

  it("counts a client whose CLI is an executable on PATH", async () => {
    const bin = join(home, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "codex"), "#!/bin/sh\n");
    await chmod(join(bin, "codex"), 0o755);
    const found = await detectHarnesses(resolvePaths({ SHELL: "/bin/zsh" }, home), { PATH: bin });
    expect(found).toContain("codex");
  });
});

describe("agy detection", () => {
  it("does not count the shared ~/.gemini/config directory", async () => {
    await mkdir(join(home, ".gemini", "config"), { recursive: true });
    expect(await detectHarnesses(resolvePaths({ SHELL: "/bin/zsh" }, home), noPath)).not.toContain("agy");
  });

  it("counts the agy CLI on PATH", async () => {
    const bin = join(home, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "agy"), "#!/bin/sh\n");
    await chmod(join(bin, "agy"), 0o755);
    expect(await detectHarnesses(resolvePaths({ SHELL: "/bin/zsh" }, home), { PATH: bin })).toContain("agy");
  });
});
