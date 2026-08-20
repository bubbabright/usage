// Ollama Cloud Usage — GNOME Shell panel indicator.
//
// A THIN CLIENT of usage-daemon (github.com/bubbabright/usage-daemon). It reads
// the daemon's normalized snapshot over localhost HTTP and renders it. It never
// touches the ollama.com cookie or scrapes HTML — the daemon owns all of that.
//
// CONTRACT = the daemon's `windows[]` descriptor. Each window is a "meter"
// descriptor `{id, label, pct, color, resets_at, will_deplete}` (REFACTOR-1's
// meter template). The panel renders ONE bar per descriptor, generically — no
// hardcoded session/weekly. A new window from the daemon just appears. Claude,
// Grok, ollama and the daemon all conform to this same shape.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TRACK_W = 46; // px width of a panel bar track
const OLLAMA_URL = 'https://ollama.com/settings';

function resetsIn(iso) {
    if (!iso)
        return '';
    const ms = Date.parse(iso) - Date.now();
    if (Number.isNaN(ms))
        return '';
    if (ms <= 0)
        return 'Resets now';
    const mins = Math.round(ms / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h >= 24)
        return `Resets in ${Math.floor(h / 24)}d ${h % 24}h`;
    if (h > 0)
        return `Resets in ${h}h ${m}m`;
    return `Resets in ${m}m`;
}

function fmtPct(pct) {
    if (pct == null)
        return '-';
    return (Number.isInteger(pct) ? pct : pct.toFixed(1)) + '%';
}

// Panel letter for a descriptor: explicit override, else first letter of label.
function letterFor(win) {
    return (win.letter ?? win.label ?? win.id ?? '?').toString().charAt(0).toUpperCase();
}

const OllamaUsageIndicator = GObject.registerClass(
class OllamaUsageIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Ollama Cloud Usage');
        this._extension = extension;
        this._settings = extension.getSettings();
        this._session = new Soup.Session({timeout: 10});
        this._bars = new Map(); // window.id -> bar actors
        this._rows = new Map(); // window.id -> menu row

        this._buildPanel();
        this._buildMenu();

        this._settingsChanged = this._settings.connect('changed', () => {
            this._applyVisibility();
            this._restartTimer();
        });

        this._applyVisibility();
        this._fetch();
        this._restartTimer();
    }

    // ---- panel ----
    _buildPanel() {
        this._panelBox = new St.BoxLayout({
            style_class: 'panel-status-menu-box ollama-panel',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._panelBox);

        const iconPath = GLib.build_filenamev([this._extension.path, 'assets', 'ollama-white.svg']);
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(iconPath),
            style_class: 'system-status-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelBox.add_child(this._icon);

        this._barsBox = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        this._panelBox.add_child(this._barsBox);

        this._tierLabel = new St.Label({
            text: '',
            style_class: 'ollama-tier',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelBox.add_child(this._tierLabel);
    }

    _makeBar() {
        const box = new St.BoxLayout({
            style_class: 'ollama-bar-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const label = new St.Label({
            style_class: 'ollama-bar-letter',
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Never truncate the glyph — a too-narrow fixed width makes St.Label
        // ellipsize 'W' down to '…'. Fixed width lives in CSS (bars stay aligned);
        // this just guarantees the wide glyph renders whole.
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        // St.Widget container + child (mirrors the working Claude/Grok bars).
        // NOT St.Bin with x_fill/St.Align — that is dead St 1.0 API on GNOME 46+
        // and throws when constructed.
        // Mirror the working Claude/Grok bars: plain St.Widget container + child,
        // both with an explicit equal height in CSS. No BinLayout / y_expand — a
        // BinLayout centers the fill vertically (the "color band in the middle"
        // bug). Default layout anchors the child top-left; inline width makes it
        // fill left-to-right at full track height.
        const track = new St.Widget({
            style_class: 'ollama-bar-track',
            style: `width:${TRACK_W}px;`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const fill = new St.Widget({style_class: 'ollama-bar-fill'});
        track.add_child(fill);
        box.add_child(label);
        box.add_child(track);
        return {box, label, track, fill};
    }

    // Ensure a bar exists for a descriptor and update it from that descriptor.
    _syncBar(win) {
        let bar = this._bars.get(win.id);
        if (!bar) {
            bar = this._makeBar();
            this._bars.set(win.id, bar);
            this._barsBox.add_child(bar.box);
        }
        bar.label.text = letterFor(win);
        const pct = win.pct == null ? null : Math.max(0, Math.min(100, win.pct));
        const px = pct == null ? 0 : Math.round((pct / 100) * TRACK_W);
        bar.fill.style = `width:${px}px; background-color:${win.color ?? '#888'};`;
        const blink = win.will_deplete &&
            this._settings.get_boolean('warn-on-projected-depletion');
        bar.track[blink ? 'add_style_class_name' : 'remove_style_class_name']('ollama-bar-warn');
        bar.box.visible = this._barVisible(win.id);
        bar.label.visible = this._settings.get_boolean('show-bar-labels');
    }

    // Per-descriptor visibility. The two documented windows keep user toggles;
    // any other descriptor the daemon publishes is shown by default.
    _barVisible(id) {
        if (id === 'session')
            return this._settings.get_boolean('show-session-bar');
        if (id === 'weekly')
            return this._settings.get_boolean('show-weekly-bar');
        return true;
    }

    _applyVisibility() {
        const s = this._settings;
        this._icon.visible = s.get_boolean('show-icon');
        this._tierLabel.visible = s.get_boolean('show-tier');
        this._barsBox.orientation = s.get_boolean('stack-panel-bars')
            ? Clutter.Orientation.VERTICAL
            : Clutter.Orientation.HORIZONTAL;
        const showLetter = s.get_boolean('show-bar-labels');
        for (const [id, bar] of this._bars) {
            bar.box.visible = this._barVisible(id);
            bar.label.visible = showLetter;
        }
    }

    // ---- menu ----
    _buildMenu() {
        this._menuHeader = new PopupMenu.PopupMenuItem('Ollama Cloud Usage', {
            reactive: false,
            style_class: 'ollama-menu-header',
        });
        this._menuTier = new St.Label({text: '', style_class: 'ollama-menu-tier'});
        this._menuHeader.add_child(this._menuTier);
        this.menu.addMenuItem(this._menuHeader);

        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._statusItem.label.style_class = 'ollama-menu-status';
        this.menu.addMenuItem(this._statusItem);
        this._statusItem.visible = false;

        // dynamic per-window section (rows created from descriptors)
        this._windowSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._windowSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refresh = new PopupMenu.PopupMenuItem('Refresh now');
        refresh.connect('activate', () => this._refreshNow());
        this.menu.addMenuItem(refresh);

        const report = new PopupMenu.PopupMenuItem('Open usage report');
        report.connect('activate', () =>
            this._openUri(`${this._daemonUrl()}/?provider=ollama`));
        this.menu.addMenuItem(report);

        const site = new PopupMenu.PopupMenuItem('Open ollama.com Usage…');
        site.connect('activate', () => this._openUri(OLLAMA_URL));
        this.menu.addMenuItem(site);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settings = new PopupMenu.PopupMenuItem('Settings');
        settings.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(settings);
    }

    _syncRow(win) {
        let row = this._rows.get(win.id);
        if (!row) {
            row = new PopupMenu.PopupMenuItem('', {reactive: false});
            this._rows.set(win.id, row);
            this._windowSection.addMenuItem(row);
        }
        const reset = resetsIn(win.resets_at);
        row.label.text = `${win.label ?? win.id}   ${fmtPct(win.pct)}${reset ? '   ' + reset : ''}`;
        return row;
    }

    // ---- data ----
    _daemonUrl() {
        return this._settings.get_string('daemon-url').replace(/\/+$/, '');
    }

    _restartTimer() {
        if (this._timer)
            GLib.source_remove(this._timer);
        const secs = this._settings.get_int('poll-interval');
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
            this._fetch();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _fetch() {
        const msg = Soup.Message.new('GET', `${this._daemonUrl()}/usage/ollama/current`);
        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                if (msg.get_status() !== Soup.Status.OK) {
                    this._renderOffline('daemon returned ' + msg.get_status());
                    return;
                }
                const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                this._render(data);
            } catch (_e) {
                this._renderOffline('Daemon offline');
            }
        });
    }

    _refreshNow() {
        const msg = Soup.Message.new('POST', `${this._daemonUrl()}/usage/ollama/refresh`);
        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                this._render(data);
            } catch (_e) {
                this._fetch();
            }
        });
    }

    // Render straight from the descriptor array — this is the contract.
    _render(snap) {
        const windows = snap?.windows ?? [];
        const ids = new Set(windows.map(w => w.id));

        for (const win of windows) {
            this._syncBar(win);
            this._syncRow(win);
        }
        // drop actors for descriptors the daemon no longer publishes
        for (const [id, bar] of this._bars) {
            if (!ids.has(id)) {
                bar.box.destroy();
                this._bars.delete(id);
            }
        }
        for (const [id, row] of this._rows) {
            if (!ids.has(id)) {
                row.destroy();
                this._rows.delete(id);
            }
        }

        const tier = snap?.tier && snap.tier !== 'unknown' ? snap.tier : '';
        this._tierLabel.text = tier;
        this._menuTier.text = tier;

        const stale = snap?.stale;
        const status = snap?.status ?? 'ok';
        if (status === 'ok' && !stale) {
            this._statusItem.visible = false;
            this._panelBox.remove_style_class_name('ollama-stale');
        } else {
            this._statusItem.visible = true;
            this._statusItem.label.text =
                status === 'auth_expired'
                    ? 'ollama.com session expired — paste cookie in Settings'
                    : status === 'rate_limited'
                        ? 'Rate limited — showing last known'
                        : 'Stale — showing last known';
            this._panelBox.add_style_class_name('ollama-stale');
        }
    }

    _renderOffline(msg) {
        this._statusItem.visible = true;
        this._statusItem.label.text = msg;
        this._panelBox.add_style_class_name('ollama-stale');
    }

    _openUri(uri) {
        try {
            Gio.AppInfo.launch_default_for_uri(uri, null);
        } catch (_e) {
            Main.notifyError('Ollama Cloud Usage', `Could not open ${uri}`);
        }
    }

    destroy() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        if (this._settingsChanged) {
            this._settings.disconnect(this._settingsChanged);
            this._settingsChanged = null;
        }
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        super.destroy();
    }
});

export default class OllamaCloudUsageExtension extends Extension {
    enable() {
        this._indicator = new OllamaUsageIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
