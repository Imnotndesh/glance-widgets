/* prefs.js
 *
 * Generic preferences UI for Desktop Widgets.
 *
 * Two concerns, kept separate:
 *   1. WIDGET_CATALOG — which widgets exist, for the enable/reorder list.
 *      Metadata-only (id/name/icon); duplicated here rather than imported
 *      from extension.js because prefs.js runs in a separate process
 *      (org.gnome.Extensions) that doesn't have access to Shell UI
 *      modules extension.js imports at the top level.
 *   2. Per-widget settings groups — one function per widget that needs
 *      configuration, added to the page below the enable/reorder list.
 *
 * ---------------------------------------------------------------------
 * ADDING A NEW WIDGET'S PREFS
 * ---------------------------------------------------------------------
 * 1. Add an entry to WIDGET_CATALOG (id must match extension.js's
 *    WIDGET_DEFS key exactly).
 * 2. If it needs configuration, write a buildXxxSettingsGroup(settings)
 *    function returning an Adw.PreferencesGroup, and reference it from
 *    that catalog entry's `buildSettings` field.
 * 3. Add the corresponding gschema keys.
 * ---------------------------------------------------------------------
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SETTINGS_KEY_WIDGETS_CONFIG = 'widgets-config';

// ======================================================================
// Widget catalog — metadata + optional settings-group builder
// ======================================================================

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
        implemented: false,
        buildSettings: null,
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

// ======================================================================
// widgets-config load/save helpers
// ======================================================================

// Returns the ordered config array, guaranteed to contain one entry per
// catalog widget (missing ones appended as disabled) so the UI always
// shows every known widget even after a fresh install or a new widget
// being added to the catalog.
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

// ======================================================================
// Enable / reorder list
// ======================================================================

function buildWidgetsListGroup(settings, window) {
    let group = new Adw.PreferencesGroup({
        title: 'Widgets',
        description: 'Choose which widgets appear on the desktop and in what order',
    });

    function render() {
        // Clear existing rows.
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

// ======================================================================
// Per-widget settings groups
// ======================================================================

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

// Placeholders for future widgets — wire these up in WIDGET_CATALOG's
// `buildSettings` field once each widget is implemented in extension.js.
//
// function buildWeatherSettingsGroup(settings) { ... }
// function buildPhotosSettingsGroup(settings) { ... }
// function buildStorageSettingsGroup(settings) { ... }

// ======================================================================
// Window assembly
// ======================================================================

export default class DesktopWidgetsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        let settings = this.getSettings();

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