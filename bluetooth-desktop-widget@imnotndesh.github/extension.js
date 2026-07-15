import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.bluetooth-desktop-widget';
const SETTINGS_KEY_WIDGETS_CONFIG = 'widgets-config';

function unpackVariantDict(dict) {
    let out = {};
    for (let key in dict)
        out[key] = dict[key].deep_unpack();
    return out;
}

function loadWidgetsConfig(settings) {
    let raw = settings.get_string(SETTINGS_KEY_WIDGETS_CONFIG);
    try {
        let parsed = JSON.parse(raw);
        if (Array.isArray(parsed))
            return parsed;
    } catch (e) {
        logError(e, 'Desktop Widgets: corrupt widgets-config, resetting');
    }
    return [{ id: 'bluetooth', enabled: true }];
}

let _httpSession = null;
function getHttpSession() {
    if (!_httpSession) {
        _httpSession = new Soup.Session();
        _httpSession.timeout = 12;
        _httpSession.user_agent = 'gnome-shell-bluetooth-desktop-widget/1.0';
    }
    return _httpSession;
}

function destroyHttpSession() {
    if (_httpSession) {
        _httpSession.abort();
        _httpSession = null;
    }
}

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        let message = Soup.Message.new('GET', url);
        if (!message) {
            reject(new Error(`Invalid URL: ${url}`));
            return;
        }

        getHttpSession().send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, null,
            (session, result) => {
                try {
                    let bytes = session.send_and_read_finish(result);
                    let status = message.get_status();
                    if (status !== Soup.Status.OK) {
                        reject(new Error(`HTTP ${status}`));
                        return;
                    }
                    let text = new TextDecoder('utf-8').decode(bytes.get_data());
                    resolve(JSON.parse(text));
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

const BLUEZ_SERVICE = 'org.bluez';
const OM_IFACE = 'org.freedesktop.DBus.ObjectManager';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';
const DEVICE_IFACE = 'org.bluez.Device1';
const BATTERY_IFACE = 'org.bluez.Battery1';
const SETTINGS_KEY_BT_STYLE = 'widget-style';

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

function batteryIconFor(percentage) {
    let level = Math.max(0, Math.min(100, Math.round(percentage / 10) * 10));
    return `battery-level-${level}-symbolic`;
}

const RING_SIZE = 68;
const RING_LINE_WIDTH = 5;

function buildRingActor(percentage, iconName) {
    let container = new St.Widget({
        layout_manager: new Clutter.BinLayout(),
        width: RING_SIZE,
        height: RING_SIZE,
    });

    let area = new St.DrawingArea({ width: RING_SIZE, height: RING_SIZE });
    area.connect('repaint', (a) => {
        let cr = a.get_context();
        let [w, h] = a.get_surface_size();
        let cx = w / 2;
        let cy = h / 2;
        let radius = Math.min(w, h) / 2 - RING_LINE_WIDTH / 2 - 1;

        cr.setSourceRGBA(1, 1, 1, 0.15);
        cr.setLineWidth(RING_LINE_WIDTH);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();

        let fraction = Math.max(0, Math.min(1, (percentage || 0) / 100));
        let startAngle = -Math.PI / 2;
        let endAngle = startAngle + fraction * 2 * Math.PI;

        cr.setSourceRGBA(0.20, 0.84, 0.29, 1);
        cr.setLineWidth(RING_LINE_WIDTH);
        cr.setLineCap(0);
        cr.arc(cx, cy, radius, startAngle, endAngle);
        cr.stroke();

        cr.$dispose();
    });

    let icon = new St.Icon({
        icon_name: iconName,
        icon_size: 22,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        style: 'color: rgba(255,255,255,0.92);',
    });

    container.add_child(area);
    container.add_child(icon);
    return container;
}

function buildCircleCell(info) {
    let cell = new St.BoxLayout({
        vertical: true,
        x_align: Clutter.ActorAlign.CENTER,
        style: 'spacing: 6px; padding: 4px 10px;',
    });

    cell.add_child(buildRingActor(info.percentage, iconNameFor(info.icon)));

    cell.add_child(new St.Label({
        text: typeof info.percentage === 'number' ? `${info.percentage}%` : '—',
        x_align: Clutter.ActorAlign.CENTER,
        style: 'color: rgba(255,255,255,0.92); font-size: 15px; font-weight: 500;',
    }));

    return cell;
}

function buildListRow(info) {
    let row = new St.BoxLayout({ style: 'padding: 8px 6px; spacing: 10px;' });

    row.add_child(new St.Icon({
        icon_name: iconNameFor(info.icon),
        icon_size: 22,
        style: 'color: rgba(255,255,255,0.85);',
    }));

    row.add_child(new St.Label({
        text: info.name,
        y_align: Clutter.ActorAlign.CENTER,
        style: 'color: rgba(255,255,255,0.92); font-size: 13px;',
        x_expand: true,
    }));

    let battery = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER, style: 'spacing: 4px;' });
    if (typeof info.percentage === 'number') {
        battery.add_child(new St.Icon({
            icon_name: batteryIconFor(info.percentage),
            icon_size: 16,
            style: 'color: rgba(255,255,255,0.75);',
        }));
        battery.add_child(new St.Label({
            text: `${info.percentage}%`,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'color: rgba(255,255,255,0.65); font-size: 12px;',
        }));
    }
    row.add_child(battery);

    return row;
}

const WEATHER_CODE_MAP = {
    0: { icon: 'weather-clear', label: 'Clear sky' },
    1: { icon: 'weather-few-clouds', label: 'Mostly clear' },
    2: { icon: 'weather-few-clouds', label: 'Partly cloudy' },
    3: { icon: 'weather-overcast', label: 'Overcast' },
    45: { icon: 'weather-fog', label: 'Fog' },
    48: { icon: 'weather-fog', label: 'Rime fog' },
    51: { icon: 'weather-showers-scattered', label: 'Light drizzle' },
    53: { icon: 'weather-showers-scattered', label: 'Drizzle' },
    55: { icon: 'weather-showers', label: 'Dense drizzle' },
    56: { icon: 'weather-showers-scattered', label: 'Freezing drizzle' },
    57: { icon: 'weather-showers', label: 'Freezing drizzle' },
    61: { icon: 'weather-showers-scattered', label: 'Light rain' },
    63: { icon: 'weather-showers', label: 'Rain' },
    65: { icon: 'weather-showers', label: 'Heavy rain' },
    66: { icon: 'weather-showers', label: 'Freezing rain' },
    67: { icon: 'weather-showers', label: 'Freezing rain' },
    71: { icon: 'weather-snow', label: 'Light snow' },
    73: { icon: 'weather-snow', label: 'Snow' },
    75: { icon: 'weather-snow', label: 'Heavy snow' },
    77: { icon: 'weather-snow', label: 'Snow grains' },
    80: { icon: 'weather-showers-scattered', label: 'Light showers' },
    81: { icon: 'weather-showers', label: 'Showers' },
    82: { icon: 'weather-showers', label: 'Violent showers' },
    85: { icon: 'weather-snow', label: 'Snow showers' },
    86: { icon: 'weather-snow', label: 'Heavy snow showers' },
    95: { icon: 'weather-storm', label: 'Thunderstorm' },
    96: { icon: 'weather-storm', label: 'Thunderstorm, hail' },
    99: { icon: 'weather-storm', label: 'Thunderstorm, hail' },
};

function weatherInfoFor(code, isDay) {
    let entry = WEATHER_CODE_MAP[code] || { icon: 'weather-severe-alert', label: 'Unknown' };
    let iconName = entry.icon;
    if (iconName === 'weather-clear')
        iconName = isDay ? 'weather-clear-symbolic' : 'weather-clear-night-symbolic';
    else if (iconName === 'weather-few-clouds')
        iconName = isDay ? 'weather-few-clouds-symbolic' : 'weather-few-clouds-night-symbolic';
    else
        iconName = `${iconName}-symbolic`;

    return { icon: iconName, label: entry.label };
}

class WeatherWidget {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings(SETTINGS_SCHEMA);
        this._settingsChangedId = null;
        this._refreshTimeoutId = null;
        this._destroyed = false;
        this._coords = null;
        this._lastLocationQuery = null;
    }

    build() {
        this._card = new St.BoxLayout({
            vertical: true,
            reactive: true,
            style: `
                background-color: rgba(28, 28, 30, 0.55);
                border-radius: 20px;
                border: 1px solid rgba(255,255,255,0.08);
                padding: 14px;
                min-width: 260px;
            `,
        });

        try {
            this._card.add_effect(new Shell.BlurEffect({
                brightness: 0.65,
                sigma: 40,
                mode: Shell.BlurMode.BACKGROUND,
            }));
        } catch (e) {
            logError(e, 'Weather widget: blur effect unavailable, using plain translucency');
        }

        this._headerLabel = new St.Label({
            text: 'Weather',
            style: `
                font-weight: 700;
                font-size: 15px;
                color: rgba(255,255,255,0.92);
                padding-bottom: 8px;
                padding-left: 4px;
            `,
        });
        this._card.add_child(this._headerLabel);

        this._contentBox = new St.Widget({ layout_manager: new Clutter.BinLayout() });
        this._card.add_child(this._contentBox);

        this._statusLabel = new St.Label({
            text: 'Loading…',
            style: 'color: rgba(255,255,255,0.5); font-size: 13px; padding: 6px 4px;',
        });
        this._card.add_child(this._statusLabel);

        this._settingsChangedId = this._settings.connect(
            'changed::weather-location',
            () => this.refresh()
        );

        this.refresh();
        this._scheduleAutoRefresh();

        return this._card;
    }

    refresh() {
        this._refreshFromApi().catch((e) => {
            logError(e, 'Weather widget: refresh failed');
            this._showStatus('Unable to load weather');
        });
    }

    destroy() {
        this._destroyed = true;
        if (this._settingsChangedId !== null) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._refreshTimeoutId !== null) {
            GLib.source_remove(this._refreshTimeoutId);
            this._refreshTimeoutId = null;
        }
        this._card = null;
        this._contentBox = null;
        this._statusLabel = null;
        this._headerLabel = null;
    }

    _scheduleAutoRefresh() {
        this._refreshTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 900, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _showStatus(text) {
        if (!this._statusLabel)
            return;
        this._contentBox.hide();
        this._statusLabel.text = text;
        this._statusLabel.show();
    }

    async _refreshFromApi() {
        let location = this._settings.get_string('weather-location').trim() || 'London';

        if (location !== this._lastLocationQuery || !this._coords) {
            this._showStatus('Loading…');
            let geo = await fetchJson(
                `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`
            );

            if (this._destroyed)
                return;

            let result = geo.results && geo.results[0];
            if (!result) {
                this._showStatus(`Location "${location}" not found`);
                return;
            }

            this._coords = {
                latitude: result.latitude,
                longitude: result.longitude,
                name: result.name,
                admin1: result.admin1,
                country: result.country_code,
            };
            this._lastLocationQuery = location;
        }

        let { latitude, longitude } = this._coords;
        let forecast = await fetchJson(
            'https://api.open-meteo.com/v1/forecast' +
            `?latitude=${latitude}&longitude=${longitude}` +
            '&current=temperature_2m,weather_code,is_day' +
            '&daily=temperature_2m_max,temperature_2m_min' +
            '&temperature_unit=celsius&timezone=auto'
        );

        if (this._destroyed)
            return;

        let current = forecast.current;
        let daily = forecast.daily;

        this._renderWeather({
            temp: Math.round(current.temperature_2m),
            high: Math.round(daily.temperature_2m_max[0]),
            low: Math.round(daily.temperature_2m_min[0]),
            code: current.weather_code,
            isDay: !!current.is_day,
            place: this._coords.name,
        });
    }

    _renderWeather(data) {
        if (!this._contentBox)
            return;

        this._statusLabel.hide();
        this._contentBox.show();
        this._contentBox.destroy_all_children();

        let info = weatherInfoFor(data.code, data.isDay);

        let cell = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 2px; padding: 4px 10px 8px 10px;',
        });

        let iconRow = new St.BoxLayout({
            x_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 8px;',
        });
        iconRow.add_child(new St.Icon({
            icon_name: info.icon,
            icon_size: 34,
            style: 'color: rgba(255,255,255,0.92);',
        }));
        iconRow.add_child(new St.Label({
            text: `${data.temp}°`,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'color: rgba(255,255,255,0.92); font-size: 34px; font-weight: 300;',
        }));
        cell.add_child(iconRow);

        cell.add_child(new St.Label({
            text: data.place,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'color: rgba(255,255,255,0.85); font-size: 13px; font-weight: 500; padding-top: 2px;',
        }));

        cell.add_child(new St.Label({
            text: info.label,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'color: rgba(255,255,255,0.6); font-size: 12px;',
        }));

        cell.add_child(new St.Label({
            text: `H:${data.high}°  L:${data.low}°`,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'color: rgba(255,255,255,0.6); font-size: 12px; padding-top: 2px;',
        }));

        this._contentBox.add_child(cell);
    }
}

class BluetoothWidget {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings(SETTINGS_SCHEMA);
        this._bus = Gio.DBus.system;
        this._devices = new Map();
        this._signalId = null;
        this._settingsChangedId = null;
    }

    build() {
        this._card = new St.BoxLayout({
            vertical: true,
            reactive: true,
            style: `
                background-color: rgba(28, 28, 30, 0.55);
                border-radius: 20px;
                border: 1px solid rgba(255,255,255,0.08);
                padding: 14px;
                min-width: 260px;
            `,
        });

        try {
            this._card.add_effect(new Shell.BlurEffect({
                brightness: 0.65,
                sigma: 40,
                mode: Shell.BlurMode.BACKGROUND,
            }));
        } catch (e) {
            logError(e, 'Bluetooth widget: blur effect unavailable, using plain translucency');
        }

        this._card.add_child(new St.Label({
            text: 'Bluetooth',
            style: `
                font-weight: 700;
                font-size: 15px;
                color: rgba(255,255,255,0.92);
                padding-bottom: 8px;
                padding-left: 4px;
            `,
        }));

        this._contentBox = new St.Widget({ layout_manager: new Clutter.BinLayout() });
        this._card.add_child(this._contentBox);

        this._emptyLabel = new St.Label({
            text: 'No devices connected',
            style: 'color: rgba(255,255,255,0.5); font-size: 13px; padding: 6px 4px;',
        });
        this._card.add_child(this._emptyLabel);

        this._settingsChangedId = this._settings.connect(
            `changed::${SETTINGS_KEY_BT_STYLE}`,
            () => this._redraw()
        );

        this._refreshFromBus();
        this._subscribeToChanges();

        return this._card;
    }

    refresh() {
        this._refreshFromBus();
    }

    destroy() {
        if (this._signalId !== null) {
            this._bus.signal_unsubscribe(this._signalId);
            this._signalId = null;
        }
        if (this._settingsChangedId !== null) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        this._card = null;
        this._contentBox = null;
        this._emptyLabel = null;
    }

    _redraw() {
        if (!this._contentBox)
            return;

        this._contentBox.destroy_all_children();

        let connected = [...this._devices.entries()].filter(([, info]) => info.connected);

        if (connected.length === 0) {
            this._emptyLabel.show();
            this._contentBox.hide();
            return;
        }

        this._emptyLabel.hide();
        this._contentBox.show();

        let style = this._settings.get_string(SETTINGS_KEY_BT_STYLE);

        if (style === 'circles') {
            let row = new St.BoxLayout({ style: 'spacing: 4px;' });
            for (let [, info] of connected)
                row.add_child(buildCircleCell(info));
            this._contentBox.add_child(row);
        } else {
            let list = new St.BoxLayout({ vertical: true });
            for (let [, info] of connected)
                list.add_child(buildListRow(info));
            this._contentBox.add_child(list);
        }
    }

    _refreshFromBus() {
        let result;
        try {
            result = this._bus.call_sync(
                BLUEZ_SERVICE, '/', OM_IFACE, 'GetManagedObjects',
                null, GLib.VariantType.new('(a{oa{sa{sv}}})'),
                Gio.DBusCallFlags.NONE, -1, null
            );
        } catch (e) {
            logError(e, 'Bluetooth widget: failed to reach BlueZ');
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
            BLUEZ_SERVICE, PROPS_IFACE, 'PropertiesChanged', null, null,
            Gio.DBusSignalFlags.NONE,
            (connection, sender, path, iface, signal, params) => {
                let [changedIface, changedProps] = params.deep_unpack();
                if (changedIface !== DEVICE_IFACE && changedIface !== BATTERY_IFACE)
                    return;

                let info = this._devices.get(path) || {
                    name: path, icon: '', connected: false, percentage: undefined,
                };

                for (let key in changedProps) {
                    let value = changedProps[key].deep_unpack();
                    if (key === 'Connected') {
                        info.connected = value;
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
                BLUEZ_SERVICE, path, PROPS_IFACE, 'Get',
                new GLib.Variant('(ss)', [BATTERY_IFACE, 'Percentage']),
                GLib.VariantType.new('(v)'),
                Gio.DBusCallFlags.NONE, -1, null
            );
            info.percentage = result.deep_unpack()[0].deep_unpack();
            this._devices.set(path, info);
            this._redraw();
        } catch (e) {
        }
    }
}

const WIDGET_DEFS = {
    bluetooth: {
        name: 'Bluetooth',
        icon: 'bluetooth-active-symbolic',
        create: (extension) => new BluetoothWidget(extension),
    },
    weather: {
        name: 'Weather',
        icon: 'weather-few-clouds-symbolic',
        create: (extension) => new WeatherWidget(extension),
    },
    // photos:  { name: 'Photos',  icon: 'image-x-generic-symbolic',    create: (ext) => new PhotosWidget(ext) },
    // clock:   { name: 'Clock',   icon: 'preferences-system-time-symbolic', create: (ext) => new ClockWidget(ext) },
    // storage: { name: 'Storage', icon: 'drive-harddisk-symbolic',     create: (ext) => new StorageWidget(ext) },
};

export default class DesktopWidgetsExtension extends Extension {
    enable() {
        this._settings = this.getSettings(SETTINGS_SCHEMA);
        this._activeWidgets = []; // [{ id, instance }]

        this._container = new St.BoxLayout({
            vertical: true,
            style: 'spacing: 14px;',
        });

        Main.layoutManager._backgroundGroup.add_child(this._container);
        this._container.set_position(
            Main.layoutManager.primaryMonitor.width - 320,
            60
        );

        this._configChangedId = this._settings.connect(
            `changed::${SETTINGS_KEY_WIDGETS_CONFIG}`,
            () => this._rebuildWidgets()
        );

        this._rebuildWidgets();
    }

    disable() {
        if (this._configChangedId !== null) {
            this._settings.disconnect(this._configChangedId);
            this._configChangedId = null;
        }

        this._destroyWidgets();
        destroyHttpSession();

        if (this._container) {
            Main.layoutManager._backgroundGroup.remove_child(this._container);
            this._container.destroy();
            this._container = null;
        }

        this._settings = null;
    }

    _destroyWidgets() {
        for (let { instance } of this._activeWidgets) {
            try {
                instance.destroy();
            } catch (e) {
                logError(e, 'Desktop Widgets: error destroying widget');
            }
        }
        this._activeWidgets = [];
        if (this._container)
            this._container.destroy_all_children();
    }

    _rebuildWidgets() {
        this._destroyWidgets();

        let config = loadWidgetsConfig(this._settings);

        for (let entry of config) {
            if (!entry.enabled)
                continue;

            let def = WIDGET_DEFS[entry.id];
            if (!def) {
                log(`Desktop Widgets: unknown widget id "${entry.id}" in config, skipping`);
                continue;
            }

            let instance = def.create(this);
            let actor;
            try {
                actor = instance.build();
            } catch (e) {
                logError(e, `Desktop Widgets: failed to build widget "${entry.id}"`);
                continue;
            }

            this._container.add_child(actor);
            this._activeWidgets.push({ id: entry.id, instance });
        }
    }
}