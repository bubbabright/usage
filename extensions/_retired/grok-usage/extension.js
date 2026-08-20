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

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing';
// Weekly SuperGrok pool — same gRPC-web surface CodexBar uses (undocumented;
// reverse-engineered from grok.com Settings → Usage). See docs/grok.md notes
// in steipete/CodexBar and prior HAR work in this monorepo.
const CREDITS_URL = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';
const USER_AGENT = 'GrokUsageExtension/1.0';
const CACHE_DIR_NAME = 'grok-usage';
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
// Projected-depletion alarm (HANDOFF-6): logo is master flash light; the
// monthly bar (depletion) flashes until snoozed, then goes solid red.
// In-memory latch only — no gschema key.
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

function valOf(x) {
    if (x == null)
        return null;
    if (typeof x === 'object' && 'val' in x)
        return x.val;
    return x;
}

// --- gRPC-web / protobuf helpers for GetGrokCreditsConfig (CodexBar-compatible) ---

function _readVarint(bytes, indexRef) {
    let value = 0;
    let shift = 0;
    while (indexRef.i < bytes.length && shift < 35) {
        const b = bytes[indexRef.i++];
        value |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0)
            return value >>> 0;
        shift += 7;
    }
    return null;
}

function _grpcWebDataFrames(bytes) {
    const frames = [];
    let i = 0;
    while (i + 5 <= bytes.length) {
        const flags = bytes[i];
        const length = (bytes[i + 1] << 24) | (bytes[i + 2] << 16) |
            (bytes[i + 3] << 8) | bytes[i + 4];
        const start = i + 5;
        const end = start + length;
        if (length < 0 || end > bytes.length)
            return null;
        if ((flags & 0x80) === 0)
            frames.push(bytes.subarray(start, end));
        i = end;
    }
    return frames;
}

function _looksLikeProtobuf(bytes) {
    if (!bytes || bytes.length === 0)
        return false;
    const first = bytes[0];
    const fieldNumber = first >> 3;
    const wireType = first & 0x07;
    return fieldNumber > 0 && (wireType === 0 || wireType === 1 ||
        wireType === 2 || wireType === 5);
}

/**
 * Scan protobuf (nested up to depth 4) for fixed32 floats and varints.
 * Port of CodexBar GrokWebBillingFetcher.scanProtobuf.
 */
function _scanProtobuf(bytes, depth = 0, path = [], orderRef = {n: 0}) {
    const fixed32 = [];
    const varints = [];
    const indexRef = {i: 0};
    while (indexRef.i < bytes.length) {
        const fieldStart = indexRef.i;
        const key = _readVarint(bytes, indexRef);
        if (key === null || key === 0) {
            indexRef.i = fieldStart + 1;
            continue;
        }
        const fieldNumber = key >>> 3;
        const wireType = key & 0x07;
        const fieldPath = path.concat(fieldNumber);

        if (wireType === 0) {
            const value = _readVarint(bytes, indexRef);
            if (value === null) {
                indexRef.i = fieldStart + 1;
                continue;
            }
            varints.push({path: fieldPath, value});
        } else if (wireType === 1) {
            if (indexRef.i + 8 > bytes.length)
                break;
            indexRef.i += 8;
        } else if (wireType === 2) {
            const length = _readVarint(bytes, indexRef);
            if (length === null || indexRef.i + length > bytes.length) {
                indexRef.i = fieldStart + 1;
                continue;
            }
            const start = indexRef.i;
            const end = start + length;
            if (depth < 4) {
                const nested = _scanProtobuf(
                    bytes.subarray(start, end), depth + 1, fieldPath, orderRef);
                fixed32.push(...nested.fixed32);
                varints.push(...nested.varints);
            }
            indexRef.i = end;
        } else if (wireType === 5) {
            if (indexRef.i + 4 > bytes.length)
                break;
            const view = new DataView(
                bytes.buffer, bytes.byteOffset + indexRef.i, 4);
            const value = view.getFloat32(0, true);
            fixed32.push({path: fieldPath, value, order: orderRef.n++});
            indexRef.i += 4;
        } else {
            indexRef.i = fieldStart + 1;
        }
    }
    return {fixed32, varints};
}

/**
 * Parse GetGrokCreditsConfig response.
 * @returns {{usedPercent: number, resetsAtMs: number|null}|null}
 */
function parseGrokCreditsConfig(rawBytes) {
    if (!rawBytes || rawBytes.length === 0)
        return null;
    const bytes = rawBytes instanceof Uint8Array
        ? rawBytes
        : new Uint8Array(rawBytes);

    let payloads = _grpcWebDataFrames(bytes);
    if (!payloads || payloads.length === 0) {
        if (_looksLikeProtobuf(bytes))
            payloads = [bytes];
        else
            return null;
    }

    const allFixed = [];
    const allVarint = [];
    const orderRef = {n: 0};
    for (const payload of payloads) {
        const scan = _scanProtobuf(payload, 0, [], orderRef);
        allFixed.push(...scan.fixed32);
        allVarint.push(...scan.varints);
    }

    // credit_usage_percent: fixed32 float 0–100, field number ending in 1;
    // prefer shallower paths (CodexBar: min path length, then order).
    const percentCandidates = allFixed.filter(f =>
        f.path.length > 0 &&
        f.path[f.path.length - 1] === 1 &&
        Number.isFinite(f.value) &&
        f.value >= 0 && f.value <= 100
    );
    percentCandidates.sort((a, b) =>
        a.path.length === b.path.length
            ? a.order - b.order
            : a.path.length - b.path.length
    );
    let usedPercent = percentCandidates.length
        ? percentCandidates[0].value
        : null;

    // Reset: prefer path [1, 5, 1] (period end), else soonest future unix ts.
    const nowSec = Date.now() / 1000;
    const tsFields = allVarint.filter(f =>
        f.value >= 1_700_000_000 && f.value <= 2_100_000_000
    );
    const future = tsFields.filter(f => f.value > nowSec);
    let resetsAtSec = null;
    const preferred = future.find(f =>
        f.path.length === 3 &&
        f.path[0] === 1 && f.path[1] === 5 && f.path[2] === 1
    );
    if (preferred)
        resetsAtSec = preferred.value;
    else if (future.length)
        resetsAtSec = Math.min(...future.map(f => f.value));

    // proto3 omits zero floats — period present + no % → 0% used.
    const hasUsagePeriod = allVarint.some(f =>
        (f.path.length >= 2 && f.path[0] === 1 && f.path[1] === 6) ||
        (f.path.length === 3 && f.path[0] === 1 && f.path[1] === 8 &&
            f.path[2] === 1 && (f.value === 1 || f.value === 2))
    );
    if (usedPercent === null && allFixed.length === 0 &&
        resetsAtSec != null && hasUsagePeriod)
        usedPercent = 0;

    if (usedPercent === null)
        return null;

    return {
        usedPercent,
        resetsAtMs: resetsAtSec != null ? resetsAtSec * 1000 : null,
    };
}

const GrokUsageIndicator = GObject.registerClass(
{GTypeName: 'GrokUsage_GrokUsageIndicator'},
class GrokUsageIndicator extends PanelMenu.Button {
    _init(extensionPath, settings, openPreferences, metadata) {
        super._init(0.0, 'Grok Usage Indicator');

        this._extensionPath = extensionPath;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._metadata = metadata;
        this._session = this._createSession();
        this._cancellable = new Gio.Cancellable();
        this._timerId = null;
        this._flashTimeoutId = null;
        this._monthlyBlinkId = null;
        this._monthlyWillDeplete = false;
        // HANDOFF-6: shared snooze latch + logo master-alarm blinker
        this._warningAck = false;
        this._logoBlinkId = null;
        this._logoColorizeOn = false;
        this._lastKnown = null;
        this._lastFetchAtMs = null;
        // Weekly SuperGrok pool from GetGrokCreditsConfig (auto poll).
        // {pct, resetsAtMs, fetchedAtMs, source: 'auto'}
        this._lastKnownWeek = null;
        this._consecutiveFailures = 0;
        this._backoffUntilMs = 0;

        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._icon = new St.Icon({
            style_class: 'system-status-icon grok-usage-icon',
            icon_size: PANEL_ICON_BASE_SIZE,
        });
        this._box.add_child(this._icon);

        // Each metric's bar + label live in their own row so the two rows
        // can be re-parented into a horizontal (side-by-side) or vertical
        // (stacked) container without rebuilding the widgets themselves —
        // same layout trick as the upstream Claude Usage extension.
        this._barsBox = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._barsBox);

        this._monthlyRow = new St.BoxLayout({
            style_class: 'panel-bar-row',
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Row layout is [tag][bar][percent] — the leading tag label sits
        // left of the bar so it never blends into the percent digits.
        this._monthlyPanelTag = new St.Label({
            text: 'M',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'grok-usage-label grok-panel-label-monthly grok-panel-tag',
        });
        this._monthlyRow.add_child(this._monthlyPanelTag);

        this._monthlyPanelProgressBg = new St.Widget({
            style_class: 'grok-panel-progress-bg',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._monthlyPanelProgressBar = new St.Widget({
            style_class: 'grok-panel-progress-bar-monthly',
        });
        this._monthlyPanelProgressBg.add_child(this._monthlyPanelProgressBar);
        this._monthlyRow.add_child(this._monthlyPanelProgressBg);

        this._monthlyPanelLabel = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'grok-usage-label grok-panel-label-monthly grok-panel-percent',
        });
        this._monthlyRow.add_child(this._monthlyPanelLabel);

        // Weekly is manual (self-reported), so its bar/label only appear
        // once at least one entry has been logged.
        this._weeklyRow = new St.BoxLayout({
            style_class: 'panel-bar-row',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._weeklyPanelTag = new St.Label({
            text: 'W',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'grok-usage-label grok-panel-label-weekly grok-panel-tag',
            visible: false,
        });
        this._weeklyRow.add_child(this._weeklyPanelTag);

        this._weeklyPanelProgressBg = new St.Widget({
            style_class: 'grok-panel-progress-bg',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._weeklyPanelProgressBar = new St.Widget({
            style_class: 'grok-panel-progress-bar-weekly',
        });
        this._weeklyPanelProgressBg.add_child(this._weeklyPanelProgressBar);
        this._weeklyRow.add_child(this._weeklyPanelProgressBg);

        this._weeklyPanelLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'grok-usage-label grok-panel-label-weekly grok-panel-percent',
            visible: false,
        });
        this._weeklyRow.add_child(this._weeklyPanelLabel);

        // Weekly renders above monthly in the panel (matches the upstream
        // Claude extension's orange-on-top / blue-below row order).
        this._barsBox.add_child(this._weeklyRow);
        this._barsBox.add_child(this._monthlyRow);

        this.add_child(this._box);

        this._hoverTooltip = new St.Label({
            style_class: 'grok-hover-tooltip',
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
        this._updateIconStyle();
        this._updateIconVisibility();
        this._applyWeekLabels();
        this._updateWeeklyAndAlarms();
        this._applyPanelSizing();
        this._applyColorScheme();

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key === 'refresh-interval') {
                this._restartTimer();
            } else if (key === 'show-panel-bar' || key === 'show-panel-percent' ||
                       key === 'show-monthly' || key === 'show-weekly' ||
                       key === 'show-bar-labels') {
                // _updateDisplayMode() also cascades to _updateWeeklyPanel()
                // via _updateWeeklyAndAlarms(), so one call covers both metrics.
                this._updateDisplayMode();
            } else if (key === 'show-icon') {
                this._updateIconVisibility();
            } else if (key === 'icon-style') {
                this._updateIconStyle();
            } else if (key === 'proxy-url') {
                this._recreateSession();
            } else if (key === 'stack-panel-bars') {
                this._updateBarLayout();
            } else if (key === 'warn-on-projected-depletion') {
                this._applyWarningState();
            } else if (key === 'refresh-trigger') {
                // Fired by the "Force Refresh" action in Settings — pull
                // usage now instead of waiting for the next scheduled poll.
                this._refreshUsage();
            }
        });

        this._loadHistoryFromDisk();
        this._seedFromHistory();
        this._seedWeekFromHistory();
        this._applyWeekLabels();
        this._refreshUsage();
        this._startTimer();
    }

    _createMenu() {
        const headerBox = new St.BoxLayout({
            style_class: 'grok-menu-header',
            x_expand: true,
        });
        const headerTitle = new St.Label({
            text: 'Grok Usage',
            style_class: 'grok-menu-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.add_child(headerTitle);
        const refreshButton = new St.Button({
            style_class: 'grok-refresh-button',
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

        // Stale banner
        this._staleBanner = new St.Label({
            text: '',
            style_class: 'grok-stale-banner',
        });
        this._staleBannerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._staleBannerItem.add_child(this._staleBanner);
        this._staleBannerItem.actor.visible = false;
        this.menu.addMenuItem(this._staleBannerItem);

        // Monthly section (auto)
        const monthlyBox = new St.BoxLayout({
            style_class: 'grok-usage-section',
            vertical: true,
            x_expand: true,
        });
        const monthlyHeader = new St.BoxLayout({vertical: false, x_expand: true});
        const monthlyLabel = new St.Label({
            text: 'Monthly',
            style_class: 'grok-section-title',
        });
        monthlyHeader.add_child(monthlyLabel);
        this._monthlyPercent = new St.Label({
            text: '…',
            style_class: 'grok-percent-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        monthlyHeader.add_child(this._monthlyPercent);
        monthlyBox.add_child(monthlyHeader);

        this._periodLabel = new St.Label({
            text: 'Period -',
            style_class: 'grok-reset-label',
        });
        monthlyBox.add_child(this._periodLabel);

        this._lastFetchLabel = new St.Label({
            text: 'Last poll -',
            style_class: 'grok-menu-muted',
        });
        monthlyBox.add_child(this._lastFetchLabel);

        const monthlyItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        monthlyItem.add_child(monthlyBox);
        this.menu.addMenuItem(monthlyItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Weekly section — auto-polled via GetGrokCreditsConfig.
        const weeklyBox = new St.BoxLayout({
            style_class: 'grok-usage-section',
            vertical: true,
            x_expand: true,
        });
        const weeklyHeader = new St.BoxLayout({vertical: false, x_expand: true});
        this._weeklySectionTitle = new St.Label({
            text: 'Weekly',
            style_class: 'grok-section-title',
        });
        weeklyHeader.add_child(this._weeklySectionTitle);
        this._weeklyPercentMenu = new St.Label({
            text: '-',
            style_class: 'grok-percent-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        weeklyHeader.add_child(this._weeklyPercentMenu);
        weeklyBox.add_child(weeklyHeader);

        this._weekLastLabel = new St.Label({
            text: 'No weekly data yet',
            style_class: 'grok-reset-label',
        });
        weeklyBox.add_child(this._weekLastLabel);

        this._weekResetLabel = new St.Label({
            text: '',
            style_class: 'grok-menu-muted',
        });
        weeklyBox.add_child(this._weekResetLabel);

        const weeklyItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        weeklyItem.add_child(weeklyBox);
        this.menu.addMenuItem(weeklyItem);

        // Convenience link to the grok.com usage page.
        const openUsageItem = new PopupMenu.PopupMenuItem('Open grok.com Usage…');
        openUsageItem.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri('https://grok.com/?_s=usage', null);
        });
        this.menu.addMenuItem(openUsageItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Read fresh (free — local file, no network) each time the menu
        // opens, since the token may have refreshed independently since the
        // last poll.
        this._tokenExpiryLabel = new St.Label({
            text: 'Token expires: ...',
            style_class: 'grok-reset-label',
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
            Promise.resolve(this._openPreferences()).catch(e => {
                console.error('Grok Usage: failed to open preferences:', e.message);
            });
        });
        this.menu.addMenuItem(settingsItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const aboutItem = new PopupMenu.PopupMenuItem('About');
        aboutItem.connect('activate', () => this._showAbout());
        this.menu.addMenuItem(aboutItem);
    }

    _getWeekState() {
        return this._lastKnownWeek && this._lastKnownWeek.pct >= 0
            ? this._lastKnownWeek
            : null;
    }

    _applyWeekLabels() {
        const week = this._getWeekState();
        if (!week) {
            if (this._weeklySectionTitle)
                this._weeklySectionTitle.set_text('Weekly');
            this._weekLastLabel.set_text('No weekly data yet');
            this._weeklyPercentMenu.set_text('-');
            if (this._weekResetLabel)
                this._weekResetLabel.set_text('');
        } else {
            if (this._weeklySectionTitle)
                this._weeklySectionTitle.set_text('Weekly');
            const rounded = Math.round(week.pct * 10) / 10;
            const showPct = Number.isInteger(week.pct)
                ? `${week.pct}%`
                : `${rounded}%`;
            this._weeklyPercentMenu.set_text(showPct);
            const when = week.fetchedAtMs
                ? this._fmtLocal(week.fetchedAtMs)
                : '-';
            this._weekLastLabel.set_text(`polled ${when}`);
            if (this._weekResetLabel) {
                if (week.resetsAtMs) {
                    const iso = new Date(week.resetsAtMs).toISOString();
                    this._weekResetLabel.set_text(
                        `Resets in ${this._formatResetTime(iso)}` +
                        `  (${this._fmtLocal(week.resetsAtMs)})`
                    );
                } else {
                    this._weekResetLabel.set_text('');
                }
            }
        }
        this._updateWeeklyPanel();
    }

    // Weekly row visibility is data-driven from the Display page:
    //   show-weekly        — the whole weekly row on/off (gated by week data)
    //   show-panel-bar     — the progress bar column
    //   show-panel-percent — the percent-text column
    //   show-bar-labels    — the leading tag letter
    // Gated by hasWeek — nothing weekly shows until the first auto poll.
    _updateWeeklyPanel() {
        const showWeekly = this._settings.get_boolean('show-weekly');
        const showBar = this._settings.get_boolean('show-panel-bar');
        const showPercent = this._settings.get_boolean('show-panel-percent');
        const showLabels = this._settings.get_boolean('show-bar-labels');
        const week = this._getWeekState();
        const hasWeek = !!week;
        const pct = week?.pct ?? 0;

        this._weeklyRow.visible = showWeekly && hasWeek;
        this._weeklyPanelProgressBg.visible = showBar && hasWeek;
        this._weeklyPanelLabel.visible = showPercent && hasWeek;
        this._weeklyPanelTag.visible = showLabels && hasWeek;
        if (hasWeek) {
            this._weeklyPanelLabel.set_text(`${Math.round(pct)}%`);
            this._updatePanelProgressBar(this._weeklyPanelProgressBar, pct);
        }
    }

    // Refresh the weekly panel row, then recompute the alarm surface
    // (monthly depletion + logo). Kept as one call so every site that changes
    // weekly data or display settings updates both in the right order.
    _updateWeeklyAndAlarms() {
        this._updateWeeklyPanel();
        this._applyWarningState();
    }

    // Monthly row visibility, data-driven from the Display page (parity with
    //   show-monthly        — the whole monthly row on/off
    //   show-panel-bar      — the progress bar column
    //   show-panel-percent  — the percent-text column
    //   show-bar-labels     — the leading tag letter
    // Cascades to _updateWeeklyPanel() via _updateWeeklyAndAlarms().
    _updateDisplayMode() {
        const showMonthly = this._settings.get_boolean('show-monthly');
        const showBar = this._settings.get_boolean('show-panel-bar');
        const showPercent = this._settings.get_boolean('show-panel-percent');
        const showLabels = this._settings.get_boolean('show-bar-labels');

        this._monthlyRow.visible = showMonthly;
        this._monthlyPanelProgressBg.visible = showBar;
        this._monthlyPanelLabel.visible = showPercent;
        this._monthlyPanelTag.visible = showLabels;

        this._updateWeeklyAndAlarms();
    }

    _updateBarLayout() {
        const stacked = this._settings.get_boolean('stack-panel-bars');
        const rowAlign = stacked ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER;
        // GNOME 48: St.BoxLayout.vertical is deprecated — use orientation.
        this._barsBox.orientation = stacked
            ? Clutter.Orientation.VERTICAL
            : Clutter.Orientation.HORIZONTAL;
        this._barsBox.spacing = stacked ? 0 : 6;
        this._monthlyRow.orientation = Clutter.Orientation.HORIZONTAL;
        this._weeklyRow.orientation = Clutter.Orientation.HORIZONTAL;
        this._monthlyRow.y_align = rowAlign;
        this._weeklyRow.y_align = rowAlign;
        this._monthlyPanelProgressBg.y_align = rowAlign;
        this._weeklyPanelProgressBg.y_align = rowAlign;
        this._monthlyPanelTag.y_align = rowAlign;
        this._weeklyPanelTag.y_align = rowAlign;
        this._monthlyPanelLabel.y_align = rowAlign;
        this._weeklyPanelLabel.y_align = rowAlign;
        this._monthlyRow.set_style(null);
        if (stacked)
            this._barsBox.add_style_class_name('panel-bars-stacked');
        else
            this._barsBox.remove_style_class_name('panel-bars-stacked');
        this._applyPanelSizing();
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
            this._monthlyPanelTag, this._monthlyPanelLabel,
            this._weeklyPanelTag, this._weeklyPanelLabel,
        ];
        const bars = [
            this._monthlyPanelProgressBg, this._monthlyPanelProgressBar,
            this._weeklyPanelProgressBg, this._weeklyPanelProgressBar,
        ];

        if (!stacked) {
            for (const label of labels)
                label.set_style(null);
            for (const bar of bars)
                bar.set_style(null);
            this._monthlyRow.set_style(null);
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

        this._monthlyRow.set_style(`margin-top: ${marginPx}px;`);
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
        const style = this._settings.get_string('icon-style') || 'light';
        // light logo on dark panels; dark logo on light panels; color = default brand
        let base = 'grok-light';
        if (style === 'dark')
            base = 'grok-dark';
        else if (style === 'color')
            base = 'grok';
        const path22 = GLib.build_filenamev([this._extensionPath, 'images', `${base}-22.png`]);
        const pathFull = GLib.build_filenamev([this._extensionPath, 'images', `${base}.png`]);
        const file22 = Gio.File.new_for_path(path22);
        const path = file22.query_exists(null) ? path22 : pathFull;
        try {
            this._icon.gicon = Gio.icon_new_for_string(path);
        } catch (e) {
            console.error('Grok Usage: icon load failed:', e.message);
            this._icon.icon_name = 'utilities-system-monitor-symbolic';
        }
        // PNG swap clears visual tint; re-apply colorize if mid-alarm flash phase.
        if (this._logoColorizeOn)
            this._applyLogoColorize(true);
    }

    _seedFromHistory() {
        const history = this._getHistory();
        for (let i = history.length - 1; i >= 0; i--) {
            const e = history[i];
            if (e.kind === 'month' || (e.used != null && e.limit != null)) {
                this._lastKnown = {
                    used: e.used,
                    limit: e.limit,
                    periodStart: e.period_start ?? null,
                    periodEnd: e.period_end ?? null,
                    pct: e.limit ? (100 * e.used) / e.limit : 0,
                };
                this._staleBanner.set_text('⚠ Last known monthly — not fetched yet this session');
                this._staleBannerItem.actor.visible = true;
                this._updateDisplay(this._lastKnown, {stale: true});
                return;
            }
        }
    }

    /** Seed weekly bar from the most recent auto sample in history. */
    _seedWeekFromHistory() {
        const history = this._getHistory();
        for (let i = history.length - 1; i >= 0; i--) {
            const e = history[i];
            if (e.source !== 'auto')
                continue;
            const pct = e.weekly_pct;
            if (pct == null || pct < 0)
                continue;
            this._lastKnownWeek = {
                pct,
                resetsAtMs: e.week_reset_ms ?? null,
                fetchedAtMs: e.t,
                source: 'auto',
            };
            return;
        }
    }

    _startTimer() {
        const sec = Math.max(30, this._settings.get_int('refresh-interval'));
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
        const baseMs = Math.max(this._settings.get_int('refresh-interval') * 1000, 30000);
        const backoffMs = Math.min(baseMs * 2 ** (this._consecutiveFailures - 1), 30 * 60 * 1000);
        this._backoffUntilMs = Date.now() + backoffMs;
        console.error(`Grok Usage: backing off ${Math.round(backoffMs / 1000)}s after ${this._consecutiveFailures} failure(s)`);
    }

    _registerFetchSuccess() {
        this._consecutiveFailures = 0;
        this._backoffUntilMs = 0;
    }

    _authPath() {
        return GLib.build_filenamev([GLib.get_home_dir(), '.grok', 'auth.json']);
    }

    _refreshUsage() {
        if (Date.now() < this._backoffUntilMs)
            return;

        const file = Gio.File.new_for_path(this._authPath());
        file.load_contents_async(this._cancellable, (f, result) => {
            try {
                const [, contents] = f.load_contents_finish(result);
                const json = JSON.parse(new TextDecoder('utf-8').decode(contents));
                const token = this._extractToken(json);
                if (!token) {
                    this._registerFetchFailure();
                    this._showError('No token — run `grok login`');
                    return;
                }
                // Monthly (cli-chat-proxy) and weekly (grok.com gRPC-web) in parallel.
                this._fetchBilling(token);
                this._fetchWeeklyCredits(token);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                this._registerFetchFailure();
                console.error('Grok Usage: failed to read auth.json:', e.message);
                this._showError('No auth — run `grok login`');
            }
        });
    }

    _extractToken(json) {
        if (!json || typeof json !== 'object')
            return null;
        // ~/.grok/auth.json is keyed by issuer::client_id → { key, refresh_token, ... }
        // Prefer a non-expired SuperGrok/xAI entry when several exist.
        const now = Date.now();
        let fallback = null;
        for (const v of Object.values(json)) {
            if (!v || typeof v !== 'object' || !v.key)
                continue;
            if (!fallback)
                fallback = v.key;
            if (v.expires_at) {
                const exp = new Date(v.expires_at).getTime();
                if (!Number.isNaN(exp) && exp > now)
                    return v.key;
            } else {
                return v.key;
            }
        }
        return fallback || json.key || json.access_token || null;
    }

    _extractExpiry(json) {
        if (!json || typeof json !== 'object')
            return null;
        for (const v of Object.values(json)) {
            if (v && typeof v === 'object' && v.expires_at)
                return v.expires_at;
        }
        return json.expires_at || null;
    }

    _updateTokenExpiryLabel() {
        try {
            const file = Gio.File.new_for_path(this._authPath());
            const [ok, contents] = file.load_contents(null);
            if (!ok)
                throw new Error('no auth file');

            const json = JSON.parse(new TextDecoder('utf-8').decode(contents));
            const expiresAt = this._extractExpiry(json);
            if (!expiresAt) {
                this._tokenExpiryLabel.set_text('Token expires: unknown');
                return;
            }

            const expiresAtMs = new Date(expiresAt).getTime();
            const expired = expiresAtMs < Date.now();
            const when = this._formatResetTime(expiresAt);
            this._tokenExpiryLabel.set_text(
                expired ? 'Token expired' : `Token expires in ${when}`
            );
        } catch (e) {
            this._tokenExpiryLabel.set_text('Token expires: unknown');
        }
    }

    _fetchBilling(token) {
        const message = Soup.Message.new('GET', BILLING_URL);
        message.request_headers.append('Authorization', `Bearer ${token}`);
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
                        if (status === 401)
                            this._showError('Auth expired — run `grok login`');
                        else
                            this._showError(`HTTP ${status}`);
                        return;
                    }

                    const data = JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data()));
                    const cfg = data.config || data;
                    const used = valOf(cfg.used);
                    const limit = valOf(cfg.monthlyLimit);
                    if (used == null || limit == null || limit === 0) {
                        this._registerFetchFailure();
                        this._showError('Bad billing payload');
                        return;
                    }

                    const nowMs = Date.now();
                    const known = {
                        used,
                        limit,
                        periodStart: cfg.billingPeriodStart || null,
                        periodEnd: cfg.billingPeriodEnd || null,
                        onDemandCap: valOf(cfg.onDemandCap),
                        pct: (100 * used) / limit,
                    };

                    this._lastKnown = known;
                    this._lastFetchAtMs = nowMs;
                    this._registerFetchSuccess();
                    this._settings.set_boolean('last-fetch-succeeded', true);
                    this._staleBannerItem.actor.visible = false;
                    this._updateDisplay(known, {stale: false});
                    this._appendHistory({
                        t: nowMs,
                        kind: 'month',
                        used,
                        limit,
                        pct: Math.round(known.pct * 100) / 100,
                        period_start: known.periodStart,
                        period_end: known.periodEnd,
                        on_demand_cap: known.onDemandCap,
                    });
                    this._flashPanel();
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    this._registerFetchFailure();
                    console.error('Grok Usage: fetch failed:', e.message);
                    this._showError('Fetch failed');
                }
            }
        );
    }

    /**
     * Poll weekly SuperGrok pool via grok.com gRPC-web GetGrokCreditsConfig.
     * Failures are quiet (monthly remains authoritative for panel errors);
     * manual entry stays available as fallback.
     */
    _fetchWeeklyCredits(token) {
        const message = Soup.Message.new('POST', CREDITS_URL);
        // Empty gRPC-web data frame (5 zero bytes).
        const body = new GLib.Bytes(new Uint8Array([0, 0, 0, 0, 0]));
        message.set_request_body_from_bytes('application/grpc-web+proto', body);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('Content-Type', 'application/grpc-web+proto');
        message.request_headers.append('x-grpc-web', '1');
        message.request_headers.append('x-user-agent', 'connect-es/2.1.1');
        message.request_headers.append('Origin', 'https://grok.com');
        message.request_headers.append('Referer', 'https://grok.com/?_s=usage');
        message.request_headers.append('Accept', '*/*');
        message.request_headers.append('User-Agent', USER_AGENT);

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (session, result) => {
                try {
                    const gbytes = session.send_and_read_finish(result);
                    const status = message.status_code;
                    if (status !== 200) {
                        console.error(`Grok Usage: weekly credits HTTP ${status}`);
                        return;
                    }

                    const raw = gbytes.get_data();
                    const parsed = parseGrokCreditsConfig(raw);
                    if (!parsed) {
                        console.error('Grok Usage: weekly credits parse failed');
                        return;
                    }

                    const nowMs = Date.now();
                    const existing = this._lastKnownWeek;
                    // Successful auto always becomes the live source (manual
                    // remains available as fallback when auto is down).
                    const prevPct = existing?.source === 'auto' ? existing.pct : null;
                    this._lastKnownWeek = {
                        pct: parsed.usedPercent,
                        resetsAtMs: parsed.resetsAtMs,
                        fetchedAtMs: nowMs,
                        source: 'auto',
                    };
                    this._applyWeekLabels();
                    this._updateWeeklyAndAlarms();

                    // History: log when % changes or first auto sample this stream.
                    const rounded = Math.round(parsed.usedPercent * 100) / 100;
                    if (prevPct == null || Math.abs(prevPct - parsed.usedPercent) >= 0.05) {
                        this._appendHistory({
                            t: nowMs,
                            kind: 'week',
                            weekly_pct: rounded,
                            source: 'auto',
                            week_reset_ms: parsed.resetsAtMs,
                        });
                    }
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    console.error('Grok Usage: weekly credits fetch failed:', e.message);
                }
            }
        );
    }

    _updateDisplay(known, {stale = false} = {}) {
        const pct = known.pct ?? 0;
        const rounded = Math.round(pct * 10) / 10;
        const suffix = stale ? ' (stale)' : '';

        this._setStaleStyle(stale);
        this._monthlyPanelLabel.set_text(`${Math.round(pct)}%`);
        this._updatePanelProgressBar(this._monthlyPanelProgressBar, pct);

        this._monthlyPercent.set_text(`${rounded}%${suffix}`);

        if (known.periodStart || known.periodEnd) {
            this._periodLabel.set_text(
                `Period ${this._fmtIsoDate(known.periodStart)} → ${this._fmtIsoDate(known.periodEnd)}`
            );
        } else {
            this._periodLabel.set_text('Period -');
        }

        if (this._lastFetchAtMs && !stale)
            this._lastFetchLabel.set_text(`Last poll ${this._fmtLocal(this._lastFetchAtMs)}`);
        else if (stale)
            this._lastFetchLabel.set_text('Last poll - (cached)');

        this._monthlyWillDeplete = this._computeMonthlyWillDeplete(
            known.periodEnd, known.periodStart, pct
        );
        // Refresh ends with _applyWarningState (monthly depletion + logo).
        this._updateWeeklyAndAlarms();
    }

    // Recent burn rate (real observed %/ms, from history.jsonl) projected
    // forward across the time remaining until the billing period ends.
    // Mirrors the upstream Claude extension's five-hour/seven-day depletion
    // math, but windowed against the actual billing period (known from the
    // API) instead of a fixed rolling-window duration, and with a much
    // wider MIN_SPAN_MS since monthly polls are far sparser than a 5-minute
    // Claude refresh interval — an adjacent pair of samples a few minutes
    // apart would otherwise produce pure rounding noise.
    _computeMonthlyWillDeplete(periodEndIso, periodStartIso, currentPct) {
        if (!periodEndIso || currentPct == null)
            return false;

        const resetsAtMs = new Date(periodEndIso).getTime();
        const nowMs = Date.now();
        const msToReset = resetsAtMs - nowMs;
        if (msToReset <= 0)
            return false;

        const windowStart = periodStartIso
            ? new Date(periodStartIso).getTime()
            : resetsAtMs - 30 * 24 * 3600 * 1000;

        const inWindow = this._getHistory().filter(
            e => e.kind === 'month' && typeof e.pct === 'number' &&
                e.t >= windowStart && e.t <= nowMs
        );
        if (inWindow.length < 2)
            return false;

        const MIN_SPAN_MS = 6 * 3600 * 1000; // 6 hours
        const first = inWindow[0];
        const last = inWindow[inWindow.length - 1];
        if (last.t - first.t < MIN_SPAN_MS)
            return false;

        const rate = leastSquaresSlope(inWindow.map(p => ({t: p.t, y: p.pct})));
        if (rate == null || rate <= 0)
            return false;

        return currentPct + rate * msToReset > 100;
    }

    // HANDOFF-6 state machine — logo master + monthly depletion cause
    // (gated by warn-on-projected-depletion) → monthly bar. Latch re-arms
    // only when the cause is inactive this cycle.
    // (Maps to future descriptor `flash`/`color` once REFACTOR-1 lands.)
    _applyWarningState() {
        const warnEnabled = this._settings.get_boolean('warn-on-projected-depletion');
        const monthlyActive = !!(this._monthlyWillDeplete && warnEnabled);

        if (!monthlyActive)
            this._warningAck = false;

        this._setBarWarning(
            this._monthlyPanelProgressBar, monthlyActive,
            '_monthlyBlinkId', 'grok-panel-progress-bar-monthly'
        );
        this._setLogoAlarm(monthlyActive && !this._warningAck);
        this._updateSnoozeMenuItem(monthlyActive);
    }

    // Three-way: un-snoozed active → blink; snoozed active → solid red; else normal.
    _setBarWarning(progressBar, active, timerField, normalClass) {
        const warningClass = 'grok-panel-progress-bar-warning';

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

    _updatePanelProgressBar(bar, pct) {
        const maxWidth = 56;
        const width = Math.round((Math.min(100, Math.max(0, pct)) / 100) * maxWidth);
        bar.set_width(width);
    }


    _setStaleStyle(stale) {
        if (stale)
            this._box.add_style_class_name('grok-stale');
        else
            this._box.remove_style_class_name('grok-stale');
    }

    _showError(msg) {
        this._settings.set_boolean('last-fetch-succeeded', false);
        this._staleBanner.set_text(`⚠ ${msg}`);
        this._staleBannerItem.actor.visible = true;
        if (this._lastKnown) {
            this._updateDisplay(this._lastKnown, {stale: true});
        } else {
            this._monthlyPanelTag.visible = false;
            this._monthlyPanelLabel.set_text('!');
        }
    }

    _flashPanel() {
        if (!this._settings.get_boolean('flash-on-refresh'))
            return;
        this._box.add_style_class_name('grok-panel-flash');
        if (this._flashTimeoutId)
            GLib.Source.remove(this._flashTimeoutId);
        this._flashTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._box.remove_style_class_name('grok-panel-flash');
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
            console.error('Grok Usage: history append failed:', e.message);
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
            console.error('Grok Usage: failed to rewrite history:', e.message);
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
            console.error('Grok Usage: failed to open usage report:', e.message);
            Main.notify('Grok Usage', `Could not open usage report: ${e.message}`);
        }
    }

    // No save dialog here — the Shell process doesn't host GTK file
    // choosers. Writes straight to Documents (or home as a fallback) using
    // the same filename scheme as prefs.js's Export CSV button.
    _exportHistoryCsv() {
        try {
            const data = [...this._getHistory()].sort((a, b) => a.t - b.t);
            const lines = ['timestamp,epoch_ms,kind,used,limit,pct,weekly_pct'];
            for (const d of data) {
                lines.push(`${new Date(d.t).toISOString()},${d.t},${d.kind ?? ''},` +
                    `${d.used ?? ''},${d.limit ?? ''},${d.pct ?? ''},${d.weekly_pct ?? ''}`);
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
            Main.notify('Grok Usage', `Exported history to ${outPath}`);
        } catch (e) {
            console.error('Grok Usage: failed to export CSV:', e.message);
            Main.notify('Grok Usage', `Could not export CSV: ${e.message}`);
        }
    }

    _showAbout() {
        const version = this._metadata?.version ?? '?';
        const url = this._metadata?.url ?? '';
        Main.notify('Grok Usage', `Version ${version}\n${url}`);
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

    _fmtIsoDate(iso) {
        if (!iso)
            return '-';
        try {
            const d = new Date(iso);
            return d.toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
        } catch {
            return String(iso).slice(0, 10);
        }
    }

    _formatResetTime(isoString) {
        try {
            const resetDate = new Date(isoString);
            const now = new Date();
            const diffMs = resetDate - now;

            if (diffMs < 0)
                return 'now';

            const diffMins = Math.floor(diffMs / 60000);
            const diffHours = Math.floor(diffMins / 60);
            const diffDays = Math.floor(diffHours / 24);

            if (diffDays > 0)
                return `${diffDays}d ${diffHours % 24}h`;
            else if (diffHours > 0)
                return `${diffHours}h ${diffMins % 60}m`;
            else
                return `${diffMins}m`;
        } catch (e) {
            return '-';
        }
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
        if (this._monthlyBlinkId) {
            GLib.Source.remove(this._monthlyBlinkId);
            this._monthlyBlinkId = null;
        }
        if (this._logoBlinkId) {
            GLib.Source.remove(this._logoBlinkId);
            this._logoBlinkId = null;
        }
        if (this._icon?.get_effect?.(LOGO_ALARM_EFFECT_NAME))
            this._icon.remove_effect_by_name(LOGO_ALARM_EFFECT_NAME);
        this._logoColorizeOn = false;
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

export default class GrokUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._cleanupDeprecatedKeys();
        this._indicator = new GrokUsageIndicator(
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

    // Good-neighbour cleanup: the week↔month skew feature and the manual
    // weekly-entry + nudge feature were both removed and their gschema keys
    // deleted. Reset the orphaned dconf values so upgraders don't carry dead
    // entries under our relocatable path. Idempotent — resetting an
    // already-empty key is a no-op — so running each enable() is harmless.
    // Failures (no dconf binary) are ignored; orphans are inert.
    _cleanupDeprecatedKeys() {
        const base = '/org/gnome/shell/extensions/grok-usage/';
        for (const key of [
            'alignment-tolerance', 'show-alignment',
            'notify-enabled', 'notify-interval-hours', 'last-notify-ms',
            'last-manual-week-pct', 'last-manual-week-ms',
        ]) {
            try {
                Gio.Subprocess.new(
                    ['dconf', 'reset', base + key],
                    Gio.SubprocessFlags.NONE
                );
            } catch (_e) {
                // dconf unavailable or reset failed — leftover keys are inert.
            }
        }
    }
}
