import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { HarnessId } from "./harness";
import { AccountStatus } from "./status";

const empty = z.object({});

export const statusRpc = defineRpc({ name: "account.status", input: empty, output: AccountStatus });
export const pollRpc = defineRpc({ name: "account.poll", input: empty, output: AccountStatus });
export const loginRpc = defineRpc({ name: "account.login", input: empty, output: AccountStatus });
export const logoutRpc = defineRpc({
  name: "account.logout",
  input: z.object({ force: z.boolean().optional() }),
  output: AccountStatus,
});
export const installHookRpc = defineRpc({
  name: "account.installHook",
  input: z.object({ id: HarnessId }),
  output: z.object({ accepted: z.boolean(), status: AccountStatus }),
});
