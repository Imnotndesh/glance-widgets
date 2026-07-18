<h1 align="center">Glance Widgets</h1>

<p align="center">
  <strong>A floating, iOS-style desktop widget stack for GNOME Shell</strong>
  <br>
  <sub>Bluetooth battery levels · Weather · Analog Clock · Storage · Immich Photos · Now Playing · Quick Toggles · GitHub PRs · Contribution Heatmap · Calendar · Quick Launch</sub>
</p>

<p align="center">
  <a href="https://github.com/Imnotndesh/glance-widgets/releases">
    <img src="https://img.shields.io/github/v/release/Imnotndesh/glance-widgets?style=flat&label=release&color=6c63ff" alt="Latest release">
  </a>
  <a href="https://extensions.gnome.org/extension/????/glance-widgets/">
    <img src="https://img.shields.io/badge/GNOME-45%20–%2050-4a86cf?style=flat&logo=gnome&logoColor=white" alt="GNOME Shell versions">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/github/license/Imnotndesh/glance-widgets?style=flat&color=6c63ff" alt="License">
  </a>
</p>

## Preview

<img width="1171" height="1016" alt="image" src="https://github.com/user-attachments/assets/48edfbb6-04c2-4f2e-817d-f2ba6406ab94" />


Glance Widgets places a configurable column of widgets in any corner of your desktop. Each widget is independently toggleable, reorderable, and assignable to a column for a multi-column layout.


## Widgets

| Widget | Description | Settings |
|---|---|---|
| **Bluetooth** | Battery levels for connected Bluetooth devices, rendered as an iOS-style circle ring or a compact list. | Widget style: `List` / `Circles` |
| **Weather** | Current conditions powered by [Open-Meteo](https://open-meteo.com) — free, no API key required. | City name or lat,lon |
| **Analog Clock** | A clean, always-visible analogue clock face. | — |
| **Storage** | Disk usage bar for any mount path (default: `/`). | Target path |
| **Photos (Immich)** | A slideshow of photos from a chosen [Immich](https://immich.app) album, cycling at a configurable interval. | Server URL, API key, album selector, slide interval |
| **Now Playing** | Currently playing media info via MPRIS (works with Spotify, Rhythmbox, Firefox, etc.). | — |
| **Quick Toggles** | System toggles for Dark Mode, Do Not Disturb, Night Light, and a row of quick-launch buttons. | — |
| **GitHub PRs** | Track open pull requests across your repos with a live counter. | GitHub username, token |
| **GitHub Contributions** | Your contribution heatmap for the past year — a grid of activity squares. | GitHub username |
| **Calendar** | A simple monthly calendar with configurable week start (Sunday / Monday). | Week start day |
| **Quick Launch** | A grid of pinned apps for one-click launch, configurable via the preferences window. | Pinned app IDs |



## Quick Install

### Prerequisites

- **GNOME Shell** 45, 46, 47, 48, 49, or 50
- **curl** and **tar**

```bash
# Check they're available
curl --version && tar --version
```
### Install the latest release

```sh
bash <(curl -sL https://raw.githubusercontent.com/Imnotndesh/glance-widgets/main/glance.sh) --install
```
### Update to a newer release
```sh
bash <(curl -sL https://raw.githubusercontent.com/Imnotndesh/glance-widgets/main/glance.sh) --update
```
### Check your installed version

```sh
bash <(curl -sL https://raw.githubusercontent.com/Imnotndesh/glance-widgets/main/glance.sh) --check
```

### Post-install

1. Restart GNOME Shell — press <kbd>Alt</kbd>+<kbd>F2</kbd>, type <kbd>r</kbd>, press <kbd>Enter</kbd> (X11) — or log out and back in (Wayland).
2. Enable the extension:
```sh
gnome-extensions enable glance-widgets@imnotndesh.github
```
3. Configure widgets via GNOME Extensions app or:
```sh
gnome-extensions prefs glance-widgets@imnotndesh.github
```

## Contributing

Contributions are welcome! Open an issue or a pull request.

- New widget ideas — suggest them in an issue
- Bug fixes — PRs are always appreciated
- Translations — if you'd like to help localise, open an issue to coordinate
