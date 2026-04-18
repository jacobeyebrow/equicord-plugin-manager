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

## Test plugin (one-click install URL)

The installer only sees **`index.tsx` at the repo root**, so the smoke-test plugin lives in its **own** repository (not the `PluginManagerTestPlugin/` subfolder here).

**Paste this in the manager channel or in a JSON catalog** (no `/tree/…` path):

`https://github.com/jacobeyebrow/equicord-plugin-manager-test-plugin`

A copy of the same source also lives under [`PluginManagerTestPlugin/`](./PluginManagerTestPlugin/) in **this** repo for reference or manual copy into `src/userplugins/`.

## License

SPDX-License-Identifier: **GPL-3.0-or-later** (see [LICENSE](./LICENSE)).
