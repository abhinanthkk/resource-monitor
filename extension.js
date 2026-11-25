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

function formatMemory(kibibytes) {
    const gibibytes = kibibytes / 1024 / 1024;
    return gibibytes >= 1 ? `${gibibytes.toFixed(1)} GiB` : `${Math.round(kibibytes / 1024)} MiB`;
}

export default class ResourceMonitorExtension extends Extension {
    enable() {
        this._previousCpu = null;
        this._cpu = null;
        this._memory = null;
        this._gpuRequestPending = false;
        this._gpu = {summary: 'GPU: checking…', detail: 'GPU metrics are being detected.'};

        this._indicator = new PanelMenu.Button(0.0, 'Resource Monitor', false);
        this._panelLabel = new St.Label({
            text: 'CPU --%  GPU --%  RAM --',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._indicator.add_child(this._panelLabel);

        this._cpuMenuItem = new PopupMenu.PopupMenuItem('CPU: collecting…', {reactive: false});
        this._gpuMenuItem = new PopupMenu.PopupMenuItem(this._gpu.detail, {reactive: false});
        this._ramMenuItem = new PopupMenu.PopupMenuItem('RAM: collecting…', {reactive: false});
        this._indicator.menu.addMenuItem(this._cpuMenuItem);
        this._indicator.menu.addMenuItem(this._gpuMenuItem);
        this._indicator.menu.addMenuItem(this._ramMenuItem);

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
                ? ` · ${formatMemory(used / 1024)} / ${formatMemory(total / 1024)}`
                : '';

            return {
                summary: `GPU ${utilization}%`,
                detail: `GPU: ${utilization}%${memory} (Linux graphics driver)`,
            };
        }

        return {
            summary: 'GPU n/a',
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
                                summary: `GPU ${Math.round(usage)}%`,
                                detail: `GPU: ${name}, ${Math.round(usage)}% · ${Math.round(usedMemory)} / ${Math.round(totalMemory)} MiB VRAM`,
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
        this._readGpu();
        this._updateLabels();
    }

    _updateLabels() {
        const cpu = this._cpu;
        const memory = this._memory;
        const cpuText = cpu === null ? '--%' : `${cpu}%`;
        const ramText = memory ? `${formatMemory(memory.used)} / ${formatMemory(memory.total)}` : 'unavailable';
        const ramPercent = memory ? Math.round(memory.used / memory.total * 100) : null;

        if (!this._indicator)
            return;

        this._panelLabel.text = `CPU ${cpuText}  ${this._gpu.summary}  RAM ${ramPercent === null ? '--%' : `${ramPercent}%`}`;
        this._cpuMenuItem.label.text = `CPU: ${cpuText}`;
        this._gpuMenuItem.label.text = this._gpu.detail;
        this._ramMenuItem.label.text = `RAM: ${ramText}`;
    }

    disable() {
        if (this._timer) {
            GLib.Source.remove(this._timer);
            this._timer = null;
        }

        this._indicator?.destroy();
        this._indicator = null;
        this._panelLabel = null;
        this._cpuMenuItem = null;
        this._gpuMenuItem = null;
        this._ramMenuItem = null;
        this._previousCpu = null;
        this._cpu = null;
        this._memory = null;
    }
}
