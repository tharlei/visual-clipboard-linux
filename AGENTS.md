# AGENTS.md

Engineering rationale for visual-clipboard-linux. Source files carry one-line docblocks only —
every "why" lives here. Read the section for a file before changing it: most of what looks
removable is load-bearing and was paid for with a real bug.

Vocabulary: **launch.log** = `~/.local/share/visual-clipboard/launch.log`, written by the
launcher's supervisor loop. Dates below are real incidents from that log.

---

## 1. Threat model

The renderer decodes images that *strangers* put on the clipboard. Any process on the box can
own the X11 selection, so clipboard content is untrusted input, and so are the paths in it.

- `history.json` / `config.json` are untrusted input too: they sit on disk, older installs left
  them group-writable, and their fields feed `path.join()` and the renderer's markup.
- CSP and `contextIsolation` are JS-level barriers. Native memory corruption in an image decoder
  walks past both (CVE-2023-4863 was exactly that, exploited in the wild). Only the Chromium
  sandbox stands there.
- Every file this process writes carries clipboard history — passwords, tokens, private keys.

Consequences enforced in code:

| Rule | Where |
|---|---|
| `process.umask(0o077)` on boot, beats remembering `{ mode: 0o600 }` per write | `main.js` |
| Chromium sandbox stays ON; only `VISUAL_CLIPBOARD_NO_SANDBOX` in exact words disables it | launcher in `install.sh` |
| Every disk read goes through `sanitizeStore` / `normalizeConfig` | `src/storage.js`, `src/validate.js` |
| A clipboard path handed to `shell.openPath()` gets a confirm dialog when risky | `src/ipc.js`, `src/validate.js` |
| Only panel windows may reach an IPC channel | `src/ipc.js` |

---

## 2. Hardware acceleration is off, deliberately

`app.disableHardwareAcceleration()` in `main.js`.

The panel is 320px of thumbnails — the GPU buys it nothing and cost everything: on NVIDIA + X11
with a transparent window, the GPU process kept dying with `GPU process isn't usable. Goodbye.`,
taking the whole app down. The root cause was the *sandboxed* GPU process failing to `dlopen`
the Mesa driver (`MESA-LOADER: failed to open dri ... Permission denied`).

So this call is load-bearing for **security**, not just stability: no DRI driver is loaded at
all, therefore that failure cannot happen, therefore the sandbox can stay on.

### It does not remove the GPU *process*

Chromium still forks one for software compositing. When that one dies (exit_code=9 across a
suspend, or launch failures), `GpuProcessHost` runs out of fallback modes and calls
`LOG(FATAL) "GPU process isn't usable. Goodbye."`, killing the browser process with it — 32 of
the 43 deaths in launch.log.

**No Chromium switch is applied for that, on purpose.** Both candidates are worse than the
supervisor loop:

- `--in-process-gpu` folds the GPU and viz threads into the browser process. Measured: they go
  from a child with `Seccomp=2 / NoNewPrivs=1 / CapEff=0` to the main process, where
  `Seccomp=0`. That deletes one sandbox stage from the exact chain this app defends
  (hostile clipboard image → renderer decoder bug → viz/GPU Mojo → browser).
- `--disable-gpu-process-crash-limit` keeps the sandbox but only lifts the retry ceiling: one
  failing episode wrote 129 `GPU process launch failed` lines in 24ms, drowning the log the app
  relies on to explain itself.

Letting it die and come back costs a visible restart and keeps both the sandbox and the log.

---

## 3. Supervision, restart and quit

Three cooperating pieces: the **supervisor loop** (launcher script), the **QUIT_FLAG** and the
**detached deadlines** in `src/procs.js`.

### Why a supervisor exists

The app used to die on its own — 32 `GPU process isn't usable. Goodbye.` aborts in launch.log,
always while the machine sat idle, leaving nothing running for a button *inside* the app to
restart. The supervisor loop is the launcher's foreground process, so the systemd app-scope
GNOME opens for a menu/autostart launch keeps it alive.

Loop rules:
- exit 0 → stop. `QUIT_FLAG` present → stop (and log it).
- any other exit → respawn after 2s.
- 5 deaths inside a 5-minute window → give up. Otherwise a machine where the app cannot start
  at all (broken install, no X) respawns forever, filling the log with the same crash.
- the deliberate-exit break is **logged**: a silent break made "the user quit" and "the
  supervisor never saw the exit" read identically, and telling those apart is most of
  diagnosing a stuck restart.

### QUIT_FLAG (`~/.local/share/visual-clipboard/quitting`)

An exit *code* cannot carry "the user asked for this": Electron's own shutdown FATAL
(`Failed to shutdown.`, 12 times in launch.log) makes a clean quit look exactly like a crash.
So `before-quit` writes the flag file, and the supervisor reads it.

`install.sh` and the launcher's `--uninstall` write it too, before any `pkill` — otherwise
uninstall turns into a restart, and an update races the copy against a respawn.

### RESTART_CODE = 42

`Reiniciar` (tray menu + panel settings) exits with a non-zero code and **no** QUIT_FLAG, so the
supervisor respawns. Deliberately not `app.relaunch()` under supervision: handing the respawn
back to the launcher means the new instance keeps the log redirect, the sandbox decision and the
supervision itself. Without a supervisor (dev run, `npm start`) `relaunch` is the only way back.

Ordering inside `restartApp()` is load-bearing — **everything that can block goes AFTER the
killer is armed**. This button gets pressed *because* the app stopped working, and three of the
five restarts in launch.log left the `reiniciar` log line as their last trace: `app.exit()` waits
on Chromium's UI task runner and `unregisterAll()` is an X11 round trip, so both hang on exactly
the state the user is trying to escape.

Also: `app.exit()` skips `before-quit`, so the panels' close veto is still armed and would keep
the window list non-empty forever — hence `allowClose()`.

On a dev run the `killSelfIn` SIGKILL wins the race against a stalled `relaunch` and nothing
comes back. Acceptable there and only there — `npm start` is a terminal away.

### Detached deadlines (`src/procs.js`)

Every emergency exit this app had lived on the same thread it was meant to rescue: `app.exit()`
posts to Chromium's UI task runner, the 5s fallback behind `Sair` was a JS timer, even
`globalShortcut.unregisterAll()` is an X11 round trip. All three need the event loop that stopped
turning. launch.log has three restarts whose last trace is the `reiniciar` line itself
(2026-08-17 14:17, 2026-08-17 16:00, 2026-08-19 17:09) — each after an hour or more with no
heartbeat — against two that exited in the same second while healthy.

So the deadline lives in a **detached `sh` child**: it fires whether or not this process ever
schedules anything again.

Safety rail: the kill is only armed against a process we can still prove is us. Field 22 of
`/proc/<pid>/stat` is the start time on the boot clock, unique per pid incarnation. If the pid
was recycled between arming and firing, the test fails and nothing dies. Being wrong in that
direction costs a stuck process; the other direction costs someone else's.

Caveat, accepted: the shell reads field 22 with `cut -d' ' -f22`, which is exact only while
`comm` holds no space. `electron` holds none. A `comm` that did would make JS and shell disagree
and the deadline would simply never fire — the safe failure.

`shQuote()`: DATA_DIR is built from `$XDG_DATA_HOME` / `$HOME`, so those paths are not ours to
trust inside a shell string. Single quotes cover every metacharacter except the single quote
itself, and a path carrying one is **refused, not escaped**.

### Watchdog / heartbeat

The app cannot detect its own freeze — the check would be a timer on the frozen loop. So:

- main thread touches `HEARTBEAT_FILE` (`alive`) once per `HEARTBEAT_MS` (60s).
- `guardHeartbeat()` spawns a detached child that only ever sleeps and stats. No touch for
  `WATCHDOG_S` → it appends a line to launch.log and SIGKILLs. The non-zero exit is all the
  supervisor needs to bring the app back.
- the file is **seeded before arming**, or the guard finds a file that never existed and kills a
  healthy boot.
- `alive`'s mtime is the only liveness proof of the MAIN THREAD an outside process can read.
  launch.log is not: the renderer writes X11 errors into it long after the browser process
  stopped scheduling anything.
- `WATCHDOG_S` default 180 (three missed beats). **Do not go under 120s**: a poll blocked on an
  X11 selection owner routinely costs 8s and those come in bursts. `CLP_WATCHDOG_S=0` disables
  it — the knob exists because the right number is a property of this desktop, not of the code.

### The heartbeat log line

The one line that separates a freeze from a crash. At `POLL_MS=500` a healthy beat reports
`poll=+120`. A much smaller delta means the main process spent the minute blocked (the
synchronous clipboard read on a dead X11 selection owner is the prime suspect); a missing beat
means it never came back. Nothing else in launch.log can tell those apart.

It also re-registers the global shortcut when `isRegistered()` says it was lost.

---

## 4. Single instance

Chromium's singleton lock **was bypassed in the wild**: two live instances on 2026-07-30, the
second sailed past `requestSingleInstanceLock()` and stole the shortcut. `app.pid` is the
fallback net.

- claimed with `link()` (atomic), retried 3x, stale file unlinked between attempts.
- `livingIncumbent()` reads `/proc/<pid>/cmdline` and requires it to contain our app path, so a
  recycled pid does not count as us.
- a duplicate that finds an incumbent behaves exactly like `second-instance`: `SIGUSR2` to
  toggle the running panel, then exit — **before** it loads the store, registers a shortcut or
  puts up a second tray icon.
- a 5s interval rewrites the pid file if it vanished or was taken over.
- `before-quit` returns early when `isPrimary` is false: a duplicate quitting on the incumbent's
  behalf owns nothing — no shortcut, an unloaded store (saving it would blank `history.json`)
  and the incumbent's pid file.

`QUIT_FLAG` is removed on boot: a stale flag (SIGKILL after `Sair` was pressed) would make the
supervisor treat the next crash as a deliberate quit and stop supervising.

---

## 5. Killing stray instances (`strayPids`)

The restart button has to clear instances that outlived their session: launch.log shows browser
processes that stopped painting but kept the tray icon and the X11 grab, so a plain relaunch
would come back to a desktop where the shortcut is already taken.

Matching rules, each one paid for:

- match on **argv[0]**, not the whole cmdline, and never the process name. An unpackaged Electron
  app is just `electron`. Matching anywhere in the cmdline picks up every shell, editor and
  `pgrep` that merely mentions the path in an argument — not theoretical: the first dry run
  targeted the terminal it was invoked from.
- argv[0] alone still sweeps a whole stray instance: every Chromium child (zygote, gpu, renderer,
  utility, broker) re-execs that same binary.
- **do not walk the process tree** of a stray: it would drag in whatever it opened through
  `shell.openPath()`. The user's editor is not ours to kill.
- exclude our own subtree: SIGKILLing this process's gpu/renderer right before it exits writes
  exactly the FATAL noise into launch.log that this change exists to remove.
- refuse an empty, relative or `/` appPath — `startsWith()` would then be true for every process
  on the box, and the blast radius of being wrong is the user's whole session.
- `comm` sits in parentheses and may contain spaces and `)` itself → split after the **last**
  `)`, so ppid is reliably the second field of the remainder. Same trick in `procStart`.
- prefix test is `appPath + path.sep`, so a sibling `app-old/` does not match.

The shell side (`install.sh`, launcher `--uninstall`) uses the same rule:
`pkill -f "^$INSTALL_DIR/node_modules/electron/dist/electron"`. The `^` anchor pins the match to
argv[0]; an unanchored pattern once killed the installer mid-run.

SIGTERM then SIGKILL, in that order: SIGTERM is a request and a wedged instance cannot honour it
— one was caught spinning at 100% CPU for two minutes after being asked to quit, still holding
the tray icon and the global shortcut while its replacement was already running. Whatever ignored
the polite signal is exactly what must not survive into the new install.

---

## 6. Logging (`src/log.js`)

`src/log.js` is required **first** in `main.js` on purpose: it patches `console.*`, so every line
any other module logs while loading already carries a timestamp.

- launch.log interleaves our lines with Chromium's, which carry their own timestamps. Ours
  carried none, so a whole session read as "boot, nothing, FATAL" with no way to tell five
  seconds from five hours — the reason no freeze was ever diagnosable.
- the **pid** is not decoration: a supervisor respawn, a duplicate that refused to die, and the
  instance that replaced it all append to the same launch.log. Chromium stamps its own lines with
  a pid; ours did not, so two instances read as one contradictory app.
- **no rotation in the app**: stdout is an fd the launcher opened with `>>`, so renaming the file
  from inside would leave this process appending to the renamed inode. The shell rotates
  (`> 2MB` → `.1`), at the top of each supervisor iteration.

---

## 7. Clipboard polling (`src/clipboard.js`)

`readClipboard()` is **synchronous** and runs on the main process. An X11 selection owner that
stops answering blocks it — and with it the tray, the shortcut and every IPC reply. That is a
freeze with no trace, which is why `POLL_SLOW_MS = 1000` gets its own warning line, and why the
line reports the **kind**: an image read stalls on the X11 selection transfer, a text one does
not, and the two want different fixes. No kind means the image read was gated off (`imageDue`
false), so the stall was in reading the format list itself.

### The image gate — a real memory leak

- `availableFormats()` is free; reading the *bytes* of a selection owned by another X11 client is
  not — Chromium retains a copy of the whole buffer on every call. So a change in the target list
  is the only routine reason to re-read image bytes (`state.imageDue`).
- `clipboard.readImage()` decodes the bitmap and leaks ~10 KB per megapixel inside Chromium's X11
  clipboard. At 2 polls/s that is **GBs per hour**. `readBuffer` never decodes → hash the raw
  target bytes and only decode when they actually change.
- `shaImage()` skips the sha256 when length + first 4096 bytes are unchanged.
- `showPanel()` sets `imageDue = true` so a second image copied from the same app is still picked
  up before the user looks at the history.

### Other capture rules

- custom targets (`x-special/gnome-copied-files`, `text/uri-list`) are readable but never listed
  by `availableFormats()` — probe them directly.
- `SECRET_HINT_FORMATS` are the targets password managers set to mark a selection as "do not
  record". Present → skip, but still record a signature so the poll does not re-evaluate.
- pause reads **nothing at all**; `setPaused(false)` reseeds `lastSig` first, else the first poll
  after resume captures exactly the secret the pause was meant to keep out.
- `writeClipToClipboard()` reads back to preset `lastSig`, so the watcher never re-captures our
  own write.
- `enforceCap()` counts only evictable clips (not pinned, in no board) against `maxItems`.

---

## 8. Panels (`src/window.js`)

One `BrowserWindow` per target display, frameless, transparent, always-on-top, all workspaces.

- `display` config: `cursor` → display under the pointer, `all` → every display, anything else →
  a pinned display id.
- navigation is fully denied (`setWindowOpenHandler` → deny, `will-navigate` prevented): the panel
  only ever shows its own local page, and any navigation — including a file drop — would leave
  the CSP'd `index.html` behind while keeping the `clp` preload.
- `close` is vetoed and turned into `hide()` (tray app). `quitting` flips on `before-quit`;
  `allowClose()` exists because `app.exit()` does **not** emit `before-quit`, so a restart would
  meet the veto and stall with the panels alive — which is what a wedged instance looks like in
  `ps` after `Reiniciar`.
- blur: ignore the focus-steal within 600ms of showing (menu/overview closing) or a
  launch-shown panel hides instantly and looks like it never opened. With one panel per monitor,
  clicking another panel blurs this one — hide the whole set only once no panel holds focus.
- `render-process-gone`: reload up to 3 times, then **destroy**. Don't just give up: a
  kept-but-rendererless window still passes `isDestroyed()`, so `showPanel()` would show an empty
  transparent panel forever and the app reads as frozen. `syncPanels()` rebuilds on the next
  open, and only then, so this never loops.
- `unresponsive` / `responsive` are logged: a panel that stops answering is the visible half of
  "travou", and the pair tells a renderer stuck on a big paint apart from a main process that
  stopped scheduling anything.
- `invalidate()` 150ms after show: hardware acceleration is off, so Chromium's software presenter
  blits frames straight into the X window — and X11 hands the panel a fresh XID on remap. The
  first frame can land in the pre-remap XID (`XGetWindowAttributes failed` in launch.log): the
  panel maps fully transparent with a correct DOM behind it. One repaint after the remap settles
  re-presents into the live XID.
- `showInactive()` first for every panel, then focus one: focusing them in turn would blur the
  previous one.
- a just-recreated panel is still loading — a `panel:shown` send would land on no listener and
  the panel opens empty until the next broadcast, so it waits for `did-finish-load`.
- the forced poll after show is `setTimeout(..., 0)` **after** the show on purpose:
  `readClipboard()` can spend seconds on a 15 MB image (X11 transfer, sha256, decode,
  `writeFileSync`). In front of the show that stall is the panel visibly freezing on open; behind
  it the new clip just arrives via `broadcast()`.
- DEBUG screenshot goes to DATA_DIR, not tmpdir: the frame is clipboard content and a fixed
  `/tmp` name is a symlink-clobber target on a shared machine.

### Global shortcut

Register wanted → on conflict fall back to `Control+Alt+Shift+V` → else none (tray still works).
The fallback is **in-memory only**: persisting it would let a transient conflict (another
instance, another app holding the key for one session) permanently overwrite the user's choice.

An X11 key grab does not always survive a suspend or a VT switch: the process stays alive, the
tray still works, and the shortcut silently does nothing — "o programa parou de funcionar" with
no error anywhere. So it is re-taken on `powerMonitor` `resume`, and re-checked every heartbeat.

`lastSig` is deliberately **not** reseeded on resume: nothing can reach the clipboard while the
machine is asleep, so reseeding would only drop whatever was copied just before it went under.

---

## 9. Storage (`src/storage.js`)

- `saveJsonAtomic`: tmp + rename. `{ mode: 0o600 }` is belt to the umask's braces — it only
  applies on create and the tmp is always new; without it the 0600 guarantee would rest solely on
  `main.js` being the entry point.
- `hardenPerms()` exists because installs from before the umask shipped left `history.json` at
  0644 (0664 under a 002 umask).
- a corrupt JSON file is renamed to `.bak` and replaced with defaults, never silently dropped.
- `scanUsage()` / `pruneOrphans()`: files no clip references anymore (crash, `.tmp` leftover, old
  bug), surfaced in the panel's settings.
- save is debounced 300ms; `flushSave()` on quit and before a restart.

## 10. Thumbnails (`src/protocol.js`)

`clp://` is registered as a privileged scheme, which **must** happen before `app.whenReady` —
`main.js` requiring this module at the top is what keeps the ordering.

Hosts: `clp://img/<id>`, `clp://file/<id>/<index>`, `clp://thumb/<id>`. Each resolves through the
in-memory store, so a URL can only ever reach a file the store already references.

Thumbnail rules — all of them are "don't block the main thread":

- decoding happens on the main thread and blocks the poll/shortcut/tray. A copied file can be
  arbitrarily large → anything over `MAX_IMAGE_BYTES` is handed straight to the renderer.
- `asIs` remembers "this one has no thumb", so an undecodable (gif/webp/svg) or already-small
  source is not re-read and re-decoded on every panel show.
- bound **both** sides (`THUMB_WIDTH` and `THUMB_HEIGHT`): a panorama capped only by height still
  decodes a huge bitmap.
- tmp + rename, like `saveJsonAtomic` — a truncated thumb would be cached forever.

---

## 11. IPC (`src/ipc.js`)

Every channel is privileged, so the sender check wraps the **registration** rather than each
handler — future channels are covered by default. A sender that is not one of our panels throws.

- `clips:openFile` — the path came off the clipboard, so any process on the box chose it. A
  `.desktop` or an executable handed to `shell.openPath()` is code execution, so `riskyToOpen()`
  gates it behind a confirm dialog. `readHead()` reads the first 64 bytes only: a file clip can
  point at a multi-gigabyte video.
- `app:restart` is deferred one tick: `restartApp()` exits the process, and the `invoke` reply
  has to reach the renderer first or the panel hangs on a promise that never settles.
- `config:update` goes through `normalizeConfig`, which keeps the current value on anything
  invalid — a bad patch is a no-op, not a reset. A display change defers `refreshPanels` because
  switching to fewer monitors destroys windows and this reply may be going to one.
- `clips:startDrag` drags a real file out (image/file clips); dropping into a terminal yields the
  path.

---

## 12. Validation (`src/validate.js`)

The guards between untrusted input and `path.join` / `globalShortcut` / `shell.openPath`.

- **`hasModifier`** — a bare key registered as a global accelerator swallows that key for every
  app on the desktop.
- **`sanitizeStore`** — ids must match `/^[a-z0-9_]+$/`; `imageFile` must be *exactly*
  `images/<id>.png` (it feeds `path.join(DATA_DIR, ...)`); `boardIds` pointing at dropped boards
  are stripped; image/file clips missing their payload are dropped.
- **`riskyToOpen`** — the extension alone is not a control: a path ending in `".desktop "` (a
  `file://` URI ending `%20`) has `extname` `".desktop "` and misses the list, while GIO still
  content-sniffs it as a desktop entry and launches it. Hence trim + lowercase, plus the exec
  bit, non-regular files, shebang and `[Desktop Entry]` in `head`.
- **`matchesIgnore`** — plain case-insensitive substring, capped at `MAX_IGNORE_PATTERNS`. Not
  regex: a user-supplied regex on every poll is a ReDoS on the main thread.

---

## 13. Tray (`src/tray.js`)

- autostart routes through the **installed launcher**, so it inherits the launcher's sandbox
  decision and log instead of re-deciding either. The direct-electron form is the dev fallback,
  where no launcher exists — and carries no `--no-sandbox`: autostart must not be the one path
  that silently starts unsandboxed.
- `Pausar captura` toggles `state.config.paused`, **not** `item.checked` — AppIndicator (Linux
  tray) doesn't flip a checkbox's state on click, so `item.checked` reports the old value and
  nothing happens.
- `Reiniciar` lives here because the tray survives a dead or unpainted panel: this is the restart
  path that still works when the window is the thing that broke.
- `Sair` calls `app.quit()`, not `exit()` — `before-quit` must run: it saves the store, releases
  the global shortcut and lets Chromium clean up its singleton files (an `exit(0)` here left them
  behind).
- `electronAgeDays()` stats `node_modules/electron/package.json`: npm rewrites it on every
  install, so its mtime is when Chromium was last replaced. The binary beside it is unusable for
  this — it carries the release zip's zeroed 1979 timestamp. Returns 0 when unreadable: never nag
  on a guess.
- `ELECTRON_STALE_DAYS = 90`. Chromium ships inside Electron and this renderer decodes images
  strangers put on the clipboard. The sandbox *contains* a decoder bug; only an upgrade removes
  it. Roughly a quarter of a year without one is worth a tray warning.

---

## 14. Renderer (`renderer/app.js`, `preload.js`)

- panel hidden = **zero DOM work**. Main sends `panel:shown` / `panel:hidden` on every show/hide
  path, and `hide` frees `cardsEl.innerHTML` — DOM, decoded bitmaps and GPU textures.
- `purgeCache()` is called by the renderer *after* it drops the cards, so the decoded bitmaps are
  already unreferenced when Chromium's image cache is flushed.
- transparent windows don't composite the video layer — video thumbs come from an offscreen
  canvas, seeked 10% in (capped at 3s) because frame 0 of many videos is blank. One decode per
  clip ever; re-renders reuse the cached data URL. Hiding the panel mid-decode aborts the
  `<video>` → retry on later renders, give up after 3.
- CSP blocks inline handlers, so media fallbacks are wired in JS.
- the shortcut editor requires a modifier for the same reason `hasModifier` does.

---

## 15. install.sh

Layout (standard per-user XDG):

```
~/.local/share/visual-clipboard/app   app code + node_modules
~/.local/bin/visual-clipboard         launcher on PATH (contains the supervisor loop)
~/.local/share/applications/*.desktop app-menu entry
```

- `stop_running` before copying: an already-running instance holds the single-instance lock, so
  the launch at the end of the script would just toggle the OLD code's panel and quit — an update
  looks like nothing happened.
- QUIT_FLAG is written **only when the data dir already exists**: creating it here would land
  0755 instead of the app's own 0700, and there is nothing running to stop before the first
  install anyway.
- `npm ci --ignore-scripts` — `ci` installs exactly what the lockfile pins, `--ignore-scripts`
  blocks dependency lifecycle hooks. Electron's binary download is then invoked explicitly:
  Electron 43 dropped the postinstall hook, so `npm install` alone leaves
  `node_modules/electron/dist` missing and the app silently won't start.
- the Electron-version nag is **advisory only**: no network, no registry, or a timeout must never
  fail an install (hence `timeout 15` and `|| true`).
- uninstall asks before touching clip history — it's the only thing here that re-running the
  script cannot bring back. Non-interactive (`curl | bash`) keeps the data; `--purge` deletes it.
  The uninstall in the launcher kills the running instance **before** removing files: its own
  shutdown writes `history.json`, which would land right back into a purged data dir.
- `SANDBOX_FLAG` is matched against an exact word list (`1|true|yes|on`, any case). A plain `-n`
  test would treat `NO_SANDBOX=0` and `NO_SANDBOX=false` as "disable" — the two spellings a
  person reaches for to say the opposite of what happens. It is also deliberately **unquoted** in
  the exec line: empty must vanish, not become an empty argv entry.
- the launcher execs `node_modules/electron/dist/electron`, the native binary. The
  `.bin/electron` shim is a `cli.js` with `#!/usr/bin/env node`, which fails from the GNOME
  menu/boot because a version-manager node (nvm) isn't on the session PATH — that is why the
  terminal worked but the icon didn't.
- terminal launch re-execs itself under `setsid` so the shell returns immediately and closing it
  doesn't kill the app.
- **autostart repair**: older installs wrote an Exec that invoked electron directly with a
  hardcoded `--no-sandbox`, so login was the one path that started unsandboxed AND skipped the
  launcher's log. It only ever got rewritten by toggling autostart in the tray, so it survived
  every reinstall. The repair rewrites Exec and keeps the user's enabled/disabled choice. It
  accepts **both** spellings — the tray writes the quoted form
  (`Exec="…/visual-clipboard" --hidden`), this script the bare one — or every install would
  "fix" a healthy entry.
- the script launches the app at the end because GNOME Shell caches the app list: the menu icon
  often doesn't show up until the next login, and a fresh install otherwise looks like nothing
  happened.

---

## 16. Tests (`test/`)

Plain `node:assert`, no framework, no Electron. `src/procs.js` pulls only `node:fs`,
`node:path`, `node:child_process`; `src/validate.js` only `node:path` + `src/constants.js` — so
both run under bare `node`.

- **`test/procs.test.js`** covers the pid set the `Reiniciar` button SIGKILLs. Getting this wrong
  kills a process that is not ours, so every rule gets a case against a fake `/proc`: match on the
  app path and never the name, skip our own subtree, follow a stray's children but not what it
  *opened*, reject a sibling `app-old/`, reject a process that merely names the path in an
  argument, survive a `comm` containing `") "`, ignore non-numeric `/proc` entries, refuse an
  empty/relative/root appPath. Second half spawns real `sleep` victims to prove the detached
  deadline fires without the process doing anything, and that a bogus start time (recycled pid)
  spares it.
- **`test/security.test.js`** covers `src/validate.js`: accelerator modifiers, config clamping,
  store sanitisation including `../` traversal in ids and `imageFile`, `riskyToOpen` on
  extensions/exec bit/shebang/desktop entries (including the trailing-space `%20` case), and
  ignore-pattern matching.

Run: `npm test`.

---

## 17. Conventions

- code, comments, commits, identifiers: **English**. User-facing strings (tray labels, dialogs,
  log lines the user reads, install prompts): **pt-BR**.
- log prefix is `[clp]`; `src/log.js` adds timestamp, level and pid.
- source files carry **one-line docblocks only**. Anything longer belongs in this file.
- `ponytail:` comments mark a deliberate shortcut with a known ceiling; they stay in the source.
