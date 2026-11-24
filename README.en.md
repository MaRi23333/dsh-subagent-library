# dsh-subagent-library

**[中文](./README.md) | English**

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="dsh-subagent-library — named subagent roster plugin for DeepSeek Harness" />
</p>

<p align="center">
  <img src="https://img.shields.io/github/actions/workflow/status/MaRi23333/dsh-subagent-library/ci.yml?style=flat-square&label=CI" alt="CI" />
  <img src="https://img.shields.io/github/license/MaRi23333/dsh-subagent-library?style=flat-square" alt="License: Apache-2.0" />
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.2--rc.5-4d6bfe?style=flat-square" alt="DeepSeek Harness 0.2.2-rc.5" />
</p>

## Subagent Library

Keep the assistants you use regularly in a named roster for DeepSeek Harness. Give each role a name, a description, and a prompt. Choose its usual model and reasoning effort, or let it follow the main conversation. Once a role is saved, you can ask for it by name in Desktop or Web.

For example, the roster below has an enabled role named `glm-adversary`. In the main conversation, you could ask:

> Ask `glm-adversary` to review this launch plan and flag the two assumptions we should check first.

The main agent uses `list_subagents` to find a saved role and `delegate` to give it the task. The role starts as a native DSH subagent. It reports back when it finishes, and you can send it follow-up questions.

![The role roster in DSH Desktop. Each card shows the role’s name, assignment, model, and enabled state.](./assets/readme/screenshot-settings.png)

[Install](#install) · [Your first delegation](#your-first-delegation) · [Switch models for one task](#switch-models-for-one-task) · [Optional groups](#groups-and-slots) · [Configuration and migration](#configuration-and-migration)

## Manage your roster

In **Settings → Subagent Library → Role roster**, filter by role ID, description, or model. Expand a card to edit its prompt, default model, and reasoning effort. Disable a role to set it aside and enable it again when you need it.

Each role has its own YAML file under `~/.dsh/subagents/` by default. Create roles in Settings, edit the files yourself, or ask a main agent with write access to that directory to configure one for you. Saved changes take effect on the next lookup or dispatch. Desktop and Web profiles can use different models for the same role.

Version 0.4.0 targets DSH `0.2.2-rc.5` and requires native subagents that can be addressed by name for follow-up messages. To upgrade from an earlier version, see the [migration guide](./MIGRATION.md) and [changelog](./CHANGELOG.md).

## Install

### Desktop client (recommended)

Desktop and Web have separate plugin installations and activation states; installing for Web does not enable the desktop plugin. The desktop GUI route needs no PATH setup.

1. In the desktop sidebar, open **Plugins** → **Add plugin**.
2. Enter the npm package name `dsh-subagent-library@latest` and install it.
3. Click **Enable now** when installation finishes. Closing the completed-install dialog leaves the plugin disabled.
4. Restart only if the UI asks you to: fully exit with **Quit** in the application menu, then reopen the app. Closing a window may only hide it.

Once enabled, open **子代理库 (Subagent Library)** in Settings and choose the role roster or groups tab. The storage and backup section shows the roster directory.

<details>
<summary>Alternative: use the desktop-bundled CLI (Windows / macOS)</summary>

Start the desktop client once to initialize it. In the application menu, open **Manage dsh Command…** → **Install** to register its bundled `dsh` command, then open a new terminal. If the UI reports a PATH conflict, follow its instructions first.

Fully exit the desktop client with **Quit**, then use the newly registered desktop-bundled CLI:

```sh
dsh plugin --profile desktop add dsh-subagent-library@latest
dsh plugin --profile desktop list
```

Reopen the desktop client afterwards. An npm-installed `dsh` or `npx` cannot manage the `desktop` profile. See the [official desktop command documentation](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/apps/desktop/README.md#bundled-command-runtime).

</details>

### Web

These commands manage Web plugins only. Use the same `dsh` CLI that starts your Web instance, matching that host's version, to install the stable release from npm:

```sh
dsh plugin --profile web add dsh-subagent-library@latest
```

After installation, stop the running `dsh web` process, start `dsh web` again with the same CLI, and refresh the page.

Other install sources:

```sh
# From GitHub (lib/ build artifacts are committed; no local build needed)
dsh plugin --profile web add github:MaRi23333/dsh-subagent-library

# From a local checkout
git clone https://github.com/MaRi23333/dsh-subagent-library.git
cd dsh-subagent-library
pnpm install && pnpm run build
dsh plugin --profile web add /absolute/path/to/dsh-subagent-library
```

> The repo commits `lib/` build artifacts, so git installs need no local build; after
> changing sources run `pnpm run build` and restart Web.
> Roster edits (files under `~/.dsh/subagents/`) are **hot-reloaded** — no restart.
>
> **Switching channels** — if you previously installed from GitHub or a local checkout and want npm-release upgrades, re-add with `dsh plugin --profile web add dsh-subagent-library@latest` to force the latest npm version.

## Your first delegation

1. Open **Settings → Subagent Library → Role roster → New role**. Enter `text-helper` as the ID and “Organize short passages from the main conversation” as the description. Leave the model empty to follow the main conversation, then save.
2. In the conversation, ask: “Have `text-helper` turn apple, banana, and pear into a numbered list, in that order. Send me its result.”
3. The start receipt from `delegate` gives you the member’s name. Once it reports back, you can ask the same member to put the list on one line.

Type `/subagent` in the command palette to browse your saved roles. The host’s `list_agents` tool shows members that have already been started.

<details>
<summary>Create a role with YAML or troubleshoot your first dispatch</summary>

To create the same role from a file, save `text-helper.yaml` in the roster directory. The filename sets the ID, the main agent sees the description, and the child receives the persona with its assignment.

```yaml
description: Organize short passages from the main conversation.
persona: Preserve proper names from the source.
```

If a role is missing, refresh the roster and check that the role is enabled. If the main agent cannot see `list_subagents` or `delegate`, check that the plugin is enabled for the Desktop or Web instance you are using and that the session can access both tools. For a first test, leave the role model empty and use the working model from the main conversation.

</details>

## Switch models for one task

Suppose `text-helper` usually follows the main model, but you want a second take today. Ask: “Have `text-helper` use DeepSeek Flash to edit this paragraph.” You can choose a model authorized in the current session for a single role or a group member. The next ordinary dispatch uses the saved role settings.

In the DSH sidebar, open **Plugins → built-in Subagent configuration → Model selection**. Enable agent model selection, select the allowed models, save, and start a new session. The main agent can call `list_subagent_models` to see the choices, pass `provider` and `model` to `delegate`, and optionally set `reasoning_effort`.

In a session without a recorded allowlist, an explicit selection is limited to the current parent provider and model. On a host that cannot read authorization, dispatch with the saved role settings remains available. Agent Teams is optional.

## Groups and slots

Some tasks call for the same people each time. To review an announcement, you might want one person to flag missing information and another to suggest a rewrite. Open **Settings → Subagent Library → Groups → New group**, select existing roles, and save their individual assignments and any shared instructions. Next time, ask for the group by name.

![An enabled two-member review group in Settings.](./assets/readme/group-settings.png)

In the conversation below, the main agent dispatches two members in the same turn. `grok-reviewer` uses its usual model to spot the missing start time. For this task, `glm-adversary` uses DeepSeek Flash to suggest a rewrite.

![Two review assignments in the same turn, with the first role on its default model and the second on DeepSeek Flash.](./assets/readme/group-dispatch.png)

Each `delegate` call starts one member. Independent assignments can start in the same turn. If an assignment depends on an earlier finding, the main agent can wait for that member to report back. Groups work with Agent Teams off. Turning it on also enables the host’s shared task board.

<details>
<summary>Group YAML example and tool calls</summary>

This `text-review` example reuses the `text-helper` role created above. The `facts` and `questions` slots give that role different assignments. Save it as `_groups/text-review.yaml` under the roster directory.

```yaml
description: Extract facts and open questions from supplied material.
instructions: Include the source for each finding.
members:
  - slot: facts
    role: text-helper
    assignment: Extract facts supported by the source.
  - slot: questions
    role: text-helper
    assignment: Identify missing information.
```

| Action | Tool call |
| --- | --- |
| Browse groups | `list_subagents({kind:"groups"})` |
| Inspect member keys, model settings and assignments | `list_subagents({group_id:"text-review"})` |
| Dispatch one member | `delegate({group_id:"text-review", slot:"facts", prompt:"Check the paragraph above."})` |

Browsing starts zero agents. The `questions` slot starts only on a separate call selecting it. A direct dispatch sends the role persona and task. A group dispatch also includes group instructions and the selected slot's assignment in the child's first message. Each start resolves the current role and profile route. Existing children keep their own sessions. Use `/subagent` to inspect the roster and groups from the command palette.

Use `/subagent groups text-review` to see which members have a configured model and which inherit the parent model. A role can inherit the model and set its own reasoning effort. After dispatch, the native subagent menu and `list_agents` show the launch model and known effort in the member description, for example `text-review/facts [model-a · high]`. Expand the `delegate` receipt for the full `provider`, `model` and `reasoningEffort` values when available.

</details>

## Configuration and migration

| Location or field | Behavior |
| --- | --- |
| `<entriesDir>/<role-id>.yaml` | Shared role with required `description`. Optional fields include `persona`, `enabled`, model route, `maxTokens`, `maxDepth` and `subagentProvider`. |
| `_profiles/<profile>/<role-id>.yaml` | Profile route with `provider`, `model`, `reasoningEffort` or explicit inheritance. A shared provider missing from the current profile falls back to the session model. An invalid explicit profile route blocks the affected role. |
| `_groups/<group-id>.yaml` | Required description and ordered nonempty `members`. Optional `name`, `enabled` and `instructions`. A member has a `slot`, a `role` and an optional `assignment`. |
| `maxDepth` | Defaults to the host limit. An explicit value can tighten it. Zero blocks delegation. |
| `subagentProvider` | Defaults to the `spawn` transport. `fork` can inherit completed turns from the parent. The LLM provider is configured separately. |
| Legacy `backgroundMode` and `toolFilter` | Both former execution modes now start a resumable child asynchronously. Roles carrying a tool filter remain blocked until its removal is explicit. Set any required permission boundaries in the host. |

On hosts with profiles, Settings saves model edits in the current profile. On hosts without profiles, the same editor changes the shared default route. Clear it to follow the session model. Profile overrides bound to the old shared route need to be set again after the default changes.

IDs and slot keys use lowercase letters, digits and hyphens, start with a letter or digit, and are at most 64 characters. Windows reserved device names are excluded. Disabling a group leaves its enabled roles available for direct use. Remove all group references before deleting a role. Settings detect stale writes. Hand-edited YAML is read on the next operation.

Configure the base directory and default transport on the plugin row of the current profile's `cordis.patch.yml`:

```yaml
- id: subagent-library
  config:
    entriesDir: ~/.dsh/subagents
    subagentProvider: spawn
```

Include the role files, `_profiles/` and `_groups/` in backups. The Settings endpoint `/subagent-library/api` shares the DSH Web Host access boundary. Configure host or reverse-proxy authentication when exposing it to other devices.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run build   # host: lib/index.js; client: lib/client.js
```

- Dev dependencies remain pinned to DSH `0.1.0-rc.6` (see package.json devDependencies); this is not the current runtime host version. If the interfaces drift on other versions, adjust against the corresponding tag of the [deepseek-harness repo](https://github.com/deepseek-ai/deepseek-harness).

## License

[Apache-2.0](./LICENSE). Third-party license notices for code inlined into the build artifacts are in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

This is an independent community project, not affiliated with or endorsed by DeepSeek; the `DeepSeek Harness` name is used only to identify the compatible platform.
