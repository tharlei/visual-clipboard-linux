#!/usr/bin/env bash
# Installs Visual Clipboard into the standard per-user XDG locations:
#   ~/.local/share/visual-clipboard/app          — app code + node_modules
#   ~/.local/bin/visual-clipboard                — launcher on PATH
#   ~/.local/share/applications/*.desktop — app-menu entry
set -euo pipefail

APP_NAME="visual-clipboard"
REPO_URL="https://github.com/tharlei/visual-clipboard-linux.git"
INSTALL_DIR="$HOME/.local/share/$APP_NAME/app"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"
CONFIG_JSON="$HOME/.local/share/$APP_NAME/config.json"

uninstall() {
  # Ask before touching clip history — it's the only thing here that isn't re-creatable
  # by re-running this script. Non-interactive (curl | bash) keeps the data.
  local purge=n
  if [ "${1:-}" = "--purge" ]; then
    purge=y
  elif [ -t 0 ]; then
    echo "Como remover o Visual Clipboard?"
    echo "  1) Desinstalação segura — remove o app, mantém histórico e configurações (padrão)"
    echo "  2) Apagar tudo — remove também o histórico de clips, imagens e configurações"
    read -r -p "Escolha [1/2]: " _opt
    [ "$_opt" = "2" ] && purge=y
  fi

  echo "Removing Visual Clipboard..."
  # match on the app dir, not the process name: an unpackaged Electron app is just "electron"
  pkill -f "$INSTALL_DIR" 2>/dev/null || true
  rm -rf "$INSTALL_DIR"
  rm -f "$BIN_DIR/$APP_NAME"
  rm -f "$DESKTOP_DIR/$APP_NAME.desktop"
  rm -f "$HOME/.config/autostart/$APP_NAME.desktop"
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
  if [ "$purge" = y ]; then
    rm -rf "$HOME/.local/share/$APP_NAME" "$HOME/.config/$APP_NAME"
    echo "Done. Everything removed, including your clip history."
  else
    echo "Done. Your clip history is still at ~/.local/share/$APP_NAME — re-run with '--uninstall --purge' to delete it too."
  fi
  exit 0
}

[ "${1:-}" = "--uninstall" ] && uninstall "${2:-}"

# Running as a local checkout (./install.sh) vs. piped in (curl ... | bash, where
# BASH_SOURCE points at a fd/pipe, not a real file next to the app's sources).
SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
if [ -n "$SCRIPT_SOURCE" ] && [ -f "$SCRIPT_SOURCE" ] && [ -f "$(dirname "$SCRIPT_SOURCE")/main.js" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
else
  command -v git >/dev/null 2>&1 || { echo "git not found. Install it (sudo apt install git) and re-run."; exit 1; }
  SCRIPT_DIR="$(mktemp -d)"
  trap 'rm -rf "$SCRIPT_DIR"' EXIT
  echo "Fetching Visual Clipboard..."
  git clone --depth 1 "$REPO_URL" "$SCRIPT_DIR"
fi

command -v node >/dev/null 2>&1 || { echo "Node.js not found. Install it (nodejs.org or your package manager) and re-run this script."; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "npm not found (normally bundled with Node.js)."; exit 1; }
if ! command -v xdotool >/dev/null 2>&1; then
  echo "Note: xdotool not found — auto-paste on selection won't work until you: sudo apt install xdotool"
fi

echo "Installing Visual Clipboard to $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR/renderer" "$INSTALL_DIR/assets" "$INSTALL_DIR/src" "$BIN_DIR" "$DESKTOP_DIR"
cp "$SCRIPT_DIR"/main.js "$SCRIPT_DIR"/preload.js "$SCRIPT_DIR"/package.json "$SCRIPT_DIR"/package-lock.json "$INSTALL_DIR"/
cp "$SCRIPT_DIR"/src/*.js "$INSTALL_DIR"/src/
cp "$SCRIPT_DIR"/renderer/*.html "$SCRIPT_DIR"/renderer/*.css "$SCRIPT_DIR"/renderer/*.js "$INSTALL_DIR"/renderer/
cp "$SCRIPT_DIR"/assets/icon.png "$SCRIPT_DIR"/assets/icon.svg "$INSTALL_DIR"/assets/

echo "Installing dependencies (downloads Electron, ~150MB, may take a while)..."
(cd "$INSTALL_DIR" && npm install)

# Electron 43 dropped the postinstall hook that fetched the binary, so `npm install`
# alone leaves node_modules/electron/dist missing and the app silently won't start.
ELECTRON_BIN="$INSTALL_DIR/node_modules/electron/dist/electron"
[ -x "$ELECTRON_BIN" ] || (cd "$INSTALL_DIR" && node node_modules/electron/install.js)
[ -x "$ELECTRON_BIN" ] || { echo "Electron binary download failed — check your connection and re-run."; exit 1; }

cat > "$BIN_DIR/$APP_NAME" <<LAUNCHER
#!/usr/bin/env bash
if [ "\${1:-}" = "--uninstall" ]; then
  # Ask before touching clip history — it's the only thing here that reinstalling
  # can't bring back. Non-interactive callers keep the data unless --purge is passed.
  PURGE=n
  if [ "\${2:-}" = "--purge" ]; then
    PURGE=y
  elif [ -t 0 ]; then
    echo "Como remover o Visual Clipboard?"
    echo "  1) Desinstalação segura — remove o app, mantém histórico e configurações (padrão)"
    echo "  2) Apagar tudo — remove também o histórico de clips, imagens e configurações"
    read -r -p "Escolha [1/2]: " _opt
    [ "\$_opt" = "2" ] && PURGE=y
  fi

  echo "Removing Visual Clipboard..."
  rm -rf "$INSTALL_DIR"
  rm -f "$BIN_DIR/$APP_NAME"
  rm -f "$DESKTOP_DIR/$APP_NAME.desktop"
  rm -f "$HOME/.config/autostart/$APP_NAME.desktop"
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
  if [ "\$PURGE" = y ]; then
    rm -rf "$HOME/.local/share/$APP_NAME" "$HOME/.config/$APP_NAME"
    echo "Done. Everything removed, including your clip history."
  else
    echo "Done. Your clip history is still at ~/.local/share/$APP_NAME — run '$APP_NAME --uninstall --purge' to delete it too."
  fi
  # the running instance holds the tray icon and global shortcut — drop it last.
  # match on the app dir, not the process name: an unpackaged Electron app is just "electron".
  pkill -f "$INSTALL_DIR" 2>/dev/null || true
  exit 0
fi
# --no-sandbox: Ubuntu/Zorin 24.04+ restrict unprivileged user namespaces via
# AppArmor by default, which crashes Chromium's sandbox setup (SIGTRAP) unless
# chrome-sandbox is manually chowned root+setuid. App loads local files only
# (no remote content, no nodeIntegration), so this is a low-risk workaround.
APP_DIR="$INSTALL_DIR"
# dist/electron = native binary (no \`node\` on PATH needed). The .bin/electron shim is a
# cli.js with '#!/usr/bin/env node', which fails from the GNOME menu/boot (a version-manager
# node like nvm isn't on the session PATH) — that's why the terminal worked but the icon didn't.
ELECTRON="\$APP_DIR/node_modules/electron/dist/electron"
LOG="$HOME/.local/share/$APP_NAME/launch.log"
echo "=== \$(date '+%F %T') launch tty=\$([ -t 1 ] && echo yes || echo no) args=[\$*] ===" >> "\$LOG" 2>&1
if [ -t 1 ]; then
  # terminal: detach so the shell returns immediately and closing it won't kill the app
  setsid "\$ELECTRON" --no-sandbox "\$APP_DIR" "\$@" >> "\$LOG" 2>&1 < /dev/null &
else
  # menu / autostart (no tty): run in FOREGROUND so the systemd app-scope keeps it alive.
  # Backgrounding + exiting here lets GNOME tear the scope (and Electron) down = "won't open".
  exec "\$ELECTRON" --no-sandbox "\$APP_DIR" "\$@" >> "\$LOG" 2>&1
fi
LAUNCHER
chmod +x "$BIN_DIR/$APP_NAME"

cat > "$DESKTOP_DIR/$APP_NAME.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Visual Clipboard
Comment=Clipboard history manager (text, links, code, images, files)
Exec=$BIN_DIR/$APP_NAME
Icon=$INSTALL_DIR/assets/icon.svg
Terminal=false
Categories=Utility;
StartupNotify=false
StartupWMClass=visual-clipboard
DESKTOP

update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Note: $BIN_DIR is not on your PATH. Add to ~/.bashrc or ~/.zshrc: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

# First-run config — interactive shells only; piped installs use defaults (change later in the app's ⚙)
if [ -t 0 ] && [ ! -f "$CONFIG_JSON" ]; then
  echo ""
  echo "Configuração inicial (Enter = padrão; dá pra mudar depois no ⚙ do app):"
  read -r -p "  Colar automático ao selecionar um clip? [Y/n] " _ap
  read -r -p "  Máximo de itens no histórico? [500] " _mx
  read -r -p "  Iniciar junto com o sistema? [y/N] " _au
  case "$_ap" in [Nn]*) _AP=false ;; *) _AP=true ;; esac
  case "$_mx" in ''|*[!0-9]*) _MX=500 ;; *) _MX=$_mx ;; esac
  mkdir -p "$(dirname "$CONFIG_JSON")"
  cat > "$CONFIG_JSON" <<CFG
{
 "shortcut": "Control+Alt+V",
 "maxItems": $_MX,
 "autoPaste": $_AP,
 "pasteDelayMs": 150
}
CFG
  case "$_au" in
    [Yy]*)
      mkdir -p "$HOME/.config/autostart"
      cat > "$HOME/.config/autostart/$APP_NAME.desktop" <<AUTO
[Desktop Entry]
Type=Application
Name=Visual Clipboard
Exec=$BIN_DIR/$APP_NAME --hidden
X-GNOME-Autostart-enabled=true
AUTO
      ;;
  esac
fi

# Start it now — GNOME Shell caches the app list, so the menu icon often doesn't
# show up until the next login and a fresh install otherwise looks like nothing happened.
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  setsid "$BIN_DIR/$APP_NAME" >/dev/null 2>&1 < /dev/null &
fi

echo ""
echo "Done! Visual Clipboard is running — press Ctrl+Alt+V to open it."
echo "Next time: launch with '$APP_NAME', or find \"Visual Clipboard\" in your app menu."
echo "To remove later: $APP_NAME --uninstall"
