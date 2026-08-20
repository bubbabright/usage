import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function historyPath() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-code-usage', 'history.jsonl']);
}

// Reads ~/.claude/.credentials.json directly — free (local file, no
// network) and authoritative, unlike the 'last-fetch-succeeded' setting
// which only reflects the last poll's HTTP result (could be stale, or
// false for unrelated reasons like a 429).
function readTokenExpiry() {
    try {
        const configDir = GLib.getenv('CLAUDE_CONFIG_DIR') ??
            GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
        const credentialsPath = GLib.build_filenamev([configDir, '.credentials.json']);
        const file = Gio.File.new_for_path(credentialsPath);
        const [ok, contents] = file.load_contents(null);
        if (!ok)
            return null;
        const json = JSON.parse(new TextDecoder('utf-8').decode(contents));
        return json.claudeAiOauth?.expiresAt ?? null;
    } catch (e) {
        return null;
    }
}

function limitsPath() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-code-usage', 'limits.json']);
}

// Populated by extension.js from the API's `limits[]` array — prefs.js never
// makes an API call itself, so this cache file (written alongside
// history.jsonl) is the only way Settings can know which per-model/plan
// limits exist to list them here. Empty until the extension has completed
// at least one successful fetch.
function loadKnownLimits() {
    try {
        const file = Gio.File.new_for_path(limitsPath());
        const [ok, contents] = file.load_contents(null);
        if (!ok)
            return [];
        const parsed = JSON.parse(new TextDecoder('utf-8').decode(contents));
        return Array.isArray(parsed) ? parsed.filter(e => e && e.id && e.label) : [];
    } catch (e) {
        return [];
    }
}

function getHiddenExtraLimitIds(settings) {
    try {
        return new Set(JSON.parse(settings.get_string('hidden-extra-limits') || '[]'));
    } catch (e) {
        return new Set();
    }
}

function setExtraLimitHidden(settings, id, isHidden) {
    const hidden = getHiddenExtraLimitIds(settings);
    if (isHidden)
        hidden.add(id);
    else
        hidden.delete(id);
    settings.set_string('hidden-extra-limits', JSON.stringify([...hidden]));
}

// mm-dd-yyyy-hh-mm-AM/PM, e.g. "07-07-2026-03-45-PM" — human-readable at a
// glance in a file browser sorted by name, unlike an ISO/epoch prefix.
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

export default class ClaudeUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Separate pages (rather than one page of stacked groups) so Adw
        // renders its built-in sidebar nav — free wayfinding once the
        // settings list is this long.
        const generalPage = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(generalPage);

        const generalGroup = new Adw.PreferencesGroup({
            title: 'General',
            description: 'Configure the Claude Usage extension',
        });
        generalPage.add(generalGroup);

        const refreshRow = new Adw.SpinRow({
            title: 'Refresh Interval',
            subtitle: 'How often to refresh usage data (in seconds)',
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 600,
                step_increment: 10,
                page_increment: 60,
                value: settings.get_int('refresh-interval'),
            }),
        });
        settings.bind(
            'refresh-interval',
            refreshRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        generalGroup.add(refreshRow);

        const displayPage = new Adw.PreferencesPage({
            title: 'Display',
            icon_name: 'preferences-desktop-display-symbolic',
        });
        window.add(displayPage);

        // "Show" is the four global column toggles — logo · label · bar ·
        // percent — laid out HORIZONTALLY in the same left-to-right order the
        // columns appear in the panel, so the switch row is a literal picture
        // of the bar. Toggling one column hides/shows that column on every
        // visible metric row at once. Which metric rows exist is a separate
        // axis (the Metrics group below), so no control owns two scopes and
        // hiding one thing can never strand another with no way back.
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

        // Per-metric row masters — the second visibility axis. Turning a
        // metric off hides its whole row (label + bar + percent) regardless of
        // the column toggles above; turning it on shows whichever columns are
        // enabled. This is where "hide monthly, keep weekly" lives.
        const metricsGroup = new Adw.PreferencesGroup({
            title: 'Metrics',
            description: 'Which metric rows appear in the panel',
        });
        displayPage.add(metricsGroup);

        const showFiveHourRow = new Adw.SwitchRow({
            title: 'Show 5-Hour',
            subtitle: 'The 5-hour metric row (orange)',
        });
        settings.bind('show-five-hour', showFiveHourRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        metricsGroup.add(showFiveHourRow);

        const showSevenDayRow = new Adw.SwitchRow({
            title: 'Show 7-Day',
            subtitle: 'The 7-day metric row (blue)',
        });
        settings.bind('show-seven-day', showSevenDayRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        metricsGroup.add(showSevenDayRow);

        const layoutGroup = new Adw.PreferencesGroup({title: 'Layout'});
        displayPage.add(layoutGroup);

        const stackBarsRow = new Adw.SwitchRow({
            title: 'Stack Bars Vertically',
            subtitle: 'Stack the 5-hour and 7-day bars on top of each other instead of side by side',
        });
        settings.bind('stack-panel-bars', stackBarsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        layoutGroup.add(stackBarsRow);

        const styleGroup = new Adw.PreferencesGroup({title: 'Style'});
        displayPage.add(styleGroup);

        const iconStyleRow = new Adw.ComboRow({
            title: 'Icon Style',
            subtitle: 'Use a color or monochrome icon in the panel',
        });

        const iconStyleModel = new Gtk.StringList();
        iconStyleModel.append('Color');
        iconStyleModel.append('Monochrome');
        iconStyleRow.set_model(iconStyleModel);

        const currentStyle = settings.get_string('icon-style');
        iconStyleRow.set_selected(currentStyle === 'monochrome' ? 1 : 0);

        iconStyleRow.connect('notify::selected', () => {
            const selected = iconStyleRow.get_selected();
            settings.set_string('icon-style', selected === 1 ? 'monochrome' : 'color');
        });

        styleGroup.add(iconStyleRow);

        // "Show Metric Letter" moved OUT of Style — the letter is now the
        // "Label" column toggle in the Show group (one of the four panel
        // columns), not a style option.

        const behaviourGroup = new Adw.PreferencesGroup({title: 'Behaviour'});
        displayPage.add(behaviourGroup);

        const warnDepletionRow = new Adw.SwitchRow({
            title: 'Warn on Projected Depletion',
            subtitle: 'If current burn rate is on track to exhaust a limit before its reset, blink that panel bar red',
        });
        settings.bind('warn-on-projected-depletion', warnDepletionRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviourGroup.add(warnDepletionRow);

        const flashOnRefreshRow = new Adw.SwitchRow({
            title: 'Flash Panel on Refresh',
            subtitle: 'Briefly flash the panel indicator each time a live usage fetch succeeds',
        });
        settings.bind('flash-on-refresh', flashOnRefreshRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviourGroup.add(flashOnRefreshRow);

        const limitsPage = new Adw.PreferencesPage({
            title: 'Limits',
            icon_name: 'view-list-symbolic',
        });
        window.add(limitsPage);

        const extraLimitsGroup = new Adw.PreferencesGroup({
            title: 'Extra Limits',
            description: 'Show or hide per-model/plan limits (from the API\'s dynamic ' +
                'limits list) in the panel dropdown. Populated after the extension\'s ' +
                'next successful fetch — empty on a fresh install.',
        });
        limitsPage.add(extraLimitsGroup);

        const knownLimits = loadKnownLimits();
        if (knownLimits.length === 0) {
            const emptyRow = new Adw.ActionRow({
                title: 'No extra limits known yet',
                subtitle: 'Open this after the extension has fetched usage data at least once',
            });
            extraLimitsGroup.add(emptyRow);
        } else {
            const hidden = getHiddenExtraLimitIds(settings);
            for (const {id, label} of knownLimits) {
                const row = new Adw.SwitchRow({
                    title: label,
                    active: !hidden.has(id),
                });
                row.connect('notify::active', () => {
                    setExtraLimitHidden(settings, id, !row.get_active());
                });
                extraLimitsGroup.add(row);
            }
        }

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
            subtitle: 'Runs `claude -p "hi" --max-turns 1`. This spends one real message against your quota — click only if you know what that costs.',
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
                    ['claude', '-p', 'hi', '--max-turns', '1'],
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
                refreshTokenRow.set_subtitle(`Failed to spawn claude CLI: ${e.message}`);
                refreshButton.set_sensitive(true);
                refreshButton.set_label('Refresh Now');
            }
        };

        refreshButton.connect('clicked', () => {
            // Check the real token expiry first — free (local file, no
            // network) and authoritative. Falls back to the
            // last-fetch-succeeded proxy only if the credentials file can't
            // be read at all.
            const expiresAt = readTokenExpiry();
            const now = Date.now();

            if (expiresAt != null) {
                if (expiresAt <= now) {
                    // Definitively expired — just run, no dialog needed.
                    runRefresh();
                    return;
                }
            } else if (!settings.get_boolean('last-fetch-succeeded')) {
                // Couldn't read expiresAt, and the last live poll failed —
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
                body: `${validityNote} A measured "hi" call costs about ` +
                    '0.33% of your 5-hour limit and 0.06% of your 7-day ' +
                    'limit — small, but not free. Run it anyway?',
            });
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('refresh', 'Refresh Anyway');
            dialog.set_response_appearance('refresh', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.set_default_response('cancel');
            dialog.set_close_response('cancel');
            dialog.connect('response', (_dialog, response) => {
                if (response === 'refresh') {
                    runRefresh();
                }
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

        const iconPath = GLib.build_filenamev([this.path, 'claude-icon-22.png']);
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
    }

    _buildHistorySection(page, settings, window) {
        const reportGroup = new Adw.PreferencesGroup({
            title: 'Usage History Export',
            description: 'Export your local 5-hour and 7-day utilization history to CSV.',
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
            const csvFilter = new Gtk.FileFilter({ name: 'CSV files' });
            csvFilter.add_pattern('*.csv');
            const filterList = new Gio.ListStore({ item_type: Gtk.FileFilter });
            filterList.append(csvFilter);

            const dialog = new Gtk.FileDialog({
                title: 'Export Usage History',
                initial_name: `${defaultCsvName()}.csv`,
                filters: filterList,
            });

            // Reopen wherever the user last saved to — persisted in
            // GSettings (dconf), so it survives across reboots, not just
            // this process's lifetime.
            const lastDir = settings.get_string('csv-export-dir');
            if (lastDir) {
                try {
                    dialog.set_initial_folder(Gio.File.new_for_path(lastDir));
                } catch (e) {
                    // directory may no longer exist (removable drive, etc.) — fall back to default
                }
            }

            dialog.save(exportButton.get_root(), null, (dlg, result) => {
                let file;
                try {
                    file = dlg.save_finish(result);
                } catch (e) {
                    return; // user cancelled — not an error, nothing to report
                }
                try {
                    const path = this._exportCsv(file.get_path());
                    settings.set_string('csv-export-dir', GLib.path_get_dirname(path));
                    exportRow.set_subtitle(`Wrote ${path} — closing…`);
                    // Prefs windows are easy to lose behind other windows
                    // (this one especially — opened via the panel dropdown,
                    // no taskbar entry of its own). Export is a one-shot
                    // action with nothing left to configure afterward, so
                    // auto-close rather than leave another buried window
                    // behind. Brief delay so the "Wrote ..." subtitle is
                    // actually readable before it vanishes.
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
    }

    // timestamp column is both a human-readable local string and the raw
    // epoch ms — Excel et al. parse the former for display, but the latter
    // survives a re-import losslessly (no locale/format round-trip risk).
    // No leading comment/tip rows — see README for the local-time formulas.
    _exportCsv(outPath) {
        const data = loadHistory().sort((a, b) => a.t - b.t);

        const lines = ['timestamp,epoch_ms,five_hour,seven_day'];
        for (const d of data) {
            const iso = new Date(d.t).toISOString();
            lines.push(`${iso},${d.t},${d.five_hour ?? ''},${d.seven_day ?? ''}`);
        }

        GLib.file_set_contents(outPath, lines.join('\n') + '\n');
        return outPath;
    }

    // Reads the bundled HTML template, injects the local history inline (no
    // server, no CORS — opens straight from file://), writes the result to
    // the cache dir, and returns a file:// URI to launch. When the daemon
    // lands, this whole method is replaced by opening the daemon's URL.
    _generateReport() {
        const templatePath = GLib.build_filenamev([this.path, 'report', 'usage-report.template.html']);
        const [ok, templateBytes] = Gio.File.new_for_path(templatePath).load_contents(null);
        if (!ok)
            throw new Error('report template not found');
        const template = new TextDecoder('utf-8').decode(templateBytes);

        const data = loadHistory().sort((a, b) => a.t - b.t);
        // Replace the full assignment statements, not the bare placeholder
        // tokens — the tokens also appear in the template's doc comment, and
        // String.replace(string, ...) only swaps the FIRST match, which would
        // otherwise hit the comment and leave the real code as an empty array.
        const html = template
            .replace('const USAGE_DATA = /*__USAGE_DATA__*/[];',
                `const USAGE_DATA = ${JSON.stringify(data)};`)
            .replace('const GENERATED_AT = /*__GENERATED_AT__*/0;',
                `const GENERATED_AT = ${Date.now()};`);

        const outDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-code-usage']);
        GLib.mkdir_with_parents(outDir, 0o755);
        const outPath = GLib.build_filenamev([outDir, 'usage-report.html']);
        GLib.file_set_contents(outPath, html);

        return GLib.filename_to_uri(outPath, null);
    }
}
