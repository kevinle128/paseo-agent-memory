import { randomBytes, randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { HarnessErrorCode, HarnessId, HarnessState, SetupError } from "../shared/harness";

const InstallFile = z.object({
  version: z.literal(1),
  installId: z.string().regex(/^[A-Za-z0-9-]{8,128}$/),
  createdAt: z.string(),
});

const CredentialFile = z.object({
  version: z.literal(1),
  origin: z.string(),
  instanceId: z.string(),
  installId: z.string(),
  keyId: z.string(),
  key: z.string().min(1),
  expiresAt: z.string(),
  account: z.object({
    userId: z.string(),
    username: z.string(),
    email: z.string().optional(),
  }),
  teams: z.array(z.object({ name: z.string(), role: z.string().optional() })),
  deviceName: z.string(),
  savedAt: z.string(),
});
export type CredentialFile = z.infer<typeof CredentialFile>;

const PendingFile = z.object({
  version: z.literal(1),
  origin: z.string(),
  installId: z.string(),
  claimToken: z.string().min(1),
  deviceName: z.string(),
  requestedAt: z.string(),
  email: z.string().optional(),
});
export type PendingFile = z.infer<typeof PendingFile>;

// What the plugin set up for one key. It holds no secret: removal recognises the plugin's own entries by a
// digest of the key. `removalPending` stays until a removal has finished, so a restart resumes it.
const HarnessFile = z.object({
  version: z.literal(1),
  keyId: z.string(),
  keyDigest: z.string().regex(/^[0-9a-f]{64}$/),
  removalPending: z.boolean().optional(),
  proxyOrigin: z.string(),
  instanceId: z.string(),
  configuredAt: z.string(),
  paths: z.object({
    home: z.string(),
    codexHome: z.string().optional(),
    ompDir: z.string().optional(),
    shell: z.string(),
  }),
  error: SetupError.optional(),
  harnesses: z.array(
    z.object({
      id: HarnessId,
      state: HarnessState,
      error: HarnessErrorCode.optional(),
      route: z.string(),
    }),
  ),
});
export type HarnessFile = z.infer<typeof HarnessFile>;

export type Store = ReturnType<typeof createStore>;

const INSTALL_NAME = "install.json";
const CREDENTIAL_NAME = "credential.json";
const PENDING_NAME = "pending.json";
const HARNESS_NAME = "harness.json";

export function createStore(dir: string) {
  // Temp file with mode 0600, fsync, then rename over the target: a reader never sees a partial file.
  async function writePrivate(name: string, value: unknown): Promise<void> {
    const target = join(dir, name);
    const temp = join(dir, `${name}.${randomBytes(6).toString("hex")}.tmp`);
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2));
      await handle.sync();
    } catch (error) {
      await handle.close();
      await rm(temp, { force: true });
      throw error;
    }
    await handle.close();
    try {
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    await chmod(target, 0o600);
  }

  async function readValidated<T>(name: string, schema: z.ZodType<T>): Promise<T | null> {
    const target = join(dir, name);
    let raw: string;
    try {
      raw = await readFile(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
    await rename(target, `${target}.corrupt-${Date.now()}`);
    // The harness record has no secret, so the moved file is safe to keep. The tool files it described are not
    // touched: without the key digest the plugin cannot tell its own entries from the user's.
    console.error(
      name === HARNESS_NAME
        ? `${name} unreadable, moved aside; tool settings that point at the Agent-Memory proxy are left in place`
        : `${name} unreadable, moved aside`,
    );
    return null;
  }

  return {
    async loadOrCreateInstallId(): Promise<string> {
      const existing = await readValidated(INSTALL_NAME, InstallFile);
      if (existing) return existing.installId;
      const installId = randomUUID();
      await writePrivate(INSTALL_NAME, {
        version: 1,
        installId,
        createdAt: new Date().toISOString(),
      });
      return installId;
    },
    readCredential: () => readValidated(CREDENTIAL_NAME, CredentialFile),
    writeCredential: (credential: CredentialFile) => writePrivate(CREDENTIAL_NAME, credential),
    deleteCredential: () => rm(join(dir, CREDENTIAL_NAME), { force: true }),
    readPending: () => readValidated(PENDING_NAME, PendingFile),
    writePending: (pending: PendingFile) => writePrivate(PENDING_NAME, pending),
    deletePending: () => rm(join(dir, PENDING_NAME), { force: true }),
    readHarness: () => readValidated(HARNESS_NAME, HarnessFile),
    writeHarness: (record: HarnessFile) => writePrivate(HARNESS_NAME, record),
    deleteHarness: () => rm(join(dir, HARNESS_NAME), { force: true }),
  };
}
