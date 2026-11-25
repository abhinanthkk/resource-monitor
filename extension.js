import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const REFRESH_INTERVAL_SECONDS = 2;

function readText(path) {
    try {
        const [success, contents] = GLib.file_get_contents(path);
        if (!success)
            return null;

        return new TextDecoder('utf-8').decode(contents).trim();
    } catch (_error) {
        return null;
    }
}

function readMemory() {
    const contents = readText('/proc/meminfo');
    if (!contents)
        return null;

    const values = new Map();
    for (const line of contents.split('\n')) {
        const match = line.match(/^(MemTotal|MemAvailable):\s+(\d+)/);
        if (match)
            values.set(match[1], Number(match[2]));
    }

    const total = values.get('MemTotal');
    const available = values.get('MemAvailable');
    if (!total || available === undefined)
        return null;

    return {used: total - available, total};
}

function readNetworkCounters() {
    const contents = readText('/proc/net/dev');
    if (!contents)
        return null;

    const interfaces = new Map();
    for (const line of contents.split('\n')) {
        const match = line.match(/^\s*([^:]+):\s*(.+)$/);
        if (!match)
            continue;

        const fields = match[2].trim().split(/\s+/).map(Number);
        if (fields.length < 9)
            continue;

        interfaces.set(match[1].trim(), {received: fields[0], sent: fields[8]});
    }

    const routeLines = readText('/proc/net/route')?.split('\n').slice(1) ?? [];
    const defaultRoutes = routeLines
        .map(line => line.trim().split(/\s+/))
        .filter(fields => fields.length >= 8 && fields[1] === '00000000' && (parseInt(fields[3], 16) & 1))
        .sort((left, right) => Number(left[6]) - Number(right[6]));

    const defaultInterface = defaultRoutes.find(route => interfaces.has(route[0]))?.[0];
    if (defaultInterface)
        return {interface: defaultInterface, ...interfaces.get(defaultInterface)};

    // A default route may not be present on an offline or IPv6-only host.
    // In that case, aggregate all non-loopback interfaces.
    const activeInterfaces = [...interfaces.entries()].filter(([name]) => name !== 'lo');
    if (activeInterfaces.length === 0)
        return null;

    return {
        interface: activeInterfaces.map(([name]) => name).join(', '),
        received: activeInterfaces.reduce((sum, [, counters]) => sum + counters.received, 0),
        sent: activeInterfaces.reduce((sum, [, counters]) => sum + counters.sent, 0),
    };
}

function formatMemoryPair(usedGibibytes, totalGibibytes) {
    const used = Number(usedGibibytes.toFixed(1)).toString();
    const total = Math.ceil(totalGibibytes);
    return `${used}/${total} GB`;
}

function formatGpuMemory(usedMebibytes, totalMebibytes) {
    return formatMemoryPair(usedMebibytes / 1024, totalMebibytes / 1024);
}

function formatRamMemory(usedKibibytes, totalKibibytes) {
    return formatMemoryPair(usedKibibytes / 1024 / 1024, totalKibibytes / 1024 / 1024);
}

function formatNetworkSpeed(downloadBytesPerSecond, uploadBytesPerSecond) {
    const peakSpeed = Math.max(downloadBytesPerSecond, uploadBytesPerSecond);
    let divisor = 1;
    let unit = 'B/s';

    if (peakSpeed >= 1_000_000_000) {
        divisor = 1_000_000_000;
        unit = 'GB/s';
    } else if (peakSpeed >= 1_000_000) {
        divisor = 1_000_000;
        unit = 'MB/s';
    } else if (peakSpeed >= 1_000) {
        divisor = 1_000;
        unit = 'KB/s';
    }

    return `${(downloadBytesPerSecond / divisor).toFixed(1)}/${(uploadBytesPerSecond / divisor).toFixed(1)} ${unit}`;
}

function createMetric(iconName, labelText) {
    const box = new St.BoxLayout({style_class: 'resource-monitor-metric'});
    box.set_style('margin-right: 8px;');
    const icon = new St.Icon({
        icon_name: iconName,
        style_class: 'system-status-icon',
        icon_size: 14,
    });
    icon.set_style('margin-right: 4px;');
    const label = new St.Label({
        text: labelText,
        y_align: Clutter.ActorAlign.CENTER,
    });
    box.add_child(icon);
    box.add_child(label);
    return {box, label};
}

export default class ResourceMonitorExtension extends Extension {
    enable() {
        this._previousCpu = null;
        this._cpu = null;
        this._memory = null;
        this._previousNetwork = null;
        this._network = {download: 0, upload: 0, interface: 'unavailable'};
        this._gpuRequestPending = false;
        this._gpu = {summary: '--/-- GB', detail: 'GPU metrics are being detected.'};

        this._indicator = new PanelMenu.Button(0.0, 'Resource Monitor', false);
        this._panelBox = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        const cpu = createMetric('computer-chip-symbolic', '--%');
        const gpu = createMetric('video-display-symbolic', '--/-- GB');
        const ram = createMetric('drive-harddisk-symbolic', '--/-- GB');
        const network = createMetric('network-transmit-receive-symbolic', '0.0/0.0 MB/s');
        this._cpuPanelLabel = cpu.label;
        this._gpuPanelLabel = gpu.label;
        this._ramPanelLabel = ram.label;
        this._networkPanelLabel = network.label;
        this._panelBox.add_child(cpu.box);
        this._panelBox.add_child(gpu.box);
        this._panelBox.add_child(ram.box);
        this._panelBox.add_child(network.box);
        this._indicator.add_child(this._panelBox);

        this._cpuMenuItem = new PopupMenu.PopupMenuItem('CPU: collecting…', {reactive: false});
        this._gpuMenuItem = new PopupMenu.PopupMenuItem(this._gpu.detail, {reactive: false});
        this._ramMenuItem = new PopupMenu.PopupMenuItem('RAM: collecting…', {reactive: false});
        this._networkMenuItem = new PopupMenu.PopupMenuItem('Network: collecting…', {reactive: false});
        this._indicator.menu.addMenuItem(this._cpuMenuItem);
        this._indicator.menu.addMenuItem(this._gpuMenuItem);
        this._indicator.menu.addMenuItem(this._ramMenuItem);
        this._indicator.menu.addMenuItem(this._networkMenuItem);

        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._refresh();
        this._timer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            REFRESH_INTERVAL_SECONDS,
            () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _readCpuUsage() {
        const stat = readText('/proc/stat');
        const line = stat?.split('\n').find(entry => entry.startsWith('cpu '));
        if (!line)
            return null;

        const counters = line.trim().split(/\s+/).slice(1).map(Number);
        if (counters.length < 4)
            return null;

        const idle = counters[3] + (counters[4] ?? 0);
        const total = counters.reduce((sum, value) => sum + value, 0);
        const current = {idle, total};
        const previous = this._previousCpu;
        this._previousCpu = current;

        if (!previous)
            return null;

        const totalDelta = total - previous.total;
        if (totalDelta <= 0)
            return null;

        const idleDelta = idle - previous.idle;
        return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
    }

    _readNetworkSpeed() {
        const counters = readNetworkCounters();
        const now = GLib.get_monotonic_time();
        const previous = this._previousNetwork;
        this._previousNetwork = counters ? {...counters, time: now} : null;

        if (!counters || !previous || counters.interface !== previous.interface)
            return {download: 0, upload: 0, interface: counters?.interface ?? 'unavailable'};

        const elapsedSeconds = (now - previous.time) / 1_000_000;
        if (elapsedSeconds <= 0)
            return {download: 0, upload: 0, interface: counters.interface};

        const receivedDelta = Math.max(0, counters.received - previous.received);
        const sentDelta = Math.max(0, counters.sent - previous.sent);
        return {
            download: receivedDelta / elapsedSeconds,
            upload: sentDelta / elapsedSeconds,
            interface: counters.interface,
        };
    }

    _readSysfsGpu() {
        for (let card = 0; card < 8; card++) {
            const vendor = readText(`/sys/class/drm/card${card}/device/vendor`);
            if (!vendor)
                continue;

            const utilizationPaths = vendor.toLowerCase() === '0x8086'
                ? [`/sys/class/drm/card${card}/gt/gt0/busy_percent`,
                    `/sys/class/drm/card${card}/device/gt/gt0/busy_percent`]
                : [`/sys/class/drm/card${card}/device/gpu_busy_percent`];

            let utilization = null;
            for (const path of utilizationPaths) {
                const value = Number(readText(path));
                if (Number.isFinite(value)) {
                    utilization = Math.round(value);
                    break;
                }
            }

            if (utilization === null)
                continue;

            const used = Number(readText(`/sys/class/drm/card${card}/device/mem_info_vram_used`));
            const total = Number(readText(`/sys/class/drm/card${card}/device/mem_info_vram_total`));
            const memory = Number.isFinite(used) && Number.isFinite(total) && total > 0
                ? ` · ${formatGpuMemory(used / 1024 / 1024, total / 1024 / 1024)} VRAM`
                : '';

            return {
                summary: Number.isFinite(used) && Number.isFinite(total) && total > 0
                    ? formatGpuMemory(used / 1024 / 1024, total / 1024 / 1024)
                    : `${utilization}%`,
                detail: `GPU utilization: ${utilization}%${memory} (Linux graphics driver)`,
            };
        }

        return {
            summary: 'n/a',
            detail: 'GPU metrics unavailable. Check that the graphics driver exposes utilization data.',
        };
    }

    _readGpu() {
        const nvidiaSmi = GLib.find_program_in_path('nvidia-smi');
        if (!nvidiaSmi) {
            this._gpu = this._readSysfsGpu();
            return;
        }

        if (this._gpuRequestPending)
            return;

        this._gpuRequestPending = true;
        try {
            const process = Gio.Subprocess.new([
                nvidiaSmi,
                '--query-gpu=name,utilization.gpu,memory.used,memory.total',
                '--format=csv,noheader,nounits',
            ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);

            process.communicate_utf8_async(null, null, (subprocess, result) => {
                this._gpuRequestPending = false;
                if (!this._indicator)
                    return;

                try {
                    const [, stdout] = subprocess.communicate_utf8_finish(result);
                    const fields = stdout?.trim().split('\n')[0]?.split(',').map(value => value.trim());
                    if (subprocess.get_successful() && fields?.length >= 4) {
                        const [name, utilization, used, total] = fields;
                        const usage = Number(utilization);
                        const usedMemory = Number(used);
                        const totalMemory = Number(total);
                        if ([usage, usedMemory, totalMemory].every(Number.isFinite)) {
                            this._gpu = {
                                summary: formatGpuMemory(usedMemory, totalMemory),
                                detail: `GPU: ${name}, ${Math.round(usage)}% utilization · ${formatGpuMemory(usedMemory, totalMemory)} VRAM`,
                            };
                            this._updateLabels();
                            return;
                        }
                    }
                } catch (_error) {
                    // Fall through to the Linux sysfs providers below.
                }

                this._gpu = this._readSysfsGpu();
                this._updateLabels();
            });
        } catch (_error) {
            this._gpuRequestPending = false;
            this._gpu = this._readSysfsGpu();
        }
    }

    _refresh() {
        this._cpu = this._readCpuUsage();
        this._memory = readMemory();
        this._network = this._readNetworkSpeed();
        this._readGpu();
        this._updateLabels();
    }

    _updateLabels() {
        const cpu = this._cpu;
        const memory = this._memory;
        const cpuText = cpu === null ? '--%' : `${cpu}%`;
        const ramText = memory
            ? formatRamMemory(memory.used, memory.total)
            : 'unavailable';
        const ramPercent = memory ? Math.round(memory.used / memory.total * 100) : null;
        const networkText = formatNetworkSpeed(this._network.download, this._network.upload);

        if (!this._indicator)
            return;

        this._cpuPanelLabel.text = cpuText;
        this._gpuPanelLabel.text = this._gpu.summary;
        this._ramPanelLabel.text = memory ? ramText : '--/-- GB';
        this._networkPanelLabel.text = networkText;
        this._cpuMenuItem.label.text = `CPU: ${cpuText}`;
        this._gpuMenuItem.label.text = this._gpu.detail;
        this._ramMenuItem.label.text = `RAM: ${ramText}${ramPercent === null ? '' : ` (${ramPercent}%)`}`;
        this._networkMenuItem.label.text = `Network: ${networkText} download/upload · ${this._network.interface}`;
    }

    disable() {
        if (this._timer) {
            GLib.Source.remove(this._timer);
            this._timer = null;
        }

        this._indicator?.destroy();
        this._indicator = null;
        this._panelBox = null;
        this._cpuPanelLabel = null;
        this._gpuPanelLabel = null;
        this._ramPanelLabel = null;
        this._networkPanelLabel = null;
        this._cpuMenuItem = null;
        this._gpuMenuItem = null;
        this._ramMenuItem = null;
        this._networkMenuItem = null;
        this._previousCpu = null;
        this._cpu = null;
        this._memory = null;
        this._previousNetwork = null;
        this._network = null;
    }
}
