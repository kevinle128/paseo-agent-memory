import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AccountScreen } from "./client/account-screen";
import { messages } from "./client/messages";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "account",
    title: messages.message("screenTitle"),
    icon: "Brain",
    Component: AccountScreen,
  });
  return () => {};
}
