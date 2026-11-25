# Resource Monitor

A lightweight GNOME Shell extension that displays CPU, GPU memory, RAM, and network throughput in the Ubuntu top bar.

## Features

- Icon-led top-bar readings for CPU percentage, GPU memory, RAM usage, and network speed.
- CPU utilization calculated from `/proc/stat`.
- RAM used/total calculated from `/proc/meminfo`.
- NVIDIA GPU utilization and VRAM usage through `nvidia-smi`.
- Linux DRM sysfs fallback for Intel and AMD drivers that expose utilization metrics.
- Network download/upload speed in MB/s, measured from `/proc/net/dev` on the default route interface when available.
- Refreshes every two seconds and requires no administrator privileges.

The panel shows CPU as a percentage, GPU and RAM as used/total GB (for example `3.4/4 GB`), and network as download/upload MB/s (for example `1.1/0.5 MB/s`). GPU utilization and the active network interface are shown in the dropdown.

GPU metrics depend on what the installed graphics driver exposes. On NVIDIA systems, `nvidia-smi` must be installed and able to query the GPU. Intel/AMD sysfs metrics are used only when their driver provides the relevant files.

## Requirements

- GNOME Shell 50 (this initial release targets Ubuntu 26.04 / GNOME 50).
- For NVIDIA metrics: a working NVIDIA driver and `nvidia-smi`.

## Install from this repository

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/resource-monitor@abee
cp extension.js metadata.json ~/.local/share/gnome-shell/extensions/resource-monitor@abee/
gnome-extensions enable resource-monitor@abee
```

If the extension does not appear immediately, log out and back in, then enable **Resource Monitor** in the Extensions app. Wayland sessions generally require a logout/login to reload GNOME Shell extensions.

To remove it:

```bash
gnome-extensions disable resource-monitor@abee
rm -r ~/.local/share/gnome-shell/extensions/resource-monitor@abee
```

## Development checks

```bash
gjs --check extension.js
gnome-extensions pack --force
```

You can inspect extension errors with:

```bash
journalctl --user -f -o cat /usr/bin/gnome-shell
```

## License

MIT
