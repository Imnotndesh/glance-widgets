/* extension.js
 *
 * Bluetooth Desktop Widget
 * -------------------------
 * Floating desktop widget listing connected Bluetooth devices with their
 * battery level, styled after the iOS Bluetooth device card (rounded card,
 * symbolic device icon on the left, name + battery pill on the right).
 *
 * Everything — D-Bus/BlueZ logic, widget construction, and styling — lives
 * in this single file on purpose (no lib/ folder, no external stylesheet),
 * per extensions.gnome.org review requirements about unreachable files.
 */

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BLUEZ_SERVICE = 'org.bluez';
const OM_IFACE = 'org.freedesktop.DBus.ObjectManager';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';
const DEVICE_IFACE = 'org.bluez.Device1';
const BATTERY_IFACE = 'org.bluez.Battery1';

// Map BlueZ's "Icon" property hint -> a symbolic icon name that ships
// with GNOME's icon theme, so we don't need to bundle any icon assets.
const ICON_MAP = {
    'audio-headset': 'audio-headphones-symbolic',
    'audio-headphones': 'audio-headphones-symbolic',
    'audio-card': 'audio-speakers-symbolic',
    'input-gaming': 'input-gaming-symbolic',
    'input-mouse': 'input-mouse-symbolic',
    'input-keyboard': 'input-keyboard-symbolic',
    'input-tablet': 'input-tablet-symbolic',
    'phone': 'phone-symbolic',
    'computer': 'computer-symbolic',
};
const FALLBACK_ICON = 'bluetooth-active-symbolic';

function iconNameFor(hint) {
    return ICON_MAP[hint] || FALLBACK_ICON;
}

// Round a battery percentage down to the nearest 10 to pick a
// battery-level-N-symbolic icon (GNOME ships these in steps of 10,
// from battery-level-0-symbolic to battery-level-100-symbolic).
function batteryIconFor(percentage) {
    let level = Math.max(0, Math.min(100, Math.round(percentage / 10) * 10));
    return `battery-level-${level}-symbolic`;
}

function unpackVariantDict(dict) {
    let out = {};
    for (let key in dict)
        out[key] = dict[key].deep_unpack();
    return out;
}

export default class BluetoothDesktopWidgetExtension extends Extension {
    enable() {
        this._bus = Gio.DBus.system;
        this._devices = new Map(); // path -> { name, icon, connected, percentage }
        this._signalId = null;

        this._buildWidget();
        this._refreshFromBus();
        this._subscribeToChanges();
    }

    disable() {
        if (this._signalId !== null) {
            this._bus.signal_unsubscribe(this._signalId);
            this._signalId = null;
        }

        if (this._widget) {
            Main.layoutManager.removeChrome(this._widget);
            this._widget.destroy();
            this._widget = null;
        }

        this._bus = null;
        this._devices = null;
        this._rowsBox = null;
        this._emptyLabel = null;
    }

    // ---------- UI ----------

    _buildWidget() {
        // Outer translucent rounded card, iOS-Bluetooth-sheet style.
        this._widget = new St.BoxLayout({
            vertical: true,
            reactive: true,
            style: `
                background-color: rgba(28, 28, 30, 0.72);
                border-radius: 20px;
                padding: 14px;
                min-width: 260px;
            `,
        });

        let title = new St.Label({
            text: 'Bluetooth',
            style: `
                font-weight: 700;
                font-size: 15px;
                color: rgba(255,255,255,0.92);
                padding-bottom: 8px;
                padding-left: 4px;
            `,
        });
        this._widget.add_child(title);

        this._rowsBox = new St.BoxLayout({ vertical: true });
        this._widget.add_child(this._rowsBox);

        this._emptyLabel = new St.Label({
            text: 'No devices connected',
            style: `
                color: rgba(255,255,255,0.5);
                font-size: 13px;
                padding: 6px 4px;
            `,
        });
        this._widget.add_child(this._emptyLabel);

        Main.layoutManager.addChrome(this._widget, {
            affectsInputRegion: true,
        });

        // Simple fixed placement near the top-right for now; drag-to-move
        // and saved position via GSettings can be added later.
        this._widget.set_position(
            Main.layoutManager.primaryMonitor.width - 300,
            60
        );
    }

    _makeRow(path, info) {
        let row = new St.BoxLayout({
            style: `
                padding: 8px 6px;
                spacing: 10px;
            `,
        });

        let icon = new St.Icon({
            icon_name: iconNameFor(info.icon),
            icon_size: 22,
            style: 'color: rgba(255,255,255,0.85);',
        });

        let name = new St.Label({
            text: info.name,
            y_align: Clutter.ActorAlign.CENTER,
            style: `
                color: rgba(255,255,255,0.92);
                font-size: 13px;
            `,
            x_expand: true,
        });

        let battery = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 4px;',
        });

        if (typeof info.percentage === 'number') {
            let batteryIcon = new St.Icon({
                icon_name: batteryIconFor(info.percentage),
                icon_size: 16,
                style: 'color: rgba(255,255,255,0.75);',
            });
            let batteryLabel = new St.Label({
                text: `${info.percentage}%`,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'color: rgba(255,255,255,0.65); font-size: 12px;',
            });
            battery.add_child(batteryIcon);
            battery.add_child(batteryLabel);
        }

        row.add_child(icon);
        row.add_child(name);
        row.add_child(battery);

        return row;
    }

    _redraw() {
        this._rowsBox.remove_all_children();

        let connected = [...this._devices.entries()]
            .filter(([, info]) => info.connected);

        if (connected.length === 0) {
            this._emptyLabel.show();
        } else {
            this._emptyLabel.hide();
            for (let [path, info] of connected)
                this._rowsBox.add_child(this._makeRow(path, info));
        }
    }

    // ---------- BlueZ / D-Bus ----------

    _refreshFromBus() {
        let result;
        try {
            result = this._bus.call_sync(
                BLUEZ_SERVICE,
                '/',
                OM_IFACE,
                'GetManagedObjects',
                null,
                GLib.VariantType.new('(a{oa{sa{sv}}})'),
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );
        } catch (e) {
            logError(e, 'Bluetooth Desktop Widget: failed to reach BlueZ');
            return;
        }

        let objects = result.deep_unpack()[0];

        for (let path in objects) {
            let ifaces = objects[path];
            if (!(DEVICE_IFACE in ifaces))
                continue;

            let props = unpackVariantDict(ifaces[DEVICE_IFACE]);
            let batteryProps = BATTERY_IFACE in ifaces
                ? unpackVariantDict(ifaces[BATTERY_IFACE])
                : null;

            this._devices.set(path, {
                name: props.Name || props.Alias || path,
                icon: props.Icon || '',
                connected: !!props.Connected,
                percentage: batteryProps ? batteryProps.Percentage : undefined,
            });
        }

        this._redraw();
    }

    _subscribeToChanges() {
        this._signalId = this._bus.signal_subscribe(
            BLUEZ_SERVICE,
            PROPS_IFACE,
            'PropertiesChanged',
            null,
            null,
            Gio.DBusSignalFlags.NONE,
            (connection, sender, path, iface, signal, params) => {
                let [changedIface, changedProps] = params.deep_unpack();

                if (changedIface !== DEVICE_IFACE && changedIface !== BATTERY_IFACE)
                    return;

                let info = this._devices.get(path) || {
                    name: path,
                    icon: '',
                    connected: false,
                    percentage: undefined,
                };

                for (let key in changedProps) {
                    let value = changedProps[key].deep_unpack();

                    if (key === 'Connected') {
                        info.connected = value;
                        // On reconnect, battery isn't always re-pushed
                        // immediately — do a one-off read to catch up.
                        if (value)
                            this._readBatteryOnce(path, info);
                    } else if (key === 'Name' || key === 'Alias') {
                        info.name = value;
                    } else if (key === 'Icon') {
                        info.icon = value;
                    } else if (key === 'Percentage') {
                        info.percentage = value;
                    }
                }

                this._devices.set(path, info);
                this._redraw();
            }
        );
    }

    _readBatteryOnce(path, info) {
        try {
            let result = this._bus.call_sync(
                BLUEZ_SERVICE,
                path,
                PROPS_IFACE,
                'Get',
                new GLib.Variant('(ss)', [BATTERY_IFACE, 'Percentage']),
                GLib.VariantType.new('(v)'),
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );
            let value = result.deep_unpack()[0].deep_unpack();
            info.percentage = value;
            this._devices.set(path, info);
            this._redraw();
        } catch (e) {
            // Device may not expose Battery1 yet right after reconnect —
            // that's fine, it'll arrive later via PropertiesChanged.
        }
    }
}