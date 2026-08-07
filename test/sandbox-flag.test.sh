#!/usr/bin/env bash
# The launcher decides whether Chromium runs sandboxed, and that decision lives inside a
# heredoc in install.sh — `bash -n` never parses it and no JS test can reach it. Pull the
# block out, undo the heredoc's backslash escaping, and run it under the spellings a person
# actually types. The failure this guards: a plain -n test treats NO_SANDBOX=0 and
# NO_SANDBOX=false as "disable the sandbox", the exact opposite of what they mean.

set -u
cd "$(dirname "$0")/.."

BLOCK=$(sed -n '/^SANDBOX_FLAG=""$/,/^esac$/p' install.sh | sed 's/\\\$/$/g')
case "$BLOCK" in
  *esac*) ;;
  *) echo "FAIL: sandbox decision block not found in install.sh"; exit 1 ;;
esac

fails=0

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

# secure by default: anything that is not an explicit yes keeps the sandbox
for v in "<unset>" "" 0 false FALSE no NO off OFF nope 2 " "; do
  check "$v" ""
done

# the documented opt-out, and the spellings people reach for instead
for v in 1 true TRUE True yes YES Yes on ON On; do
  check "$v" "--no-sandbox"
done

[ "$fails" -eq 0 ] || exit 1
echo "ok — sandbox flag"
