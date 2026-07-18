import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.glance-widgets';
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
        implemented: true,
        buildSettings: buildPhotosSettingsGroup,
    },
    {
        id: 'clock',
        name: 'Analog Clock',
        icon: 'preferences-system-time-symbolic',
        implemented: true,
        buildSettings: null,
    },
    {
        id: 'storage',
        name: 'Storage',
        icon: 'drive-harddisk-symbolic',
        implemented: true,
        buildSettings: buildStorageSettingsGroup,
    },
    {
        id: 'nowplaying',
        name: 'Now Playing',
        icon: 'audio-x-generic-symbolic',
        implemented: true,
        buildSettings: null,
    },
    {
        id: 'quicktoggles',
        name: 'Quick Toggles',
        icon: 'emblem-system-symbolic',
        implemented: true,
        buildSettings: null,
    },
    {
        id: 'github-prs',
        name: 'GitHub PRs',
        icon: 'document-edit-symbolic',
        implemented: true,
        buildSettings: buildGithubSettingsGroup,
    },
    {
        id: 'github-heatmap',
        name: 'GitHub Contributions',
        icon: 'view-grid-symbolic',
        implemented: true,
        buildSettings: null,
    },
    {
        id: 'calendar',
        name: 'Calendar',
        icon: 'x-office-calendar-symbolic',
        implemented: true,
        buildSettings: buildCalendarSettingsGroup,
    },
    {
        id: 'quicklaunch',
        name: 'Quick Launch',
        icon: 'view-app-grid-symbolic',
        implemented: true,
        buildSettings: buildQuickLaunchSettingsGroup,
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
        logError(e, 'Glance Widgets prefs: corrupt widgets-config, resetting');
    }

    for (let entry of WIDGET_CATALOG) {
        if (!config.some((e) => e.id === entry.id))
            config.push({ id: entry.id, enabled: false, column: 1 });
    }

    for (let entry of config) {
        if (typeof entry.column !== 'number' || entry.column < 1)
            entry.column = 1;
    }

    return config;
}

function saveConfig(settings, config) {
    settings.set_string(SETTINGS_KEY_WIDGETS_CONFIG, JSON.stringify(config));
}

function buildWidgetsListGroup(settings, window) {
    const MAX_COLUMNS = 6;

    let group = new Adw.PreferencesGroup({
        title: 'Widgets',
        description: 'Choose which widgets appear on the desktop, which column they sit in (column 1 sits nearest your chosen screen corner), and their stacking order within that column',
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

            let columnLabel = new Gtk.Label({ label: 'Col', valign: Gtk.Align.CENTER });
            let columnSpin = new Gtk.SpinButton({
                valign: Gtk.Align.CENTER,
                sensitive: meta.implemented,
                adjustment: new Gtk.Adjustment({
                    lower: 1, upper: MAX_COLUMNS, step_increment: 1,
                    value: entry.column || 1,
                }),
            });
            columnSpin.connect('notify::value', () => {
                let cfg = loadConfig(settings);
                cfg[index].column = columnSpin.get_value_as_int();
                saveConfig(settings, cfg);
            });

            let upButton = new Gtk.Button({
                icon_name: 'go-up-symbolic',
                valign: Gtk.Align.CENTER,
                sensitive: meta.implemented && index > 0,
                css_classes: ['flat'],
                tooltip_text: 'Move earlier in stacking order',
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
                tooltip_text: 'Move later in stacking order',
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

            controls.append(columnLabel);
            controls.append(columnSpin);
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

    let hint = new Adw.ActionRow({
        subtitle: 'Widgets in the same column stack in the order above, starting from the anchored corner. Different column numbers place widgets side by side, with column 1 nearest the corner you pick below.',
    });
    group.add(hint);
    group._rows.push(hint);

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
let _secretModulePromise = null;
function getSecretModule() {
    if (!_secretModulePromise) {
        _secretModulePromise = import('gi://Secret')
            .then((m) => m.default)
            .catch((e) => {
                logError(e, 'Glance Widgets prefs: libsecret unavailable, falling back to GSettings storage for the Immich API key');
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

async function storeApiKey(instanceUrl, apiKey, settings) {
    let Secret = await getSecretModule();
    let schema = await getPhotosSecretSchema();

    if (!Secret || !schema) {
        settings.set_string('photos-api-key-plain', apiKey);
        return;
    }

    await new Promise((resolve) => {
        Secret.password_store(
            schema,
            { 'instance-url': instanceUrl },
            Secret.COLLECTION_DEFAULT,
            'Immich API Key',
            apiKey,
            null,
            (source, result) => {
                try {
                    Secret.password_store_finish(result);
                    settings.set_string('photos-api-key-plain', '');
                } catch (e) {
                    logError(e, 'Glance Widgets prefs: failed to store Immich API key in keyring, falling back to GSettings');
                    settings.set_string('photos-api-key-plain', apiKey);
                }
                resolve();
            }
        );
    });
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
                    logError(e, 'Glance Widgets prefs: failed to look up Immich API key');
                }
                resolve(apiKey || settings.get_string('photos-api-key-plain') || null);
            }
        );
    });
}

function immichRequest(url, apiKey, callback) {
    let session = new Soup.Session();
    session.timeout = 10;
    let message = Soup.Message.new('GET', url);
    if (!message) {
        callback(false, `Invalid URL: ${url}`);
        return;
    }
    message.request_headers.append('x-api-key', apiKey);
    message.request_headers.append('Accept', 'application/json');

    session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session_, result) => {
        try {
            let bytes = session_.send_and_read_finish(result);
            let status = message.get_status();
            if (status !== Soup.Status.OK) {
                callback(false, `Server responded with HTTP ${status}`);
                return;
            }
            let text = new TextDecoder('utf-8').decode(bytes.get_data());
            callback(true, JSON.parse(text));
        } catch (e) {
            callback(false, e.message);
        }
    });
}

function testImmichConnection(url, apiKey, callback) {
    immichRequest(`${url}/api/users/me`, apiKey, (ok, data) => {
        if (!ok) {
            callback(false, data);
            return;
        }
        callback(true, data.name || data.email || 'user');
    });
}

function fetchImmichAlbums(url, apiKey, callback) {
    immichRequest(`${url}/api/albums`, apiKey, (ok, data) => {
        if (!ok) {
            callback(false, data);
            return;
        }
        callback(true, data);
    });
}

function buildPhotosSettingsGroup(settings) {
    let group = new Adw.PreferencesGroup({
        title: 'Photos (Immich)',
        description: 'Connect to your Immich server and choose an album to display',
    });

    let urlRow = new Adw.EntryRow({ title: 'Server URL' });
    urlRow.set_text(settings.get_string('photos-instance-url'));
    group.add(urlRow);

    let keyRow = new Adw.PasswordEntryRow({ title: 'API Key' });
    group.add(keyRow);

    let existingUrl = settings.get_string('photos-instance-url');
    if (existingUrl) {
        lookupApiKey(existingUrl, settings).then((key) => {
            if (key)
                keyRow.set_text(key);
        });
    }

    let statusRow = new Adw.ActionRow({ title: 'Status', subtitle: 'Not connected' });
    group.add(statusRow);

    let testButton = new Gtk.Button({
        label: 'Test Connection',
        valign: Gtk.Align.CENTER,
        css_classes: ['suggested-action'],
    });
    let testRow = new Adw.ActionRow({ title: 'Connect' });
    testRow.add_suffix(testButton);
    testRow.activatable_widget = testButton;
    group.add(testRow);

    let albumComboRow = new Adw.ComboRow({
        title: 'Album',
        subtitle: 'Shown as a slideshow on the desktop widget',
        visible: false,
    });
    group.add(albumComboRow);

    let albumsData = [];
    let suppressAlbumSignal = false;

    function populateAlbums(url, apiKey) {
        statusRow.subtitle = 'Loading albums…';
        fetchImmichAlbums(url, apiKey, (ok, albumsOrError) => {
            if (!ok) {
                statusRow.subtitle = `Connected, but failed to load albums: ${albumsOrError}`;
                return;
            }
            if (albumsOrError.length === 0) {
                statusRow.subtitle = 'Connected — no albums found on this server';
                albumComboRow.visible = false;
                return;
            }

            statusRow.subtitle = 'Connected';
            albumsData = albumsOrError;

            suppressAlbumSignal = true;
            albumComboRow.model = new Gtk.StringList({
                strings: albumsData.map((a) => `${a.albumName} (${a.assetCount} photos)`),
            });

            let currentAlbumId = settings.get_string('photos-album-id');
            let idx = albumsData.findIndex((a) => a.id === currentAlbumId);
            albumComboRow.selected = idx >= 0 ? idx : 0;
            suppressAlbumSignal = false;

            albumComboRow.visible = true;
            if (idx < 0) {
                let album = albumsData[0];
                settings.set_string('photos-album-id', album.id);
                settings.set_string('photos-album-name', album.albumName);
            }
        });
    }

    testButton.connect('clicked', () => {
        let url = urlRow.get_text().trim().replace(/\/+$/, '');
        let apiKey = keyRow.get_text().trim();

        if (!url || !apiKey) {
            statusRow.subtitle = 'Please enter both a server URL and an API key';
            return;
        }

        testButton.sensitive = false;
        statusRow.subtitle = 'Testing…';

        testImmichConnection(url, apiKey, (ok, userOrError) => {
            testButton.sensitive = true;

            if (!ok) {
                statusRow.subtitle = `Connection failed: ${userOrError}`;
                albumComboRow.visible = false;
                return;
            }

            settings.set_string('photos-instance-url', url);
            storeApiKey(url, apiKey, settings).catch((e) =>
                logError(e, 'Glance Widgets prefs: failed to save Immich API key'));
            statusRow.subtitle = `Connected as ${userOrError}`;

            populateAlbums(url, apiKey);
        });
    });

    albumComboRow.connect('notify::selected', () => {
        if (suppressAlbumSignal)
            return;
        let album = albumsData[albumComboRow.selected];
        if (!album)
            return;
        settings.set_string('photos-album-id', album.id);
        settings.set_string('photos-album-name', album.albumName);
    });
    if (existingUrl) {
        lookupApiKey(existingUrl, settings).then((key) => {
            if (key)
                populateAlbums(existingUrl, key);
        });
    }

    let intervalRow = new Adw.SpinRow({
        title: 'Slideshow interval',
        subtitle: 'Seconds between photo changes',
        adjustment: new Gtk.Adjustment({
            lower: 3, upper: 300, step_increment: 1,
            value: settings.get_int('photos-slide-interval-seconds'),
        }),
    });
    intervalRow.connect('notify::value', () => {
        settings.set_int('photos-slide-interval-seconds', intervalRow.value);
    });
    group.add(intervalRow);

    let hint = new Adw.ActionRow({
        subtitle: 'Generate an API key in Immich under Account Settings → API Keys. The key is stored in your system keyring, not in plain settings.',
    });
    group.add(hint);

    return group;
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

async function storeGithubToken(token, settings) {
    let Secret = await getSecretModule();
    let schema = await getGithubSecretSchema();

    if (!Secret || !schema) {
        settings.set_string('github-token-plain', token);
        return;
    }

    await new Promise((resolve) => {
        Secret.password_store(
            schema, { 'account': 'github' }, Secret.COLLECTION_DEFAULT,
            'GitHub Token', token, null,
            (source, result) => {
                try {
                    Secret.password_store_finish(result);
                    settings.set_string('github-token-plain', '');
                } catch (e) {
                    logError(e, 'Glance Widgets prefs: failed to store GitHub token in keyring, falling back to GSettings');
                    settings.set_string('github-token-plain', token);
                }
                resolve();
            }
        );
    });
}

async function lookupGithubToken(settings) {
    let Secret = await getSecretModule();
    let schema = await getGithubSecretSchema();

    if (!Secret || !schema)
        return settings.get_string('github-token-plain') || null;

    return new Promise((resolve) => {
        Secret.password_lookup(
            schema, { 'account': 'github' }, null,
            (source, result) => {
                let token = null;
                try {
                    token = Secret.password_lookup_finish(result);
                } catch (e) {
                    logError(e, 'Glance Widgets prefs: failed to look up GitHub token');
                }
                resolve(token || settings.get_string('github-token-plain') || null);
            }
        );
    });
}

function githubRequest(url, token, callback) {
    let session = new Soup.Session();
    session.timeout = 10;
    let message = Soup.Message.new('GET', url);
    if (!message) {
        callback(false, `Invalid URL: ${url}`);
        return;
    }
    message.request_headers.append('Authorization', `Bearer ${token}`);
    message.request_headers.append('Accept', 'application/vnd.github+json');
    message.request_headers.append('User-Agent', 'glance-widgets-gnome-extension');

    session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session_, result) => {
        try {
            let bytes = session_.send_and_read_finish(result);
            let status = message.get_status();
            let text = new TextDecoder('utf-8').decode(bytes.get_data());
            if (status !== Soup.Status.OK) {
                callback(false, `HTTP ${status}`);
                return;
            }
            callback(true, JSON.parse(text));
        } catch (e) {
            callback(false, e.message);
        }
    });
}

function testGithubConnection(token, callback) {
    githubRequest('https://api.github.com/user', token, (ok, dataOrError) => {
        if (!ok) {
            callback(false, dataOrError);
            return;
        }
        callback(true, dataOrError.login);
    });
}

function buildGithubSettingsGroup(settings) {
    let group = new Adw.PreferencesGroup({
        title: 'GitHub',
        description: 'Powers both the "GitHub PRs" and "GitHub Contributions" widgets',
    });

    let tokenRow = new Adw.PasswordEntryRow({ title: 'Personal Access Token' });
    group.add(tokenRow);

    lookupGithubToken(settings).then((token) => {
        if (token)
            tokenRow.set_text(token);
    });

    let existingUsername = settings.get_string('github-username');
    let statusRow = new Adw.ActionRow({
        title: 'Status',
        subtitle: existingUsername ? `Connected as ${existingUsername}` : 'Not connected',
    });
    group.add(statusRow);

    let testButton = new Gtk.Button({
        label: 'Test Connection',
        valign: Gtk.Align.CENTER,
        css_classes: ['suggested-action'],
    });
    let testRow = new Adw.ActionRow({ title: 'Connect' });
    testRow.add_suffix(testButton);
    testRow.activatable_widget = testButton;
    group.add(testRow);

    testButton.connect('clicked', () => {
        let token = tokenRow.get_text().trim();
        if (!token) {
            statusRow.subtitle = 'Please enter a personal access token';
            return;
        }

        testButton.sensitive = false;
        statusRow.subtitle = 'Testing…';

        testGithubConnection(token, (ok, loginOrError) => {
            testButton.sensitive = true;

            if (!ok) {
                statusRow.subtitle = `Connection failed: ${loginOrError}`;
                return;
            }

            settings.set_string('github-username', loginOrError);
            storeGithubToken(token, settings).catch((e) =>
                logError(e, 'Glance Widgets prefs: failed to save GitHub token'));
            statusRow.subtitle = `Connected as ${loginOrError}`;
        });
    });

    let hint = new Adw.ActionRow({
        subtitle: 'Generate a token at github.com → Settings → Developer settings → Personal access tokens, with "repo" and "read:user" scopes. It\'s stored in your system keyring, not in plain settings.',
    });
    group.add(hint);

    return group;
}

function buildCalendarSettingsGroup(settings) {
    let group = new Adw.PreferencesGroup({
        title: 'Calendar',
        description: 'Configure the Calendar widget',
    });

    let row = new Adw.ComboRow({
        title: 'Week starts on',
        model: new Gtk.StringList({ strings: ['Monday', 'Sunday'] }),
    });
    row.selected = settings.get_string('calendar-week-start') === 'sunday' ? 1 : 0;
    row.connect('notify::selected', () => {
        settings.set_string('calendar-week-start', row.selected === 1 ? 'sunday' : 'monday');
    });
    group.add(row);

    return group;
}

const QUICKLAUNCH_MAX_PINNED = 8;

function buildQuickLaunchSettingsGroup(settings) {
    let group = new Adw.PreferencesGroup({
        title: 'Quick Launch',
        description: `Pinned apps always appear first (up to ${QUICKLAUNCH_MAX_PINNED} slots, 4 per row); remaining slots automatically fill with your most-used apps.`,
    });

    function loadPinned() {
        try {
            let parsed = JSON.parse(settings.get_string('quicklaunch-pinned-apps'));
            return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
        } catch (e) {
            return [];
        }
    }

    function savePinned(ids) {
        settings.set_string('quicklaunch-pinned-apps', JSON.stringify(ids));
    }

    let searchEntry = new Gtk.SearchEntry({ placeholder_text: 'Search installed apps to pin…' });
    let searchRow = new Adw.ActionRow();
    searchRow.set_child(searchEntry);
    group.add(searchRow);

    let resultsBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, visible: false });
    let resultsRow = new Adw.ActionRow();
    resultsRow.set_child(resultsBox);
    group.add(resultsRow);

    function render() {
        for (let row of [...(group._pinnedRows || [])])
            group.remove(row);
        group._pinnedRows = [];

        let pinned = loadPinned();

        pinned.forEach((desktopId, index) => {
            let appInfo = Gio.DesktopAppInfo.new(desktopId);
            let row = new Adw.ActionRow({
                title: appInfo ? appInfo.get_display_name() : desktopId,
                subtitle: appInfo ? '' : 'App not found on this system',
            });
            if (appInfo && appInfo.get_icon())
                row.add_prefix(new Gtk.Image({ gicon: appInfo.get_icon(), pixel_size: 24 }));

            let removeButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                tooltip_text: 'Unpin',
            });
            removeButton.connect('clicked', () => {
                let ids = loadPinned();
                ids.splice(index, 1);
                savePinned(ids);
                render();
            });
            row.add_suffix(removeButton);
            group.add(row);
            group._pinnedRows.push(row);
        });

        searchEntry.sensitive = pinned.length < QUICKLAUNCH_MAX_PINNED;
        searchEntry.placeholder_text = pinned.length < QUICKLAUNCH_MAX_PINNED
            ? 'Search installed apps to pin…'
            : `Maximum of ${QUICKLAUNCH_MAX_PINNED} pinned apps reached`;
    }

    searchEntry.connect('search-changed', () => {
        let query = searchEntry.get_text().trim().toLowerCase();
        let child = resultsBox.get_first_child();
        while (child) {
            let next = child.get_next_sibling();
            resultsBox.remove(child);
            child = next;
        }

        if (!query) {
            resultsBox.visible = false;
            return;
        }

        let pinned = loadPinned();
        let matches = Gio.AppInfo.get_all()
            .filter((info) => info.should_show() && info.get_display_name().toLowerCase().includes(query))
            .filter((info) => !pinned.includes(info.get_id()))
            .slice(0, 6);

        for (let info of matches) {
            let button = new Gtk.Button({ css_classes: ['flat'] });
            let box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
            if (info.get_icon())
                box.append(new Gtk.Image({ gicon: info.get_icon(), pixel_size: 20 }));
            box.append(new Gtk.Label({ label: info.get_display_name(), xalign: 0, hexpand: true }));
            button.set_child(box);

            button.connect('clicked', () => {
                let ids = loadPinned();
                if (!ids.includes(info.get_id()) && ids.length < QUICKLAUNCH_MAX_PINNED) {
                    ids.push(info.get_id());
                    savePinned(ids);
                }
                searchEntry.set_text('');
                render();
            });

            resultsBox.append(button);
        }

        resultsBox.visible = matches.length > 0;
    });

    group._pinnedRows = [];
    render();

    return group;
}

function buildStorageSettingsGroup(settings) {
    let group = new Adw.PreferencesGroup({
        title: 'Storage',
        description: 'Configure the Storage widget',
    });

    let row = new Adw.EntryRow({
        title: 'Mount path',
    });
    row.set_text(settings.get_string('storage-mount-path') || '/');

    row.connect('changed', () => {
        let text = row.get_text().trim();
        settings.set_string('storage-mount-path', text || '/');
    });

    group.add(row);

    let hint = new Adw.ActionRow({
        subtitle: 'Filesystem path to report usage for, e.g. "/" or "/home".',
    });
    group.add(hint);

    return group;
}

function buildLayoutSettingsGroup(settings) {
    let group = new Adw.PreferencesGroup({
        title: 'Position & Spacing',
        description: 'Where the widget grid sits on the desktop. Assign each widget to a column in the Widgets section above to arrange them side by side.',
    });

    let anchorRow = new Adw.ComboRow({
        title: 'Screen corner',
        subtitle: 'Which corner the widgets anchor to',
        model: new Gtk.StringList({ strings: ['Top left', 'Top right', 'Bottom left', 'Bottom right'] }),
    });
    const ANCHOR_VALUES = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
    let currentAnchor = settings.get_string('container-anchor');
    let anchorIdx = ANCHOR_VALUES.indexOf(currentAnchor);
    anchorRow.selected = anchorIdx >= 0 ? anchorIdx : 1;
    anchorRow.connect('notify::selected', () => {
        settings.set_string('container-anchor', ANCHOR_VALUES[anchorRow.selected]);
    });
    group.add(anchorRow);

    function spinRow(title, subtitle, key, lower, upper, step) {
        let row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({
                lower, upper,
                step_increment: step,
                value: settings.get_int(key),
            }),
        });
        row.connect('notify::value', () => {
            settings.set_int(key, row.value);
        });
        group.add(row);
        return row;
    }

    spinRow('Horizontal margin', 'Distance from the left/right screen edge, in pixels',
        'container-margin-x', 0, 400, 5);
    spinRow('Vertical margin', 'Distance from the top/bottom screen edge, in pixels',
        'container-margin-y', 0, 400, 5);
    spinRow('Widget spacing', 'Gap between stacked widgets within a column, in pixels',
        'widget-spacing', 0, 60, 2);
    spinRow('Column spacing', 'Gap between columns once widgets overflow into a new one, in pixels',
        'column-spacing', 0, 80, 2);

    let hint = new Adw.ActionRow({
        subtitle: 'Set each widget\'s column number in the Widgets list above. Column 1 always sits nearest the corner you pick here — e.g. with "Top right" selected, column 1 hugs the right edge and column 2 sits to its left; with "Top left" selected, column 1 hugs the left edge and column 2 sits to its right. The same applies vertically for stacking order within a column when anchored to the bottom.',
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

        let addGroupSafely = (label, buildFn) => {
            try {
                page.add(buildFn());
            } catch (e) {
                logError(e, `Glance Widgets prefs: failed to build "${label}" settings group`);
                let errorGroup = new Adw.PreferencesGroup({ title: label });
                errorGroup.add(new Adw.ActionRow({
                    title: 'This section failed to load',
                    subtitle: e.message || String(e),
                }));
                page.add(errorGroup);
            }
        };

        addGroupSafely('Widgets', () => buildWidgetsListGroup(settings, window));

        for (let meta of WIDGET_CATALOG) {
            if (meta.implemented && meta.buildSettings)
                addGroupSafely(meta.name, () => meta.buildSettings(settings));
        }

        addGroupSafely('Position & Spacing', () => buildLayoutSettingsGroup(settings));

        window.add(page);
        window.set_default_size(480, 680);
    }
}