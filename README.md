# equicord-plugin-manager

Equicord **userplugin** (**ChannelPluginManager**): in a chosen channel, replace the chat area with a client-side overlay to **browse channel messages as a plugin catalog**, paste **git clone URLs**, and **install userplugins** through the **UserpluginInstaller** native helpers (same URL rules as **Settings → UserPlugins**).

## Requirements

- **Equicord** (or compatible fork) with **UserpluginInstaller** enabled.
- **Desktop / Equibop** build so `VencordNative.pluginHelpers.UserpluginInstaller` exists (clone / list / uninstall).

## One-click install (this repo)

UserpluginInstaller clones the repository and expects an entry file **`index.tsx`** at the **repository root**.

**Install URL (paste in ChannelPluginManager or UserPlugins):**

`https://github.com/jacobeyebrow/equicord-plugin-manager`

After a successful clone, enable **ChannelPluginManager** under your userplugins and **refresh / restart** the client as prompted.

## Settings

- **Channel ID** — only that channel shows the overlay (default in source is a placeholder; change it to your channel in plugin settings).

The overlay **hides** while Discord / Vencord **settings** or **`role="dialog"`** modals are open so it does not cover them.

## Channel catalog format

Post messages in the configured channel. The manager parses:

- JSON: `{"plugins":[{"title":"…","description":"…","url":"https://github.com/owner/repo"}]}`
- Single-object JSON per message
- Lines starting with `PLUGIN {...}`
- Bare supported clone URLs (GitHub, GitLab, Codeberg, nin0, etc.)

## Test plugin (`PluginManagerTestPlugin`)

This repository includes a **minimal** second plugin under [`PluginManagerTestPlugin/`](./PluginManagerTestPlugin/).

**Important:** The installer clones the **repo root** into `src/userplugins/<repo-name>/`. It does **not** install a random subfolder by URL. So you **cannot** one-click install *only* `PluginManagerTestPlugin` from this same repository using a normal GitHub HTTPS link.

Use either:

1. **Manual test** — Copy the `PluginManagerTestPlugin` folder into your `src/userplugins/` tree (next to other plugins), rebuild/restart, enable **PluginManagerTestPlugin**, then open **Equicord toolbox → “PM install test”** and confirm the toast.

2. **One-click test** — Publish `PluginManagerTestPlugin` as **its own** GitHub repository with `index.tsx` at the **root** (same layout as this repo, but only those files), then install with that repo’s HTTPS URL.

To verify the **manager** flow end-to-end, install this repo first (main plugin), then use a catalog entry URL pointing at a **small dedicated test repo** you control.

## License

SPDX-License-Identifier: **GPL-3.0-or-later** (see [LICENSE](./LICENSE)).
