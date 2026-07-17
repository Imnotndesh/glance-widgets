import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.glance-widgets';
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
        logError(e, 'Glance Widgets: corrupt widgets-config, resetting');
    }
    return [{ id: 'bluetooth', enabled: true }];
}

let _httpSession = null;
function getHttpSession() {
    if (!_httpSession) {
        _httpSession = new Soup.Session();
        _httpSession.timeout = 12;
        _httpSession.user_agent = 'gnome-shell-glance-widgets/1.0';
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

// See prefs.js for why libsecret is loaded lazily rather than imported at
// module scope: a missing typelib there must not stop the whole extension
// (or the whole prefs window) from loading.
let _secretModulePromise = null;
function getSecretModule() {
    if (!_secretModulePromise) {
        _secretModulePromise = import('gi://Secret')
            .then((m) => m.default)
            .catch((e) => {
                logError(e, 'Glance Widgets: libsecret unavailable, falling back to GSettings storage for the Immich API key');
                return null;
            });
    }
    return _secretModulePromise;
}

let _photosSecretSchema = null;
async function getPhotosSecretSchema() {
    let Secret = await getSecretModule();
    if (!Secret)
        return null;
    if (!_photosSecretSchema) {
        _photosSecretSchema = new Secret.Schema(
            'org.gnome.shell.extensions.glance-widgets.photos',
            Secret.SchemaFlags.NONE,
            { 'instance-url': Secret.SchemaAttributeType.STRING }
        );
    }
    return _photosSecretSchema;
}

async function lookupApiKey(instanceUrl, settings) {
    if (!instanceUrl)
        return settings.get_string('photos-api-key-plain') || null;

    let Secret = await getSecretModule();
    let schema = await getPhotosSecretSchema();

    if (!Secret || !schema)
        return settings.get_string('photos-api-key-plain') || null;

    return new Promise((resolve) => {
        Secret.password_lookup(
            schema,
            { 'instance-url': instanceUrl },
            null,
            (source, result) => {
                let apiKey = null;
                try {
                    apiKey = Secret.password_lookup_finish(result);
                } catch (e) {
                    logError(e, 'Glance Widgets: failed to look up Immich API key');
                }
                resolve(apiKey || settings.get_string('photos-api-key-plain') || null);
            }
        );
    });
}

function fetchJsonAuth(url, apiKey) {
    return new Promise((resolve, reject) => {
        let message = Soup.Message.new('GET', url);
        if (!message) {
            reject(new Error(`Invalid URL: ${url}`));
            return;
        }
        message.request_headers.append('x-api-key', apiKey);

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

function fetchBytesAuth(url, apiKey) {
    return new Promise((resolve, reject) => {
        let message = Soup.Message.new('GET', url);
        if (!message) {
            reject(new Error(`Invalid URL: ${url}`));
            return;
        }
        message.request_headers.append('x-api-key', apiKey);

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
                    resolve(bytes);
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

const CLOCK_SIZE = 90;

class ClockWidget {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings(SETTINGS_SCHEMA);
        this._tickTimeoutId = null;
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
            logError(e, 'Clock widget: blur effect unavailable, using plain translucency');
        }

        this._card.add_child(new St.Label({
            text: 'Clock',
            style: `
                font-weight: 700;
                font-size: 15px;
                color: rgba(255,255,255,0.92);
                padding-bottom: 8px;
                padding-left: 4px;
            `,
        }));

        let wrap = new St.BoxLayout({ x_align: Clutter.ActorAlign.CENTER, style: 'padding: 4px 0 6px 0;' });

        this._face = new St.DrawingArea({ width: CLOCK_SIZE, height: CLOCK_SIZE });
        this._face.connect('repaint', (area) => this._paintFace(area));
        wrap.add_child(this._face);
        this._card.add_child(wrap);

        this._dateLabel = new St.Label({
            x_align: Clutter.ActorAlign.CENTER,
            style: 'color: rgba(255,255,255,0.6); font-size: 12px;',
        });

        let dateWrap = new St.BoxLayout({ x_align: Clutter.ActorAlign.CENTER });
        dateWrap.add_child(this._dateLabel);
        this._card.add_child(dateWrap);

        this._updateDateLabel();
        this._scheduleTick();

        return this._card;
    }

    refresh() {
        this._updateDateLabel();
        if (this._face)
            this._face.queue_repaint();
    }

    destroy() {
        if (this._tickTimeoutId !== null) {
            GLib.source_remove(this._tickTimeoutId);
            this._tickTimeoutId = null;
        }
        this._card = null;
        this._face = null;
        this._dateLabel = null;
    }

    _scheduleTick() {
        // Repaint once a second — cheap for a small cairo face, and keeps
        // the second hand smooth without any external dependency.
        this._tickTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (this._face)
                this._face.queue_repaint();
            this._updateDateLabel();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _updateDateLabel() {
        if (!this._dateLabel)
            return;
        let now = GLib.DateTime.new_now_local();
        this._dateLabel.text = now.format('%a, %b %-d');
    }

    _paintFace(area) {
        let cr = area.get_context();
        let [w, h] = area.get_surface_size();
        let cx = w / 2;
        let cy = h / 2;
        let radius = Math.min(w, h) / 2 - 3;

        // Face
        cr.setSourceRGBA(1, 1, 1, 0.06);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.fill();

        cr.setSourceRGBA(1, 1, 1, 0.18);
        cr.setLineWidth(1.5);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();

        // Hour ticks
        for (let i = 0; i < 12; i++) {
            let angle = (i / 12) * 2 * Math.PI;
            let outer = radius - 2;
            let inner = radius - (i % 3 === 0 ? 9 : 5);
            cr.setSourceRGBA(1, 1, 1, i % 3 === 0 ? 0.55 : 0.3);
            cr.setLineWidth(i % 3 === 0 ? 2 : 1.2);
            cr.moveTo(cx + Math.sin(angle) * inner, cy - Math.cos(angle) * inner);
            cr.lineTo(cx + Math.sin(angle) * outer, cy - Math.cos(angle) * outer);
            cr.stroke();
        }

        let now = GLib.DateTime.new_now_local();
        let hours = now.get_hour() % 12;
        let minutes = now.get_minute();
        let seconds = now.get_second();

        let hourAngle = ((hours + minutes / 60) / 12) * 2 * Math.PI;
        let minuteAngle = ((minutes + seconds / 60) / 60) * 2 * Math.PI;
        let secondAngle = (seconds / 60) * 2 * Math.PI;

        this._drawHand(cr, cx, cy, hourAngle, radius * 0.5, 3, [1, 1, 1, 0.92]);
        this._drawHand(cr, cx, cy, minuteAngle, radius * 0.72, 2.2, [1, 1, 1, 0.92]);
        this._drawHand(cr, cx, cy, secondAngle, radius * 0.8, 1, [0.98, 0.6, 0.25, 0.95]);

        cr.setSourceRGBA(0.98, 0.6, 0.25, 0.95);
        cr.arc(cx, cy, 2.4, 0, 2 * Math.PI);
        cr.fill();

        cr.$dispose();
    }

    _drawHand(cr, cx, cy, angle, length, width, rgba) {
        cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], rgba[3]);
        cr.setLineWidth(width);
        cr.setLineCap(1);
        cr.moveTo(cx, cy);
        cr.lineTo(cx + Math.sin(angle) * length, cy - Math.cos(angle) * length);
        cr.stroke();
    }
}

const STORAGE_RING_SIZE = 68;
const STORAGE_RING_LINE_WIDTH = 5;

function formatBytes(bytes) {
    if (!Number.isFinite(bytes))
        return '—';
    let units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }
    let decimals = value >= 100 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

class StorageWidget {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings(SETTINGS_SCHEMA);
        this._settingsChangedId = null;
        this._refreshTimeoutId = null;
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
            logError(e, 'Storage widget: blur effect unavailable, using plain translucency');
        }

        this._card.add_child(new St.Label({
            text: 'Storage',
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

        this._statusLabel = new St.Label({
            text: 'Loading…',
            style: 'color: rgba(255,255,255,0.5); font-size: 13px; padding: 6px 4px;',
        });
        this._card.add_child(this._statusLabel);

        this._settingsChangedId = this._settings.connect(
            'changed::storage-mount-path',
            () => this.refresh()
        );

        this.refresh();
        this._refreshTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });

        return this._card;
    }

    refresh() {
        try {
            this._refreshFromDisk();
        } catch (e) {
            logError(e, 'Storage widget: refresh failed');
            this._showStatus('Unable to read filesystem info');
        }
    }

    destroy() {
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
    }

    _showStatus(text) {
        if (!this._statusLabel)
            return;
        this._contentBox.hide();
        this._statusLabel.text = text;
        this._statusLabel.show();
    }

    _refreshFromDisk() {
        let path = this._settings.get_string('storage-mount-path') || '/';
        let file = Gio.File.new_for_path(path);

        let info = file.query_filesystem_info(
            'filesystem::size,filesystem::free',
            null
        );

        let total = info.get_attribute_uint64('filesystem::size');
        let free = info.get_attribute_uint64('filesystem::free');
        let used = total - free;
        let usedFraction = total > 0 ? used / total : 0;

        this._renderStorage({ path, total, free, used, usedFraction });
    }

    _renderStorage(data) {
        if (!this._contentBox)
            return;

        this._statusLabel.hide();
        this._contentBox.show();
        this._contentBox.destroy_all_children();

        let cell = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 6px; padding: 4px 10px;',
        });

        let ringContainer = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: STORAGE_RING_SIZE,
            height: STORAGE_RING_SIZE,
        });

        let area = new St.DrawingArea({ width: STORAGE_RING_SIZE, height: STORAGE_RING_SIZE });
        area.connect('repaint', (a) => {
            let cr = a.get_context();
            let [w, h] = a.get_surface_size();
            let cx = w / 2;
            let cy = h / 2;
            let radius = Math.min(w, h) / 2 - STORAGE_RING_LINE_WIDTH / 2 - 1;

            cr.setSourceRGBA(1, 1, 1, 0.15);
            cr.setLineWidth(STORAGE_RING_LINE_WIDTH);
            cr.arc(cx, cy, radius, 0, 2 * Math.PI);
            cr.stroke();

            let fraction = Math.max(0, Math.min(1, data.usedFraction));
            let startAngle = -Math.PI / 2;
            let endAngle = startAngle + fraction * 2 * Math.PI;

            if (fraction < 0.7)
                cr.setSourceRGBA(0.20, 0.84, 0.29, 1);
            else if (fraction < 0.9)
                cr.setSourceRGBA(0.95, 0.70, 0.15, 1);
            else
                cr.setSourceRGBA(0.92, 0.26, 0.21, 1);

            cr.setLineWidth(STORAGE_RING_LINE_WIDTH);
            cr.setLineCap(0);
            cr.arc(cx, cy, radius, startAngle, endAngle);
            cr.stroke();

            cr.$dispose();
        });

        let icon = new St.Icon({
            icon_name: 'drive-harddisk-symbolic',
            icon_size: 22,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'color: rgba(255,255,255,0.92);',
        });

        ringContainer.add_child(area);
        ringContainer.add_child(icon);
        cell.add_child(ringContainer);

        cell.add_child(new St.Label({
            text: `${Math.round(data.usedFraction * 100)}% used`,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'color: rgba(255,255,255,0.92); font-size: 15px; font-weight: 500;',
        }));

        cell.add_child(new St.Label({
            text: `${formatBytes(data.free)} free of ${formatBytes(data.total)}`,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'color: rgba(255,255,255,0.6); font-size: 12px;',
        }));

        cell.add_child(new St.Label({
            text: data.path,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'color: rgba(255,255,255,0.45); font-size: 11px; padding-top: 2px;',
        }));

        this._contentBox.add_child(cell);
    }
}

const PHOTOS_FADE_DURATION_MS = 280;

class PhotosWidget {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings(SETTINGS_SCHEMA);
        this._settingsChangedIds = [];
        this._slideTimeoutId = null;
        this._apiKey = null;
        this._instanceUrl = null;
        this._assetIds = [];
        this._assetIndex = 0;
        this._destroyed = false;
        this._loadToken = 0;
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
            logError(e, 'Photos widget: blur effect unavailable, using plain translucency');
        }

        this._card.add_child(new St.Label({
            text: 'Photos',
            style: `
                font-weight: 700;
                font-size: 15px;
                color: rgba(255,255,255,0.92);
                padding-bottom: 8px;
                padding-left: 4px;
            `,
        }));

        this._imageBin = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: 248,
            height: 172,
            style: 'border-radius: 12px; background-color: rgba(0,0,0,0.2); background-size: cover; background-position: center;',
            clip_to_allocation: true,
        });

        let imageWrap = new St.BoxLayout({ x_align: Clutter.ActorAlign.CENTER });
        imageWrap.add_child(this._imageBin);
        this._card.add_child(imageWrap);

        this._captionLabel = new St.Label({
            x_align: Clutter.ActorAlign.CENTER,
            style: 'color: rgba(255,255,255,0.6); font-size: 12px; padding-top: 8px;',
        });
        let captionWrap = new St.BoxLayout({ x_align: Clutter.ActorAlign.CENTER });
        captionWrap.add_child(this._captionLabel);
        this._card.add_child(captionWrap);

        this._statusLabel = new St.Label({
            text: 'Loading…',
            style: 'color: rgba(255,255,255,0.5); font-size: 13px; padding: 6px 4px;',
        });
        this._card.add_child(this._statusLabel);

        for (let key of ['photos-album-id', 'photos-instance-url']) {
            this._settingsChangedIds.push(
                this._settings.connect(`changed::${key}`, () => this.refresh())
            );
        }
        this._settingsChangedIds.push(
            this._settings.connect('changed::photos-slide-interval-seconds', () => {
                if (this._assetIds.length > 0)
                    this._scheduleSlideshow();
            })
        );

        this.refresh();

        return this._card;
    }

    refresh() {
        this._loadAlbum().catch((e) => {
            if (this._destroyed)
                return;
            logError(e, 'Photos widget: failed to load album');
            this._showStatus('Unable to reach Immich server');
        });
    }

    destroy() {
        this._destroyed = true;

        for (let id of this._settingsChangedIds)
            this._settings.disconnect(id);
        this._settingsChangedIds = [];

        if (this._slideTimeoutId !== null) {
            GLib.source_remove(this._slideTimeoutId);
            this._slideTimeoutId = null;
        }

        this._card = null;
        this._imageBin = null;
        this._captionLabel = null;
        this._statusLabel = null;
    }

    async _loadAlbum() {
        let token = ++this._loadToken;

        let url = this._settings.get_string('photos-instance-url').trim().replace(/\/+$/, '');
        let albumId = this._settings.get_string('photos-album-id');

        if (!url || !albumId) {
            this._showStatus('No album selected — pick one in extension preferences');
            return;
        }

        let apiKey = await lookupApiKey(url, this._settings);
        if (token !== this._loadToken || this._destroyed)
            return;

        if (!apiKey) {
            this._showStatus('No API key found — reconnect in extension preferences');
            return;
        }

        this._instanceUrl = url;
        this._apiKey = apiKey;

        let album = await fetchJsonAuth(`${url}/api/albums/${albumId}`, apiKey);
        if (token !== this._loadToken || this._destroyed)
            return;

        this._assetIds = (album.assets || []).map((a) => a.id);
        this._assetIndex = 0;

        if (this._captionLabel)
            this._captionLabel.text = album.albumName || '';

        if (this._assetIds.length === 0) {
            this._showStatus('This album has no photos');
            return;
        }

        this._showNextPhoto();
        this._scheduleSlideshow();
    }

    _scheduleSlideshow() {
        if (this._slideTimeoutId !== null) {
            GLib.source_remove(this._slideTimeoutId);
            this._slideTimeoutId = null;
        }
        let intervalSeconds = this._settings.get_int('photos-slide-interval-seconds') || 20;
        this._slideTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, intervalSeconds,
            () => {
                this._showNextPhoto();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _showNextPhoto() {
        if (this._assetIds.length === 0)
            return;

        let assetId = this._assetIds[this._assetIndex];
        this._assetIndex = (this._assetIndex + 1) % this._assetIds.length;

        let url = `${this._instanceUrl}/api/assets/${assetId}/thumbnail?size=preview`;
        fetchBytesAuth(url, this._apiKey).then((bytes) => {
            if (this._destroyed || !this._imageBin)
                return;

            let path = this._cacheFileForAsset(assetId);
            try {
                let file = Gio.File.new_for_path(path);
                file.replace_contents(
                    bytes.get_data(), null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null
                );
            } catch (e) {
                logError(e, 'Photos widget: failed to cache thumbnail to disk');
                return;
            }

            this._applyPhoto(path);
        }).catch((e) => {
            logError(e, 'Photos widget: failed to load thumbnail');
        });
    }

    _applyPhoto(path) {
        if (!this._imageBin)
            return;

        let isFirstPhoto = this._statusLabel.visible;
        this._statusLabel.hide();
        this._imageBin.show();

        let setImage = () => {
            if (!this._imageBin)
                return;
            this._imageBin.style = `
                border-radius: 12px;
                background-size: cover;
                background-position: center;
                background-image: url("file://${path}");
            `;
        };

        if (isFirstPhoto) {
            // Nothing to crossfade from yet — just show it.
            this._imageBin.opacity = 0;
            setImage();
            this._imageBin.ease({
                opacity: 255,
                duration: PHOTOS_FADE_DURATION_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            return;
        }

        this._imageBin.ease({
            opacity: 0,
            duration: PHOTOS_FADE_DURATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!this._imageBin)
                    return;
                setImage();
                this._imageBin.ease({
                    opacity: 255,
                    duration: PHOTOS_FADE_DURATION_MS,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                });
            },
        });
    }

    _cacheFileForAsset(assetId) {
        let dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'glance-widgets', 'photos']);
        GLib.mkdir_with_parents(dir, 0o700);
        // Reuse one file per position in the rotation (rather than per asset)
        // so the on-disk cache doesn't grow unboundedly for large albums.
        let slot = this._assetIndex % 6;
        return GLib.build_filenamev([dir, `thumb-${slot}-${assetId}.jpg`]);
    }

    _showStatus(text) {
        if (!this._statusLabel)
            return;
        this._imageBin.hide();
        this._statusLabel.text = text;
        this._statusLabel.show();
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
    clock: {
        name: 'Analog Clock',
        icon: 'preferences-system-time-symbolic',
        create: (extension) => new ClockWidget(extension),
    },
    storage: {
        name: 'Storage',
        icon: 'drive-harddisk-symbolic',
        create: (extension) => new StorageWidget(extension),
    },
    photos: {
        name: 'Photos',
        icon: 'image-x-generic-symbolic',
        create: (extension) => new PhotosWidget(extension),
    },
};

const LAYOUT_SETTINGS_KEYS = [
    'container-anchor',
    'container-margin-x',
    'container-margin-y',
    'widget-spacing',
    'column-spacing',
];

export default class DesktopWidgetsExtension extends Extension {
    enable() {
        this._settings = this.getSettings(SETTINGS_SCHEMA);
        this._activeWidgets = []; // [{ id, instance }]

        // this._columnsBox holds one or more vertical columns; a column
        // overflows into a new one once its stacked widgets would run past
        // the bottom of the usable screen area.
        this._columnsBox = new St.BoxLayout({ vertical: false });
        Main.layoutManager._backgroundGroup.add_child(this._columnsBox);

        this._configChangedId = this._settings.connect(
            `changed::${SETTINGS_KEY_WIDGETS_CONFIG}`,
            () => this._rebuildWidgets()
        );

        this._layoutChangedIds = LAYOUT_SETTINGS_KEYS.map((key) =>
            this._settings.connect(`changed::${key}`, () => this._rebuildWidgets())
        );

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed',
            () => this._rebuildWidgets()
        );

        this._rebuildWidgets();
    }

    disable() {
        if (this._configChangedId !== null) {
            this._settings.disconnect(this._configChangedId);
            this._configChangedId = null;
        }

        for (let id of this._layoutChangedIds || [])
            this._settings.disconnect(id);
        this._layoutChangedIds = [];

        if (this._monitorsChangedId !== null) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }

        this._destroyWidgets();
        destroyHttpSession();

        if (this._columnsBox) {
            Main.layoutManager._backgroundGroup.remove_child(this._columnsBox);
            this._columnsBox.destroy();
            this._columnsBox = null;
        }

        this._settings = null;
    }

    _destroyWidgets() {
        for (let { instance } of this._activeWidgets) {
            try {
                instance.destroy();
            } catch (e) {
                logError(e, 'Glance Widgets: error destroying widget');
            }
        }
        this._activeWidgets = [];
        if (this._columnsBox)
            this._columnsBox.destroy_all_children();
    }

    _rebuildWidgets() {
        this._destroyWidgets();

        let widgetSpacing = this._settings.get_int('widget-spacing');
        let columnSpacing = this._settings.get_int('column-spacing');
        let marginX = this._settings.get_int('container-margin-x');
        let marginY = this._settings.get_int('container-margin-y');
        let anchor = this._settings.get_string('container-anchor');

        let monitor = Main.layoutManager.primaryMonitor;

        this._columnsBox.set_style(`spacing: ${columnSpacing}px;`);

        let config = loadWidgetsConfig(this._settings);

        // Group enabled widgets by their explicit column assignment (set in
        // preferences; 1 = the column nearest the anchored corner),
        // preserving each widget's relative order within its column.
        let columns = new Map(); // columnNumber -> [actor, ...]

        for (let entry of config) {
            if (!entry.enabled)
                continue;

            let def = WIDGET_DEFS[entry.id];
            if (!def) {
                log(`Glance Widgets: unknown widget id "${entry.id}" in config, skipping`);
                continue;
            }

            let instance = def.create(this);
            let actor;
            try {
                actor = instance.build();
            } catch (e) {
                logError(e, `Glance Widgets: failed to build widget "${entry.id}"`);
                continue;
            }

            let columnNumber = Number.isInteger(entry.column) && entry.column >= 1 ? entry.column : 1;
            if (!columns.has(columnNumber))
                columns.set(columnNumber, []);
            columns.get(columnNumber).push(actor);

            this._activeWidgets.push({ id: entry.id, instance });
        }

        // Column 1 must end up visually nearest the anchored corner. Clutter/St
        // lay out BoxLayout children in insertion order (first added = leftmost
        // for a horizontal box, topmost for a vertical one). So:
        //  - Anchored to the right: insert columns highest-number-first, so
        //    column 1 is added last and lands rightmost (nearest the edge).
        //  - Anchored to the left: insert ascending as normal (column 1 first
        //    = leftmost = nearest the edge).
        // The same logic applies vertically, within each column, for a
        // bottom anchor: the first-listed widget should end up nearest the
        // bottom edge, so the column's children are reversed before adding.
        let horizontalReverse = anchor.endsWith('right');
        let verticalReverse = anchor.startsWith('bottom');

        let sortedColumnNumbers = [...columns.keys()].sort((a, b) => a - b);
        if (horizontalReverse)
            sortedColumnNumbers.reverse();

        for (let columnNumber of sortedColumnNumbers) {
            let columnBox = new St.BoxLayout({
                vertical: true,
                style: `spacing: ${widgetSpacing}px;`,
            });

            let actors = columns.get(columnNumber);
            if (verticalReverse)
                actors = [...actors].reverse();

            for (let actor of actors)
                columnBox.add_child(actor);

            this._columnsBox.add_child(columnBox);
        }

        this._positionColumns(monitor, anchor, marginX, marginY);
    }

    _positionColumns(monitor, anchor, marginX, marginY) {
        let [, , naturalWidth, naturalHeight] = this._columnsBox.get_preferred_size();

        let x = anchor.endsWith('right')
            ? monitor.width - marginX - naturalWidth
            : marginX;
        let y = anchor.startsWith('bottom')
            ? monitor.height - marginY - naturalHeight
            : marginY;

        this._columnsBox.set_position(monitor.x + x, monitor.y + y);
    }
}