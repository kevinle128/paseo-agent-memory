import { z } from "zod";

/** The clients Agent-Memory supports and the plugin can set up. */
export const HarnessId = z.enum(["claude", "codex", "omp", "agy"]);
export type HarnessId = z.infer<typeof HarnessId>;
export const HARNESS_IDS = HarnessId.options;

/** The client name of the Agent-Memory hook installer, which is also the route segment of the proxy. */
export const INSTALLER_CLIENT: Record<HarnessId, string> = {
  claude: "claude-code",
  codex: "codex",
  omp: "omp",
  agy: "antigravity",
};

/** configured: provider and hook are in place. partial: only the provider is. failed: nothing was set up. */
export const HarnessState = z.enum(["configured", "partial", "failed"]);
export type HarnessState = z.infer<typeof HarnessState>;

export const HarnessErrorCode = z.enum([
  "settings_invalid",
  "codex_profile",
  "models_invalid",
  "own_provider",
  "toml_unsupported",
  "no_models",
  "write_failed",
  "installer_failed",
]);
export type HarnessErrorCode = z.infer<typeof HarnessErrorCode>;

/** Why nothing was set up for the whole machine. */
export const SetupError = z.enum(["no_proxy", "bad_key"]);
export type SetupError = z.infer<typeof SetupError>;

export const RemovalResult = z.enum(["kept", "failed"]);
export type RemovalResult = z.infer<typeof RemovalResult>;

export const SetupView = z.object({
  configuredAt: z.string(),
  running: z.boolean().optional(),
  error: SetupError.optional(),
  harnesses: z.array(
    z.object({ id: HarnessId, state: HarnessState, error: HarnessErrorCode.optional() }),
  ),
});
export type SetupView = z.infer<typeof SetupView>;

/** Harnesses whose configuration could not be removed at log out; a clean removal reports nothing. */
export const RemovalView = z.array(z.object({ id: HarnessId, result: RemovalResult }));
export type RemovalView = z.infer<typeof RemovalView>;
