# paseo-agent-memory

Paseo plugin that logs a person in to Agent-Memory with their VTC mail account
(device login) and keeps a per-device Agent-Memory key in a private file on the
daemon host.

Fork-only: install it from a directory or this Git repo, never from the gallery.
It requires Paseo `>=0.16.0 <0.17.0`.

## Install

```bash
paseo plugin install github:kevinle128/paseo-agent-memory
paseo plugin ls   # paseo-agent-memory must be running
```

The repo is private: the daemon host needs Git access to `kevinle128`. The Paseo host
must also reach the Agent-Memory Panel (`https://vtc.taildae6a9.ts.net:8126`, tailnet only).

## What it does

- Settings > Plugins > Agent-Memory > Account: "Log in with VTC mail", browser
  login, then "Connected".
- A person who is not in a team yet sees "Waiting for an admin" and is connected
  automatically after approval, even if the screen was closed.
- The key is stored in `<PASEO_HOME>/plugin-data/paseo-agent-memory/credential.json`
  (file mode 0600, directory 0700). It is never stored in plugin settings.
  Removing the plugin keeps the file; "Log out" deletes it.
- Default address is the VTC Agent-Memory Panel `https://vtc.taildae6a9.ts.net:8126`
  (tailnet only). Change it in the Connection section of the screen for another server.
  Plain `http` is accepted only for `localhost`, `127.0.0.1` and `[::1]`.
  The address must match exactly what the login link carries, so type it the same way
  every time: the login link is checked against the configured address and a different
  host name, port or scheme is refused.
- Vietnamese strings are complete, but the Paseo app has no `vi` language yet, so
  the screen shows English until the fork adds it.

## Tool setup (Claude Code, Codex, omp, Antigravity)

When a login issues a **new** key (first login, or a reinstall; a renewal keeps the key and
does nothing), the plugin sets up every supported tool that is installed on the machine at that
moment. It gives the same result as the Agent-Memory Guide page and `setup/hooks.sh`:

| Tool | Provider and key | Project hook |
|---|---|---|
| Claude Code | `env.ANTHROPIC_BASE_URL` and `env.ANTHROPIC_AUTH_TOKEN` in `~/.claude/settings.json` | installer `--client claude-code` |
| Codex | `model_provider = "team-proxy"` and `[model_providers.team-proxy]` in `$CODEX_HOME/config.toml` (`experimental_bearer_token`) | installer `--client codex` |
| omp | a marked provider region in `models.yml` (providers built from `<proxy>/omp/<space>/v1/models`) | installer `--client omp` |
| Antigravity (agy) | written by the installer (`~/.agent-memory/antigravity.url` and the shell profile block); the plugin also adds the `agent-memory` MCP server to `~/.gemini/config/mcp_config.json` (see below) | installer `--client antigravity` |

- **Proxy address.** Read from the Panel: `GET <panel>/api/v1/meta/instances` (public) and the
  `proxy_endpoint` of the configured instance. If the Panel gives none, nothing is set up.
- **Installed** means the CLI (`claude`, `codex`, `omp`, `agy`) is an executable on `PATH` or in a
  usual install directory, or the tool's own config directory exists (`~/.claude`, `$CODEX_HOME` or
  `~/.codex`, `$PI_CODING_AGENT_DIR` or `~/.omp/agent`, `~/.gemini/antigravity-cli`).
- **Backups.** Every existing file is copied to `<file>.agent-memory-backup-<time>` before the
  plugin changes it. Other settings are kept. A file that cannot be edited safely (invalid JSON, a
  Codex top-level `profile`, CRLF in `models.yml`) is left as it is and shown as not set up.
- **Key handling.** The key is never put in a process argument. The installer gets it only for
  Antigravity, in `AGENT_MEMORY_KEY`. Claude Code, Codex and omp keep the key in their own config
  file, as the manual flow does (those files are the user's, outside the plugin data directory).
  When a hook install fails, the account screen can show the last lines of the installer's error
  after the key, tokens and the home directory have been removed. Those lines stay in the plugin
  process only. They are not written to the plugin log.
- **Record.** `<plugin data dir>/harness.json` (no key, no installer output) lists what was set up,
  including the step and short error code when a client did not finish. The account screen shows it.
  A tool that is not fully set up has Install hook or Try again, which runs that tool again.
  A tool installed later is not set up automatically: follow the Guide steps for it.
- **Log out.** After the server accepts the log out, the plugin removes what it added: the entries
  above and the project hook (installer `--uninstall`). An entry the user changed since is kept and
  shown on the screen. Backups are not restored and are not deleted. If the installer cannot be
  reached at log out, the hook stays and the screen says so.

## The agent-memory MCP

The Panel serves a read-only MCP server at `<panel>/api/v1/mcp`. While you are logged in, the plugin
adds it to every Claude Code, Codex and omp agent that Paseo opens, under the name `agent-memory`.
It lets the agent ask who you are in Agent-Memory, how Agent-Memory works, and questions about the
wikis and code graphs of your teams. It shows nothing that the Panel hides from you.

- **Providers.** `claude`, `codex` and `omp` get the entry from the plugin each time an agent opens.
  Other Paseo providers get no entry, except Antigravity (below).
- **Antigravity.** The Paseo `antigravity` provider ignores MCP servers that a plugin injects when an
  agent opens, and `agy` takes MCP servers only from its own config files. So the plugin does not list
  `antigravity` in the open hook. Instead, when it sets up `agy` for a new key, it writes the `agent-memory`
  server (`serverUrl` plus the two headers, the layout of `agy mcp add --header ... agent-memory <url>`)
  into `~/.gemini/config/mcp_config.json`, after a backup, and keeps every other entry and key.
  - This entry applies to every `agy` launch, also outside Paseo, like the Claude Code and Codex entries.
  - The plugin's MCP switch below does not control it.
  - **Gateway URL at open.** The Paseo daemon reads `AGY_LLM_GATEWAY_URL` from the shell profile once, when
    it starts, so after a log out and a new login a Paseo `agy` agent would still use the old, expired key
    and the gateway would list only a few models. So the open hook sets `AGY_LLM_GATEWAY_URL` in the
    environment of every `antigravity` agent to `<proxy>/antigravity/<instance>/<key>`, the content of
    `~/.agent-memory/antigravity.url`, with the key of the login now. The MCP switch does not control this
    either, because it is part of the `agy` setup. The value is set only while you are logged in, the key
    has not expired, the saved address is the address of the login, and the plugin record says `agy` was
    set up for this key (state "configured", or "partial" after only the MCP entry failed). Otherwise the
    environment stays as it is. No other provider is changed, the hook makes no network call, and the value
    is never logged. A non-empty `AGY_LLM_GATEWAY_URL` that you set in Paseo settings or for one agent
    (for example a URL without memory) wins: the plugin leaves it as it is. An agent that was opened
    before the new login keeps the old key until you reopen it. The Paseo model picker is read with the
    daemon environment, so it can show the model list of the old key until the daemon restarts.
  - The file now holds the key, as `~/.agent-memory/antigravity.url` does. A file that was open to the
    group or others is changed to mode 0600.
  - At log out the plugin removes exactly that entry, when it still holds the key. An entry you changed
    is kept and shown on the screen. A file that the plugin created is deleted only when nothing else is
    left in it; a file that existed before always stays. A failed MCP removal does not stop the removal of
    the URL file and the hook; the screen then reports the failure.
  - An `agent-memory` entry that points at another host or path is yours: the plugin leaves it alone and
    the tool shows as partly set up. When the plugin updates its own entry, it keeps other headers, other
    fields and `disabled: true`.
- **Switch.** Settings > Plugins > Agent-Memory > Account shows "Turn on the agent-memory MCP". It is
  on until you save a different value. A change applies the next time an agent opens, so reopen the
  agent after you change it. If the saved setting is not valid, the MCP is off, the switch shows Off,
  and a Reset action restores the default.
- **No entry without a valid login.** When you are logged out, the key has expired, or the saved
  address no longer matches the address you logged in to (the screen shows "server changed"), agents
  open without the MCP. The hook reads local files only, so an agent still opens when the Panel is down.
- **Key.** The plugin sends the key as the `x-tdai-user-key` header. Paseo keeps the entry in memory
  for the launch and does not save it in the agent record. The Claude SDK passes the MCP config inline
  to the Claude process, so the key is visible in that process's arguments on your own machine while
  the agent runs. omp never receives it.
- **Name.** Do not save your own MCP server named `agent-memory` in an agent. The names would collide
  and the agent would not open.

## Out of scope

- Injecting instructions, or env for any provider other than `antigravity`, into agents at open time.
- Adding the MCP to agents that you start outside Paseo.
- Skills, Command Center and sidebar items, gallery publication, a language picker.
- Any change to the Paseo fork or to Agent-Memory.

## Develop

```bash
npm install
npm run typecheck
npm test            # unit tests with an in-process fake server
npm run test:e2e    # opt-in, needs the local Agent-Memory stack (see below)
```

The e2e test is skipped unless `PAM_E2E=1`. It also needs `PAM_E2E_PANEL`,
`PAM_E2E_CORE`, `PAM_E2E_SSO` and `PAM_E2E_ADMIN_KEY`. Status: it passes against the local stack of the Agent-Memory repo (fake SSO, Core, Panel and Proxy).
in every normal run.

## Install into a local daemon (isolated, never your live `~/.paseo`)

```bash
export PAM_HOME=/tmp/pam-paseo-home && mkdir -p "$PAM_HOME"
paseo daemon config set daemon.listen 127.0.0.1:16767 --home "$PAM_HOME"
paseo daemon config set pluginsEnabled true --home "$PAM_HOME"
PASEO_HOME="$PAM_HOME" paseo daemon run --home "$PAM_HOME" > /tmp/pam-daemon.log 2>&1 &
paseo --host 127.0.0.1:16767 plugin install "$(pwd)"
paseo --host 127.0.0.1:16767 plugin ls paseo-agent-memory      # running
paseo --host 127.0.0.1:16767 plugin logs paseo-agent-memory    # "data dir: /tmp/pam-paseo-home/..."
```

If the logged data dir is under `~/.paseo`, stop and remove the plugin. Edit loop:
`npm run typecheck && paseo --host 127.0.0.1:16767 plugin reload paseo-agent-memory`.
Stop: `paseo --host 127.0.0.1:16767 plugin remove paseo-agent-memory`, kill the
daemon, `rm -rf /tmp/pam-paseo-home /tmp/pam-daemon.log`.
To use the UI, connect the Paseo app to host `127.0.0.1:16767`.
