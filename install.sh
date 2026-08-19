#!/usr/bin/env bash
# Installs Visual Clipboard into the per-user XDG locations. Rationale: AGENTS.md §15.
set -euo pipefail

APP_NAME="visual-clipboard"
REPO_URL="https://github.com/tharlei/visual-clipboard-linux.git"
INSTALL_DIR="$HOME/.local/share/$APP_NAME/app"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"
CONFIG_JSON="$HOME/.local/share/$APP_NAME/config.json"

# ^ anchors the match to argv[0]: an unanchored pattern also kills shells that merely name the path.
APP_PROC="^$INSTALL_DIR/node_modules/electron/dist/electron"

# Stops a running instance: flags the exit as deliberate, then SIGTERM and SIGKILL.
stop_running() {
  [ -d "$HOME/.local/share/$APP_NAME" ] && : > "$HOME/.local/share/$APP_NAME/quitting" 2>/dev/null || true
  pkill -f "$APP_PROC" 2>/dev/null && sleep 2 || true
  pkill -9 -f "$APP_PROC" 2>/dev/null && sleep 1 || true
}

# Removes the app; keeps clip history unless --purge or option 2 is chosen.
uninstall() {
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
  stop_running
  rm -rf "$INSTALL_DIR"
  rm -f "$BIN_DIR/$APP_NAME"
  rm -f "$DESKTOP_DIR/$APP_NAME.desktop"
  rm -f "$HOME/.config/autostart/$APP_NAME.desktop"
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
  if [ "$purge" = y ]; then
    rm -rf "$HOME/.local/share/$APP_NAME" "$HOME/.config/$APP_NAME"
    echo "Done. Everything removed, including your clip history."
  else
    rm -f "$HOME/.local/share/$APP_NAME/quitting"
    echo "Done. Your clip history is still at ~/.local/share/$APP_NAME — re-run with '--uninstall --purge' to delete it too."
  fi
  exit 0
}

[ "${1:-}" = "--uninstall" ] && uninstall "${2:-}"

# Local checkout (./install.sh) vs. piped in (curl ... | bash), which needs a clone first.
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
stop_running
mkdir -p "$INSTALL_DIR/renderer" "$INSTALL_DIR/assets" "$INSTALL_DIR/src" "$BIN_DIR" "$DESKTOP_DIR"
cp "$SCRIPT_DIR"/main.js "$SCRIPT_DIR"/preload.js "$SCRIPT_DIR"/package.json "$SCRIPT_DIR"/package-lock.json "$INSTALL_DIR"/
cp "$SCRIPT_DIR"/src/*.js "$INSTALL_DIR"/src/
cp "$SCRIPT_DIR"/renderer/*.html "$SCRIPT_DIR"/renderer/*.css "$SCRIPT_DIR"/renderer/*.js "$INSTALL_DIR"/renderer/
cp "$SCRIPT_DIR"/assets/icon.png "$SCRIPT_DIR"/assets/icon.svg "$INSTALL_DIR"/assets/

echo "Installing dependencies (downloads Electron, ~150MB, may take a while)..."
(cd "$INSTALL_DIR" && npm ci --ignore-scripts)

# Electron 43 dropped the postinstall hook that fetched the binary — invoke it explicitly.
ELECTRON_BIN="$INSTALL_DIR/node_modules/electron/dist/electron"
[ -x "$ELECTRON_BIN" ] || (cd "$INSTALL_DIR" && node node_modules/electron/install.js)
[ -x "$ELECTRON_BIN" ] || { echo "Electron binary download failed — check your connection and re-run."; exit 1; }

# Advisory only: no network, no registry or a timeout must never fail an install.
ELECTRON_HAVE="$(node -p "require('$INSTALL_DIR/node_modules/electron/package.json').version" 2>/dev/null || true)"
ELECTRON_LATEST="$(cd "$INSTALL_DIR" && timeout 15 npm view electron version 2>/dev/null || true)"
if [ -n "$ELECTRON_HAVE" ] && [ -n "$ELECTRON_LATEST" ] && [ "$ELECTRON_HAVE" != "$ELECTRON_LATEST" ]; then
  echo
  echo "Heads up: Electron $ELECTRON_HAVE installed, $ELECTRON_LATEST released."
  echo "  Chromium security fixes ride along with it. To take the newer one:"
  echo "    npm install electron@$ELECTRON_LATEST   # in your clone, then commit the lockfile"
  echo "    ./install.sh"
  echo
fi

cat > "$BIN_DIR/$APP_NAME" <<LAUNCHER
#!/usr/bin/env bash
if [ "\${1:-}" = "--uninstall" ]; then
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
  mkdir -p "$HOME/.local/share/$APP_NAME" 2>/dev/null || true
  : > "$HOME/.local/share/$APP_NAME/quitting" 2>/dev/null || true
  APP_PROC="^$INSTALL_DIR/node_modules/electron/dist/electron"
  pkill -f "\$APP_PROC" 2>/dev/null || true
  sleep 2
  pkill -9 -f "\$APP_PROC" 2>/dev/null || true
  rm -rf "$INSTALL_DIR"
  rm -f "$BIN_DIR/$APP_NAME"
  rm -f "$DESKTOP_DIR/$APP_NAME.desktop"
  rm -f "$HOME/.config/autostart/$APP_NAME.desktop"
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
  if [ "\$PURGE" = y ]; then
    rm -rf "$HOME/.local/share/$APP_NAME" "$HOME/.config/$APP_NAME"
    echo "Done. Everything removed, including your clip history."
  else
    rm -f "$HOME/.local/share/$APP_NAME/quitting"
    echo "Done. Your clip history is still at ~/.local/share/$APP_NAME — run '$APP_NAME --uninstall --purge' to delete it too."
  fi
  exit 0
fi
APP_DIR="$INSTALL_DIR"
# Sandbox stays ON — see AGENTS.md §1 and §2. Escape hatch: VISUAL_CLIPBOARD_NO_SANDBOX=1
SANDBOX_FLAG=""
case "\${VISUAL_CLIPBOARD_NO_SANDBOX:-}" in
  1|true|TRUE|True|yes|YES|Yes|on|ON|On) SANDBOX_FLAG="--no-sandbox" ;;
esac
# dist/electron is the native binary; the .bin/electron shim needs node on the session PATH.
ELECTRON="\$APP_DIR/node_modules/electron/dist/electron"
LOG="$HOME/.local/share/$APP_NAME/launch.log"
QUIT_FLAG="$HOME/.local/share/$APP_NAME/quitting"

if [ "\${1:-}" = "--_supervise" ]; then
  shift
elif [ -t 1 ]; then
  setsid "\$0" --_supervise "\$@" >/dev/null 2>&1 < /dev/null &
  exit 0
fi

# Supervisor loop: respawns on any unexpected exit, gives up after 5 deaths in 5min.
tries=0
window_start=\$(date +%s)
while :; do
  if [ -f "\$LOG" ] && [ "\$(stat -c%s "\$LOG" 2>/dev/null || echo 0)" -gt 2097152 ]; then
    mv -f "\$LOG" "\$LOG.1"
  fi
  echo "=== \$(date '+%F %T') launch tty=\$([ -t 1 ] && echo yes || echo no) sandbox=\$([ -n "\$SANDBOX_FLAG" ] && echo off || echo on) args=[\$*] ===" >> "\$LOG" 2>&1
  # \$SANDBOX_FLAG unquoted on purpose: empty must vanish, not become an empty argv entry.
  CLP_SUPERVISED=1 "\$ELECTRON" \$SANDBOX_FLAG "\$APP_DIR" "\$@" >> "\$LOG" 2>&1 < /dev/null
  code=\$?
  if [ -f "\$QUIT_FLAG" ]; then
    rm -f "\$QUIT_FLAG"
    echo "=== \$(date '+%F %T') supervisor: saída deliberada (exit=\$code), encerrando ===" >> "\$LOG" 2>&1
    break
  fi
  [ "\$code" -eq 0 ] && break
  now=\$(date +%s)
  if [ \$((now - window_start)) -gt 300 ]; then
    tries=0
    window_start=\$now
  fi
  tries=\$((tries + 1))
  if [ "\$tries" -gt 5 ]; then
    echo "=== \$(date '+%F %T') supervisor: 5 quedas em 5min, desistindo (exit=\$code) ===" >> "\$LOG" 2>&1
    break
  fi
  echo "=== \$(date '+%F %T') supervisor: exit=\$code, religando em 2s (tentativa \$tries) ===" >> "\$LOG" 2>&1
  sleep 2
done
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

# Repairs an old autostart entry that invoked electron directly with a hardcoded --no-sandbox.
AUTOSTART_FILE="$HOME/.config/autostart/$APP_NAME.desktop"
if [ -f "$AUTOSTART_FILE" ] && ! grep -qF "Exec=$BIN_DIR/$APP_NAME " "$AUTOSTART_FILE" \
   && ! grep -qF "Exec=\"$BIN_DIR/$APP_NAME\" " "$AUTOSTART_FILE"; then
  cat > "$AUTOSTART_FILE" <<AUTOFIX
[Desktop Entry]
Type=Application
Name=Visual Clipboard
Exec=$BIN_DIR/$APP_NAME --hidden
X-GNOME-Autostart-enabled=true
AUTOFIX
  echo "Fixed autostart: it was launching Electron directly with --no-sandbox."
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Note: $BIN_DIR is not on your PATH. Add to ~/.bashrc or ~/.zshrc: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

# First-run config — interactive shells only; piped installs use defaults.
if [ -t 0 ] && [ ! -f "$CONFIG_JSON" ]; then
  echo ""
  echo "Configuração inicial (Enter = padrão; dá pra mudar depois no ⚙ do app):"
  read -r -p "  Colar automático ao selecionar um clip? [Y/n] " _ap
  read -r -p "  Máximo de itens no histórico? [500] " _mx
  read -r -p "  Iniciar junto com o sistema? [y/N] " _au
  case "$_ap" in [Nn]*) _AP=false ;; *) _AP=true ;; esac
  case "$_mx" in ''|*[!0-9]*) _MX=500 ;; *) _MX=$_mx ;; esac
  mkdir -p "$(dirname "$CONFIG_JSON")"
  chmod 700 "$(dirname "$CONFIG_JSON")" 2>/dev/null || true
  (umask 077; : > "$CONFIG_JSON")
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

# Start it now: GNOME caches the app list, so the menu icon often lags a login.
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  setsid "$BIN_DIR/$APP_NAME" >/dev/null 2>&1 < /dev/null &
fi

echo ""
echo "Done! Visual Clipboard is running — press Ctrl+Alt+V to open it."
echo "Next time: launch with '$APP_NAME', or find \"Visual Clipboard\" in your app menu."
echo "To remove later: $APP_NAME --uninstall"
