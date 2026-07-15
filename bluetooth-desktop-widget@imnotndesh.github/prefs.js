import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.bluetooth-desktop-widget';
const SETTINGS_KEY_WIDGETS_CONFIG = 'widgets-config';


const WIDGET_CATALOG = [
    {
        id: 'bluetooth',
        name: 'Bluetooth',
        icon: 'bluetooth-active-symbolic',
        implemented: true,
        buildSettings: buildBluetoothSettingsGroup,
    },
    {
        id: 'weather',
        name: 'Weather',
        icon: 'weather-few-clouds-symbolic',
        implemented: true,
        buildSettings: buildWeatherSettingsGroup,
    },
    {
        id: 'photos',
        name: 'Photos (Immich)',
        icon: 'image-x-generic-symbolic',
        implemented: false,
        buildSettings: null,
    },
    {
        id: 'clock',
        name: 'Analog Clock',
        icon: 'preferences-system-time-symbolic',
        implemented: false,
        buildSettings: null,
    },
    {
        id: 'storage',
        name: 'Storage',
        icon: 'drive-harddisk-symbolic',
        implemented: false,
        buildSettings: null,
    },
];

function catalogEntry(id) {
    return WIDGET_CATALOG.find((w) => w.id === id);
}

function loadConfig(settings) {
    let raw = settings.get_string(SETTINGS_KEY_WIDGETS_CONFIG);
    let config = [];
    try {
        let parsed = JSON.parse(raw);
        if (Array.isArray(parsed))
            config = parsed.filter((e) => catalogEntry(e.id));
    } catch (e) {
        logError(e, 'Desktop Widgets prefs: corrupt widgets-config, resetting');
    }

    for (let entry of WIDGET_CATALOG) {
        if (!config.some((e) => e.id === entry.id))
            config.push({ id: entry.id, enabled: false });
    }

    return config;
}

function saveConfig(settings, config) {
    settings.set_string(SETTINGS_KEY_WIDGETS_CONFIG, JSON.stringify(config));
}

function buildWidgetsListGroup(settings, window) {
    let group = new Adw.PreferencesGroup({
        title: 'Widgets',
        description: 'Choose which widgets appear on the desktop and in what order',
    });

    function render() {
        for (let row of [...(group._rows || [])])
            group.remove(row);
        group._rows = [];

        let config = loadConfig(settings);

        config.forEach((entry, index) => {
            let meta = catalogEntry(entry.id);

            let row = new Adw.ActionRow({
                title: meta.name,
                subtitle: meta.implemented ? '' : 'Coming soon',
                sensitive: meta.implemented,
            });
            row.add_prefix(new Gtk.Image({ icon_name: meta.icon, pixel_size: 20 }));

            let controls = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 6,
                valign: Gtk.Align.CENTER,
            });

            let upButton = new Gtk.Button({
                icon_name: 'go-up-symbolic',
                valign: Gtk.Align.CENTER,
                sensitive: meta.implemented && index > 0,
                css_classes: ['flat'],
            });
            upButton.connect('clicked', () => {
                let cfg = loadConfig(settings);
                [cfg[index - 1], cfg[index]] = [cfg[index], cfg[index - 1]];
                saveConfig(settings, cfg);
                render();
            });

            let downButton = new Gtk.Button({
                icon_name: 'go-down-symbolic',
                valign: Gtk.Align.CENTER,
                sensitive: meta.implemented && index < config.length - 1,
                css_classes: ['flat'],
            });
            downButton.connect('clicked', () => {
                let cfg = loadConfig(settings);
                [cfg[index], cfg[index + 1]] = [cfg[index + 1], cfg[index]];
                saveConfig(settings, cfg);
                render();
            });

            let toggle = new Gtk.Switch({
                active: entry.enabled,
                valign: Gtk.Align.CENTER,
                sensitive: meta.implemented,
            });
            toggle.connect('notify::active', () => {
                let cfg = loadConfig(settings);
                cfg[index].enabled = toggle.active;
                saveConfig(settings, cfg);
            });

            controls.append(upButton);
            controls.append(downButton);
            controls.append(toggle);
            row.add_suffix(controls);
            row.activatable_widget = toggle;

            group.add(row);
            group._rows.push(row);
        });
    }

    group._rows = [];
    render();

    return group;
}


function buildBluetoothSettingsGroup(settings) {
    let group = new Adw.PreferencesGroup({
        title: 'Bluetooth',
        description: 'Configure the Bluetooth widget',
    });

    let row = new Adw.ComboRow({
        title: 'Widget style',
        subtitle: '"Circles" mimics the iOS battery widget look',
        model: new Gtk.StringList({ strings: ['List', 'Circles'] }),
    });

    let current = settings.get_string('widget-style');
    row.selected = current === 'list' ? 0 : 1;

    row.connect('notify::selected', () => {
        settings.set_string('widget-style', row.selected === 0 ? 'list' : 'circles');
    });

    group.add(row);
    return group;
}

function buildWeatherSettingsGroup(settings) {
    let group = new Adw.PreferencesGroup({
        title: 'Weather',
        description: 'Powered by Open-Meteo — free, no API key required',
    });

    let row = new Adw.EntryRow({
        title: 'Location',
    });
    row.set_text(settings.get_string('weather-location'));

    row.connect('changed', () => {
        settings.set_string('weather-location', row.get_text());
    });

    group.add(row);

    let hint = new Adw.ActionRow({
        subtitle: 'Enter a city name, e.g. "Berlin" or "Austin, US". Leave blank to default to London.',
    });
    group.add(hint);

    return group;
}

export default class DesktopWidgetsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        let settings = this.getSettings(SETTINGS_SCHEMA);

        let page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-desktop-symbolic',
        });

        page.add(buildWidgetsListGroup(settings, window));

        for (let meta of WIDGET_CATALOG) {
            if (meta.implemented && meta.buildSettings)
                page.add(meta.buildSettings(settings));
        }

        window.add(page);
        window.set_default_size(480, 600);
    }
}