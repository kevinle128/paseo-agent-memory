import { credentialMatchesOrigin } from "../shared/view";
import { MCP_PROVIDERS, MCP_SERVER_NAME } from "../shared/constants";
import { mcpHeaders, mcpUrl } from "../shared/mcp-entry";
import type { CredentialFile } from "./store";

export interface McpHttpServer {
  type: "http";
  url: string;
  headers: Record<string, string>;
}

export interface McpAttachInput {
  provider: string;
  credential: Pick<CredentialFile, "origin" | "instanceId" | "key" | "expiresAt"> | null;
  /** The address in the saved settings now; a login for another address gives no entry. */
  settingsOrigin: string | null;
  enabled: boolean;
  nowMs: number;
}

const providers: readonly string[] = MCP_PROVIDERS;

/** The MCP entry for one agent, or `undefined` when this agent must not get one. */
export function mcpServersFor(input: McpAttachInput): Record<string, McpHttpServer> | undefined {
  const { provider, credential, enabled, nowMs, settingsOrigin } = input;
  if (!enabled || !providers.includes(provider) || !credential) return undefined;
  if (!credentialMatchesOrigin(settingsOrigin, credential.origin)) return undefined;
  const expires = Date.parse(credential.expiresAt);
  if (!Number.isFinite(expires) || expires <= nowMs) return undefined;
  return {
    [MCP_SERVER_NAME]: {
      type: "http",
      url: mcpUrl(credential.origin),
      headers: mcpHeaders(credential.instanceId, credential.key),
    },
  };
}

export interface McpAttachDeps {
  /** Reads the saved switch. Local state only. */
  readEnabled(): Promise<boolean>;
  /** The server address in the saved connection settings. Local state only. */
  readSettingsOrigin(): Promise<string | null>;
  /** Reads the credential file. Local state only. */
  readCredential(): Promise<McpAttachInput["credential"]>;
  now(): number;
  log(message: string): void;
}

interface OpenRequest {
  provider: string;
  mcpServers: Record<string, unknown>;
}

/**
 * Handler for the agent open hook. It does no network call and never throws: a failure here must
 * not stop an agent from opening. It never logs the key, the headers or the request.
 */
export function createMcpAttachHook(deps: McpAttachDeps) {
  return async <Request extends OpenRequest>({
    request,
  }: {
    request: Request;
  }): Promise<Request | undefined> => {
    try {
      const enabled = await deps.readEnabled();
      if (!enabled || !providers.includes(request.provider)) return undefined;
      const map = mcpServersFor({
        provider: request.provider,
        credential: await deps.readCredential(),
        settingsOrigin: await deps.readSettingsOrigin(),
        enabled,
        nowMs: deps.now(),
      });
      if (!map) return undefined;
      return { ...request, mcpServers: { ...request.mcpServers, ...map } };
    } catch (error) {
      deps.log(`mcp attach skipped (${error instanceof Error ? error.name : "unknown"})`);
      return undefined;
    }
  };
}
