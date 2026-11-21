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
| Antigravity (agy) | written by the installer (`~/.agent-memory/antigravity.url` and the shell profile block) | installer `--client antigravity` |

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
- **Record.** `<plugin data dir>/harness.json` (no key) lists what was set up; the account screen
  shows it. A tool installed later is not set up automatically: follow the Guide steps for it.
- **Log out.** After the server accepts the log out, the plugin removes what it added: the entries
  above and the project hook (installer `--uninstall`). An entry the user changed since is kept and
  shown on the screen. Backups are not restored and are not deleted. If the installer cannot be
  reached at log out, the hook stays and the screen says so.

## Out of scope

- Injecting env, instructions or the agent-memory MCP into agents at open time (next step).
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
