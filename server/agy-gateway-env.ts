import { agyGatewayUrl, keyDigest } from "./harness-files";
import { credentialMatchesOrigin } from "../shared/view";
import type { CredentialFile, HarnessFile } from "./store";

/** The variable `agy` reads for its gateway URL. */
export const AGY_GATEWAY_ENV = "AGY_LLM_GATEWAY_URL";
const AGY_PROVIDER = "antigravity";

export interface AgyGatewayInput {
  provider: string;
  credential: Pick<CredentialFile, "origin" | "instanceId" | "key" | "expiresAt"> | null;
  /** The address in the saved settings now; a login for another address gives no value. */
  settingsOrigin: string | null;
  harness: Pick<HarnessFile, "keyDigest" | "removalPending" | "error" | "instanceId" | "harnesses"> | null;
  nowMs: number;
}

/**
 * The gateway URL for one Antigravity agent, or `undefined` when the agent must keep its own environment.
 * The value is the content of `~/.agent-memory/antigravity.url`, but with the key of the login now, so an
 * agent opened after a new login never uses the key that the Paseo daemon read from the shell profile at start.
 */
export function agyGatewayUrlFor(input: AgyGatewayInput): string | undefined {
  const { provider, credential, harness, settingsOrigin, nowMs } = input;
  if (provider !== AGY_PROVIDER || !credential || !harness) return undefined;
  if (!credentialMatchesOrigin(settingsOrigin, credential.origin)) return undefined;
  const expires = Date.parse(credential.expiresAt);
  if (!Number.isFinite(expires) || expires <= nowMs) return undefined;
  // The record must describe this key: a record of an older key says nothing about the file for this one.
  if (harness.removalPending || harness.error) return undefined;
  if (harness.keyDigest !== keyDigest(credential.key) || harness.instanceId !== credential.instanceId) return undefined;
  const entry = harness.harnesses.find((h) => h.id === "agy");
  if (!entry) return undefined;
  // `configured`: the installer wrote the URL. `partial` with an error: the installer finished and only the MCP
  // entry failed. `partial` without an error is a setup that has not reached the installer yet.
  const urlWritten =
    entry.state === "configured" ||
    (entry.state === "partial" && entry.error !== undefined);
  return urlWritten ? agyGatewayUrl(entry.route, credential.key) : undefined;
}

export interface AgyGatewayDeps {
  readCredential(): Promise<AgyGatewayInput["credential"]>;
  readSettingsOrigin(): Promise<string | null>;
  readHarness(): Promise<AgyGatewayInput["harness"]>;
  now(): number;
  log(message: string): void;
}

interface OpenRequest {
  provider: string;
  env: Record<string, string>;
}

/**
 * Handler for the agent open hook. Local files only, no network call. It changes `env` and nothing else, and
 * it never throws or logs the value: a failure leaves the request as it is.
 */
export function createAgyGatewayEnvHook(deps: AgyGatewayDeps) {
  return async <Request extends OpenRequest>({
    request,
  }: {
    request: Request;
  }): Promise<Request | undefined> => {
    if (request.provider !== AGY_PROVIDER) return undefined;
    // `request.env` holds only what the user set for this launch, not the daemon environment, so a value
    // here is an explicit choice (for example a URL without memory) and wins over the plugin.
    if (request.env[AGY_GATEWAY_ENV]) return undefined;
    try {
      const url = agyGatewayUrlFor({
        provider: request.provider,
        credential: await deps.readCredential(),
        settingsOrigin: await deps.readSettingsOrigin(),
        harness: await deps.readHarness(),
        nowMs: deps.now(),
      });
      if (!url) return undefined;
      return { ...request, env: { ...request.env, [AGY_GATEWAY_ENV]: url } };
    } catch (error) {
      deps.log(`antigravity gateway env skipped (${error instanceof Error ? error.name : "unknown"})`);
      return undefined;
    }
  };
}

interface ChainRequest {
  provider: string;
  env: Record<string, string>;
  mcpServers: Record<string, unknown>;
}
type OpenStep = <Request extends ChainRequest>(input: { request: Request }) => Promise<Request | undefined>;

/**
 * One handler for the open hook from two steps: the second step sees the result of the first, and a step
 * that changed nothing leaves the other's result as it is.
 */
export function chainOpenSteps(first: OpenStep, second: OpenStep): OpenStep {
  return async <Request extends ChainRequest>({ request }: { request: Request }) => {
    const afterFirst = await first({ request });
    const afterSecond = await second({ request: afterFirst ?? request });
    return afterSecond ?? afterFirst;
  };
}
