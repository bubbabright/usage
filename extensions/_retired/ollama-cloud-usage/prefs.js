// Preferences for Ollama Cloud Usage.
//
// The Cookie page is the intended divergence from the Claude/Grok extensions:
// there is no auth/proxy config here because the DAEMON owns auth. This page just
// forwards a pasted ollama.com session cookie to the daemon
// (POST /usage/ollama/cookie); the daemon persists + uses it. The cookie is never
// stored in GSettings.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class OllamaCloudUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.add(this._generalPage(settings));
        window.add(this._displayPage(settings));
        window.add(this._cookiePage(settings));
        window.add(this._aboutPage());
    }

    _generalPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: 'Daemon',
            description: 'This extension reads usage from a local usage-daemon.',
        });
        page.add(group);

        const url = new Adw.EntryRow({title: 'Daemon URL'});
        url.text = settings.get_string('daemon-url');
        url.connect('changed', () =>
            settings.set_string('daemon-url', url.text.trim()));
        group.add(url);

        const interval = new Adw.SpinRow({
            title: 'Client refresh interval (seconds)',
            subtitle: 'How often to re-read the daemon (the daemon does the real polling)',
            adjustment: new Gtk.Adjustment({lower: 10, upper: 3600, step_increment: 10}),
        });
        settings.bind('poll-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(interval);

        return page;
    }

    _displayPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Display',
            icon_name: 'view-reveal-symbolic',
        });

        const show = new Adw.PreferencesGroup({title: 'Show'});
        page.add(show);
        for (const [key, title] of [
            ['show-icon', 'Icon'],
            ['show-tier', 'Tier badge'],
            ['show-session-bar', 'Session bar'],
            ['show-weekly-bar', 'Weekly bar'],
            ['show-bar-labels', 'S / W letter before each bar'],
        ]) {
            const row = new Adw.SwitchRow({title});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            show.add(row);
        }

        const layout = new Adw.PreferencesGroup({title: 'Layout'});
        page.add(layout);
        const stack = new Adw.SwitchRow({
            title: 'Stack bars vertically',
            subtitle: 'Session over Weekly instead of side by side',
        });
        settings.bind('stack-panel-bars', stack, 'active', Gio.SettingsBindFlags.DEFAULT);
        layout.add(stack);

        const behaviour = new Adw.PreferencesGroup({title: 'Behaviour'});
        page.add(behaviour);
        const warn = new Adw.SwitchRow({
            title: 'Warn on projected depletion',
            subtitle: 'Blink a bar when the daemon projects it to hit 100% before reset',
        });
        settings.bind('warn-on-projected-depletion', warn, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(warn);

        return page;
    }

    _cookiePage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Cookie',
            icon_name: 'dialog-password-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: 'ollama.com session cookie',
            description:
                'Ollama\'s website authenticates on the browser session cookie ' +
                '(not the API key). Paste it here and it is sent to the daemon, ' +
                'which stores and uses it. Firefox: F12 → Network → reload → click ' +
                'the "settings" request → Request Headers → copy the Cookie value.',
        });
        page.add(group);

        const entry = new Adw.PasswordEntryRow({title: 'Cookie'});
        group.add(entry);

        const status = new Gtk.Label({label: '', wrap: true, xalign: 0, margin_top: 6});
        status.add_css_class('dim-label');

        const send = new Gtk.Button({
            label: 'Send to daemon',
            halign: Gtk.Align.START,
            margin_top: 6,
            css_classes: ['suggested-action'],
        });
        send.connect('clicked', () => {
            const cookie = entry.text.trim();
            if (!cookie) {
                status.label = 'Nothing to send — paste a cookie first.';
                return;
            }
            status.label = 'Sending…';
            this._postCookie(settings.get_string('daemon-url'), cookie, (ok, detail) => {
                status.label = ok
                    ? `✓ Daemon accepted the cookie. ${detail}`
                    : `✗ ${detail}`;
                if (ok)
                    entry.text = '';
            });
        });

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        box.append(send);
        box.append(status);
        const holder = new Adw.PreferencesGroup();
        holder.add(box);
        page.add(holder);

        return page;
    }

    _postCookie(daemonUrl, cookie, cb) {
        try {
            const base = daemonUrl.replace(/\/+$/, '');
            const session = new Soup.Session({timeout: 15});
            const msg = Soup.Message.new('POST', `${base}/usage/ollama/cookie`);
            msg.set_request_body_from_bytes(
                'text/plain',
                new GLib.Bytes(new TextEncoder().encode(cookie)));
            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                try {
                    const bytes = s.send_and_read_finish(res);
                    const code = msg.get_status();
                    if (code !== Soup.Status.OK) {
                        cb(false, `Daemon returned HTTP ${code}.`);
                        return;
                    }
                    const snap = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    if (snap.status === 'ok')
                        cb(true, `Tier ${snap.tier}, live usage now flowing.`);
                    else if (snap.status === 'auth_expired')
                        cb(false, 'Daemon stored it but ollama.com rejected it — cookie may be wrong or expired.');
                    else
                        cb(true, `Stored (status: ${snap.status}).`);
                } catch (e) {
                    cb(false, `Bad response from daemon: ${e.message}`);
                }
            });
        } catch (e) {
            cb(false, `Could not reach daemon: ${e.message}`);
        }
    }

    _aboutPage() {
        const page = new Adw.PreferencesPage({
            title: 'About',
            icon_name: 'help-about-symbolic',
        });
        const group = new Adw.PreferencesGroup();
        page.add(group);
        group.add(new Adw.ActionRow({
            title: 'Ollama Cloud Usage',
            subtitle: 'Thin client of usage-daemon — reads localhost, never scrapes. Not affiliated with Ollama.',
        }));
        group.add(new Adw.ActionRow({
            title: 'Daemon',
            subtitle: 'github.com/bubbabright/usage-daemon',
        }));
        return page;
    }
}
