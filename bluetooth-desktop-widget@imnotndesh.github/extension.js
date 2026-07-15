import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import { QuickToggle, SystemIndicator } from 'resource:///org/gnome/shell/ui/quickSettings.js';

function getStreamPortSafely(stream) {
    const ports = stream.get_ports ? stream.get_ports() : [];
    const hasPorts = Array.isArray(ports) && ports.length > 0;
    const port = hasPorts ? stream.get_port() : null;
    return { ports, hasPorts, port };
}

function classifyDeviceKind(stream) {
    const name = (stream.get_name?.() ?? '').toLowerCase();
    const { hasPorts, port } = getStreamPortSafely(stream);

    if (!hasPorts) return 'virtual';

    const portId = (port?.port ?? '').toLowerCase();
    const portHuman = (port?.human_port ?? '').toLowerCase();
    const isBluetooth = name.includes('bluez') || name.includes('bluetooth');
    const looksLikeHeadphones =
        portId.includes('headphone') ||
        portId.includes('headset') ||
        portHuman.includes('headphone') ||
        portHuman.includes('headset') ||
        name.includes('headphone');

    if (isBluetooth) return 'bluetooth-headphones';
    if (looksLikeHeadphones) return 'wired-headphones';
    return 'speaker-or-other';
}

function isHeadphoneKind(kind) {
    return kind === 'bluetooth-headphones' || kind === 'wired-headphones';
}

function extractBluetoothMac(stream) {
    const name = stream.get_name?.() ?? '';
    const match = name.match(/bluez_output\.([0-9A-Fa-f_]{17})\./);
    if (!match) return null;
    return match[1].replace(/_/g, ':').toUpperCase();
}

function getDeviceId(stream, kind) {
    if (kind === 'bluetooth-headphones') return extractBluetoothMac(stream);
    if (kind === 'wired-headphones') return 'wired-jack';
    return null;
}

function getDeviceLabel(stream) {
    return stream.get_description?.() ?? stream.get_name?.() ?? 'Unknown device';
}

const NOTIFICATION_SOURCE_TITLE = 'Headphone Volume Limiter';

const HeadphoneLimiterToggle = GObject.registerClass(
class HeadphoneLimiterToggle extends QuickToggle {
    _init(settings) {
        super._init({
            title: _('Volume Limiter'),
            iconName: 'audio-headphones-symbolic',
            toggleMode: true,
        });

        this._settings = settings;
        this._settings.bind(
            'enabled',
            this,
            'checked',
            Gio.SettingsBindFlags.DEFAULT
        );
    }
});

const HeadphoneLimiterIndicator = GObject.registerClass(
class HeadphoneLimiterIndicator extends SystemIndicator {
    _init(settings) {
        super._init();
        this.quickSettingsItems.push(new HeadphoneLimiterToggle(settings));
    }
});

export default class HeadphoneVolumeLimiterExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._indicator = new HeadphoneLimiterIndicator(this._settings);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        this._notifSource = null;
        this._notifSourceDestroyId = null;

        this._sessionOverrides = new Set();
        this._isClamping = false;

        this._isReady = false;
        this._streamHandlers = new Map();
        this._activeStreamId = null;

        this._control = new Gvc.MixerControl({ name: 'headphone-volume-limiter' });

        this._control.connectObject(
            'state-changed', (control, state) => {
                if (state === Gvc.MixerControlState.READY) {
                    this._isReady = true;
                    this._attachAllStreams();
                    this._onActiveOutputChanged(control.get_default_sink());
                }
            },
            'output-added', (control, id) => {
                if (!this._isReady) return;
                const uiDevice = control.lookup_output_id(id);
                if (!uiDevice) return;
                const streamId = uiDevice.stream_id;
                const stream = control.lookup_stream_id(streamId);
                if (stream instanceof Gvc.MixerSink)
                    this._attachStream(stream);
            },
            'output-removed', (control, id) => {
                const uiDevice = control.lookup_output_id(id);
                if (uiDevice)
                    this._detachStreamById(uiDevice.stream_id);
            },
            'active-output-update', (control, id) => {
                if (!this._isReady) return;
                const stream = control.lookup_stream_id(id);
                this._onActiveOutputChanged(stream);
            },
            this
        );

        this._control.open();

        this._debug('enabled');
    }

    disable() {
        for (const { stream, id } of this._streamHandlers.values()) {
            try { stream.disconnect(id); } catch (e) { }
        }
        this._streamHandlers.clear();

        this._control?.disconnectObject(this);
        this._control?.close();
        this._control = null;

        if (this._indicator) {
            this._indicator.quickSettingsItems.forEach(item => item.destroy());
            this._indicator.destroy();
            this._indicator = null;
        }

        if (this._notifSourceDestroyId) {
            this._notifSource.disconnect(this._notifSourceDestroyId);
            this._notifSourceDestroyId = null;
        }
        if (this._notifSource) {
            this._notifSource.destroy();
            this._notifSource = null;
        }

        this._sessionOverrides.clear();
        this._settings = null;
        delete global.headphoneLimiterDebug;
    }

    _debug(...args) {
        if (global.headphoneLimiterDebug)
            console.debug('[headphone-limiter]', ...args);
    }

    _attachAllStreams() {
        const sinks = this._control.get_sinks();
        for (const stream of sinks)
            this._attachStream(stream);
    }

    _attachStream(stream) {
        if (!stream) return;
        const id = stream.get_id();
        if (this._streamHandlers.has(id)) return;

        const handlerId = stream.connect('notify::volume', () => {
            this._onStreamVolumeChanged(stream);
        });
        this._streamHandlers.set(id, { stream, id: handlerId });
    }

    _detachStreamById(id) {
        const entry = this._streamHandlers.get(id);
        if (entry) {
            try { entry.stream.disconnect(entry.id); } catch (e) { }
            this._streamHandlers.delete(id);
        }
        this._sessionOverrides.clear();
    }

    _onActiveOutputChanged(stream) {
        if (!stream) {
            this._activeStreamId = null;
            return;
        }
        this._activeStreamId = stream.get_id();
        this._onStreamVolumeChanged(stream);
    }

    _findConnectedHeadphoneStream() {
        for (const { stream } of this._streamHandlers.values()) {
            try {
                const kind = classifyDeviceKind(stream);
                if (isHeadphoneKind(kind)) return stream;
            } catch (e) { }
        }
        return null;
    }

    _onStreamVolumeChanged(stream) {
        if (this._isClamping) return;
        if (!this._settings.get_boolean('enabled')) return;

        if (stream.get_id() !== this._activeStreamId) return;

        const kind = classifyDeviceKind(stream);
        let effectiveDeviceId = getDeviceId(stream, kind);

        if (!isHeadphoneKind(kind)) {
            if (kind === 'virtual') {
                const connectedHeadphone = this._findConnectedHeadphoneStream();
                if (!connectedHeadphone) return;
                this._debug('virtual stream proxying headphone', getDeviceLabel(connectedHeadphone));
                effectiveDeviceId = getDeviceId(connectedHeadphone, classifyDeviceKind(connectedHeadphone));
            } else {
                return;
            }
        }

        const deviceId = effectiveDeviceId;

        const deviceMode = this._settings.get_string('device-mode');
        if (deviceMode === 'specific') {
            const target = this._settings.get_string('specific-device-id');
            if (deviceId !== target) return;
        }

        if (deviceId && this._sessionOverrides.has(deviceId)) return;

        const limitPercent = this._settings.get_int('limit-percent');
        const maxNorm = this._control.get_vol_max_norm();
        const limitVolume = Math.round((limitPercent / 100) * maxNorm);

        const currentVolume = stream.get_volume();
        if (currentVolume <= limitVolume) return;

        const actionMode = this._settings.get_string('action-mode');
        const label = getDeviceLabel(stream);

        if (actionMode === 'warn-allow') {
            this._notify(
                `Volume above ${limitPercent}% on ${label}`,
                'Allowed, but this exceeds your configured headphone limit.'
            );
            return;
        }

        this._clampVolume(stream, limitVolume);

        if (actionMode === 'block') return;

        this._notifyWithAllowAction(label, limitPercent, deviceId);
    }

    _clampVolume(stream, targetVolume) {
        this._isClamping = true;
        try {
            stream.volume = targetVolume;
            stream.push_volume();
        } finally {
            this._isClamping = false;
        }
    }

    _getNotifSource() {
        if (this._notifSource) return this._notifSource;

        this._notifSource = new MessageTray.Source({
            title: NOTIFICATION_SOURCE_TITLE,
            iconName: 'audio-headphones-symbolic',
        });
        Main.messageTray.add(this._notifSource);
        this._notifSourceDestroyId = this._notifSource.connect('destroy', () => {
            this._notifSourceDestroyId = null;
            this._notifSource = null;
        });
        return this._notifSource;
    }

    _notify(title, body) {
        const source = this._getNotifSource();
        const notification = new MessageTray.Notification({ source, title, body });
        source.addNotification(notification);
    }

    _notifyWithAllowAction(deviceLabel, limitPercent, deviceId) {
        const source = this._getNotifSource();
        const notification = new MessageTray.Notification({
            source,
            title: `Volume limited to ${limitPercent}% on ${deviceLabel}`,
            body: 'This device is capped by your headphone volume limiter.',
        });

        if (deviceId) {
            notification.addAction('Allow louder for this session', () => {
                this._sessionOverrides.add(deviceId);
            });
        }

        source.addNotification(notification);
    }
}
