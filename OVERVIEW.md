Agent-Memory logs you in to Agent-Memory with your VTC mail account. While you are logged in, it attaches the Agent-Memory HTTP MCP server to each agent through the `agent.open.before` hook, and it writes configuration for the supported harnesses on the daemon host.

The MCP server is read-only. An agent can ask who you are in Agent-Memory, how Agent-Memory works, and questions about the wikis and code graphs of your teams. It shows nothing the Panel hides from you.

## Setup

The daemon host needs the VTC tailnet to reach the Agent-Memory Panel. The plugin repository is private, so the host also needs read access before it can be installed.

The plugin needs Paseo `>=0.16.0 <0.17.0`. The default Panel address is the VTC tailnet address. You can change it in the Connection section of the account screen. Plain `http` is accepted only for localhost.

## Account

Settings, then Plugins, then Agent-Memory, opens the `account` screen. Use it to log in, see the connection status, and log out.

Log in once per machine in the browser with your VTC mail. The login lasts 7 days and renews when you log in again. If your account is not in a team yet, the screen waits for an admin and connects after approval.

## What it reads and sends

The plugin stores your email and device key in `~/.paseo/plugin-data/paseo-agent-memory/`. The key file is private to the daemon host. Log out deletes it. Removing the plugin keeps it.

On a new login the plugin writes harness configuration for the tools installed on the machine:

- Claude Code: `~/.claude/settings.json`
- Codex: `config.toml` under `$CODEX_HOME` or `~/.codex`
- omp: `models.yml` in the omp agent directory
- Antigravity: `~/.agent-memory/antigravity.url`, the shell profile block, and `~/.gemini/config/mcp_config.json`

It copies each existing file to a backup before it changes the file. Other settings in those files are kept. Log out removes the entries the plugin added.

While an agent is open, the plugin sends the device key to the Panel MCP server as the `x-tdai-user-key` header. Claude, Codex, and omp receive that entry from the `agent.open.before` hook. Antigravity reads it from its own config file. The account screen has a switch, "Turn on the agent-memory MCP". It stays on until you turn it off, and a change applies the next time an agent opens.

The hook reads local files only. When you are logged out, the key has expired, or the saved address no longer matches the login, agents open without the MCP entry.
