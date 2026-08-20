import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const API_URL = 'https://api.anthropic.com/api/oauth/usage';
// Anthropic puts requests without this UA in an aggressively rate-limited
// bucket that returns persistent 429s regardless of interval (see
// anthropics/claude-code#31021, #30930, #31637).
const CLAUDE_USER_AGENT = 'claude-code/2.1.0';
const CACHE_DIR_NAME = 'claude-code-usage';
const HISTORY_FILE = 'history.jsonl';
const MAX_HISTORY_LINES = 20000; // ~70 days at a 5-minute poll interval
const HISTORY_TRIM_EVERY = 200;
const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';
const PANEL_ICON_BASE_SIZE = 18;
// Stacked-cluster baseline (factor 1.0) — raised from the old fixed 9/7/2px
// so the two-row cluster roughly matches a standard panel row's height
// instead of sitting shorter than neighbouring icons even before scaling.
const STACKED_LABEL_BASE_PX = 11;
const STACKED_BAR_HEIGHT_BASE_PX = 9;
const STACKED_ROW_MARGIN_BASE_PX = 3;
// Projected-depletion alarm (HANDOFF-6): logo is master flash light;
// cause bars flash until snoozed, then hold solid red. In-memory only.
const WARNING_BLINK_MS = 700;
const LOGO_ALARM_EFFECT_NAME = 'logo-alarm-colorize';
// #ef4444 — matches *-panel-progress-bar-warning (GNOME 48: Cogl.Color, not Clutter.Color)
const LOGO_ALARM_TINT = {red: 239, green: 68, blue: 68, alpha: 255};

function isColorSchemeDark(interfaceSettings) {
    const scheme = interfaceSettings.get_string('color-scheme');
    if (scheme === 'prefer-dark')
        return true;
    if (scheme === 'prefer-light')
        return false;
    const stScheme = St.Settings.get().color_scheme;
    if (stScheme === St.SettingsColorScheme.PREFER_DARK)
        return true;
    if (stScheme === St.SettingsColorScheme.PREFER_LIGHT)
        return false;
    return Main.panel.has_style_class_name('dark');
}

function cacheDir() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), CACHE_DIR_NAME]);
}

function historyPath() {
    return GLib.build_filenamev([cacheDir(), HISTORY_FILE]);
}

function ensureCacheDir() {
    const dir = Gio.File.new_for_path(cacheDir());
    try {
        dir.make_directory_with_parents(null);
    } catch (e) {
        // exists or race — fine
    }
}

function leastSquaresSlope(points) {
    const n = points.length;
    if (n < 2)
        return null;
    let sumT = 0;
    let sumY = 0;
    let sumTT = 0;
    let sumTY = 0;
    for (const p of points) {
        sumT += p.t;
        sumY += p.y;
        sumTT += p.t * p.t;
        sumTY += p.t * p.y;
    }
    const denom = n * sumTT - sumT * sumT;
    if (denom === 0)
        return null;
    return (n * sumTY - sumT * sumY) / denom;
}

const ClaudeUsageIndicator = GObject.registerClass(
{GTypeName: 'ClaudeCodeUsage_ClaudeUsageIndicator'},
class ClaudeUsageIndicator extends PanelMenu.Button {
    _init(extensionPath, settings, openPreferences, metadata) {
        super._init(0.0, 'Claude Usage Indicator');

        this._extensionPath = extensionPath;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._metadata = metadata;
        this._session = this._createSession();
        this._cancellable = new Gio.Cancellable();
        this._lastKnownData = null;
        this._extraLimitRows = new Map();
        this._fiveHourWillDeplete = false;
        this._sevenDayWillDeplete = false;
        this._fiveHourBlinkId = null;
        this._sevenDayBlinkId = null;
        // HANDOFF-6: shared snooze latch + logo master-alarm blinker
        this._warningAck = false;
        this._logoBlinkId = null;
        this._logoColorizeOn = false;
        this._consecutiveFailures = 0;
        this._backoffUntilMs = 0;

        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });

        const iconPath = GLib.build_filenamev([this._extensionPath, 'claude-icon-22.png']);
        const gicon = Gio.icon_new_for_string(iconPath);
        this._icon = new St.Icon({
            gicon: gicon,
            style_class: 'claude-icon',
            icon_size: PANEL_ICON_BASE_SIZE,
        });
        this._box.add_child(this._icon);

        // Each metric's bar + label live in their own row so the two rows can
        // be re-parented into a horizontal (side-by-side) or vertical
        // (stacked) container without rebuilding the widgets themselves.
        this._barsBox = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._barsBox);

        this._fiveHourRow = new St.BoxLayout({
            style_class: 'panel-bar-row',
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Row layout is [tag][bar][percent] — the leading tag label sits
        // left of the bar so it never blends into the percent digits (was
        // "5 35%" read as one number when the tag was a glued-on prefix).
        this._fiveHourPanelTag = new St.Label({
            text: '5',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-usage-label claude-panel-label-five-hour claude-panel-tag',
        });
        this._fiveHourRow.add_child(this._fiveHourPanelTag);

        this._fiveHourPanelProgressBg = new St.Widget({
            style_class: 'claude-panel-progress-bg',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._fiveHourPanelProgressBar = new St.Widget({
            style_class: 'claude-panel-progress-bar-five-hour',
        });
        this._fiveHourPanelProgressBg.add_child(this._fiveHourPanelProgressBar);
        this._fiveHourRow.add_child(this._fiveHourPanelProgressBg);

        // Each metric gets its own colored label (matches its bar's identity
        // color) so both 5h and 7d percentages are distinguishable in text
        // mode, not just one ambiguous white number.
        this._fiveHourPanelLabel = new St.Label({
            text: '...',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-usage-label claude-panel-label-five-hour claude-panel-percent',
        });
        this._fiveHourRow.add_child(this._fiveHourPanelLabel);
        this._barsBox.add_child(this._fiveHourRow);

        this._sevenDayRow = new St.BoxLayout({
            style_class: 'panel-bar-row',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._sevenDayPanelTag = new St.Label({
            text: 'W',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-usage-label claude-panel-label-seven-day claude-panel-tag',
        });
        this._sevenDayRow.add_child(this._sevenDayPanelTag);

        this._sevenDayPanelProgressBg = new St.Widget({
            style_class: 'claude-panel-progress-bg',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._sevenDayPanelProgressBar = new St.Widget({
            style_class: 'claude-panel-progress-bar-seven-day',
        });
        this._sevenDayPanelProgressBg.add_child(this._sevenDayPanelProgressBar);
        this._sevenDayRow.add_child(this._sevenDayPanelProgressBg);

        this._sevenDayPanelLabel = new St.Label({
            text: '...',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-usage-label claude-panel-label-seven-day claude-panel-percent',
        });
        this._sevenDayRow.add_child(this._sevenDayPanelLabel);
        this._barsBox.add_child(this._sevenDayRow);

        this.add_child(this._box);

        this._lastFetchAtMs = null;
        this._hoverTooltip = new St.Label({
            style_class: 'claude-hover-tooltip',
            visible: false,
        });
        Main.layoutManager.uiGroup.add_child(this._hoverTooltip);
        this.connect('enter-event', () => this._showHoverTooltip());
        this.connect('leave-event', () => this._hideHoverTooltip());

        this._createMenu();

        this._interfaceSettings = new Gio.Settings({schema_id: INTERFACE_SCHEMA});
        this._textScalingId = this._interfaceSettings.connect(
            'changed::text-scaling-factor', () => this._applyPanelSizing());
        this._colorSchemeId = this._interfaceSettings.connect(
            'changed::color-scheme', () => this._applyColorScheme());
        this._stColorSchemeId = St.Settings.get().connect(
            'notify::color-scheme', () => this._applyColorScheme());

        this._updateDisplayMode();
        this._updateBarLayout();
        this._updateIconVisibility();
        this._updateIconStyle();
        this._applyPanelSizing();
        this._applyColorScheme();

        this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
            if (key === 'refresh-interval') {
                this._restartTimer();
            } else if (key === 'show-icon') {
                this._updateIconVisibility();
            } else if (key === 'proxy-url') {
                this._recreateSession();
            } else if (key === 'icon-style') {
                this._updateIconStyle();
            } else if (key === 'show-panel-bar' || key === 'show-panel-percent' ||
                       key === 'show-five-hour' || key === 'show-seven-day' ||
                       key === 'show-bar-labels') {
                this._updateDisplayMode();
            } else if (key === 'stack-panel-bars') {
                this._updateBarLayout();
            } else if (key === 'warn-on-projected-depletion') {
                this._applyWarningState();
            } else if (key === 'hidden-extra-limits') {
                // Visibility for extra-limit rows is now managed from the
                // Settings window (prefs.js), not the dropdown itself — react
                // to the shared GSettings key changing from that process.
                this._applyExtraLimitVisibility();
            } else if (key === 'refresh-trigger') {
                // Fired by the manual "Force Token Refresh" button in
                // Settings — pull usage now instead of waiting up to
                // refresh-interval seconds for the next scheduled poll.
                this._refreshUsage();
            }
        });

        // history.jsonl outlives this process — seed last-known-good from
        // disk immediately so a fresh extension load (disable/enable,
        // logout/login) shows real numbers right away instead of blanking
        // out until the first live fetch returns. Only truly empty history
        // (the very first run ever) has nothing to show here.
        this._loadHistoryFromDisk();
        this._seedLastKnownFromHistory();

        this._refreshUsage();
        this._startTimer();
    }

    _seedLastKnownFromHistory() {
        const history = this._getHistory();
        if (!history.length)
            return;

        const last = history[history.length - 1];
        this._lastKnownData = {
            five_hour: {utilization: last.five_hour ?? 0},
            seven_day: {utilization: last.seven_day ?? 0},
        };
        this._staleBanner.set_text('⚠ Last known usage — not fetched yet this session');
        this._staleBannerItem.actor.visible = true;
        this._updateDisplay(this._lastKnownData, {stale: true});
    }

    // Element visibility is data-driven from the Display page toggles:
    //   show-five-hour / show-seven-day — the whole metric row on/off
    //   show-panel-bar                  — the progress bar (both rows)
    //   show-panel-percent              — the percent label (both rows)
    //   show-bar-labels                 — the leading tag letter (both rows)
    // Each is independent, so hiding one never strands another with no control
    // that visibly restores it.
    _updateDisplayMode() {
        const showFiveHour = this._settings.get_boolean('show-five-hour');
        const showSevenDay = this._settings.get_boolean('show-seven-day');
        const showBar = this._settings.get_boolean('show-panel-bar');
        const showPercent = this._settings.get_boolean('show-panel-percent');
        const showLabels = this._settings.get_boolean('show-bar-labels');

        this._fiveHourRow.visible = showFiveHour;
        this._sevenDayRow.visible = showSevenDay;

        this._fiveHourPanelProgressBg.visible = showBar;
        this._sevenDayPanelProgressBg.visible = showBar;

        this._fiveHourPanelLabel.visible = showPercent;
        this._sevenDayPanelLabel.visible = showPercent;

        this._fiveHourPanelTag.visible = showLabels;
        this._sevenDayPanelTag.visible = showLabels;
    }

    _updateBarLayout() {
        const stacked = this._settings.get_boolean('stack-panel-bars');
        const rowAlign = stacked ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER;
        this._barsBox.vertical = stacked;
        this._barsBox.spacing = stacked ? 0 : 6;
        this._fiveHourRow.vertical = false;
        this._sevenDayRow.vertical = false;
        this._fiveHourRow.y_align = rowAlign;
        this._sevenDayRow.y_align = rowAlign;
        this._fiveHourPanelProgressBg.y_align = rowAlign;
        this._sevenDayPanelProgressBg.y_align = rowAlign;
        this._fiveHourPanelTag.y_align = rowAlign;
        this._sevenDayPanelTag.y_align = rowAlign;
        this._fiveHourPanelLabel.y_align = rowAlign;
        this._sevenDayPanelLabel.y_align = rowAlign;
        this._sevenDayRow.set_style(null);
        if (stacked)
            this._barsBox.add_style_class_name('panel-bars-stacked');
        else
            this._barsBox.remove_style_class_name('panel-bars-stacked');
        this._applyPanelSizing();
    }

    _updateIconVisibility() {
        const showIcon = this._settings.get_boolean('show-icon');
        if (showIcon) {
            this._icon.show();
        } else {
            this._icon.hide();
        }
    }

    _createSession() {
        const session = new Soup.Session();
        const proxyUrl = this._settings.get_string('proxy-url');

        if (proxyUrl && proxyUrl.trim() !== '') {
            const proxyResolver = Gio.SimpleProxyResolver.new(proxyUrl.trim(), null);
            session.set_proxy_resolver(proxyResolver);
        }

        return session;
    }

    _recreateSession() {
        if (this._session) {
            this._session.abort();
        }
        this._session = this._createSession();
        this._refreshUsage();
	}
    // Stacked cluster used to sit on frozen px (with the icon deliberately
    // pinned to compensate) so it stayed shorter than neighbouring panel
    // elements even at factor 1.0 and never grew under GNOME's Large Text.
    // Now every dimension — icon, label font, bar height, row gap — scales
    // together from the same `factor`, so nothing needs to be frozen.
    _applyPanelSizing() {
        const factor = this._interfaceSettings.get_double('text-scaling-factor') || 1.0;
        const stacked = this._settings.get_boolean('stack-panel-bars');

        this._icon.icon_size = Math.round(PANEL_ICON_BASE_SIZE * factor);

        const labels = [
            this._fiveHourPanelTag, this._fiveHourPanelLabel,
            this._sevenDayPanelTag, this._sevenDayPanelLabel,
        ];
        const bars = [
            this._fiveHourPanelProgressBg, this._fiveHourPanelProgressBar,
            this._sevenDayPanelProgressBg, this._sevenDayPanelProgressBar,
        ];

        if (!stacked) {
            for (const label of labels)
                label.set_style(null);
            for (const bar of bars)
                bar.set_style(null);
            this._sevenDayRow.set_style(null);
            return;
        }

        const labelPx = Math.round(STACKED_LABEL_BASE_PX * factor);
        const barPx = Math.round(STACKED_BAR_HEIGHT_BASE_PX * factor);
        const marginPx = Math.round(STACKED_ROW_MARGIN_BASE_PX * factor);

        const labelStyle = `font-size: ${labelPx}px; line-height: ${labelPx}px;`;
        for (const label of labels)
            label.set_style(labelStyle);

        const barStyle = `height: ${barPx}px;`;
        for (const bar of bars)
            bar.set_style(barStyle);

        this._sevenDayRow.set_style(`margin-top: ${marginPx}px;`);
    }

    _applyColorScheme() {
        const dark = isColorSchemeDark(this._interfaceSettings);
        const add = dark ? 'is-dark' : 'is-light';
        const remove = dark ? 'is-light' : 'is-dark';
        for (const actor of [this._box, this.menu?.box, this._hoverTooltip]) {
            if (!actor)
                continue;
            actor.remove_style_class_name(remove);
            actor.add_style_class_name(add);
        }
    }

    _updateIconStyle() {
        const style = this._settings.get_string('icon-style');
        const desatName = 'monochrome-desaturate';
        const brightName = 'monochrome-brightness';
        const hasEffect = this._icon.get_effect(desatName) !== null;

        if (style === 'monochrome' && !hasEffect) {
            this._icon.add_effect(new Clutter.DesaturateEffect({factor: 1.0, name: desatName}));
            const brightnessEffect = new Clutter.BrightnessContrastEffect({name: brightName});
            brightnessEffect.set_brightness_full(1, 1, 1);
            this._icon.add_effect(brightnessEffect);
        } else if (style !== 'monochrome' && hasEffect) {
            this._icon.remove_effect_by_name(desatName);
            this._icon.remove_effect_by_name(brightName);
        }
        // Colorize must sit *after* desaturate so the red tint survives
        // monochrome. Re-apply on top if mid-alarm flash phase.
        if (this._logoColorizeOn)
            this._applyLogoColorize(true);
    }

    _createMenu() {
        const headerBox = new St.BoxLayout({
            style_class: 'claude-menu-header',
            x_expand: true,
        });
        const headerTitle = new St.Label({
            text: 'Claude Code Usage',
            style_class: 'claude-menu-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.add_child(headerTitle);
        const refreshButton = new St.Button({
            style_class: 'claude-refresh-button',
            child: new St.Icon({icon_name: 'view-refresh-symbolic', icon_size: 14}),
        });
        refreshButton.connect('clicked', () => {
            // Manual refresh — bypass any active backoff, the user is
            // explicitly asking for a fresh number right now.
            this._backoffUntilMs = 0;
            this._refreshUsage();
        });
        headerBox.add_child(refreshButton);
        const headerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        headerItem.add_child(headerBox);
        this.menu.addMenuItem(headerItem);

        // Shown only while displaying cached numbers after a failed fetch
        // (e.g. expired token). Hidden during normal live operation.
        this._staleBanner = new St.Label({
            text: '',
            style_class: 'claude-stale-banner',
        });
        this._staleBannerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._staleBannerItem.add_child(this._staleBanner);
        this._staleBannerItem.actor.visible = false;
        this.menu.addMenuItem(this._staleBannerItem);

        const fiveHourBox = new St.BoxLayout({
            style_class: 'claude-usage-section',
            vertical: true,
        });
        const fiveHourHeader = new St.BoxLayout({ vertical: false });
        const fiveHourLabel = new St.Label({
            text: '5-Hour Usage',
            style_class: 'claude-section-title',
        });
        fiveHourHeader.add_child(fiveHourLabel);
        this._fiveHourPercent = new St.Label({
            text: '...',
            style_class: 'claude-percent-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        fiveHourHeader.add_child(this._fiveHourPercent);
        fiveHourBox.add_child(fiveHourHeader);

        const fiveHourProgressBg = new St.Widget({
            style_class: 'claude-progress-bg',
        });
        this._fiveHourProgressBar = new St.Widget({
            style_class: 'claude-progress-bar claude-bar-five-hour',
        });
        fiveHourProgressBg.add_child(this._fiveHourProgressBar);
        fiveHourBox.add_child(fiveHourProgressBg);

        this._fiveHourResetLabel = new St.Label({
            text: 'Resets: ...',
            style_class: 'claude-reset-label',
        });
        fiveHourBox.add_child(this._fiveHourResetLabel);

        const fiveHourItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        fiveHourItem.add_child(fiveHourBox);
        this.menu.addMenuItem(fiveHourItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const sevenDayBox = new St.BoxLayout({
            style_class: 'claude-usage-section',
            vertical: true,
        });
        const sevenDayHeader = new St.BoxLayout({ vertical: false });
        const sevenDayLabel = new St.Label({
            text: '7-Day Usage',
            style_class: 'claude-section-title',
        });
        sevenDayHeader.add_child(sevenDayLabel);
        this._sevenDayPercent = new St.Label({
            text: '...',
            style_class: 'claude-percent-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        sevenDayHeader.add_child(this._sevenDayPercent);
        sevenDayBox.add_child(sevenDayHeader);

        const sevenDayProgressBg = new St.Widget({
            style_class: 'claude-progress-bg',
        });
        this._sevenDayProgressBar = new St.Widget({
            style_class: 'claude-progress-bar claude-bar-seven-day',
        });
        sevenDayProgressBg.add_child(this._sevenDayProgressBar);
        sevenDayBox.add_child(sevenDayProgressBg);

        this._sevenDayResetLabel = new St.Label({
            text: 'Resets: ...',
            style_class: 'claude-reset-label',
        });
        sevenDayBox.add_child(this._sevenDayResetLabel);

        const sevenDayItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        sevenDayItem.add_child(sevenDayBox);
        this.menu.addMenuItem(sevenDayItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Populated dynamically from the API's `limits[]` array, so new
        // per-model/plan offerings (e.g. a scoped weekly limit for a new
        // model) show up automatically without a code change.
        this._extraLimitsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._extraLimitsSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Read fresh (free — local file, no network) each time the menu
        // opens, since the token may have refreshed independently since the
        // last poll (e.g. another running `claude` process refreshed it).
        this._tokenExpiryLabel = new St.Label({
            text: 'Token expires: ...',
            style_class: 'claude-reset-label',
        });
        const tokenExpiryItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        tokenExpiryItem.add_child(this._tokenExpiryLabel);
        this.menu.addMenuItem(tokenExpiryItem);

        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen)
                this._updateTokenExpiryLabel();
        });

        // HANDOFF-6: snooze quiets logo flash; cause stays solid red until clear
        this._snoozeWarningItem = new PopupMenu.PopupMenuItem('Snooze warning');
        this._snoozeWarningItem.connect('activate', () => {
            this._warningAck = true;
            this._applyWarningState();
        });
        this._snoozeWarningItem.actor.visible = false;
        this.menu.addMenuItem(this._snoozeWarningItem);

        const openReportItem = new PopupMenu.PopupMenuItem('Open usage report');
        openReportItem.connect('activate', () => this._openUsageReport());
        this.menu.addMenuItem(openReportItem);

        const exportCsvItem = new PopupMenu.PopupMenuItem('Export history (CSV)');
        exportCsvItem.connect('activate', () => this._exportHistoryCsv());
        this.menu.addMenuItem(exportCsvItem);

        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => {
            // openPreferences() is async (spawns the prefs process over
            // D-Bus) and can reject — e.g. a prefs window is already open —
            // which otherwise surfaces as an unhandled promise rejection in
            // the shell log instead of just... nothing happening.
            Promise.resolve(this._openPreferences()).catch(e => {
                console.error('Claude Usage: failed to open preferences:', e.message);
            });
        });
        this.menu.addMenuItem(settingsItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const aboutItem = new PopupMenu.PopupMenuItem('About');
        aboutItem.connect('activate', () => this._showAbout());
        this.menu.addMenuItem(aboutItem);
    }

    // Same template-injection approach as prefs.js's _generateReport —
    // duplicated rather than shared because the two files run in separate
    // GJS processes (Shell vs. prefs) with no common module loader between
    // them.
    _generateReport() {
        const templatePath = GLib.build_filenamev([this._extensionPath, 'report', 'usage-report.template.html']);
        const [ok, templateBytes] = Gio.File.new_for_path(templatePath).load_contents(null);
        if (!ok)
            throw new Error('report template not found');
        const template = new TextDecoder('utf-8').decode(templateBytes);

        const data = [...this._getHistory()].sort((a, b) => a.t - b.t);
        const html = template
            .replace('const USAGE_DATA = /*__USAGE_DATA__*/[];',
                `const USAGE_DATA = ${JSON.stringify(data)};`)
            .replace('const GENERATED_AT = /*__GENERATED_AT__*/0;',
                `const GENERATED_AT = ${Date.now()};`);

        ensureCacheDir();
        const outPath = GLib.build_filenamev([cacheDir(), 'usage-report.html']);
        GLib.file_set_contents(outPath, html);

        return GLib.filename_to_uri(outPath, null);
    }

    _openUsageReport() {
        try {
            const uri = this._generateReport();
            Gio.AppInfo.launch_default_for_uri(uri, null);
        } catch (e) {
            console.error('Claude Usage: failed to open usage report:', e.message);
            Main.notify('Claude Code Usage', `Could not open usage report: ${e.message}`);
        }
    }

    // No save dialog here — the Shell process doesn't host GTK file
    // choosers. Writes straight to Documents (or home as a fallback) using
    // the same filename scheme as prefs.js's Export CSV button.
    _exportHistoryCsv() {
        try {
            const data = [...this._getHistory()].sort((a, b) => a.t - b.t);
            const lines = ['timestamp,epoch_ms,five_hour,seven_day'];
            for (const d of data)
                lines.push(`${new Date(d.t).toISOString()},${d.t},${d.five_hour ?? ''},${d.seven_day ?? ''}`);

            const dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS) ??
                GLib.get_home_dir();
            const pad = n => String(n).padStart(2, '0');
            const d = new Date();
            const hours24 = d.getHours();
            const ampm = hours24 >= 12 ? 'PM' : 'AM';
            const hours12 = hours24 % 12 || 12;
            const name = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${d.getFullYear()}-` +
                `${pad(hours12)}-${pad(d.getMinutes())}-${ampm}-usage-history.csv`;
            const outPath = GLib.build_filenamev([dir, name]);
            GLib.file_set_contents(outPath, lines.join('\n') + '\n');
            Main.notify('Claude Code Usage', `Exported history to ${outPath}`);
        } catch (e) {
            console.error('Claude Usage: failed to export CSV:', e.message);
            Main.notify('Claude Code Usage', `Could not export CSV: ${e.message}`);
        }
    }

    _showAbout() {
        const version = this._metadata?.version ?? '?';
        const url = this._metadata?.url ?? '';
        Main.notify('Claude Code Usage', `Version ${version}\n${url}`);
    }

    _updateTokenExpiryLabel() {
        try {
            const configDir = GLib.getenv('CLAUDE_CONFIG_DIR') ??
                GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
            const credentialsPath = GLib.build_filenamev([configDir, '.credentials.json']);
            const file = Gio.File.new_for_path(credentialsPath);
            const [ok, contents] = file.load_contents(null);
            if (!ok)
                throw new Error('no credentials file');

            const json = JSON.parse(new TextDecoder('utf-8').decode(contents));
            const expiresAt = json.claudeAiOauth?.expiresAt;
            if (!expiresAt) {
                this._tokenExpiryLabel.set_text('Token expires: unknown');
                return;
            }

            const expired = expiresAt < Date.now();
            const when = this._formatResetTime(expiresAt);
            this._tokenExpiryLabel.set_text(
                expired ? 'Token expired' : `Token expires in ${when}`
            );
        } catch (e) {
            this._tokenExpiryLabel.set_text('Token expires: unknown');
        }
    }

    _startTimer() {
        const interval = this._settings.get_int('refresh-interval');
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._refreshUsage();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
    }

    _restartTimer() {
        this._stopTimer();
        this._startTimer();
    }

    // Exponential backoff on repeated 401/429/HTTP-error/network-failure —
    // otherwise a short refresh-interval (configurable down to 10s) just
    // keeps hammering an endpoint that's already telling us to back off.
    // Base grows from whatever the user configured (or 30s, whichever is
    // bigger) doubling per consecutive failure, capped at 30 minutes.
    // Resets to zero on the next success. This only skips the NETWORK
    // CALL — the regular timer tick still fires and the last-known display
    // (live, stale-marked, or quiet per the 429 case) is untouched either way.
    _registerFetchFailure() {
        this._consecutiveFailures++;
        const baseMs = Math.max(this._settings.get_int('refresh-interval') * 1000, 30000);
        const backoffMs = Math.min(baseMs * 2 ** (this._consecutiveFailures - 1), 30 * 60 * 1000);
        this._backoffUntilMs = Date.now() + backoffMs;
        console.error(`Claude Usage: backing off ${Math.round(backoffMs / 1000)}s after ${this._consecutiveFailures} consecutive failure(s)`);
    }

    _registerFetchSuccess() {
        this._consecutiveFailures = 0;
        this._backoffUntilMs = 0;
    }

    _refreshUsage() {
        if (Date.now() < this._backoffUntilMs)
            return; // skip this tick — still backing off from a recent failure

        const configDir = GLib.getenv('CLAUDE_CONFIG_DIR') ??
            GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
        const credentialsPath = GLib.build_filenamev([
            configDir,
            '.credentials.json',
        ]);

        const file = Gio.File.new_for_path(credentialsPath);
        file.load_contents_async(this._cancellable, (file, result) => {
            try {
                const [, contents] = file.load_contents_finish(result);
                const decoder = new TextDecoder('utf-8');
                const json = JSON.parse(decoder.decode(contents));
                const token = json.claudeAiOauth?.accessToken;

                if (!token) {
                    this._registerFetchFailure();
                    this._showError('No token', 'No credentials');
                    return;
                }

                this._fetchUsage(token);
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return; // destroyed mid-read — nothing left to update

                this._registerFetchFailure();
                console.error('Claude Usage: Failed to read credentials:', e.message);
                this._showError('No token', 'No credentials');
            }
        });
    }

    _fetchUsage(token) {
        const message = Soup.Message.new('GET', API_URL);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
        message.request_headers.append('User-Agent', CLAUDE_USER_AGENT);

        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);

                    if (message.status_code !== 200) {
                        this._registerFetchFailure();
                        if (message.status_code === 401) {
                            // Token genuinely expired — can't refresh, so mark
                            // the display stale (user is likely idle anyway).
                            this._showError('Auth', 'Token expired — run `claude` to refresh');
                        } else if (message.status_code === 429) {
                            // The usage endpoint rate-limits INDEPENDENTLY of
                            // token validity — a 429 says nothing about auth or
                            // the actual usage numbers (which barely move
                            // between polls). Keep showing the last values
                            // cleanly instead of alarming/dimming; the token is
                            // fine, so don't flip last-fetch-succeeded either.
                            this._keepLastKnownQuiet();
                        } else {
                            this._showError('Error', `HTTP ${message.status_code}`);
                        }
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const data = JSON.parse(decoder.decode(bytes.get_data()));

                    this._lastKnownData = data;
                    this._lastFetchAtMs = Date.now();
                    this._registerFetchSuccess();
                    this._settings.set_boolean('last-fetch-succeeded', true);
                    this._updateDisplay(data);
                    this._appendHistory(data.five_hour?.utilization ?? 0, data.seven_day?.utilization ?? 0);
                    this._flashPanel();
                } catch (e) {
                    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return; // destroyed mid-fetch — nothing left to update

                    this._registerFetchFailure();
                    console.error('Claude Usage: Failed to fetch usage:', e.message);
                    this._showError('Error', 'Fetch failed');
                }
            }
        );
    }

    _updateDisplay(data, {stale = false} = {}) {
        const fiveHour = data.five_hour?.utilization ?? 0;
        const sevenDay = data.seven_day?.utilization ?? 0;
        const suffix = stale ? ' (stale)' : '';

        this._setStaleStyle(stale);

        // Keep showing the last-known percentages even when stale (marked as
        // such) rather than a dead status word — if the token expired, the
        // user is probably idle and real usage is close to this anyway.
        this._fiveHourPanelLabel.set_text(`${Math.round(fiveHour)}%`);
        this._sevenDayPanelLabel.set_text(`${Math.round(sevenDay)}%`);

        this._updatePanelProgressBar(this._fiveHourPanelProgressBar, fiveHour);
        this._updatePanelProgressBar(this._sevenDayPanelProgressBar, sevenDay);

        this._fiveHourPercent.set_text(`${Math.round(fiveHour)}%${suffix}`);
        this._updateProgressBar(this._fiveHourProgressBar, fiveHour);

        this._sevenDayPercent.set_text(`${Math.round(sevenDay)}%${suffix}`);
        this._updateProgressBar(this._sevenDayProgressBar, sevenDay);

        if (data.five_hour?.resets_at) {
            this._fiveHourResetLabel.set_text(
                `Resets in ${this._formatResetTime(data.five_hour.resets_at)}`
            );
        }

        if (data.seven_day?.resets_at) {
            this._sevenDayResetLabel.set_text(
                `Resets in ${this._formatResetTime(data.seven_day.resets_at)}`
            );
        }

        this._updateExtraLimits(data.limits);

        this._fiveHourWillDeplete = this._computeWillDeplete('five_hour', data.five_hour?.resets_at, fiveHour);
        this._sevenDayWillDeplete = this._computeWillDeplete('seven_day', data.seven_day?.resets_at, sevenDay);
        this._applyWarningState();
    }

    // Least-squares burn rate (%/ms) over in-window history, projected
    // forward across the time remaining until this window's reset. A flat or
    // improving slope never warns; not enough span yet never warns either.
    _computeWillDeplete(key, resetsAtIso, currentPercent) {
        if (!resetsAtIso || currentPercent == null)
            return false;

        const resetsAtMs = new Date(resetsAtIso).getTime();
        const nowMs = Date.now();
        const msToReset = resetsAtMs - nowMs;
        if (msToReset <= 0)
            return false;

        const windowMs = key === 'five_hour' ? 5 * 3600 * 1000 : 7 * 24 * 3600 * 1000;
        const windowStart = resetsAtMs - windowMs;

        const inWindow = this._getHistory().filter(
            p => p.t >= windowStart && p.t <= nowMs && typeof p[key] === 'number'
        );
        if (inWindow.length < 2)
            return false;

        const MIN_SPAN_MS = 5 * 60 * 1000; // 5 minutes
        const first = inWindow[0];
        const last = inWindow[inWindow.length - 1];
        if (last.t - first.t < MIN_SPAN_MS)
            return false;

        const rate = leastSquaresSlope(inWindow.map(p => ({t: p.t, y: p[key]})));
        if (rate == null || rate <= 0)
            return false;

        return currentPercent + rate * msToReset > 100;
    }

    _loadHistoryFromDisk() {
        this._history = [];
        this._historyAppendCounter = 0;
        try {
            ensureCacheDir();
            const file = Gio.File.new_for_path(historyPath());
            const [ok, contents] = file.load_contents(null);
            if (!ok)
                return;
            const entries = new TextDecoder('utf-8').decode(contents)
                .split('\n')
                .filter(l => l.trim())
                .map(l => {
                    try {
                        return JSON.parse(l);
                    } catch (e) {
                        return null;
                    }
                })
                .filter(e => e && typeof e.t === 'number');
            this._history = entries.length > MAX_HISTORY_LINES
                ? entries.slice(entries.length - MAX_HISTORY_LINES)
                : entries;
        } catch (e) {
            this._history = [];
        }
    }

    _getHistory() {
        return this._history;
    }

    // HANDOFF-6 state machine — logo master + per-cause bars.
    // One shared latch: re-arm only when *no* cause is active this cycle.
    // (Maps to future descriptor `flash`/`color` once REFACTOR-1 lands.)
    _applyWarningState() {
        const warnEnabled = this._settings.get_boolean('warn-on-projected-depletion');
        const fiveActive = !!(this._fiveHourWillDeplete && warnEnabled);
        const sevenActive = !!(this._sevenDayWillDeplete && warnEnabled);
        const anyActive = fiveActive || sevenActive;

        if (!anyActive)
            this._warningAck = false;

        this._setBarWarning(
            this._fiveHourPanelProgressBar, fiveActive,
            '_fiveHourBlinkId', 'claude-panel-progress-bar-five-hour'
        );
        this._setBarWarning(
            this._sevenDayPanelProgressBar, sevenActive,
            '_sevenDayBlinkId', 'claude-panel-progress-bar-seven-day'
        );
        this._setLogoAlarm(anyActive && !this._warningAck);
        this._updateSnoozeMenuItem(anyActive);
    }

    // Three-way: un-snoozed active → blink; snoozed active → solid red; else normal.
    _setBarWarning(progressBar, active, timerField, normalClass) {
        const warningClass = 'claude-panel-progress-bar-warning';

        if (active && !this._warningAck) {
            if (!this[timerField]) {
                let isRed = false;
                this[timerField] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WARNING_BLINK_MS, () => {
                    isRed = !isRed;
                    progressBar.remove_style_class_name(normalClass);
                    progressBar.remove_style_class_name(warningClass);
                    progressBar.add_style_class_name(isRed ? warningClass : normalClass);
                    return GLib.SOURCE_CONTINUE;
                });
            }
        } else if (active && this._warningAck) {
            if (this[timerField]) {
                GLib.Source.remove(this[timerField]);
                this[timerField] = null;
            }
            progressBar.remove_style_class_name(normalClass);
            progressBar.add_style_class_name(warningClass);
        } else {
            if (this[timerField]) {
                GLib.Source.remove(this[timerField]);
                this[timerField] = null;
            }
            progressBar.remove_style_class_name(warningClass);
            progressBar.add_style_class_name(normalClass);
        }
    }

    _setLogoAlarm(flash) {
        if (flash) {
            if (!this._logoBlinkId) {
                let isRed = false;
                this._logoBlinkId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WARNING_BLINK_MS, () => {
                    isRed = !isRed;
                    this._applyLogoColorize(isRed);
                    return GLib.SOURCE_CONTINUE;
                });
            }
        } else {
            if (this._logoBlinkId) {
                GLib.Source.remove(this._logoBlinkId);
                this._logoBlinkId = null;
            }
            this._applyLogoColorize(false);
        }
    }

    // Raster PNG logo — CSS color cannot tint it. Toggle a named ColorizeEffect.
    // Always remove+re-add so the effect sits after monochrome desaturate.
    _applyLogoColorize(on) {
        this._logoColorizeOn = !!on;
        if (this._icon.get_effect(LOGO_ALARM_EFFECT_NAME))
            this._icon.remove_effect_by_name(LOGO_ALARM_EFFECT_NAME);
        if (on) {
            const tint = new Cogl.Color(LOGO_ALARM_TINT);
            this._icon.add_effect(new Clutter.ColorizeEffect({
                name: LOGO_ALARM_EFFECT_NAME,
                tint,
            }));
        }
    }

    _updateSnoozeMenuItem(anyActive) {
        if (!this._snoozeWarningItem)
            return;
        this._snoozeWarningItem.actor.visible = anyActive;
        if (!anyActive)
            return;
        if (this._warningAck) {
            this._snoozeWarningItem.label.set_text('Warning acknowledged');
            this._snoozeWarningItem.setSensitive(false);
        } else {
            this._snoozeWarningItem.label.set_text('Snooze warning');
            this._snoozeWarningItem.setSensitive(true);
        }
    }

    // `limits[]` also includes the two limits already covered above (kind
    // 'session' -> five_hour, kind 'weekly_all' -> seven_day); everything
    // else is a per-model/plan limit that may or may not exist depending on
    // account rollout, so render it dynamically instead of hardcoding.
    _updateExtraLimits(limits) {
        if (!Array.isArray(limits))
            return;

        const hidden = this._getHiddenExtraLimitIds();
        const discovered = [];

        for (const entry of limits) {
            if (entry.kind === 'session' || entry.kind === 'weekly_all')
                continue;

            const id = this._extraLimitId(entry);
            const label = this._extraLimitLabel(entry);
            discovered.push({id, label});

            let row = this._extraLimitRows.get(id);
            if (!row) {
                row = this._createExtraLimitRow(!hidden.has(id));
                this._extraLimitRows.set(id, row);
            }

            row.titleLabel.set_text(label);

            const percent = entry.percent ?? 0;
            row.percentLabel.set_text(`${Math.round(Number(percent))}%`);
            this._updateProgressBar(row.progressBar, percent);
            if (entry.resets_at) {
                row.resetLabel.set_text(`Resets in ${this._formatResetTime(entry.resets_at)}`);
            }
        }

        this._writeExtraLimitsCache(discovered);
    }

    // Toggling which extra-limit rows are visible now happens in the
    // Settings window (prefs.js), which writes the same 'hidden-extra-limits'
    // GSettings key this extension already reads — just apply it here
    // instead of hosting the switch in the dropdown itself.
    _applyExtraLimitVisibility() {
        const hidden = this._getHiddenExtraLimitIds();
        for (const [id, row] of this._extraLimitRows) {
            row.detailItem.actor.visible = !hidden.has(id);
        }
    }

    // Shared with prefs.js (separate process) via a flat file, same reason
    // as cacheDir/historyPath — prefs.js has never made an API call, so it has no
    // other way to know which per-model/plan limits exist to list them in
    // Settings. Merged with whatever's already on disk so a limit that
    // briefly disappears from one API response doesn't vanish from the
    // Settings list.
    static get limitsPath() {
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-code-usage']);
        GLib.mkdir_with_parents(dir, 0o755);
        return GLib.build_filenamev([dir, 'limits.json']);
    }

    _writeExtraLimitsCache(discovered) {
        try {
            const path = ClaudeUsageIndicator.limitsPath;
            const file = Gio.File.new_for_path(path);
            const known = new Map();

            try {
                const [ok, contents] = file.load_contents(null);
                if (ok) {
                    const existing = JSON.parse(new TextDecoder('utf-8').decode(contents));
                    if (Array.isArray(existing)) {
                        for (const entry of existing) {
                            if (entry && entry.id)
                                known.set(entry.id, entry);
                        }
                    }
                }
            } catch (e) {
                // No cache yet, or corrupt — start fresh.
            }

            for (const entry of discovered)
                known.set(entry.id, entry);

            file.replace_contents(
                JSON.stringify([...known.values()]),
                null, false, Gio.FileCreateFlags.NONE, null
            );
        } catch (e) {
            console.error('Claude Usage: failed to write limits cache:', e.message);
        }
    }

    _extraLimitId(entry) {
        return `${entry.kind}::${entry.scope?.model?.id ?? entry.scope?.model?.display_name ?? entry.group ?? 'unknown'}`;
    }

    _extraLimitLabel(entry) {
        const groupLabel = entry.group === 'weekly' ? 'Weekly' :
            entry.group === 'session' ? 'Session' :
            entry.group ? entry.group[0].toUpperCase() + entry.group.slice(1) : entry.kind;
        const modelName = entry.scope?.model?.display_name;
        return modelName ? `${groupLabel} — ${modelName}` : `${groupLabel} (${entry.kind})`;
    }

    _getHiddenExtraLimitIds() {
        try {
            return new Set(JSON.parse(this._settings.get_string('hidden-extra-limits') || '[]'));
        } catch (e) {
            return new Set();
        }
    }

    _createExtraLimitRow(initiallyVisible) {
        const detailBox = new St.BoxLayout({
            style_class: 'claude-usage-section',
            vertical: true,
        });

        const header = new St.BoxLayout({ vertical: false });
        const titleLabel = new St.Label({
            style_class: 'claude-section-title',
        });
        header.add_child(titleLabel);
        const percentLabel = new St.Label({
            style_class: 'claude-percent-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        header.add_child(percentLabel);
        detailBox.add_child(header);

        const progressBg = new St.Widget({ style_class: 'claude-progress-bg' });
        const progressBar = new St.Widget({ style_class: 'claude-progress-bar claude-bar-extra' });
        progressBg.add_child(progressBar);
        detailBox.add_child(progressBg);

        const resetLabel = new St.Label({
            style_class: 'claude-reset-label',
            text: 'Resets: ...',
        });
        detailBox.add_child(resetLabel);

        const detailItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        detailItem.add_child(detailBox);
        detailItem.actor.visible = initiallyVisible;

        this._extraLimitsSection.addMenuItem(detailItem);

        return { detailItem, titleLabel, percentLabel, progressBar, resetLabel };
    }

    _appendHistory(fiveHour, sevenDay) {
        try {
            ensureCacheDir();
            const entry = {t: Date.now(), five_hour: fiveHour, seven_day: sevenDay};
            this._history.push(entry);
            if (this._history.length > MAX_HISTORY_LINES)
                this._history.shift();

            const path = historyPath();
            const file = Gio.File.new_for_path(path);
            const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
            stream.write_all(new TextEncoder().encode(`${JSON.stringify(entry)}\n`), null);
            stream.close(null);

            this._historyAppendCounter = (this._historyAppendCounter || 0) + 1;
            if (this._historyAppendCounter % HISTORY_TRIM_EVERY === 0)
                this._rewriteHistoryFile();
        } catch (e) {
            console.error('Claude Usage: failed to append history:', e.message);
        }
    }

    _rewriteHistoryFile() {
        try {
            const path = historyPath();
            const content = this._history.map(e => JSON.stringify(e)).join('\n') +
                (this._history.length ? '\n' : '');
            Gio.File.new_for_path(path).replace_contents(
                content, null, false, Gio.FileCreateFlags.NONE, null
            );
        } catch (e) {
            console.error('Claude Usage: failed to rewrite history:', e.message);
        }
    }

    // 429 from the usage endpoint: token is valid, numbers are effectively
    // unchanged — just keep the last display clean (no stale dim, no alarm,
    // no last-fetch-succeeded flip). If there's no data yet at all, leave the
    // startup placeholder rather than inventing an error state.
    _keepLastKnownQuiet() {
        if (this._lastKnownData) {
            this._updateDisplay(this._lastKnownData, {stale: false});
        }
    }

    // On error, repaint with the last known-good numbers (marked stale)
    // instead of blanking the display — a transient 401/429 shouldn't erase
    // the only usage info the user has.
    _showError(statusWord, detailText) {
        this._settings.set_boolean('last-fetch-succeeded', false);
        if (this._lastKnownData) {
            // Repaint last-known numbers with the stale overlay + a banner
            // explaining why. The panel keeps showing the % (dimmed).
            this._staleBanner.set_text(`⚠ Last known usage — ${detailText}`);
            this._staleBannerItem.actor.visible = true;
            this._updateDisplay(this._lastKnownData, {stale: true});
        } else {
            // No cache yet (fresh install / never succeeded) — nothing to
            // show but the error itself.
            this._setStaleStyle(false);
            this._staleBanner.set_text('');
            this._staleBannerItem.actor.visible = false;
            this._fiveHourPanelTag.visible = false;
            this._sevenDayPanelTag.visible = false;
            this._fiveHourPanelLabel.set_text(statusWord);
            this._sevenDayPanelLabel.set_text('');
            this._fiveHourPercent.set_text(detailText);
            this._sevenDayPercent.set_text('-');
        }
    }

    // Toggle the visual "stale" treatment (dimmed panel label + bars) and
    // hide the banner when live again.
    _setStaleStyle(stale) {
        const apply = (widget, cls) => {
            if (stale)
                widget.add_style_class_name(cls);
            else
                widget.remove_style_class_name(cls);
        };
        apply(this._fiveHourPanelLabel, 'claude-stale');
        apply(this._sevenDayPanelLabel, 'claude-stale');
        apply(this._fiveHourPanelProgressBar, 'claude-stale');
        apply(this._sevenDayPanelProgressBar, 'claude-stale');
        if (!stale && this._staleBannerItem) {
            this._staleBannerItem.actor.visible = false;
        }
    }

    _updatePanelProgressBar(progressBar, usage) {
        const maxWidth = 50;
        const width = Math.round((Math.min(100, Math.max(0, usage)) / 100) * maxWidth);
        progressBar.set_width(width);
    }

    // Brief visual feedback that a live refresh just landed — settings-gated,
    // one-shot (not a repeating blink like the depletion warning).
    _flashPanel() {
        if (!this._settings.get_boolean('flash-on-refresh'))
            return;

        if (this._flashTimeoutId) {
            GLib.Source.remove(this._flashTimeoutId);
            this._flashTimeoutId = null;
            this._box.remove_style_class_name('claude-panel-flash');
        }

        this._box.add_style_class_name('claude-panel-flash');
        this._flashTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 220, () => {
            this._box.remove_style_class_name('claude-panel-flash');
            this._flashTimeoutId = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    // Width only — color is a fixed identity class on each bar (5h orange,
    // 7d blue, extra gray) so a metric keeps ONE color regardless of level.
    // Severity is already surfaced by the projected-depletion blink.
    _updateProgressBar(progressBar, usage) {
        const maxWidth = 200;
        const width = Math.round((Math.min(100, Math.max(0, usage)) / 100) * maxWidth);
        progressBar.set_width(width);
    }

    // Independent of whatever's currently on display (live, stale-marked,
    // or silently skipped by backoff) — always the last time a fetch
    // actually returned 200, so hovering during a long backoff tells you
    // exactly how stale the numbers really are.
    _showHoverTooltip() {
        const text = this._lastFetchAtMs
            ? `Last updated: ${new Date(this._lastFetchAtMs).toLocaleString()}`
            : 'Last updated: never';
        this._hoverTooltip.set_text(text);

        const [x, y] = this.get_transformed_position();
        this._hoverTooltip.set_position(Math.round(x), Math.round(y + this.get_height() + 4));
        this._hoverTooltip.visible = true;
    }

    _hideHoverTooltip() {
        this._hoverTooltip.visible = false;
    }

    _formatResetTime(isoString) {
        try {
            const resetDate = new Date(isoString);
            const now = new Date();
            const diffMs = resetDate - now;

            if (diffMs < 0) {
                return 'now';
            }

            const diffMins = Math.floor(diffMs / 60000);
            const diffHours = Math.floor(diffMins / 60);
            const diffDays = Math.floor(diffHours / 24);

            if (diffDays > 0) {
                return `${diffDays}d ${diffHours % 24}h`;
            } else if (diffHours > 0) {
                return `${diffHours}h ${diffMins % 60}m`;
            } else {
                return `${diffMins}m`;
            }
        } catch (e) {
            return '-';
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._stopTimer();
        if (this._fiveHourBlinkId) {
            GLib.Source.remove(this._fiveHourBlinkId);
            this._fiveHourBlinkId = null;
        }
        if (this._sevenDayBlinkId) {
            GLib.Source.remove(this._sevenDayBlinkId);
            this._sevenDayBlinkId = null;
        }
        if (this._logoBlinkId) {
            GLib.Source.remove(this._logoBlinkId);
            this._logoBlinkId = null;
        }
        if (this._icon?.get_effect?.(LOGO_ALARM_EFFECT_NAME))
            this._icon.remove_effect_by_name(LOGO_ALARM_EFFECT_NAME);
        this._logoColorizeOn = false;
        if (this._flashTimeoutId) {
            GLib.Source.remove(this._flashTimeoutId);
            this._flashTimeoutId = null;
        }
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._stColorSchemeId) {
            St.Settings.get().disconnect(this._stColorSchemeId);
            this._stColorSchemeId = null;
        }
        if (this._interfaceSettings) {
            if (this._textScalingId) {
                this._interfaceSettings.disconnect(this._textScalingId);
                this._textScalingId = null;
            }
            if (this._colorSchemeId) {
                this._interfaceSettings.disconnect(this._colorSchemeId);
                this._colorSchemeId = null;
            }
            this._interfaceSettings = null;
        }
        if (this._hoverTooltip) {
            this._hoverTooltip.destroy();
            this._hoverTooltip = null;
        }
        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new ClaudeUsageIndicator(
            this.path,
            this._settings,
            () => this.openPreferences(),
            this.metadata
        );
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
