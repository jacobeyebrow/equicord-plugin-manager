/*
 * Equicord / Vencord user plugin — full-screen overlay in one channel: browse & install userplugins
 * (uses UserpluginInstaller native helpers when available).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { disableStyle, enableStyle } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { Heading } from "@components/Heading";
import { Notice } from "@components/Notice";
import definePlugin, { OptionType } from "@utils/types";
import { relaunch } from "@utils/native";
import { Message } from "@vencord/discord-types";
import { CLONE_LINK_REGEX, showInstallFinishedAlert } from "@equicordplugins/userpluginInstaller.dev/misc/constants";
import { findByPropsLazy, findCssClassesLazy } from "@webpack";
import {
    Alerts,
    Button,
    createRoot,
    MessageStore,
    React,
    ReactDOM,
    SelectedChannelStore,
    showToast,
    Toasts,
    useEffect,
    useLayoutEffect,
    useMemo,
    useState,
    useStateFromStores
} from "@webpack/common";
import type { Root } from "react-dom/client";

import managedStyle from "./styles.css?managed";

const DEFAULT_CHANNEL_ID = "1495061791041130678";

const OpenSettingsModule = findByPropsLazy("openUserSettings") as {
    openUserSettings: (panel: string) => void;
};

/** Discord stacks User Settings & other UIs as non–base-layer `.layer` nodes — hide our overlay when those are visible. */
const DiscordLayerClasses = findCssClassesLazy("baseLayer", "layer");

/**
 * True while settings, modals, or other layer/dialog UI is covering the app (so we don’t sit on top of them).
 */
function shouldSuppressPluginManagerOverlay(): boolean {
    const L = DiscordLayerClasses as { layer?: string; baseLayer?: string } | null;
    if (L?.layer && L?.baseLayer) {
        const layerTok = L.layer.trim().split(/\s+/)[0];
        const baseTok = L.baseLayer.trim().split(/\s+/)[0];
        if (layerTok && baseTok) {
            try {
                const nodes = document.querySelectorAll<HTMLElement>(`div.${CSS.escape(layerTok)}`);
                for (const el of nodes) {
                    if (el.classList.contains(baseTok)) continue;
                    if (el.closest(".vc-cpm-shell")) continue;
                    if (el.getAttribute("aria-hidden") === "true") continue;
                    const st = getComputedStyle(el);
                    if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) < 0.05) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width < 64 || r.height < 64) continue;
                    return true;
                }
            } catch {
                /* ignore selector/CSS.escape issues */
            }
        }
    }

    try {
        for (const d of document.querySelectorAll<HTMLElement>("[role=\"dialog\"]")) {
            if (d.closest(".vc-cpm-shell")) continue;
            const st = getComputedStyle(d);
            if (st.display === "none" || st.visibility === "hidden") continue;
            const r = d.getBoundingClientRect();
            if (r.width < 100 || r.height < 60) continue;
            return true;
        }
    } catch {
        /* ignore */
    }

    return false;
}

function useAllowPluginManagerOverlay(): boolean {
    const [allowed, setAllowed] = useState(() => !shouldSuppressPluginManagerOverlay());

    useLayoutEffect(() => {
        const tick = () => {
            setAllowed(!shouldSuppressPluginManagerOverlay());
        };
        tick();
        const id = window.setInterval(tick, 200);
        const app = document.getElementById("app-mount");
        const obs = new MutationObserver(tick);
        if (app) {
            obs.observe(app, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ["class", "style", "aria-hidden"]
            });
        }
        return () => {
            window.clearInterval(id);
            obs.disconnect();
        };
    }, []);

    return allowed;
}

type UserpluginNative = {
    initPluginInstall: (link: string, source: string, owner: string, repo: string) => Promise<string>;
    getUserplugins: () => Promise<
        {
            name: string;
            description: string;
            directory?: string;
            remote: string;
        }[]
    >;
    rmPlugin: (directoryName: string) => Promise<string>;
};

function getUserpluginNative(): UserpluginNative | undefined {
    return (window as unknown as { VencordNative?: { pluginHelpers?: { UserpluginInstaller?: UserpluginNative } } })
        .VencordNative?.pluginHelpers?.UserpluginInstaller;
}

export type CatalogEntry = {
    title: string;
    description?: string;
    url: string;
};

const settings = definePluginSettings({
    channelId: {
        type: OptionType.STRING,
        description: "Channel ID where the chat area is replaced by this plugin manager overlay.",
        default: DEFAULT_CHANNEL_ID
    }
});

function getMessagesArray(channelId: string): Message[] {
    if (!channelId) return [];
    const bucket = MessageStore.getMessages(channelId) as { _array?: Message[] } | undefined;
    if (!bucket?._array) return [];
    return [...bucket._array].filter(m => !(m as { deleted?: boolean }).deleted);
}

function stripCodeFence(s: string): string {
    let t = s.trim();
    if (t.startsWith("```")) {
        t = t.replace(/^```(?:json)?\s*/i, "");
        t = t.replace(/```\s*$/i, "");
    }
    return t.trim();
}

function normalizeUrl(url: string): string {
    const u = url.trim();
    if (!u) return "";
    if (!/^https?:\/\//i.test(u)) return `https://${u}`;
    return u;
}

function catalogEntryFromMatch(match: RegExpMatchArray): CatalogEntry | null {
    const url = match[0]?.trim();
    if (!url) return null;
    const idpl = url.includes("plugins.nin0.dev") ? 1 : 0;
    const title = (match[[3, 6][idpl]] as string) || "Plugin";
    const desc = idpl ? "plugins.nin0.dev" : `${match[[2, 5][idpl]]}/${match[[3, 6][idpl]]}`;
    return { title, description: desc, url: match[0] };
}

/** Merge message content into a catalog: JSON blocks, bare clone URLs, PLUGIN lines. */
export function parseCatalogFromMessages(messages: Message[]): CatalogEntry[] {
    const sorted = [...messages].sort((a, b) => {
        const ta = new Date(String(a.timestamp)).getTime();
        const tb = new Date(String(b.timestamp)).getTime();
        return ta - tb;
    });

    const seen = new Set<string>();
    const catalog: CatalogEntry[] = [];

    const pushCanonical = (entry: CatalogEntry) => {
        const m = normalizeUrl(entry.url).match(CLONE_LINK_REGEX);
        if (!m) return;
        const key = m[0];
        if (seen.has(key)) return;
        seen.add(key);
        const idpl = m[0].includes("plugins.nin0.dev") ? 1 : 0;
        const repoName = m[[3, 6][idpl]] as string;
        catalog.push({
            title: entry.title || repoName || "Plugin",
            description: entry.description,
            url: m[0]
        });
    };

    const joined = sorted
        .map(m => (m.content ?? "").trim())
        .filter(Boolean)
        .join("\n");

    try {
        const body = stripCodeFence(joined);
        const j = JSON.parse(body) as { plugins?: unknown };
        if (j.plugins && Array.isArray(j.plugins)) {
            for (const raw of j.plugins) {
                if (!raw || typeof raw !== "object") continue;
                const o = raw as { title?: string; name?: string; description?: string; desc?: string; url?: string };
                const um = normalizeUrl(String(o.url ?? "")).match(CLONE_LINK_REGEX);
                if (!um) continue;
                pushCanonical({
                    title: String(o.title ?? o.name ?? "Plugin"),
                    description:
                        o.description != null ? String(o.description) : o.desc != null ? String(o.desc) : undefined,
                    url: um[0]
                });
            }
            if (catalog.length) return catalog;
        }
    } catch {
        /* fall through */
    }

    for (const msg of sorted) {
        const c = stripCodeFence(msg.content ?? "");

        try {
            const j = JSON.parse(c) as { plugins?: unknown };
            if (j.plugins && Array.isArray(j.plugins)) {
                for (const raw of j.plugins) {
                    if (!raw || typeof raw !== "object") continue;
                    const o = raw as { title?: string; name?: string; description?: string; url?: string };
                    const um = normalizeUrl(String(o.url ?? "")).match(CLONE_LINK_REGEX);
                    if (!um) continue;
                    pushCanonical({
                        title: String(o.title ?? o.name ?? "Plugin"),
                        description: o.description != null ? String(o.description) : undefined,
                        url: um[0]
                    });
                }
                continue;
            }
        } catch {
            try {
                const o = JSON.parse(c) as { title?: string; name?: string; description?: string; url?: string };
                if (o.url) {
                    const um = normalizeUrl(String(o.url)).match(CLONE_LINK_REGEX);
                    if (um)
                        pushCanonical({
                            title: String(o.title ?? o.name ?? "Plugin"),
                            description: o.description != null ? String(o.description) : undefined,
                            url: um[0]
                        });
                }
            } catch {
                /* try lines */
            }
        }

        const lines = c.split("\n").map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
            const um = line.match(CLONE_LINK_REGEX);
            if (um) {
                const ce = catalogEntryFromMatch(um);
                if (ce) pushCanonical(ce);
            }
            if (line.toUpperCase().startsWith("PLUGIN ")) {
                try {
                    const o = JSON.parse(line.slice(7).trim()) as {
                        title?: string;
                        name?: string;
                        description?: string;
                        url?: string;
                    };
                    const m2 = normalizeUrl(String(o.url ?? "")).match(CLONE_LINK_REGEX);
                    if (m2)
                        pushCanonical({
                            title: String(o.title ?? o.name ?? "Plugin"),
                            description: o.description != null ? String(o.description) : undefined,
                            url: m2[0]
                        });
                } catch {
                    /* ignore */
                }
            }
        }

        const blockMatch = c.match(CLONE_LINK_REGEX);
        if (blockMatch) {
            const ce = catalogEntryFromMatch(blockMatch);
            if (ce) pushCanonical(ce);
        }
    }

    return catalog;
}

function findChatRect(): { top: number; left: number; width: number; height: number } {
    const main = document.querySelector("main");
    const el = main ?? document.body;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
}

async function runInstall(url: string, refresh: () => void) {
    const Native = getUserpluginNative();
    if (!Native?.initPluginInstall) {
        showToast("UserpluginInstaller native is not available. Use Equicord Desktop / Equibop with UserpluginInstaller enabled, then restart once.", Toasts.Type.FAILURE);
        return;
    }
    const n = normalizeUrl(url);
    const gitLink = n.match(CLONE_LINK_REGEX);
    if (!gitLink) {
        showToast("That URL is not a supported git clone link (GitHub, GitLab, Codeberg, etc.).", Toasts.Type.FAILURE);
        return;
    }
    const idpl = gitLink.includes("plugins.nin0.dev") ? 1 : 0;
    try {
        const raw = await Native.initPluginInstall(
            gitLink[0],
            gitLink[[1, 4][idpl]] as string,
            gitLink[[2, 5][idpl]] as string,
            gitLink[[3, 6][idpl]] as string
        );
        const { name, native: needsNative } = JSON.parse(raw) as { name: string; native: boolean };
        showInstallFinishedAlert(name, needsNative);
        refresh();
    } catch (e: any) {
        if (String(e).includes("silentStop")) return;
        Alerts.show({
            title: "Install error",
            body: String(e)
        });
    }
}

async function runUninstall(directory: string | undefined, refresh: () => void) {
    if (!directory) return;
    const Native = getUserpluginNative();
    if (!Native?.rmPlugin) {
        showToast("Uninstall requires UserpluginInstaller native (desktop client).", Toasts.Type.FAILURE);
        return;
    }
    try {
        await Native.rmPlugin(directory);
        showToast(`Removed ${directory}`, Toasts.Type.SUCCESS);
        refresh();
    } catch (e: any) {
        Alerts.show({ title: "Uninstall cancelled or failed", body: String(e) });
    }
}

function PluginManagerOverlay({ channelId }: { channelId: string }) {
    const allowOverlay = useAllowPluginManagerOverlay();
    const messages = useStateFromStores([MessageStore], () => getMessagesArray(channelId));
    const catalog = useMemo(() => parseCatalogFromMessages(messages), [messages]);

    const [installed, setInstalled] = useState<
        { name: string; description: string; directory?: string; remote: string }[]
    >([]);
    const [manualUrl, setManualUrl] = useState("");

    const nativeOk = !!getUserpluginNative()?.initPluginInstall;

    const refreshInstalled = () => {
        void (async () => {
            const N = getUserpluginNative();
            if (!N?.getUserplugins) {
                setInstalled([]);
                return;
            }
            try {
                setInstalled(await N.getUserplugins());
            } catch {
                setInstalled([]);
            }
        })();
    };

    useEffect(() => {
        refreshInstalled();
    }, [channelId]);

    const isInstalledDir = (repoNameGuess: string) =>
        installed.some(p => p.directory === repoNameGuess || p.remote?.includes(repoNameGuess));

    const [rect, setRect] = useState(findChatRect);
    useLayoutEffect(() => {
        const update = () => setRect(findChatRect());
        update();
        window.addEventListener("resize", update);
        let ro: ResizeObserver | undefined;
        const main = document.querySelector("main");
        if (main) {
            ro = new ResizeObserver(update);
            ro.observe(main);
        }
        const id = window.setInterval(update, 400);
        return () => {
            window.removeEventListener("resize", update);
            window.clearInterval(id);
            ro?.disconnect();
        };
    }, []);

    if (!allowOverlay) return null;

    return ReactDOM.createPortal(
        <div
            className="vc-cpm-shell"
            style={{
                top: rect.top,
                left: rect.left,
                width: rect.width,
                height: rect.height
            }}
        >
            <div className="vc-cpm-backdrop" aria-hidden />
            <div className="vc-cpm-backdrop-glow" aria-hidden />
            <div className="vc-cpm-panel">
                <div className="vc-cpm-inner">
                    <header className="vc-cpm-hero">
                        <div className="vc-cpm-hero-visual" aria-hidden>
                            <svg className="vc-cpm-hero-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path
                                    d="M8 6h6l2 4h6L30 18v8H8V6Z"
                                    stroke="currentColor"
                                    strokeWidth="1.75"
                                    strokeLinejoin="round"
                                    opacity=".9"
                                />
                                <path d="M8 26H4v-8h4M12 14h8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" opacity=".55" />
                            </svg>
                        </div>
                        <div className="vc-cpm-hero-text">
                            <div className="vc-cpm-badge-row">
                                <span className="vc-cpm-badge vc-cpm-badge--accent">Plugin manager</span>
                                <span className="vc-cpm-badge vc-cpm-badge--muted">#{channelId.slice(-6)}</span>
                                <span className={nativeOk ? "vc-cpm-badge vc-cpm-badge--ok" : "vc-cpm-badge vc-cpm-badge--warn"}>
                                    {nativeOk ? "Installer ready" : "Installer unavailable"}
                                </span>
                            </div>
                            <Heading tag="h1" className="vc-cpm-title">
                                Userplugins
                            </Heading>
                            <p className="vc-cpm-sub">
                                Clone trusted repos into your <span className="vc-cpm-sub-em">src/userplugins</span> folder — same URL rules as
                                Settings → UserPlugins. Build a live catalog from messages below.
                            </p>
                        </div>
                    </header>

                    {!nativeOk && (
                        <div className="vc-cpm-alert">
                            <Notice.Warning>
                                Clone / uninstall needs the <strong>UserpluginInstaller</strong> native module (Equicord Desktop / Equibop). Enable
                                that plugin and restart if you still see this after an update.
                            </Notice.Warning>
                        </div>
                    )}

                    <section className="vc-cpm-section">
                        <div className="vc-cpm-section-head">
                            <span className="vc-cpm-section-kicker">Quick install</span>
                            <h2 className="vc-cpm-section-title">Install from URL</h2>
                            <p className="vc-cpm-section-desc">Paste a GitHub, GitLab, Codeberg, or nin0.dev clone link.</p>
                        </div>
                        <div className="vc-cpm-install-card">
                            <div className="vc-cpm-input-row">
                                <label className="vc-cpm-url-field">
                                    <span className="vc-cpm-url-label">Repository URL</span>
                                    <input
                                        className="vc-cpm-input"
                                        placeholder="https://github.com/owner/repo"
                                        spellCheck={false}
                                        autoComplete="off"
                                        value={manualUrl}
                                        onChange={e => setManualUrl(e.currentTarget.value)}
                                    />
                                </label>
                                <div className="vc-cpm-install-actions">
                                    <Button
                                        className="vc-cpm-btn-primary"
                                        onClick={() => {
                                            void runInstall(manualUrl, refreshInstalled);
                                        }}
                                    >
                                        Install plugin
                                    </Button>
                                    <Button
                                        look={Button.Looks.OUTLINED}
                                        className="vc-cpm-btn-secondary"
                                        onClick={() => {
                                            try {
                                                OpenSettingsModule.openUserSettings("vencord_userplugins_panel");
                                            } catch {
                                                showToast("Could not open UserPlugins settings.", Toasts.Type.FAILURE);
                                            }
                                        }}
                                    >
                                        UserPlugins settings
                                    </Button>
                                    <Button
                                        look={Button.Looks.OUTLINED}
                                        className="vc-cpm-btn-secondary"
                                        onClick={() => {
                                            Alerts.show({
                                                title: "Restart client",
                                                body: "Restart Discord to apply newly installed userplugins and settings (enable plugins in UserPlugins first if needed).",
                                                confirmText: "Restart",
                                                cancelText: "Cancel",
                                                onConfirm: () => relaunch()
                                            });
                                        }}
                                    >
                                        Restart client
                                    </Button>
                                </div>
                            </div>
                        </div>
                    </section>

                    <section className="vc-cpm-section">
                        <div className="vc-cpm-section-head">
                            <span className="vc-cpm-section-kicker">Channel catalog</span>
                            <h2 className="vc-cpm-section-title">
                                From messages <em className="vc-cpm-count">{catalog.length}</em>
                            </h2>
                            <p className="vc-cpm-section-desc">Parsed from this channel&apos;s message history (JSON blocks, PLUGIN lines, or bare URLs).</p>
                        </div>
                        {catalog.length === 0 ? (
                            <div className="vc-cpm-empty">
                                <span className="vc-cpm-empty-icon" aria-hidden>
                                    ∅
                                </span>
                                <p className="vc-cpm-empty-title">No entries yet</p>
                                <p className="vc-cpm-empty-text">
                                    Post a JSON catalog, a <code>PLUGIN {"{...}"}</code> line, or paste supported clone URLs in separate messages.
                                </p>
                            </div>
                        ) : (
                            <div className="vc-cpm-catalog-grid">
                                {catalog.map((entry, i) => {
                                    const idpl = entry.url.includes("plugins.nin0.dev") ? 1 : 0;
                                    const m = entry.url.match(CLONE_LINK_REGEX);
                                    const dirGuess = m ? (m[[3, 6][idpl]] as string) : "";
                                    const installedHere = dirGuess && isInstalledDir(dirGuess);
                                    return (
                                        <article key={`${entry.url}-${i}`} className="vc-cpm-card vc-cpm-card--catalog">
                                            <div className="vc-cpm-card-top">
                                                <span className="vc-cpm-card-icon" aria-hidden>
                                                    ◆
                                                </span>
                                                <div className="vc-cpm-card-body">
                                                    <h3>{entry.title}</h3>
                                                    {entry.description ? <p>{entry.description}</p> : null}
                                                    <code className="vc-cpm-url">{entry.url}</code>
                                                </div>
                                            </div>
                                            <div className="vc-cpm-card-actions">
                                                <Button
                                                    className="vc-cpm-btn-primary"
                                                    disabled={!nativeOk || installedHere}
                                                    onClick={() => void runInstall(entry.url, refreshInstalled)}
                                                >
                                                    {installedHere ? "Installed" : "Install"}
                                                </Button>
                                                <Button look={Button.Looks.LINK} onClick={() => void navigator.clipboard?.writeText(entry.url)}>
                                                    Copy
                                                </Button>
                                            </div>
                                        </article>
                                    );
                                })}
                            </div>
                        )}
                    </section>

                    <section className="vc-cpm-section vc-cpm-section--installed">
                        <div className="vc-cpm-section-head">
                            <span className="vc-cpm-section-kicker">This client</span>
                            <h2 className="vc-cpm-section-title">
                                Installed <em className="vc-cpm-count">{installed.length}</em>
                            </h2>
                            <p className="vc-cpm-section-desc">Folders discovered via UserpluginInstaller — enable &amp; manage from settings.</p>
                        </div>
                        {installed.length === 0 ? (
                            <div className="vc-cpm-empty vc-cpm-empty--soft">
                                <span className="vc-cpm-empty-icon" aria-hidden>
                                    📂
                                </span>
                                <p className="vc-cpm-empty-title">Nothing cloned yet</p>
                                <p className="vc-cpm-empty-text">After a successful install, hit refresh — or open UserPlugins settings.</p>
                            </div>
                        ) : (
                            <div className="vc-cpm-catalog-grid">
                                {installed.map(p => (
                                    <article key={p.directory ?? p.name} className="vc-cpm-card vc-cpm-card--installed">
                                        <div className="vc-cpm-card-top">
                                            <span className="vc-cpm-card-icon vc-cpm-card-icon--check" aria-hidden>
                                                ✓
                                            </span>
                                            <div className="vc-cpm-card-body">
                                                <h3>{p.name}</h3>
                                                <p>{p.description || "—"}</p>
                                                <code className="vc-cpm-url">{p.remote}</code>
                                            </div>
                                        </div>
                                        <div className="vc-cpm-card-actions">
                                            <Button
                                                look={Button.Looks.OUTLINED}
                                                className="vc-cpm-btn-secondary"
                                                onClick={() => {
                                                    try {
                                                        OpenSettingsModule.openUserSettings("vencord_userplugins_panel");
                                                    } catch {
                                                        /* noop */
                                                    }
                                                }}
                                            >
                                                Settings
                                            </Button>
                                            <Button color={Button.Colors.RED} onClick={() => void runUninstall(p.directory, refreshInstalled)}>
                                                Remove…
                                            </Button>
                                        </div>
                                    </article>
                                ))}
                            </div>
                        )}
                        <div className="vc-cpm-refresh-row">
                            <Button size="sm" look={Button.Looks.OUTLINED} onClick={() => refreshInstalled()}>
                                Refresh installed list
                            </Button>
                        </div>
                    </section>
                </div>
            </div>
        </div>,
        document.body
    );
}

function ChannelPluginManagerRoot() {
    const { channelId: configured } = settings.use(["channelId"]);
    const selected = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getChannelId() ?? "");
    const target = configured.trim();
    const active = selected === target && target.length > 0;
    if (!active) return null;
    return (
        <ErrorBoundary noop>
            <PluginManagerOverlay channelId={target} />
        </ErrorBoundary>
    );
}

let reactRoot: Root | null = null;
let hostEl: HTMLDivElement | null = null;

function mountApp() {
    if (reactRoot) return;
    hostEl = document.createElement("div");
    hostEl.id = "vc-channel-plugin-manager-root";
    document.body.appendChild(hostEl);
    reactRoot = createRoot(hostEl);
    reactRoot.render(<ChannelPluginManagerRoot />);
}

function unmountApp() {
    reactRoot?.unmount();
    reactRoot = null;
    hostEl?.remove();
    hostEl = null;
}

export default definePlugin({
    name: "ChannelPluginManager",
    description:
        "In one channel, replaces the chat area with a userplugin manager: paste clone URLs, install via UserpluginInstaller, and load a catalog from channel messages (JSON or links). Client-only UI overlay.",
    tags: ["Utility", "Dev"],
    authors: [{ name: "ChannelPluginManager", id: 0n, badge: false }],

    settings,

    settingsAboutComponent: () => (
        <Notice.Info>
            <p>
                Set the <strong>channel ID</strong> (default <code>{DEFAULT_CHANNEL_ID}</code>). Open that channel to see the manager. Git clone
                URLs must match the same patterns as Settings → UserPlugins (GitHub, GitLab, Codeberg, git.nin0.dev, plugins.nin0.dev).
            </p>
            <p style={{ marginTop: 8 }}>
                The overlay <strong>does not show on top of settings or modals</strong> — it hides while User Settings, Vencord settings, or
                dialogs are open, then returns when you close them.
            </p>
            <p style={{ marginTop: 8 }}>
                Requires the <strong>UserpluginInstaller</strong> Equicord plugin with native helpers for clone / uninstall. Post a JSON catalog in
                the channel to populate the list, or type a URL under “Install from URL”.
            </p>
            <p style={{ marginTop: 10 }}>
                <strong>Example message</strong> to paste in that channel (replace the URL with a real repo you trust):
            </p>
            <pre
                style={{
                    whiteSpace: "pre-wrap",
                    fontSize: 12,
                    padding: 10,
                    borderRadius: 8,
                    background: "var(--background-secondary)",
                    overflow: "auto",
                    maxHeight: 180
                }}
            >
                {`{"plugins":[
  {
    "title": "My userplugin",
    "description": "Optional blurb",
    "url": "https://github.com/OWNER/REPO"
  }
]}`}
            </pre>
        </Notice.Info>
    ),

    start() {
        enableStyle(managedStyle);
        mountApp();
    },

    stop() {
        unmountApp();
        disableStyle(managedStyle);
    }
});
