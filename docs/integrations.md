# Integrations

## Codex through direct MCP

From an arbitrary checkout, build and register the server:

```bash
npm ci
npm run build
codex mcp add machines -- node "$PWD/dist/mcp/server.js"
```

This command records the current checkout's absolute built entry point. Keep that
checkout available, or register again after moving it. It requires no marketplace
or helper skill. Start a new Codex thread and ask “Show me the Machines available
here.” The [official MCP guide](https://developers.openai.com/codex/mcp) describes
stdio server registration and configuration.

The five tools are:

| Tool | Inputs and result |
| --- | --- |
| `machine_list` | Absolute `cwd`; definitions, descriptions, missing Agents, per-file errors |
| `machine_agents` | Absolute `cwd`; configured Agent preset names and metadata |
| `machine_start` | Absolute `cwd`, Machine name, optional input/preset overrides; immediate run snapshot |
| `machine_status` | Optional exact `runId`; authoritative current-session snapshots |
| `machine_respond` | Exact `runId`, current `human.requestId`, and response; submits one waiting request |

Preserve the IDs returned by the tools. A stale request or repeated submission is
rejected. When explicit choices are present, send one of those exact strings.

Codex CLI can use text and structured tool results. Clients supporting MCP Apps
can also render the attached live card, which polls status and submits Human input.
Client support for the card varies; the same tools work without it.

## Portable Codex plugin

Build the self-contained plugin from the checkout:

```bash
npm ci
npm run build:plugin
npm run smoke:plugin
```

The result is `build/codex/machines/`, containing the manifest, compiled server,
production dependencies, widget assets, and machine-builder skill. Copy the entire
directory when distributing it. Node 24 or later must be on the receiving system's
PATH; the original checkout is unnecessary after copying. Build does not modify
your Codex installation or global configuration.

The plugin MCP configuration uses `command: "node"`, a relative server argument,
and `cwd: "."`. Codex resolves the plugin's relative working directory against
the installed plugin root, so no checkout-specific path or shell expansion is
needed. The source `codex/machines/` directory is an input to this build, not the
complete installable bundle.
This path behavior is implemented by the
[Codex 0.153.2 plugin parser](https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/codex-mcp/src/plugin_config.rs#L281-L288).

Install the resulting directory through your chosen local/repository marketplace
using the [official plugin packaging guide](https://developers.openai.com/plugins/build/plugins#install-a-local-plugin-manually).
For example, copy the complete bundle to a marketplace repository's
`plugins/machines/`, and add this entry to its `.agents/plugins/marketplace.json`:

```json
{
  "name": "machines-local",
  "interface": { "displayName": "Machines local" },
  "plugins": [{
    "name": "machines",
    "source": { "source": "local", "path": "./plugins/machines" },
    "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
    "category": "Productivity"
  }]
}
```

From that marketplace root, the current Codex CLI accepts:

```bash
codex plugin marketplace add "$PWD"
codex plugin add machines@machines-local
```

Existing marketplaces can add the plugin entry to their current list instead of
replacing their catalog. Use the direct MCP route when a marketplace is unnecessary.
Choose one installation route per Codex environment to avoid duplicate tools.

After updating the build, replace the complete bundle in the marketplace and
refresh the installation using the host's plugin management controls. Start a new
thread after installing or updating. The plugin version comes from its checked-in
manifest; release changes should bump it along with the package version.

The bundled configuration pre-approves the launcher tools. Discovery imports
trusted code, and start/respond can continue work that modifies files or contacts
external services. Tool annotations describe those capabilities. Configure your
preferred tool-approval policy in Codex if you need different behavior; workflow
Human states remain defined by each Machine.

## Pi extension

For a checkout on POSIX systems:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/pi-extension/index.ts" ~/.pi/agent/extensions/machines.ts
```

Run this from the Machines checkout after `npm ci`. Choose an unused destination;
the command does not replace an existing extension. Pi discovers it on startup;
use `/reload` after a source update. Keep the checkout available while using the
symlink. A locally installed npm package also includes the built extension at
`node_modules/machines/dist/pi-extension/index.js`.

Pi exposes the same five tools using the conversation's current directory, with
a status widget and native Human dialogs. Canceling a dialog leaves its Machine
waiting; answer later through `machine_respond` with the current request ID.
Pi exit, session replacement, and reload terminate its session-owned runs.

## Troubleshooting

For an isolated global catalog, set `MACHINES_USER_HOME` to an absolute directory;
Machines reads global definitions and presets from that directory's `.machines/`.
Explicit programmatic `home` options take precedence. This is useful for tests or
separate workflow collections without changing the operating-system home directory.

- **Node cannot load TypeScript from a dependency:** install the built tarball;
  source exports are for checkout development. Keep workflow definitions outside
  `node_modules` and use Node 24 or later.
- **A definition has an error or missing Agent:** inspect `machine list` and
  `machine agents`, correct metadata or presets, and list again. Imports refresh
  on the next discovery call. Run preflight remains strict.
- **The Agent fails on a permission request:** ACP permission interaction is not
  implemented. Use a harness configured for the intended task; Human states
  handle workflow decisions, not ACP permission prompts.
- **A run disappeared after reload:** runs are session-scoped and have no durable
  resume mechanism. Inspect effects already produced before starting another run.
- **The Codex card is absent:** use `machine_status` and `machine_respond`; visual
  resource rendering depends on the MCP client.
- **Agent output is too noisy:** ACP callers can select `output: "capture"`;
  the launcher already captures final text. The CLI's `o` hotkey toggles normalized
  activity while an Agent runs and is suspended during Human input.
