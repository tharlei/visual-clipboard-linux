#!/usr/bin/env bash
# Covers the sandbox decision and supervisor loop inside install.sh's heredoc. See AGENTS.md §15.

set -u
cd "$(dirname "$0")/.."

BLOCK=$(sed -n '/^SANDBOX_FLAG=""$/,/^esac$/p' install.sh | sed 's/\\\$/$/g')
case "$BLOCK" in
  *esac*) ;;
  *) echo "FAIL: sandbox decision block not found in install.sh"; exit 1 ;;
esac

fails=0

# Runs the extracted block under one env value and compares the resulting flag.
check() {
  local value="$1" expected="$2" got
  if [ "$value" = "<unset>" ]; then
    got=$(env -u VISUAL_CLIPBOARD_NO_SANDBOX bash -c "$BLOCK"'; printf %s "$SANDBOX_FLAG"')
  else
    got=$(VISUAL_CLIPBOARD_NO_SANDBOX="$value" bash -c "$BLOCK"'; printf %s "$SANDBOX_FLAG"')
  fi
  if [ "$got" != "$expected" ]; then
    echo "FAIL: NO_SANDBOX=$value -> '${got}', expected '${expected}'"
    fails=$((fails + 1))
  fi
}

for v in "<unset>" "" 0 false FALSE no NO off OFF nope 2 " "; do
  check "$v" ""
done

for v in 1 true TRUE True yes YES Yes on ON On; do
  check "$v" "--no-sandbox"
done

[ "$fails" -eq 0 ] || exit 1

# Fails when the launcher loses a piece of the supervisor loop.
need() {
  if ! grep -qF "$1" install.sh; then
    echo "FAIL: launcher lost '$1'"
    fails=$((fails + 1))
  fi
}
need 'CLP_SUPERVISED=1'
need 'QUIT_FLAG="$HOME'
need 'if [ -f "\$QUIT_FLAG" ]; then'
need '"\$tries" -gt 5'
need 'mv -f "\$LOG" "\$LOG.1"'
need 'setsid "\$0" --_supervise'

if grep -nE 'pkill( -9)? -f "\$(INSTALL_DIR|\{INSTALL_DIR\})' install.sh; then
  echo "FAIL: unanchored pkill above — use the ^…/electron form"
  fails=$((fails + 1))
fi

[ "$fails" -eq 0 ] || exit 1
echo "ok — sandbox flag + supervisor"
