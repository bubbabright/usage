import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function historyPath() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'firecrawl-usage', 'history.jsonl']);
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

export default class FirecrawlUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const generalPage = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(generalPage);

        const pollGroup = new Adw.PreferencesGroup({
            title: 'General',
            description: 'Auto-fetch GET /v2/team/credit-usage using the API key in ~/.config/firecrawl-cli/credentials.json (firecrawl login)',
        });
        generalPage.add(pollGroup);

        const refreshRow = new Adw.SpinRow({
            title: 'Refresh Interval',
            subtitle: 'Seconds between polls',
            adjustment: new Gtk.Adjustment({
                lower: 60,
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
            subtitle: 'Briefly flash the panel indicator each time a live poll succeeds',
        });
        settings.bind('flash-on-refresh', flashRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        pollGroup.add(flashRow);

        // Display
        const displayPage = new Adw.PreferencesPage({
            title: 'Display',
            icon_name: 'preferences-desktop-display-symbolic',
        });
        window.add(displayPage);

        const showGroup = new Adw.PreferencesGroup({
            title: 'Show',
            description: 'Panel columns: logo, progress bar, remaining-credits label',
        });
        displayPage.add(showGroup);

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

        const panelColumns = [
            {key: 'show-icon', caption: 'Logo'},
            {key: 'show-panel-bar', caption: 'Bar'},
            {key: 'show-panel-text', caption: 'Credits'},
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

        const behaviourGroup = new Adw.PreferencesGroup({title: 'Behaviour'});
        displayPage.add(behaviourGroup);

        const warnRow = new Adw.SwitchRow({
            title: 'Warn on Low Runway',
            subtitle: 'If burn rate projects the balance hitting zero within the threshold below, blink the panel bar red — snooze from the panel menu',
        });
        settings.bind('warn-on-low-runway', warnRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviourGroup.add(warnRow);

        const runwayDaysRow = new Adw.SpinRow({
            title: 'Runway Warning Threshold',
            subtitle: 'Days of projected balance remaining before warning',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 90,
                step_increment: 1,
                page_increment: 7,
                value: settings.get_int('runway-warn-days'),
            }),
        });
        settings.bind('runway-warn-days', runwayDaysRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        behaviourGroup.add(runwayDaysRow);

        const advancedPage = new Adw.PreferencesPage({
            title: 'Advanced',
            icon_name: 'preferences-other-symbolic',
        });
        window.add(advancedPage);

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

        const authGroup = new Adw.PreferencesGroup({
            title: 'Authentication',
            description: 'The firecrawl CLI holds a static API key (no OAuth expiry, nothing to refresh). ' +
                'If auth fails, run `firecrawl login` in a terminal, then hit the refresh button in the panel menu.',
        });
        advancedPage.add(authGroup);

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

        const aboutRow = new Adw.ActionRow({
            title: this.metadata.name,
            subtitle: `Version ${this.metadata.version}`,
        });
        aboutRow.add_prefix(new Gtk.Image({
            icon_name: 'edit-find-symbolic',
            pixel_size: 32,
        }));
        aboutGroup.add(aboutRow);

        const descRow = new Adw.ActionRow({
            title: this.metadata.description,
        });
        descRow.set_title_lines(0);
        aboutGroup.add(descRow);

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
            description: 'Balance can exceed one cycle\'s plan credits (rollover), so the panel shows a raw credit ' +
                'count rather than a 0-100% quota bar. The bar itself is capped at one cycle\'s worth.',
        });
        aboutPage.add(notesGroup);
    }

    _buildHistorySection(page, settings, window) {
        const reportGroup = new Adw.PreferencesGroup({
            title: 'Usage History Export',
            description: 'Export your local credit-balance history to CSV.',
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
        const statsRow = new Adw.ActionRow({
            title: 'Samples on Disk',
            subtitle: `${history.length} samples`,
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

        const lines = ['timestamp,epoch_ms,remaining,plan,pct'];
        for (const d of data) {
            const iso = new Date(d.t).toISOString();
            lines.push(`${iso},${d.t},${d.remaining ?? ''},${d.plan ?? ''},${d.pct ?? ''}`);
        }

        GLib.file_set_contents(outPath, lines.join('\n') + '\n');
        return outPath;
    }
}
