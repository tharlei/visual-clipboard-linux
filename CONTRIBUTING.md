# Contributing

Small, dependency-free Electron app — `main.js` is the whole backend, `renderer/` is the UI. No build step, no bundler.

## Local setup

```bash
git clone https://github.com/tharlei/visual-clipboard-linux.git
cd visual-clipboard-linux
npm install
npm start
```

## Before opening a PR

- No linter or test suite is configured yet — just run the app (`npm start`) and check the feature you touched still works, along with the golden-path flows (copy → card appears, search, click-to-paste).
- Keep diffs focused; avoid unrelated formatting changes.
- Commit messages loosely follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, ...).

## Issues

Bug reports and feature requests are welcome — use the templates when opening one. Include your distro/DE (this targets X11/GNOME) and steps to reproduce for bugs.
