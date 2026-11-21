import { MCP_PATH } from "./constants";

export const MCP_SERVICE_HEADER = "x-tdai-service-id";
export const MCP_KEY_HEADER = "x-tdai-user-key";

/** The address of the Panel's MCP server. */
export const mcpUrl = (origin: string): string => new URL(MCP_PATH, origin).toString();

/** The two headers that every client sends to the MCP server. */
export const mcpHeaders = (instanceId: string, key: string): Record<string, string> => ({
  [MCP_SERVICE_HEADER]: instanceId,
  [MCP_KEY_HEADER]: key,
});
