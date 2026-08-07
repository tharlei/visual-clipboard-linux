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
- Tray menu: open, clear history, **pause capture**, **start on login**, quit.

## Data & configuration

Everything is 100% local, stored in `~/.local/share/visual-clipboard/`:

- `history.json` — clip history and boards
- `images/` — captured images
- `config.json` — settings:

```json
{ "shortcut": "Control+Alt+V", "maxItems": 500, "autoPaste": true, "pasteDelayMs": 150,
  "paused": false, "ignorePatterns": [] }
```

Edit the file and restart, or just use the ⚙ **Settings** panel in-app (applies instantly). Running `./install.sh` from a terminal asks about a couple of these on first run; the `curl | bash` one-liner can't prompt, so it uses the defaults above.

`ignorePatterns` has no UI — edit `config.json` directly. It's a list of plain **substrings** (not regexes), matched case-insensitively against text clips; anything matching is never recorded. Useful for a token prefix or a marker your tooling emits:

```json
{ "ignorePatterns": ["BEGIN RSA PRIVATE KEY", "ghp_", "AKIA"] }
```

## Security & privacy

Runs entirely on your machine. There's no server, no telemetry, no account, no network calls — nothing is monitored or sent anywhere. Your clipboard history never leaves `~/.local/share/visual-clipboard/`.

**Your history is only as private as that directory.** The app creates it `0700` and every file inside `0600` (owner-only), and it re-applies those permissions on every start, including on installs that predate this. Nothing is encrypted at rest: anything that can read your files as you can read your clip history. That's a deliberate call — a key stored next to the data it protects buys nothing against the same attacker.

**Pausing.** Tray → *Pausar captura* stops clipboard polling entirely. Anything copied while paused is never seen, and resuming does not sweep it up retroactively. The panel shows a chip while capture is off.

**Password managers.** Clips marked secret by the manager (`x-kde-passwordManagerHint` and the `org.nspasteboard.*` hints) are skipped. Not every manager sets one — when in doubt, pause first or add a substring to `ignorePatterns`.

**The Chromium sandbox is on, unconditionally.** It matters here more than in most apps: the renderer's job is decoding images someone else put on your clipboard, and a bug in an image decoder is native code execution, not XSS — the CSP and `contextIsolation` are JavaScript-level barriers that memory corruption walks straight past. The sandbox is the layer that contains it. Hardware acceleration is disabled (`app.disableHardwareAcceleration()`) so the sandboxed GPU process never needs to load a Mesa DRI driver, which is what used to make the sandbox unusable on some NVIDIA + X11 setups. Confirm yours is on:

```bash
grep sandbox= ~/.local/share/visual-clipboard/launch.log | tail -1
```

If a machine still refuses to start (AppArmor restricting unprivileged user namespaces is the usual cause), `VISUAL_CLIPBOARD_NO_SANDBOX=1` turns it off — with the tradeoff above.

**Keeping Chromium current.** The sandbox contains a decoder bug; only an upgrade removes it, and `npm ci` installs exactly what the lockfile pins. Two nudges cover that: `install.sh` reports when a newer Electron has been released, and the tray grows a warning item once the installed one is more than 90 days old. Updating is a lockfile bump in your clone:

```bash
npm install electron@latest && ./install.sh
```

**Opening files.** A file clip carries whatever path was on the clipboard, and any process on the machine can put one there. Opening a `.desktop` file, a script, or anything with the execute bit prompts for confirmation first, defaulting to *Cancel*.

### Residual risks, stated plainly

- **Auto-paste sends `ctrl+v` to whatever window has focus** after you pick a clip. If focus moved, it pastes there. Content you never inspected can land in a terminal — turn auto-paste off in ⚙ if that matters to you.
- **The clipboard is a shared bus.** Any app you run can read it and write to it; a clipboard manager records what's there, it can't police who put it there.
- `install.sh` pins dependencies to `package-lock.json` and blocks dependency lifecycle scripts (`npm ci --ignore-scripts`), but the `curl | bash` one-liner is still unsigned code from the network. Preferring `git clone`, reading `install.sh`, then running it locally is the stricter path.

Found something? Open an issue — or email the address in `LICENSE` if you'd rather not disclose publicly.

## Contributing

Issues and PRs welcome — this is a small Electron app with no runtime dependencies (see `src/` for the backend — one file per feature — and `renderer/` for the UI) and a good target for first-time contributors. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
