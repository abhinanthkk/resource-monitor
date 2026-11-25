# Resource Monitor

A lightweight GNOME Shell extension that displays CPU, GPU, and RAM usage in the Ubuntu top bar.

## Features

- CPU utilization calculated from `/proc/stat`.
- RAM utilization calculated from `/proc/meminfo`.
- NVIDIA GPU utilization and VRAM usage through `nvidia-smi`.
- Linux DRM sysfs fallback for Intel and AMD drivers that expose utilization metrics.
- Refreshes every two seconds and requires no administrator privileges.

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
