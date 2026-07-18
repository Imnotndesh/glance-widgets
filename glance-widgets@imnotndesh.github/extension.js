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

function unwrapVariant(value) {
    while (value && typeof value.deep_unpack === 'function')
        value = value.deep_unpack();
    return value;
}

function unpackVariantDict(dict) {
    let out = {};
    for (let key in dict)
        out[key] = unwrapVariant(dict[key]);
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

let _githubSecretSchema = null;
async function getGithubSecretSchema() {
    let Secret = await getSecretModule();
    if (!Secret)
        return null;
    if (!_githubSecretSchema) {
        _githubSecretSchema = new Secret.Schema(
            'org.gnome.shell.extensions.glance-widgets.github',
            Secret.SchemaFlags.NONE,
            { 'account': Secret.SchemaAttributeType.STRING }
        );
    }
    return _githubSecretSchema;
}

async function lookupGithubToken(settings) {
    let Secret = await getSecretModule();
    let schema = await getGithubSecretSchema();

    if (!Secret || !schema)
        return settings.get_string('github-token-plain') || null;

    return new Promise((resolve) => {
        Secret.password_lookup(
            schema,
            { 'account': 'github' },
            null,
            (source, result) => {
                let token = null;
                try {
                    token = Secret.password_lookup_finish(result);
                } catch (e) {
                    logError(e, 'Glance Widgets: failed to look up GitHub token');
                }
                resolve(token || settings.get_string('github-token-plain') || null);
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

function fetchGithubJson(url, token) {
    return new Promise((resolve, reject) => {
        let message = Soup.Message.new('GET', url);
        if (!message) {
            reject(new Error(`Invalid URL: ${url}`));
            return;
        }
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('Accept', 'application/vnd.github+json');
        message.request_headers.append('X-GitHub-Api-Version', '2022-11-28');
        message.request_headers.append('User-Agent', 'glance-widgets-gnome-extension');

        getHttpSession().send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, null,
            (session, result) => {
                try {
                    let bytes = session.send_and_read_finish(result);
                    let status = message.get_status();
                    let text = new TextDecoder('utf-8').decode(bytes.get_data());
                    if (status !== Soup.Status.OK) {
                        reject(new Error(`HTTP ${status}: ${text}`));
                        return;
                    }
                    resolve(JSON.parse(text));
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

function fetchGithubGraphQL(query, variables, token) {
    return new Promise((resolve, reject) => {
        let message = Soup.Message.new('POST', 'https://api.github.com/graphql');
        if (!message) {
            reject(new Error('Invalid GraphQL URL'));
            return;
        }
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('Accept', 'application/vnd.github+json');
        message.request_headers.append('User-Agent', 'glance-widgets-gnome-extension');

        let body = JSON.stringify({ query, variables });
        message.set_request_body_from_bytes('application/json', GLib.Bytes.new(new TextEncoder().encode(body)));

        getHttpSession().send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, null,
            (session, result) => {
                try {
                    let bytes = session.send_and_read_finish(result);
                    let status = message.get_status();
                    let text = new TextDecoder('utf-8').decode(bytes.get_data());
                    if (status !== Soup.Status.OK) {
                        reject(new Error(`HTTP ${status}: ${text}`));
                        return;
                    }
                    let parsed = JSON.parse(text);
                    if (parsed.errors && parsed.errors.length > 0) {
                        reject(new Error(parsed.errors.map((e) => e.message).join('; ')));
                        return;
                    }
                    resolve(parsed.data);
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

const BLUEZ_SERVICE = 'org.bluez';
function fetchBytesPlain(url) {
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
                    resolve(bytes);
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

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

const DBUS_IFACE = 'org.freedesktop.DBus';
const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';

class NowPlayingWidget {
    constructor(extension) {
        this._extension = extension;
        this._bus = Gio.DBus.session;
        this._pollTimeoutId = null;
        this._propsSignalId = null;
        this._activeBusName = null;
        this._destroyed = false;
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
                brightness: 0.65, sigma: 40, mode: Shell.BlurMode.BACKGROUND,
            }));
        } catch (e) {
            logError(e, 'Now Playing widget: blur effect unavailable, using plain translucency');
        }

        let topRow = new St.BoxLayout({ style: 'spacing: 10px;' });

        this._artBin = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: 52, height: 52,
            style: 'border-radius: 10px; background-color: rgba(255,255,255,0.08); background-size: cover; background-position: center;',
            clip_to_allocation: true,
        });
        this._artIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 24,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'color: rgba(255,255,255,0.5);',
        });
        this._artBin.add_child(this._artIcon);
        topRow.add_child(this._artBin);

        let textCol = new St.BoxLayout({ vertical: true, y_align: Clutter.ActorAlign.CENTER, x_expand: true, style: 'spacing: 2px;' });
        this._titleLabel = new St.Label({
            text: 'Nothing playing',
            style: 'color: rgba(255,255,255,0.92); font-size: 13px; font-weight: 600;',
        });
        this._artistLabel = new St.Label({
            text: '',
            style: 'color: rgba(255,255,255,0.6); font-size: 12px;',
        });
        textCol.add_child(this._titleLabel);
        textCol.add_child(this._artistLabel);
        topRow.add_child(textCol);

        this._card.add_child(topRow);

        let controls = new St.BoxLayout({
            x_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 8px; padding-top: 10px;',
        });

        this._prevButton = this._makeControlButton('media-skip-backward-symbolic');
        this._playPauseButton = this._makeControlButton('media-playback-start-symbolic');
        this._nextButton = this._makeControlButton('media-skip-forward-symbolic');

        this._prevButton.connect('clicked', () => this._callPlayerMethod('Previous'));
        this._playPauseButton.connect('clicked', () => this._callPlayerMethod('PlayPause'));
        this._nextButton.connect('clicked', () => this._callPlayerMethod('Next'));

        controls.add_child(this._prevButton);
        controls.add_child(this._playPauseButton);
        controls.add_child(this._nextButton);
        this._card.add_child(controls);
        this._controls = controls;
        this._setControlsSensitive(false);

        this._refreshPlayerList();
        this._pollTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
            this._refreshPlayerList();
            return GLib.SOURCE_CONTINUE;
        });

        return this._card;
    }

    destroy() {
        this._destroyed = true;

        if (this._pollTimeoutId !== null) {
            GLib.source_remove(this._pollTimeoutId);
            this._pollTimeoutId = null;
        }
        this._unsubscribeProps();

        this._card = null;
        this._artBin = null;
        this._artIcon = null;
        this._titleLabel = null;
        this._artistLabel = null;
        this._controls = null;
        this._prevButton = null;
        this._playPauseButton = null;
        this._nextButton = null;
    }

    _makeControlButton(iconName) {
        let icon = new St.Icon({ icon_name: iconName, icon_size: 16, style: 'color: rgba(255,255,255,0.9);' });
        let button = new St.Button({
            reactive: true,
            can_focus: true,
            track_hover: true,
            style: 'border-radius: 999px; padding: 8px; background-color: rgba(255,255,255,0.08);',
            child: icon,
        });
        button._icon = icon;
        return button;
    }

    _setControlsSensitive(sensitive) {
        if (!this._controls)
            return;
        this._controls.reactive = sensitive;
        for (let button of [this._prevButton, this._nextButton, this._playPauseButton])
            button.can_focus = sensitive;
        this._controls.opacity = sensitive ? 255 : 100;
    }

    async _refreshPlayerList() {
        if (this._destroyed)
            return;
        try {
            let result = await this._dbusCall(
                DBUS_IFACE, '/org/freedesktop/DBus', DBUS_IFACE, 'ListNames',
                null, GLib.VariantType.new('(as)')
            );
            if (this._destroyed)
                return;

            let names = result.deep_unpack()[0].filter((n) => n.startsWith(MPRIS_PREFIX));

            if (names.length === 0) {
                this._subscribeToPlayer(null);
                this._renderNothingPlaying();
                return;
            }

            let chosen = names[0];
            for (let name of names) {
                let status = await this._getPlaybackStatus(name);
                if (this._destroyed)
                    return;
                if (status === 'Playing') {
                    chosen = name;
                    break;
                }
            }

            if (chosen !== this._activeBusName)
                this._subscribeToPlayer(chosen);

            await this._updateFromBusName(chosen);
        } catch (e) {
            logError(e, 'Now Playing widget: failed to list media players');
        }
    }

    _dbusCall(busName, objectPath, iface, method, parameters, replyType) {
        return new Promise((resolve, reject) => {
            this._bus.call(
                busName, objectPath, iface, method, parameters, replyType,
                Gio.DBusCallFlags.NONE, 3000, null,
                (connection, result) => {
                    try {
                        resolve(connection.call_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    async _getPlaybackStatus(busName) {
        try {
            let result = await this._dbusCall(
                busName, MPRIS_PATH, PROPS_IFACE, 'Get',
                new GLib.Variant('(ss)', [MPRIS_PLAYER_IFACE, 'PlaybackStatus']),
                GLib.VariantType.new('(v)')
            );
            return result.deep_unpack()[0].deep_unpack();
        } catch (e) {
            return null;
        }
    }

    _subscribeToPlayer(busName) {
        this._unsubscribeProps();
        this._activeBusName = busName;
        if (!busName)
            return;
        this._propsSignalId = this._bus.signal_subscribe(
            busName, PROPS_IFACE, 'PropertiesChanged', MPRIS_PATH, null,
            Gio.DBusSignalFlags.NONE,
            () => this._onPropertiesChanged(busName)
        );
    }

    _onPropertiesChanged(busName) {
        // Some players (browser tabs especially) fire PropertiesChanged
        // several times a second for playback position. Throttle so we
        // don't flood D-Bus with GetAll calls.
        let now = GLib.get_monotonic_time();
        if (this._lastPropsUpdate && now - this._lastPropsUpdate < 500 * 1000)
            return;
        this._lastPropsUpdate = now;
        this._updateFromBusName(busName).catch((e) => {
            logError(e, 'Now Playing widget: failed to handle property update');
        });
    }

    _unsubscribeProps() {
        if (this._propsSignalId !== null) {
            this._bus.signal_unsubscribe(this._propsSignalId);
            this._propsSignalId = null;
        }
    }

    async _updateFromBusName(busName) {
        if (this._destroyed || !busName) {
            this._renderNothingPlaying();
            return;
        }
        try {
            let result = await this._dbusCall(
                busName, MPRIS_PATH, PROPS_IFACE, 'GetAll',
                new GLib.Variant('(s)', [MPRIS_PLAYER_IFACE]),
                GLib.VariantType.new('(a{sv})')
            );
            if (this._destroyed)
                return;

            let props = unpackVariantDict(result.deep_unpack()[0]);
            let metadata = unpackVariantDict(props.Metadata || {});
            let title = metadata['xesam:title'] || 'Unknown title';
            let artistField = metadata['xesam:artist'];
            let artist = Array.isArray(artistField) ? artistField.join(', ') : (artistField || '');
            let artUrl = metadata['mpris:artUrl'] || '';
            let status = props.PlaybackStatus || 'Stopped';

            this._render({ title, artist, artUrl, status, busName });
        } catch (e) {
            logError(e, 'Now Playing widget: failed to parse player metadata');
            this._renderNothingPlaying();
        }
    }

    _render(data) {
        if (!this._card)
            return;

        this._setControlsSensitive(true);
        this._titleLabel.text = data.title;
        this._artistLabel.text = data.artist;
        this._playPauseButton._icon.icon_name = data.status === 'Playing'
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';

        this._applyArt(data.artUrl);
    }

    _renderNothingPlaying() {
        if (!this._card)
            return;
        this._titleLabel.text = 'Nothing playing';
        this._artistLabel.text = '';
        this._artBin.style = 'border-radius: 10px; background-color: rgba(255,255,255,0.08);';
        this._artIcon.show();
        this._setControlsSensitive(false);
    }

    _applyArt(artUrl) {
        if (!artUrl) {
            this._artBin.style = 'border-radius: 10px; background-color: rgba(255,255,255,0.08);';
            this._artIcon.show();
            return;
        }

        if (artUrl.startsWith('file://')) {
            this._artIcon.hide();
            this._artBin.style = `border-radius: 10px; background-size: cover; background-position: center; background-image: url("${artUrl}");`;
            return;
        }

        if (!artUrl.startsWith('http://') && !artUrl.startsWith('https://')) {
            this._artBin.style = 'border-radius: 10px; background-color: rgba(255,255,255,0.08);';
            this._artIcon.show();
            return;
        }

        if (this._lastFetchedArtUrl === artUrl)
            return;
        this._lastFetchedArtUrl = artUrl;

        fetchBytesPlain(artUrl).then((bytes) => {
            if (this._destroyed || !this._artBin)
                return;
            let dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'glance-widgets', 'nowplaying']);
            GLib.mkdir_with_parents(dir, 0o700);
            let path = GLib.build_filenamev([dir, 'art.jpg']);
            try {
                let file = Gio.File.new_for_path(path);
                file.replace_contents(bytes.get_data(), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            } catch (e) {
                logError(e, 'Now Playing widget: failed to cache album art');
                return;
            }
            this._artIcon.hide();
            this._artBin.style = `border-radius: 10px; background-size: cover; background-position: center; background-image: url("file://${path}");`;
        }).catch((e) => {
            logError(e, 'Now Playing widget: failed to fetch album art');
        });
    }

    _callPlayerMethod(method) {
        if (!this._activeBusName)
            return;
        this._bus.call(
            this._activeBusName, MPRIS_PATH, MPRIS_PLAYER_IFACE, method,
            null, null, Gio.DBusCallFlags.NONE, -1, null,
            (connection, result) => {
                try {
                    connection.call_finish(result);
                } catch (e) {
                    logError(e, `Now Playing widget: ${method} failed`);
                }
            }
        );
    }
}

class QuickTogglesWidget {
    constructor(extension) {
        this._extension = extension;
        this._notifSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.notifications' });
        this._colorSettings = null;
        this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        try {
            this._colorSettings = new Gio.Settings({ schema_id: 'org.gnome.settings-daemon.plugins.color' });
        } catch (e) {
            logError(e, 'Quick Toggles widget: night light schema unavailable');
        }
        this._signalIds = [];
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
                brightness: 0.65, sigma: 40, mode: Shell.BlurMode.BACKGROUND,
            }));
        } catch (e) {
            logError(e, 'Quick Toggles widget: blur effect unavailable, using plain translucency');
        }

        this._card.add_child(new St.Label({
            text: 'Quick Toggles',
            style: `
                font-weight: 700;
                font-size: 15px;
                color: rgba(255,255,255,0.92);
                padding-bottom: 10px;
                padding-left: 4px;
            `,
        }));

        let row = new St.BoxLayout({ x_align: Clutter.ActorAlign.CENTER, style: 'spacing: 12px;' });

        this._dndButton = this._makeToggleButton('audio-volume-muted-symbolic', 'Do Not Disturb');
        this._dndButton.connect('clicked', () => {
            let dndCurrentlyOn = !this._notifSettings.get_boolean('show-banners');
            this._notifSettings.set_boolean('show-banners', dndCurrentlyOn);
        });
        row.add_child(this._dndButton);

        if (this._colorSettings) {
            this._nightLightButton = this._makeToggleButton('display-brightness-symbolic', 'Night Light');
            this._nightLightButton.connect('clicked', () => {
                let current = this._colorSettings.get_boolean('night-light-enabled');
                this._colorSettings.set_boolean('night-light-enabled', !current);
            });
            row.add_child(this._nightLightButton);
        }

        this._darkModeButton = this._makeToggleButton('weather-clear-night-symbolic', 'Dark Mode');
        this._darkModeButton.connect('clicked', () => {
            let isDark = this._interfaceSettings.get_string('color-scheme') === 'prefer-dark';
            this._interfaceSettings.set_string('color-scheme', isDark ? 'default' : 'prefer-dark');
        });
        row.add_child(this._darkModeButton);

        this._card.add_child(row);

        this._signalIds.push([this._notifSettings, this._notifSettings.connect('changed::show-banners', () => this._syncState())]);
        if (this._colorSettings)
            this._signalIds.push([this._colorSettings, this._colorSettings.connect('changed::night-light-enabled', () => this._syncState())]);
        this._signalIds.push([this._interfaceSettings, this._interfaceSettings.connect('changed::color-scheme', () => this._syncState())]);

        this._syncState();

        return this._card;
    }

    destroy() {
        for (let [settingsObj, id] of this._signalIds)
            settingsObj.disconnect(id);
        this._signalIds = [];

        this._card = null;
        this._dndButton = null;
        this._nightLightButton = null;
        this._darkModeButton = null;
    }

    _makeToggleButton(iconName, accessibleName) {
        return new St.Button({
            reactive: true,
            can_focus: true,
            track_hover: true,
            accessible_name: accessibleName,
            style: 'border-radius: 14px; padding: 12px; background-color: rgba(255,255,255,0.08);',
            child: new St.Icon({ icon_name: iconName, icon_size: 20, style: 'color: rgba(255,255,255,0.85);' }),
        });
    }

    _setButtonActive(button, active) {
        if (!button)
            return;
        button.style = active
            ? 'border-radius: 14px; padding: 12px; background-color: rgba(10, 132, 255, 0.85);'
            : 'border-radius: 14px; padding: 12px; background-color: rgba(255,255,255,0.08);';
    }

    _syncState() {
        this._setButtonActive(this._dndButton, !this._notifSettings.get_boolean('show-banners'));
        if (this._colorSettings)
            this._setButtonActive(this._nightLightButton, this._colorSettings.get_boolean('night-light-enabled'));
        this._setButtonActive(this._darkModeButton, this._interfaceSettings.get_string('color-scheme') === 'prefer-dark');
    }
}

class GithubPRWidget {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings(SETTINGS_SCHEMA);
        this._settingsChangedId = null;
        this._refreshTimeoutId = null;
        this._destroyed = false;
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
                brightness: 0.65, sigma: 40, mode: Shell.BlurMode.BACKGROUND,
            }));
        } catch (e) {
            logError(e, 'GitHub PRs widget: blur effect unavailable, using plain translucency');
        }

        this._card.add_child(new St.Label({
            text: 'GitHub',
            style: `
                font-weight: 700;
                font-size: 15px;
                color: rgba(255,255,255,0.92);
                padding-bottom: 8px;
                padding-left: 4px;
            `,
        }));

        this._contentBox = new St.BoxLayout({ vertical: true, style: 'spacing: 6px;' });

        this._openPrRow = this._buildStatRow('document-edit-symbolic', 'Open PRs');
        this._reviewRow = this._buildStatRow('emblem-important-symbolic', 'Review requests');
        this._contentBox.add_child(this._openPrRow.row);
        this._contentBox.add_child(this._reviewRow.row);
        this._card.add_child(this._contentBox);

        this._statusLabel = new St.Label({
            text: 'Loading…',
            style: 'color: rgba(255,255,255,0.5); font-size: 13px; padding: 6px 4px;',
        });
        this._card.add_child(this._statusLabel);

        this._settingsChangedId = this._settings.connect('changed::github-username', () => this.refresh());

        this.refresh();
        this._refreshTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 300, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });

        return this._card;
    }

    refresh() {
        this._load().catch((e) => {
            if (this._destroyed)
                return;
            logError(e, 'GitHub PRs widget: failed to load');
            this._showStatus(`Unable to reach GitHub: ${e.message}`);
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
    }

    _buildStatRow(iconName, label) {
        let row = new St.BoxLayout({ style: 'spacing: 8px;' });
        row.add_child(new St.Icon({ icon_name: iconName, icon_size: 16, style: 'color: rgba(255,255,255,0.7);' }));
        let textLabel = new St.Label({
            text: label,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style: 'color: rgba(255,255,255,0.8); font-size: 13px;',
        });
        let countLabel = new St.Label({
            text: '—',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'color: rgba(255,255,255,0.92); font-size: 15px; font-weight: 700;',
        });
        row.add_child(textLabel);
        row.add_child(countLabel);
        return { row, countLabel };
    }

    async _load() {
        let username = this._settings.get_string('github-username');
        if (!username) {
            this._showStatus('Configure GitHub in preferences');
            return;
        }

        let token = await lookupGithubToken(this._settings);
        if (this._destroyed)
            return;
        if (!token) {
            this._showStatus('No GitHub token found — configure in preferences');
            return;
        }

        let authoredQuery = encodeURIComponent(`is:open is:pr author:${username}`);
        let reviewQuery = encodeURIComponent(`is:open is:pr review-requested:${username}`);

        let [authored, reviewRequested] = await Promise.all([
            fetchGithubJson(`https://api.github.com/search/issues?q=${authoredQuery}`, token),
            fetchGithubJson(`https://api.github.com/search/issues?q=${reviewQuery}`, token),
        ]);

        if (this._destroyed || !this._contentBox)
            return;

        this._statusLabel.hide();
        this._contentBox.show();
        this._openPrRow.countLabel.text = `${authored.total_count}`;
        this._reviewRow.countLabel.text = `${reviewRequested.total_count}`;
    }

    _showStatus(text) {
        if (!this._statusLabel)
            return;
        this._contentBox.hide();
        this._statusLabel.text = text;
        this._statusLabel.show();
    }
}

const GITHUB_HEATMAP_QUERY = `
query($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays {
            date
            contributionCount
            color
          }
        }
      }
    }
  }
}`;

const HEATMAP_SQUARE = 9;
const HEATMAP_GAP = 3;
const HEATMAP_ROWS = 7;
const HEATMAP_WIDTH = 232;
const HEATMAP_HEIGHT = HEATMAP_ROWS * (HEATMAP_SQUARE + HEATMAP_GAP) - HEATMAP_GAP;

class GithubHeatmapWidget {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings(SETTINGS_SCHEMA);
        this._settingsChangedId = null;
        this._refreshTimeoutId = null;
        this._weeks = null;
        this._destroyed = false;
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
                brightness: 0.65, sigma: 40, mode: Shell.BlurMode.BACKGROUND,
            }));
        } catch (e) {
            logError(e, 'GitHub Heatmap widget: blur effect unavailable, using plain translucency');
        }

        this._card.add_child(new St.Label({
            text: 'Contributions',
            style: `
                font-weight: 700;
                font-size: 15px;
                color: rgba(255,255,255,0.92);
                padding-bottom: 8px;
                padding-left: 4px;
            `,
        }));

        this._area = new St.DrawingArea({ width: HEATMAP_WIDTH, height: HEATMAP_HEIGHT });
        this._area.connect('repaint', (a) => this._paint(a));
        let wrap = new St.BoxLayout({ x_align: Clutter.ActorAlign.CENTER });
        wrap.add_child(this._area);
        this._card.add_child(wrap);

        this._captionLabel = new St.Label({
            x_align: Clutter.ActorAlign.CENTER,
            style: 'color: rgba(255,255,255,0.5); font-size: 12px; padding-top: 8px;',
        });
        let captionWrap = new St.BoxLayout({ x_align: Clutter.ActorAlign.CENTER });
        captionWrap.add_child(this._captionLabel);
        this._card.add_child(captionWrap);

        this._statusLabel = new St.Label({
            text: 'Loading…',
            style: 'color: rgba(255,255,255,0.5); font-size: 13px; padding: 6px 4px;',
        });
        this._card.add_child(this._statusLabel);

        this._settingsChangedId = this._settings.connect('changed::github-username', () => this.refresh());

        this.refresh();
        this._refreshTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 21600, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });

        return this._card;
    }

    refresh() {
        this._load().catch((e) => {
            if (this._destroyed)
                return;
            logError(e, 'GitHub Heatmap widget: failed to load');
            this._showStatus(`Unable to reach GitHub: ${e.message}`);
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
        this._area = null;
        this._captionLabel = null;
        this._statusLabel = null;
    }

    async _load() {
        let username = this._settings.get_string('github-username');
        if (!username) {
            this._showStatus('Configure GitHub in preferences');
            return;
        }

        let token = await lookupGithubToken(this._settings);
        if (this._destroyed)
            return;
        if (!token) {
            this._showStatus('No GitHub token found — configure in preferences');
            return;
        }

        let data = await fetchGithubGraphQL(GITHUB_HEATMAP_QUERY, { login: username }, token);
        if (this._destroyed || !this._area)
            return;

        let calendar = data && data.user && data.user.contributionsCollection.contributionCalendar;
        if (!calendar) {
            this._showStatus('No contribution data found for this user');
            return;
        }

        this._weeks = calendar.weeks;
        this._statusLabel.hide();
        this._area.show();
        this._captionLabel.text = `${calendar.totalContributions} contributions in the last year`;
        this._area.queue_repaint();
    }

    _showStatus(text) {
        if (!this._statusLabel)
            return;
        this._area.hide();
        this._captionLabel.text = '';
        this._statusLabel.text = text;
        this._statusLabel.show();
    }

    _paint(area) {
        if (!this._weeks)
            return;

        let cr = area.get_context();
        let [w] = area.get_surface_size();
        let columns = Math.max(1, Math.floor((w + HEATMAP_GAP) / (HEATMAP_SQUARE + HEATMAP_GAP)));
        let weeks = this._weeks.slice(-columns);

        weeks.forEach((week, i) => {
            week.contributionDays.forEach((day, j) => {
                let x = i * (HEATMAP_SQUARE + HEATMAP_GAP);
                let y = j * (HEATMAP_SQUARE + HEATMAP_GAP);
                this._setSourceFromColor(cr, day.contributionCount > 0 ? day.color : null);
                cr.rectangle(x, y, HEATMAP_SQUARE, HEATMAP_SQUARE);
                cr.fill();
            });
        });

        cr.$dispose();
    }

    _setSourceFromColor(cr, hexColor) {
        if (hexColor && hexColor.startsWith('#') && hexColor.length >= 7) {
            let r = parseInt(hexColor.slice(1, 3), 16) / 255;
            let g = parseInt(hexColor.slice(3, 5), 16) / 255;
            let b = parseInt(hexColor.slice(5, 7), 16) / 255;
            cr.setSourceRGB(r, g, b);
        } else {
            cr.setSourceRGBA(1, 1, 1, 0.08);
        }
    }
}

class CalendarWidget {
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
                brightness: 0.65, sigma: 40, mode: Shell.BlurMode.BACKGROUND,
            }));
        } catch (e) {
            logError(e, 'Calendar widget: blur effect unavailable, using plain translucency');
        }

        this._headerLabel = new St.Label({
            style: `
                font-weight: 700;
                font-size: 15px;
                color: rgba(255,255,255,0.92);
                padding-bottom: 10px;
                padding-left: 4px;
            `,
        });
        this._card.add_child(this._headerLabel);

        this._grid = new St.Widget({
            layout_manager: new Clutter.GridLayout({ column_spacing: 6, row_spacing: 6 }),
        });
        let wrap = new St.BoxLayout({ x_align: Clutter.ActorAlign.CENTER });
        wrap.add_child(this._grid);
        this._card.add_child(wrap);

        this._settingsChangedId = this._settings.connect('changed::calendar-week-start', () => this._render());

        this._render();
        this._refreshTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3600, () => {
            this._render();
            return GLib.SOURCE_CONTINUE;
        });

        return this._card;
    }

    refresh() {
        this._render();
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
        this._headerLabel = null;
        this._grid = null;
    }

    _daysInMonth(year, month) {
        let firstOfThis = GLib.DateTime.new_local(year, month, 1, 0, 0, 0);
        let firstOfNext = month === 12
            ? GLib.DateTime.new_local(year + 1, 1, 1, 0, 0, 0)
            : GLib.DateTime.new_local(year, month + 1, 1, 0, 0, 0);
        let diffMicroseconds = firstOfNext.difference(firstOfThis);
        return Math.round(diffMicroseconds / (24 * 3600 * 1000000));
    }

    _render() {
        if (!this._grid)
            return;

        this._grid.destroy_all_children();
        let layout = this._grid.layout_manager;

        let now = GLib.DateTime.new_now_local();
        this._headerLabel.text = now.format('%B %Y');

        let weekStartsSunday = this._settings.get_string('calendar-week-start') === 'sunday';
        let dowLabels = weekStartsSunday
            ? ['S', 'M', 'T', 'W', 'T', 'F', 'S']
            : ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

        dowLabels.forEach((label, col) => {
            layout.attach(new St.Label({
                text: label,
                x_align: Clutter.ActorAlign.CENTER,
                style: 'color: rgba(255,255,255,0.4); font-size: 11px; font-weight: 600; min-width: 24px;',
            }), col, 0, 1, 1);
        });

        let year = now.get_year();
        let month = now.get_month();
        let firstOfMonth = GLib.DateTime.new_local(year, month, 1, 0, 0, 0);
        let firstWeekday = firstOfMonth.get_day_of_week();
        let offset = weekStartsSunday ? firstWeekday % 7 : firstWeekday - 1;

        let daysInMonth = this._daysInMonth(year, month);
        let today = now.get_day_of_month();

        let row = 1;
        let col = offset;
        const CELL_SIZE = 24;
        for (let day = 1; day <= daysInMonth; day++) {
            let isToday = day === today;
            layout.attach(this._makeDayCell(day, isToday, CELL_SIZE), col, row, 1, 1);

            col++;
            if (col > 6) {
                col = 0;
                row++;
            }
        }
    }

    _makeDayCell(day, isToday, size) {
        let cell = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: size,
            height: size,
            style: isToday
                ? 'border-radius: 999px; background-color: rgba(10,132,255,0.9);'
                : '',
        });

        cell.add_child(new St.Label({
            text: `${day}`,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: isToday
                ? 'color: white; font-size: 12px; font-weight: 700;'
                : 'color: rgba(255,255,255,0.85); font-size: 12px;',
        }));

        return cell;
    }
}

const QUICKLAUNCH_COLUMNS = 4;
const QUICKLAUNCH_ROWS = 2;
const QUICKLAUNCH_MAX_APPS = QUICKLAUNCH_COLUMNS * QUICKLAUNCH_ROWS;

class QuickLaunchWidget {
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
                brightness: 0.65, sigma: 40, mode: Shell.BlurMode.BACKGROUND,
            }));
        } catch (e) {
            logError(e, 'Quick Launch widget: blur effect unavailable, using plain translucency');
        }

        this._card.add_child(new St.Label({
            text: 'Quick Launch',
            style: `
                font-weight: 700;
                font-size: 15px;
                color: rgba(255,255,255,0.92);
                padding-bottom: 10px;
                padding-left: 4px;
            `,
        }));

        this._grid = new St.Widget({
            layout_manager: new Clutter.GridLayout({ column_spacing: 10, row_spacing: 10 }),
        });
        let wrap = new St.BoxLayout({ x_align: Clutter.ActorAlign.CENTER });
        wrap.add_child(this._grid);
        this._card.add_child(wrap);

        this._settingsChangedId = this._settings.connect('changed::quicklaunch-pinned-apps', () => this._render());

        this._render();
        // Most-used ranking can shift over time; a light periodic re-render
        // keeps it current without needing an explicit usage-changed signal.
        this._refreshTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._render();
            return GLib.SOURCE_CONTINUE;
        });

        return this._card;
    }

    refresh() {
        this._render();
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
        this._grid = null;
    }

    _loadPinnedIds() {
        try {
            let parsed = JSON.parse(this._settings.get_string('quicklaunch-pinned-apps'));
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    _computeAppList() {
        let appSystem = Shell.AppSystem.get_default();
        let pinnedIds = this._loadPinnedIds();
        let pinnedApps = pinnedIds
            .map((id) => appSystem.lookup_app(id))
            .filter((app) => app !== null);

        let usedApps = [];
        try {
            usedApps = Shell.AppUsage.get_default().get_most_used().filter((app) => app !== null);
        } catch (e) {
            logError(e, 'Quick Launch widget: failed to read app usage data');
        }

        let seenIds = new Set(pinnedApps.map((app) => app.get_id()));
        let combined = [...pinnedApps];

        for (let app of usedApps) {
            if (combined.length >= QUICKLAUNCH_MAX_APPS)
                break;
            if (seenIds.has(app.get_id()))
                continue;
            combined.push(app);
            seenIds.add(app.get_id());
        }

        return combined.slice(0, QUICKLAUNCH_MAX_APPS);
    }

    _render() {
        if (!this._grid)
            return;

        this._grid.destroy_all_children();
        let layout = this._grid.layout_manager;

        let apps = this._computeAppList();

        if (apps.length === 0) {
            layout.attach(new St.Label({
                text: 'Pin apps in preferences to see them here',
                style: 'color: rgba(255,255,255,0.5); font-size: 12px;',
            }), 0, 0, QUICKLAUNCH_COLUMNS, 1);
            return;
        }

        apps.forEach((app, index) => {
            let col = index % QUICKLAUNCH_COLUMNS;
            let row = Math.floor(index / QUICKLAUNCH_COLUMNS);

            let button = new St.Button({
                reactive: true,
                can_focus: true,
                track_hover: true,
                accessible_name: app.get_name(),
                style: 'border-radius: 12px; padding: 6px; background-color: rgba(255,255,255,0.06);',
                child: app.create_icon_texture(42),
            });
            button.connect('clicked', () => {
                try {
                    app.activate();
                } catch (e) {
                    logError(e, `Quick Launch widget: failed to launch "${app.get_id()}"`);
                }
            });

            layout.attach(button, col, row, 1, 1);
        });
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
    nowplaying: {
        name: 'Now Playing',
        icon: 'audio-x-generic-symbolic',
        create: (extension) => new NowPlayingWidget(extension),
    },
    quicktoggles: {
        name: 'Quick Toggles',
        icon: 'emblem-system-symbolic',
        create: (extension) => new QuickTogglesWidget(extension),
    },
    'github-prs': {
        name: 'GitHub PRs',
        icon: 'document-edit-symbolic',
        create: (extension) => new GithubPRWidget(extension),
    },
    'github-heatmap': {
        name: 'GitHub Contributions',
        icon: 'view-grid-symbolic',
        create: (extension) => new GithubHeatmapWidget(extension),
    },
    calendar: {
        name: 'Calendar',
        icon: 'x-office-calendar-symbolic',
        create: (extension) => new CalendarWidget(extension),
    },
    quicklaunch: {
        name: 'Quick Launch',
        icon: 'view-app-grid-symbolic',
        create: (extension) => new QuickLaunchWidget(extension),
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
        this._activeWidgets = [];

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

        let columns = new Map();

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