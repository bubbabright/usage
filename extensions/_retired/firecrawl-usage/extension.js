import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const DEFAULT_API_URL = 'https://api.firecrawl.dev';
const CREDIT_USAGE_PATH = '/v2/team/credit-usage';
const USER_AGENT = 'FirecrawlUsageExtension/1.0';
const CACHE_DIR_NAME = 'firecrawl-usage';
const HISTORY_FILE = 'history.jsonl';
const MAX_HISTORY_LINES = 20000; // ~70 days at a 5-minute poll interval
const HISTORY_TRIM_EVERY = 200;
const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';
const PANEL_ICON_BASE_SIZE = 18;
const WARNING_BLINK_MS = 700;
// Runway projection needs enough spread to not be pure rounding noise —
// credit-usage polls are sparse (5+ min apart) compared to a live quota API.
const RUNWAY_MIN_SPAN_MS = 6 * 3600 * 1000; // 6 hours
const RUNWAY_WINDOW_MS = 14 * 24 * 3600 * 1000; // 14 days

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

// Balance can exceed one cycle's plan credits (rollover / banked credits),
// so a raw count reads better in the panel than a percentage that might
// say "887%". Bar and stale coloring still use the capped percentage.
function formatCredits(n) {
    if (!Number.isFinite(n))
        return '?';
    const abs = Math.abs(n);
    if (abs >= 1_000_000)
        return `${(n / 1_000_000).toFixed(1)}M`;
    if (abs >= 1000)
        return `${(n / 1000).toFixed(1)}k`;
    return `${Math.round(n)}`;
}

const FirecrawlUsageIndicator = GObject.registerClass(
{GTypeName: 'FirecrawlUsage_FirecrawlUsageIndicator'},
class FirecrawlUsageIndicator extends PanelMenu.Button {
    _init(extensionPath, settings, openPreferences, metadata) {
        super._init(0.0, 'Firecrawl Usage Indicator');

        this._extensionPath = extensionPath;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._metadata = metadata;
        this._session = this._createSession();
        this._cancellable = new Gio.Cancellable();
        this._timerId = null;
        this._flashTimeoutId = null;
        this._blinkId = null;
        this._warningAck = false;
        this._lastKnown = null;
        this._lastFetchAtMs = null;
        this._consecutiveFailures = 0;
        this._backoffUntilMs = 0;
        this._willDeplete = false;
        this._runwayDays = null;

        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._icon = new St.Icon({
            style_class: 'system-status-icon firecrawl-usage-icon',
            icon_name: 'edit-find-symbolic',
            icon_size: PANEL_ICON_BASE_SIZE,
        });
        this._box.add_child(this._icon);

        this._row = new St.BoxLayout({
            style_class: 'panel-bar-row',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._panelProgressBg = new St.Widget({
            style_class: 'firecrawl-panel-progress-bg',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelProgressBar = new St.Widget({
            style_class: 'firecrawl-panel-progress-bar',
        });
        this._panelProgressBg.add_child(this._panelProgressBar);
        this._row.add_child(this._panelProgressBg);

        this._panelLabel = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'firecrawl-usage-label firecrawl-panel-percent',
        });
        this._row.add_child(this._panelLabel);

        this._box.add_child(this._row);
        this.add_child(this._box);

        this._hoverTooltip = new St.Label({
            style_class: 'firecrawl-hover-tooltip',
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
        this._applyPanelSizing();
        this._applyColorScheme();

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key === 'refresh-interval') {
                this._restartTimer();
            } else if (key === 'show-panel-bar' || key === 'show-panel-text') {
                this._updateDisplayMode();
            } else if (key === 'show-icon') {
                this._updateIconVisibility();
            } else if (key === 'proxy-url') {
                this._recreateSession();
            } else if (key === 'warn-on-low-runway' || key === 'runway-warn-days') {
                this._applyWarningState();
            }
        });

        this._loadHistoryFromDisk();
        this._seedFromHistory();
        this._refreshUsage();
        this._startTimer();
    }

    _createMenu() {
        const headerBox = new St.BoxLayout({
            style_class: 'firecrawl-menu-header',
            x_expand: true,
        });
        const headerTitle = new St.Label({
            text: 'Firecrawl Usage',
            style_class: 'firecrawl-menu-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.add_child(headerTitle);
        const refreshButton = new St.Button({
            style_class: 'firecrawl-refresh-button',
            child: new St.Icon({icon_name: 'view-refresh-symbolic', icon_size: 14}),
        });
        refreshButton.connect('clicked', () => {
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

        this._staleBanner = new St.Label({
            text: '',
            style_class: 'firecrawl-stale-banner',
        });
        this._staleBannerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._staleBannerItem.add_child(this._staleBanner);
        this._staleBannerItem.actor.visible = false;
        this.menu.addMenuItem(this._staleBannerItem);

        const creditsBox = new St.BoxLayout({
            style_class: 'firecrawl-usage-section',
            vertical: true,
            x_expand: true,
        });
        const creditsHeader = new St.BoxLayout({vertical: false, x_expand: true});
        const creditsLabel = new St.Label({
            text: 'Credits Remaining',
            style_class: 'firecrawl-section-title',
        });
        creditsHeader.add_child(creditsLabel);
        this._creditsPercent = new St.Label({
            text: '…',
            style_class: 'firecrawl-percent-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        creditsHeader.add_child(this._creditsPercent);
        creditsBox.add_child(creditsHeader);

        this._cycleLabel = new St.Label({
            text: 'Cycle -',
            style_class: 'firecrawl-reset-label',
        });
        creditsBox.add_child(this._cycleLabel);

        this._runwayLabel = new St.Label({
            text: '',
            style_class: 'firecrawl-reset-label',
        });
        creditsBox.add_child(this._runwayLabel);

        this._lastFetchLabel = new St.Label({
            text: 'Last poll -',
            style_class: 'firecrawl-menu-muted',
        });
        creditsBox.add_child(this._lastFetchLabel);

        const creditsItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        creditsItem.add_child(creditsBox);
        this.menu.addMenuItem(creditsItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const openUsageItem = new PopupMenu.PopupMenuItem('Open firecrawl.dev Usage…');
        openUsageItem.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri('https://www.firecrawl.dev/app/usage', null);
        });
        this.menu.addMenuItem(openUsageItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

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
            Promise.resolve(this._openPreferences()).catch(e => {
                console.error('Firecrawl Usage: failed to open preferences:', e.message);
            });
        });
        this.menu.addMenuItem(settingsItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const aboutItem = new PopupMenu.PopupMenuItem('About');
        aboutItem.connect('activate', () => this._showAbout());
        this.menu.addMenuItem(aboutItem);
    }

    _updateDisplayMode() {
        const showBar = this._settings.get_boolean('show-panel-bar');
        const showText = this._settings.get_boolean('show-panel-text');
        this._panelProgressBg.visible = showBar;
        this._panelLabel.visible = showText;
    }

    _updateIconVisibility() {
        this._icon.visible = this._settings.get_boolean('show-icon');
    }

    _createSession() {
        const session = new Soup.Session({timeout: 30});
        const proxyUrl = this._settings.get_string('proxy-url');

        if (proxyUrl && proxyUrl.trim() !== '') {
            const proxyResolver = Gio.SimpleProxyResolver.new(proxyUrl.trim(), null);
            session.set_proxy_resolver(proxyResolver);
        }

        return session;
    }

    _recreateSession() {
        if (this._session)
            this._session.abort();
        this._session = this._createSession();
        this._refreshUsage();
    }

    _applyPanelSizing() {
        const factor = this._interfaceSettings.get_double('text-scaling-factor') || 1.0;
        this._icon.icon_size = Math.round(PANEL_ICON_BASE_SIZE * factor);
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

    _seedFromHistory() {
        const history = this._getHistory();
        for (let i = history.length - 1; i >= 0; i--) {
            const e = history[i];
            if (e.remaining == null)
                continue;
            this._lastKnown = {
                remaining: e.remaining,
                plan: e.plan,
                periodStart: e.period_start ?? null,
                periodEnd: e.period_end ?? null,
                pct: e.plan ? Math.min(100, (100 * e.remaining) / e.plan) : 0,
            };
            this._staleBanner.set_text('⚠ Last known balance — not fetched yet this session');
            this._staleBannerItem.actor.visible = true;
            this._updateDisplay(this._lastKnown, {stale: true});
            return;
        }
    }

    _startTimer() {
        const sec = Math.max(60, this._settings.get_int('refresh-interval'));
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, sec, () => {
            this._refreshUsage();
            return GLib.SOURCE_CONTINUE;
        });
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

    _registerFetchFailure() {
        this._consecutiveFailures++;
        const baseMs = Math.max(this._settings.get_int('refresh-interval') * 1000, 60000);
        const backoffMs = Math.min(baseMs * 2 ** (this._consecutiveFailures - 1), 30 * 60 * 1000);
        this._backoffUntilMs = Date.now() + backoffMs;
        console.error(`Firecrawl Usage: backing off ${Math.round(backoffMs / 1000)}s after ${this._consecutiveFailures} failure(s)`);
    }

    _registerFetchSuccess() {
        this._consecutiveFailures = 0;
        this._backoffUntilMs = 0;
    }

    // The firecrawl CLI stores a static API key here (no OAuth expiry) —
    // read-only, matches the suite's "never auto-spend quota" standing rule
    // (there's nothing to refresh anyway).
    _credentialsPath() {
        return GLib.build_filenamev([GLib.get_home_dir(), '.config', 'firecrawl-cli', 'credentials.json']);
    }

    _refreshUsage() {
        if (Date.now() < this._backoffUntilMs)
            return;

        const file = Gio.File.new_for_path(this._credentialsPath());
        file.load_contents_async(this._cancellable, (f, result) => {
            try {
                const [, contents] = f.load_contents_finish(result);
                const json = JSON.parse(new TextDecoder('utf-8').decode(contents));
                const apiKey = json?.apiKey;
                if (!apiKey) {
                    this._registerFetchFailure();
                    this._showError('No API key — run `firecrawl login`');
                    return;
                }
                const apiUrl = (json.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
                this._fetchCreditUsage(apiUrl, apiKey);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                this._registerFetchFailure();
                console.error('Firecrawl Usage: failed to read credentials.json:', e.message);
                this._showError('No auth — run `firecrawl login`');
            }
        });
    }

    _fetchCreditUsage(apiUrl, apiKey) {
        const message = Soup.Message.new('GET', apiUrl + CREDIT_USAGE_PATH);
        message.request_headers.append('Authorization', `Bearer ${apiKey}`);
        message.request_headers.append('Accept', 'application/json');
        message.request_headers.append('User-Agent', USER_AGENT);

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const status = message.status_code;
                    if (status !== 200) {
                        this._registerFetchFailure();
                        if (status === 401 || status === 403)
                            this._showError('Auth rejected — run `firecrawl login`');
                        else
                            this._showError(`HTTP ${status}`);
                        return;
                    }

                    const data = JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data()));
                    const cfg = data.data || data;
                    const remaining = cfg.remainingCredits;
                    const plan = cfg.planCredits;
                    if (remaining == null || plan == null) {
                        this._registerFetchFailure();
                        this._showError('Bad credit-usage payload');
                        return;
                    }

                    const nowMs = Date.now();
                    const known = {
                        remaining,
                        plan,
                        periodStart: cfg.billingPeriodStart || null,
                        periodEnd: cfg.billingPeriodEnd || null,
                        pct: plan ? Math.min(100, (100 * remaining) / plan) : 0,
                    };

                    this._lastKnown = known;
                    this._lastFetchAtMs = nowMs;
                    this._registerFetchSuccess();
                    this._staleBannerItem.actor.visible = false;
                    this._updateDisplay(known, {stale: false});
                    this._appendHistory({
                        t: nowMs,
                        remaining,
                        plan,
                        pct: Math.round(known.pct * 100) / 100,
                        period_start: known.periodStart,
                        period_end: known.periodEnd,
                    });
                    this._flashPanel();
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    this._registerFetchFailure();
                    console.error('Firecrawl Usage: fetch failed:', e.message);
                    this._showError('Fetch failed');
                }
            }
        );
    }

    _updateDisplay(known, {stale = false} = {}) {
        const pct = known.pct ?? 0;
        const suffix = stale ? ' (stale)' : '';

        this._setStaleStyle(stale);
        this._panelLabel.set_text(formatCredits(known.remaining));
        this._updatePanelProgressBar(pct);

        this._creditsPercent.set_text(`${formatCredits(known.remaining)}${suffix}`);

        if (known.plan) {
            const pctRounded = Math.round(pct * 10) / 10;
            this._cycleLabel.set_text(
                `${Math.round(known.remaining)} / ${Math.round(known.plan)} credits per cycle (${pctRounded}%)`
            );
        } else {
            this._cycleLabel.set_text('Cycle -');
        }

        if (this._lastFetchAtMs && !stale)
            this._lastFetchLabel.set_text(`Last poll ${this._fmtLocal(this._lastFetchAtMs)}`);
        else if (stale)
            this._lastFetchLabel.set_text('Last poll - (cached)');

        this._computeRunway(known.remaining);
        this._applyWarningState();
    }

    // Balance can roll over indefinitely (no hard reset each cycle), so
    // there's no fixed window to project against like a monthly cap. Instead
    // project the observed burn rate on `remaining` forward to zero — a
    // runway estimate, which is the meaningful signal for a banked-balance
    // model (see README "ext divergence rule": data model forces the split
    // from the window-reset math the other standalone extensions use).
    _computeRunway(currentRemaining) {
        const nowMs = Date.now();
        const windowStart = nowMs - RUNWAY_WINDOW_MS;
        const inWindow = this._getHistory().filter(
            e => typeof e.remaining === 'number' && e.t >= windowStart && e.t <= nowMs
        );

        this._willDeplete = false;
        this._runwayDays = null;

        if (inWindow.length < 2) {
            this._runwayLabel.set_text('');
            return;
        }

        const first = inWindow[0];
        const last = inWindow[inWindow.length - 1];
        if (last.t - first.t < RUNWAY_MIN_SPAN_MS) {
            this._runwayLabel.set_text('');
            return;
        }

        const rate = leastSquaresSlope(inWindow.map(p => ({t: p.t, y: p.remaining})));
        if (rate == null || rate >= 0) {
            this._runwayLabel.set_text('Balance steady or growing');
            return;
        }

        const msToZero = -currentRemaining / rate;
        const days = msToZero / (24 * 3600 * 1000);
        this._runwayDays = days;
        this._runwayLabel.set_text(
            days < 1
                ? 'At current pace: exhausted in <1 day'
                : `At current pace: exhausted in ~${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'}`
        );

        const warnDays = this._settings.get_int('runway-warn-days');
        this._willDeplete = days <= warnDays;
    }

    _applyWarningState() {
        const warnEnabled = this._settings.get_boolean('warn-on-low-runway');
        const active = !!(this._willDeplete && warnEnabled);

        if (!active)
            this._warningAck = false;

        this._setBarWarning(active);
        this._updateSnoozeMenuItem(active);
    }

    _setBarWarning(active) {
        const normalClass = 'firecrawl-panel-progress-bar';
        const warningClass = 'firecrawl-panel-progress-bar-warning';

        if (active && !this._warningAck) {
            if (!this._blinkId) {
                let isRed = false;
                this._blinkId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WARNING_BLINK_MS, () => {
                    isRed = !isRed;
                    this._panelProgressBar.remove_style_class_name(normalClass);
                    this._panelProgressBar.remove_style_class_name(warningClass);
                    this._panelProgressBar.add_style_class_name(isRed ? warningClass : normalClass);
                    return GLib.SOURCE_CONTINUE;
                });
            }
        } else if (active && this._warningAck) {
            if (this._blinkId) {
                GLib.Source.remove(this._blinkId);
                this._blinkId = null;
            }
            this._panelProgressBar.remove_style_class_name(normalClass);
            this._panelProgressBar.add_style_class_name(warningClass);
        } else {
            if (this._blinkId) {
                GLib.Source.remove(this._blinkId);
                this._blinkId = null;
            }
            this._panelProgressBar.remove_style_class_name(warningClass);
            this._panelProgressBar.add_style_class_name(normalClass);
        }
    }

    _updateSnoozeMenuItem(active) {
        if (!this._snoozeWarningItem)
            return;
        this._snoozeWarningItem.actor.visible = active;
        if (!active)
            return;
        if (this._warningAck) {
            this._snoozeWarningItem.label.set_text('Warning acknowledged');
            this._snoozeWarningItem.setSensitive(false);
        } else {
            this._snoozeWarningItem.label.set_text('Snooze warning');
            this._snoozeWarningItem.setSensitive(true);
        }
    }

    _updatePanelProgressBar(pct) {
        const maxWidth = 56;
        const width = Math.round((Math.min(100, Math.max(0, pct)) / 100) * maxWidth);
        this._panelProgressBar.set_width(width);
    }

    _setStaleStyle(stale) {
        if (stale)
            this._box.add_style_class_name('firecrawl-stale');
        else
            this._box.remove_style_class_name('firecrawl-stale');
    }

    _showError(msg) {
        this._staleBanner.set_text(`⚠ ${msg}`);
        this._staleBannerItem.actor.visible = true;
        if (this._lastKnown) {
            this._updateDisplay(this._lastKnown, {stale: true});
        } else {
            this._panelLabel.set_text('!');
        }
    }

    _flashPanel() {
        if (!this._settings.get_boolean('flash-on-refresh'))
            return;
        this._box.add_style_class_name('firecrawl-panel-flash');
        if (this._flashTimeoutId)
            GLib.Source.remove(this._flashTimeoutId);
        this._flashTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._box.remove_style_class_name('firecrawl-panel-flash');
            this._flashTimeoutId = null;
            return GLib.SOURCE_REMOVE;
        });
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

    _appendHistory(entry) {
        try {
            ensureCacheDir();
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
            console.error('Firecrawl Usage: history append failed:', e.message);
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
            console.error('Firecrawl Usage: failed to rewrite history:', e.message);
        }
    }

    // Same template-injection approach as prefs.js's _generateReport —
    // duplicated rather than shared because the two files run in separate
    // GJS processes (Shell vs. prefs) with no common module loader.
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
            console.error('Firecrawl Usage: failed to open usage report:', e.message);
            Main.notify('Firecrawl Usage', `Could not open usage report: ${e.message}`);
        }
    }

    // No save dialog here — the Shell process doesn't host GTK file
    // choosers. Writes straight to Documents (or home as a fallback) using
    // the same filename scheme as prefs.js's Export CSV button.
    _exportHistoryCsv() {
        try {
            const data = [...this._getHistory()].sort((a, b) => a.t - b.t);
            const lines = ['timestamp,epoch_ms,remaining,plan,pct'];
            for (const d of data) {
                lines.push(`${new Date(d.t).toISOString()},${d.t},` +
                    `${d.remaining ?? ''},${d.plan ?? ''},${d.pct ?? ''}`);
            }

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
            Main.notify('Firecrawl Usage', `Exported history to ${outPath}`);
        } catch (e) {
            console.error('Firecrawl Usage: failed to export CSV:', e.message);
            Main.notify('Firecrawl Usage', `Could not export CSV: ${e.message}`);
        }
    }

    _showAbout() {
        const version = this._metadata?.version ?? '?';
        const url = this._metadata?.url ?? '';
        Main.notify('Firecrawl Usage', `Version ${version}\n${url}`);
    }

    _fmtLocal(ms) {
        const d = new Date(ms);
        return d.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        });
    }

    // Independent of whatever's currently on display (live, stale-marked,
    // or silently skipped by backoff) — always the last time a fetch
    // actually returned 200.
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

    destroy() {
        this._stopTimer();
        if (this._flashTimeoutId) {
            GLib.Source.remove(this._flashTimeoutId);
            this._flashTimeoutId = null;
        }
        if (this._blinkId) {
            GLib.Source.remove(this._blinkId);
            this._blinkId = null;
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
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        if (this._hoverTooltip) {
            this._hoverTooltip.destroy();
            this._hoverTooltip = null;
        }
        super.destroy();
    }
});

export default class FirecrawlUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new FirecrawlUsageIndicator(
            this.path,
            this._settings,
            () => this.openPreferences(),
            this.metadata
        );
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._settings = null;
    }
}
