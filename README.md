# Visual Clipboard

[🇺🇸 English](#) | [🇧🇷 Português](README.pt-BR.md)

A clipboard history manager for Linux (X11/GNOME), inspired by Clp for macOS.
Local history of **text, links, code, images and files** (including video), with instant search, boards, inline editing, and auto-paste.

Open source (MIT) — fork it, modify it, make it yours.

![Visual Clipboard screenshot](docs/screenshot.png)

## Requirements

- Linux with X11 (tested on Zorin OS / GNOME)
- Node.js >= 22.12 (required by Electron 43)
- `xdotool` for auto-paste: `sudo apt install xdotool` (without it, clips are copied only — paste manually with Ctrl+V)

## Install

One-liner (fetches and installs, no manual clone needed):

```bash
curl -fsSL https://raw.githubusercontent.com/tharlei/visual-clipboard-linux/main/install.sh | bash
```

Or clone and run it yourself:

```bash
git clone https://github.com/tharlei/visual-clipboard-linux.git
cd visual-clipboard-linux
./install.sh
```

Installs into the standard per-user locations — `~/.local/share/visual-clipboard/app` (code), `~/.local/bin/visual-clipboard` (launcher), `~/.local/share/applications` (app-menu entry) — and downloads Electron (~150MB, first run only). The app starts as soon as the install finishes — after that, launch it with the `visual-clipboard` command or from your app menu ("Visual Clipboard").

To remove: `visual-clipboard --uninstall`. It asks whether to keep your clip history or erase everything; add `--purge` to skip the prompt and wipe it all.

### Development / run from source

```bash
npm install
npm start
```

- **Ctrl+Alt+V** toggles the panel (or click the tray icon).
- Copy anything as usual — it shows up as a card in the history.
- **Search** by typing; **tabs** filter by type; **1–9** selects; **←/→ + Enter** navigates; **Esc** closes.
- **E** edits the focused card (text/link/code) or opens the file; **Delete** removes the focused card; **Ctrl+Enter** saves in the editor.
- Clicking a card copies it and **auto-pastes** into whatever app was focused.
- **Drag a card out**: image/video/file drops the **real file** (its path when dropped in a terminal); text drops as a single line.
- **Settings** (⚙ top-right, or tray → Configurações): change the shortcut, auto-paste, paste delay and history size — no file editing.
- Hover a card for actions: pin 📌, edit ✎ (text/link/code), open file, boards, delete.
- **Boards** (`+` button): pinned collections — never expire, excluded from "Clear history".
- Tray menu: open, clear history, **start on login**, quit.

## Data & configuration

Everything is 100% local, stored in `~/.local/share/visual-clipboard/`:

- `history.json` — clip history and boards
- `images/` — captured images
- `config.json` — settings:

```json
{ "shortcut": "Control+Alt+V", "maxItems": 500, "autoPaste": true, "pasteDelayMs": 150 }
```

Edit the file and restart, or just use the ⚙ **Settings** panel in-app (applies instantly). Running `./install.sh` from a terminal asks about a couple of these on first run; the `curl | bash` one-liner can't prompt, so it uses the defaults above.

## Security & privacy

Runs entirely on your machine. There's no server, no telemetry, no account, no network calls — nothing is monitored or sent anywhere. Your clipboard history never leaves `~/.local/share/visual-clipboard/`.

## Contributing

Issues and PRs welcome — this is a small Electron app with no runtime dependencies (see `src/` for the backend — one file per feature — and `renderer/` for the UI) and a good target for first-time contributors. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
