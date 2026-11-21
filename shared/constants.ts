// RFC 6761 ".invalid" never resolves; the real address is typed by the user.
export const PLACEHOLDER_ORIGIN = "https://agent-memory.invalid";
// The VTC Agent-Memory Panel on the tailnet; a host that saved the placeholder still counts as not configured.
export const DEFAULT_ORIGIN = "https://vtc.taildae6a9.ts.net:8126";
export const DATA_DIR_NAME = "paseo-agent-memory";
export const RENEW_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HTTP_TIMEOUT_MS = 15_000;
export const DEVICE_SLOW_DOWN_STEP_S = 5; // RFC 8628 section 3.5
export const DEVICE_MAX_INTERVAL_S = 60;
export const CLAIM_MIN_INTERVAL_S = 60;
export const CLAIM_MAX_BACKOFF_S = 15 * 60;
export const DEFAULT_INSTANCE_ID = "default";
// The Panel serves one read-only MCP server; Paseo adds it to agents of the providers below.
export const MCP_SERVER_NAME = "agent-memory";
export const MCP_PATH = "/api/v1/mcp";
// The clients Agent-Memory supports. Other Paseo providers get no MCP entry.
export const MCP_PROVIDERS = ["claude", "codex", "omp"] as const;
