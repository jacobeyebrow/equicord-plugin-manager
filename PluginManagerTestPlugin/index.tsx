/*
 * Minimal userplugin for smoke-testing ChannelPluginManager installs.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";
import { showToast, Toasts } from "@webpack/common";

export default definePlugin({
    name: "PluginManagerTestPlugin",
    description: "Smoke test: Equicord toolbox action confirms the plugin loaded after clone.",
    tags: ["Dev"],
    authors: [{ name: "Equicord", id: 0n }],

    toolboxActions: {
        "PM install test"() {
            showToast("PluginManagerTestPlugin: install OK (toolbox action).", Toasts.Type.SUCCESS);
        }
    }
});
