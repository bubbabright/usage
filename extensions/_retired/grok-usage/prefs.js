import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function authPath() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.grok', 'auth.json']);
}

function historyPath() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'grok-usage', 'history.jsonl']);
}

// Reads ~/.grok/auth.json directly — free (local file, no network) and
// authoritative, unlike the 'last-fetch-succeeded' setting which only
// reflects the last poll's HTTP result.
function readTokenExpiry() {
    try {
        const file = Gio.File.new_for_path(authPath());
        const [ok, contents] = file.load_contents(null);
        if (!ok)
            return null;
        const json = JSON.parse(new TextDecoder('utf-8').decode(contents));
        for (const v of Object.values(json)) {
            if (v && typeof v === 'object' && v.expires_at)
                return new Date(v.expires_at).getTime();
        }
        return json.expires_at ? new Date(json.expires_at).getTime() : null;
    } catch (e) {
        return null;
    }
}

// mm-dd-yyyy-hh-mm-AM/PM, e.g. "07-07-2026-03-45-PM" — human-readable at a
// glance in a file browser sorted by name.
function defaultCsvName() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const hours24 = d.getHours();
    const ampm = hours24 >= 12 ? 'PM' : 'AM';
    const hours12 = hours24 % 12 || 12;
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${d.getFullYear()}-` +
        `${pad(hours12)}-${pad(d.getMinutes())}-${ampm}-usage-history`;
}

function loadHistory() {
    try {
        const file = Gio.File.new_for_path(historyPath());
        const [ok, contents] = file.load_contents(null);
        if (!ok)
            return [];
        return new TextDecoder('utf-8').decode(contents)
            .split('\n')
            .filter(l => l.trim())
            .map(l => {
                try {
                    return JSON.parse(l);
                } catch (e) {
                    return null;
                }
            })
            .filter(entry => entry && typeof entry.t === 'number');
    } catch (e) {
        return [];
    }
}

export default class GrokUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Separate pages (rather than one page of stacked groups) so Adw
        // renders its built-in sidebar nav.
        const generalPage = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(generalPage);

        const pollGroup = new Adw.PreferencesGroup({
            title: 'General',
            description: 'Auto-fetch monthly (cli-chat-proxy) + weekly SuperGrok pool (grok.com GetGrokCreditsConfig) using OAuth in ~/.grok/auth.json',
        });
        generalPage.add(pollGroup);

        const refreshRow = new Adw.SpinRow({
            title: 'Refresh Interval',
            subtitle: 'Seconds between monthly + weekly polls',
            adjustment: new Gtk.Adjustment({
                lower: 30,
                upper: 3600,
                step_increment: 30,
                page_increment: 60,
                value: settings.get_int('refresh-interval'),
            }),
        });
        settings.bind('refresh-interval', refreshRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        pollGroup.add(refreshRow);

        const flashRow = new Adw.SwitchRow({
            title: 'Flash Panel on Refresh',
            subtitle: 'Briefly flash the panel indicator each time a live monthly poll succeeds',
        });
        settings.bind('flash-on-refresh', flashRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        pollGroup.add(flashRow);

        // Display
        const displayPage = new Adw.PreferencesPage({
            title: 'Display',
            icon_name: 'preferences-desktop-display-symbolic',
        });
        window.add(displayPage);

        // "Show" holds the four panel columns as a horizontal row of toggles,
        // in the same left-to-right order they appear in the panel bar (logo,
        // label, bar, percent) so the settings read like the bar itself. Each
        // toggle shows/hides that column on every metric row. Kept in parity
        // with the claude extension's Display page.
        const showGroup = new Adw.PreferencesGroup({
            title: 'Show',
            description: 'The four panel columns, in panel order. Each toggle shows or hides that column on every metric row.',
        });
        displayPage.add(showGroup);

        // Adw.SwitchRow stacks vertically; a custom PreferencesRow holding a
        // homogeneous Gtk.Box of [caption-over-switch] cells gives the
        // horizontal, bar-mirroring layout the model calls for.
        const columnsRow = new Adw.PreferencesRow({
            activatable: false,
            selectable: false,
        });
        const columnsBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            homogeneous: true,
            spacing: 6,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        columnsRow.set_child(columnsBox);

        // Order MUST match the panel columns left-to-right: logo, label, bar,
        // percent. Keep in sync with the panel row build in extension.js.
        const panelColumns = [
            {key: 'show-icon', caption: 'Logo'},
            {key: 'show-bar-labels', caption: 'Label'},
            {key: 'show-panel-bar', caption: 'Bar'},
            {key: 'show-panel-percent', caption: 'Percent'},
        ];
        for (const col of panelColumns) {
            const cell = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 6,
                halign: Gtk.Align.CENTER,
            });
            const caption = new Gtk.Label({
                label: col.caption,
                halign: Gtk.Align.CENTER,
            });
            caption.add_css_class('caption');
            const sw = new Gtk.Switch({halign: Gtk.Align.CENTER});
            settings.bind(col.key, sw, 'active', Gio.SettingsBindFlags.DEFAULT);
            cell.append(caption);
            cell.append(sw);
            columnsBox.append(cell);
        }
        showGroup.add(columnsRow);

        // Per-metric row masters — the second visibility axis. Turning a metric
        // off hides its whole row (label + bar + percent) regardless of the
        // column toggles above; turning it on shows whichever columns are
        // enabled. This is where "hide monthly, keep weekly" lives.
        const metricsGroup = new Adw.PreferencesGroup({
            title: 'Metrics',
            description: 'Which metric rows appear in the panel',
        });
        displayPage.add(metricsGroup);

        const showMonthlyRow = new Adw.SwitchRow({
            title: 'Show Monthly',
            subtitle: 'The monthly metric row (blue)',
        });
        settings.bind('show-monthly', showMonthlyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        metricsGroup.add(showMonthlyRow);

        const showWeeklyRow = new Adw.SwitchRow({
            title: 'Show Weekly',
            subtitle: 'The weekly metric row (orange), once auto-polled weekly data exists',
        });
        settings.bind('show-weekly', showWeeklyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        metricsGroup.add(showWeeklyRow);

        const layoutGroup = new Adw.PreferencesGroup({title: 'Layout'});
        displayPage.add(layoutGroup);

        const stackBarsRow = new Adw.SwitchRow({
            title: 'Stack Bars Vertically',
            subtitle: 'Stack the monthly and weekly bars on top of each other instead of side by side',
        });
        settings.bind('stack-panel-bars', stackBarsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        layoutGroup.add(stackBarsRow);

        const styleGroup = new Adw.PreferencesGroup({title: 'Style'});
        displayPage.add(styleGroup);

        const iconStyles = ['light', 'dark', 'color'];
        const iconStyleRow = new Adw.ComboRow({
            title: 'Icon Style',
            subtitle: 'Light for dark panels, dark for light panels',
            model: new Gtk.StringList({strings: ['Light (dark panel)', 'Dark (light panel)', 'Color / default']}),
            selected: Math.max(0, iconStyles.indexOf(settings.get_string('icon-style'))),
        });
        iconStyleRow.connect('notify::selected', () => {
            const i = iconStyleRow.selected;
            if (i >= 0 && i < iconStyles.length)
                settings.set_string('icon-style', iconStyles[i]);
        });
        styleGroup.add(iconStyleRow);

        const behaviourGroup = new Adw.PreferencesGroup({title: 'Behaviour'});
        displayPage.add(behaviourGroup);

        const warnDepletionRow = new Adw.SwitchRow({
            title: 'Warn on Projected Depletion',
            subtitle: 'If burn rate will exhaust the monthly limit before period end, flash the monthly bar (and logo) red — snooze from the panel menu',
        });
        settings.bind('warn-on-projected-depletion', warnDepletionRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviourGroup.add(warnDepletionRow);

        // Flash Panel on Refresh already lives on the General page (next to
        // the poll interval it reacts to) — not duplicated here.

        // Limits page intentionally omitted: the upstream Claude Usage
        // extension's Limits page lists per-model/plan entries discovered
        // from the Anthropic API's dynamic `limits[]` array. xAI's billing
        // endpoint has no equivalent — there is nothing to list.

        const advancedPage = new Adw.PreferencesPage({
            title: 'Advanced',
            icon_name: 'preferences-other-symbolic',
        });
        window.add(advancedPage);

        const authGroup = new Adw.PreferencesGroup({
            title: 'Authentication',
            description: 'Manual token refresh — opt-in only, never triggered automatically by this extension',
        });
        advancedPage.add(authGroup);

        const refreshTokenRow = new Adw.ActionRow({
            title: 'Force Token Refresh',
            subtitle: 'Runs `grok -p "hi" --max-turns 1`. This spends one real message against your quota — click only if you know what that costs.',
        });
        const refreshButton = new Gtk.Button({
            label: 'Refresh Now',
            valign: Gtk.Align.CENTER,
        });
        const runRefresh = () => {
            refreshButton.set_sensitive(false);
            refreshButton.set_label('Refreshing…');
            try {
                const proc = Gio.Subprocess.new(
                    ['grok', '-p', 'hi', '--max-turns', '1'],
                    Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
                );
                proc.wait_async(null, (proc, result) => {
                    try {
                        proc.wait_finish(result);
                        refreshTokenRow.set_subtitle('Done — pulling latest usage now…');
                    } catch (e) {
                        refreshTokenRow.set_subtitle(`Failed: ${e.message}`);
                    }
                    // Nudge the running extension to fetch immediately
                    // instead of waiting up to refresh-interval seconds.
                    settings.set_int('refresh-trigger', settings.get_int('refresh-trigger') + 1);
                    refreshButton.set_sensitive(true);
                    refreshButton.set_label('Refresh Now');
                });
            } catch (e) {
                refreshTokenRow.set_subtitle(`Failed to spawn grok CLI: ${e.message}`);
                refreshButton.set_sensitive(true);
                refreshButton.set_label('Refresh Now');
            }
        };

        refreshButton.connect('clicked', () => {
            const expiresAt = readTokenExpiry();
            const now = Date.now();

            if (expiresAt != null) {
                if (expiresAt <= now) {
                    // Definitively expired — just run, no dialog needed.
                    runRefresh();
                    return;
                }
            } else if (!settings.get_boolean('last-fetch-succeeded')) {
                // Couldn't read expires_at, and the last live poll failed —
                // best guess is the token needs refreshing.
                runRefresh();
                return;
            }

            const minsLeft = expiresAt != null ? Math.round((expiresAt - now) / 60000) : null;
            const validityNote = minsLeft != null
                ? `Your token is still valid for about ${minsLeft} more minute${minsLeft === 1 ? '' : 's'}.`
                : 'Your last usage check succeeded, so the token is probably not expired.';

            const dialog = new Adw.AlertDialog({
                heading: 'Refresh not needed?',
                body: `${validityNote} A measured "hi" call spends a small amount of quota — small, but not free. Run it anyway?`,
            });
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('refresh', 'Refresh Anyway');
            dialog.set_response_appearance('refresh', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.set_default_response('cancel');
            dialog.set_close_response('cancel');
            dialog.connect('response', (_dialog, response) => {
                if (response === 'refresh')
                    runRefresh();
            });
            dialog.present(refreshButton.get_root());
        });
        refreshTokenRow.add_suffix(refreshButton);
        authGroup.add(refreshTokenRow);

        const networkGroup = new Adw.PreferencesGroup({
            title: 'Network',
            description: 'Configure network settings',
        });
        advancedPage.add(networkGroup);

        const proxyRow = new Adw.EntryRow({
            title: 'Proxy URL',
            show_apply_button: true,
        });
        proxyRow.set_text(settings.get_string('proxy-url'));
        proxyRow.connect('apply', () => {
            settings.set_string('proxy-url', proxyRow.get_text());
        });
        networkGroup.add(proxyRow);

        const proxyHint = new Gtk.Label({
            label: 'Example: http://localhost:11809 (leave empty for no proxy)',
            xalign: 0,
            css_classes: ['dim-label', 'caption'],
            margin_start: 12,
            margin_top: 4,
        });
        networkGroup.add(proxyHint);

        const historyPage = new Adw.PreferencesPage({
            title: 'History',
            icon_name: 'document-save-symbolic',
        });
        window.add(historyPage);
        this._buildHistorySection(historyPage, settings, window);

        this._buildAboutPage(window);
    }

    _buildAboutPage(window) {
        const aboutPage = new Adw.PreferencesPage({
            title: 'About',
            icon_name: 'help-about-symbolic',
        });
        window.add(aboutPage);

        const aboutGroup = new Adw.PreferencesGroup();
        aboutPage.add(aboutGroup);

        const iconPath = GLib.build_filenamev([this.path, 'images', 'grok-light.png']);
        const aboutRow = new Adw.ActionRow({
            title: this.metadata.name,
            subtitle: `Version ${this.metadata.version}`,
        });
        aboutRow.add_prefix(new Gtk.Image({
            file: iconPath,
            pixel_size: 32,
        }));
        aboutGroup.add(aboutRow);

        const descRow = new Adw.ActionRow({
            title: this.metadata.description,
        });
        descRow.set_title_lines(0);
        aboutGroup.add(descRow);

        // metadata.json's "url" field is optional per the GNOME Shell
        // extension spec — dev/side-loaded installs often omit it.
        if (this.metadata.url) {
            const linkGroup = new Adw.PreferencesGroup();
            aboutPage.add(linkGroup);

            const repoRow = new Adw.ActionRow({
                title: 'Source repository',
                subtitle: this.metadata.url,
                activatable: true,
            });
            repoRow.add_suffix(new Gtk.Image({icon_name: 'web-browser-symbolic'}));
            repoRow.connect('activated', () => {
                Gtk.show_uri(window, this.metadata.url, Gdk.CURRENT_TIME);
            });
            linkGroup.add(repoRow);
        }

        const notesGroup = new Adw.PreferencesGroup({
            description: 'No Limits page: xAI\'s billing API has no per-model/plan dynamic limits list like Anthropic\'s, so there is nothing to enumerate.',
        });
        aboutPage.add(notesGroup);
    }

    _buildHistorySection(page, settings, window) {
        const reportGroup = new Adw.PreferencesGroup({
            title: 'Usage History Export',
            description: 'Export your local monthly and weekly usage history to CSV.',
        });
        page.add(reportGroup);

        const exportRow = new Adw.ActionRow({
            title: 'Export to CSV',
            subtitle: 'Asks where to save, writes a CSV of every recorded sample',
        });
        const exportButton = new Gtk.Button({
            label: 'Export CSV…',
            valign: Gtk.Align.CENTER,
        });
        exportButton.connect('clicked', () => {
            const csvFilter = new Gtk.FileFilter({name: 'CSV files'});
            csvFilter.add_pattern('*.csv');
            const filterList = new Gio.ListStore({item_type: Gtk.FileFilter});
            filterList.append(csvFilter);

            const dialog = new Gtk.FileDialog({
                title: 'Export Usage History',
                initial_name: `${defaultCsvName()}.csv`,
                filters: filterList,
            });

            const lastDir = settings.get_string('csv-export-dir');
            if (lastDir) {
                try {
                    dialog.set_initial_folder(Gio.File.new_for_path(lastDir));
                } catch (e) {
                    // directory may no longer exist — fall back to default
                }
            }

            dialog.save(exportButton.get_root(), null, (dlg, result) => {
                let file;
                try {
                    file = dlg.save_finish(result);
                } catch (e) {
                    return; // user cancelled
                }
                try {
                    const path = this._exportCsv(file.get_path());
                    settings.set_string('csv-export-dir', GLib.path_get_dirname(path));
                    exportRow.set_subtitle(`Wrote ${path} — closing…`);
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
                        window.close();
                        return GLib.SOURCE_REMOVE;
                    });
                } catch (e) {
                    exportRow.set_subtitle(`Could not export CSV: ${e.message}`);
                }
            });
        });
        exportRow.add_suffix(exportButton);
        exportRow.set_activatable_widget(exportButton);
        reportGroup.add(exportRow);

        const history = loadHistory();
        const months = history.filter(e => e.kind === 'month' || e.used != null).length;
        const weeks = history.filter(e => e.kind === 'week' || e.weekly_pct != null).length;
        const statsRow = new Adw.ActionRow({
            title: 'Samples on Disk',
            subtitle: `${months} monthly · ${weeks} weekly · ${history.length} total lines`,
        });
        reportGroup.add(statsRow);

        const openHist = new Adw.ActionRow({
            title: 'Open History Folder',
        });
        const openBtn = new Gtk.Button({
            label: 'Open',
            valign: Gtk.Align.CENTER,
        });
        openBtn.connect('clicked', () => {
            const dir = GLib.path_get_dirname(historyPath());
            Gio.AppInfo.launch_default_for_uri(`file://${dir}`, null);
        });
        openHist.add_suffix(openBtn);
        openHist.set_activatable_widget(openBtn);
        reportGroup.add(openHist);
    }

    // timestamp column is both a human-readable local string and the raw
    // epoch ms — the latter survives a re-import losslessly.
    _exportCsv(outPath) {
        const data = loadHistory().sort((a, b) => a.t - b.t);

        const lines = ['timestamp,epoch_ms,kind,used,limit,pct,weekly_pct'];
        for (const d of data) {
            const iso = new Date(d.t).toISOString();
            lines.push(`${iso},${d.t},${d.kind ?? ''},${d.used ?? ''},${d.limit ?? ''},${d.pct ?? ''},${d.weekly_pct ?? ''}`);
        }

        GLib.file_set_contents(outPath, lines.join('\n') + '\n');
        return outPath;
    }
}
