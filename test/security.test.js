'use strict';

/** Covers src/validate.js: the guards between untrusted input and path.join/globalShortcut/openPath. */

const assert = require('node:assert');

const { MAX_IGNORE_PATTERNS, DEFAULT_CONFIG } = require('../src/constants');
const { hasModifier, normalizeConfig, sanitizeStore, riskyToOpen, matchesIgnore } = require('../src/validate');

const stat = ({ dir = false, file = true, mode = 0o644 }) => ({
  isDirectory: () => dir,
  isFile: () => file,
  mode,
});

assert.equal(hasModifier('V'), false, 'bare key has no modifier');
assert.equal(hasModifier('Control+Alt+V'), true);
assert.equal(hasModifier('CommandOrControl+Shift+V'), true);
assert.equal(hasModifier('Nope+V'), false, 'unknown modifier name is not a modifier');

{
  const c = normalizeConfig({ maxItems: 999999 }, DEFAULT_CONFIG);
  assert.equal(c.maxItems, 5000, 'maxItems clamped up');
}
{
  const c = normalizeConfig({ maxItems: 1 }, DEFAULT_CONFIG);
  assert.equal(c.maxItems, 10, 'maxItems clamped down');
}
{
  const c = normalizeConfig({ shortcut: 'V' }, DEFAULT_CONFIG);
  assert.equal(c.shortcut, DEFAULT_CONFIG.shortcut, 'modifier-less accelerator refused');
}
{
  const c = normalizeConfig({ shortcut: 'Control+Alt+B' }, DEFAULT_CONFIG);
  assert.equal(c.shortcut, 'Control+Alt+B', 'valid accelerator kept');
}
{
  const many = Array.from({ length: MAX_IGNORE_PATTERNS + 20 }, (_, i) => 'p' + i);
  const c = normalizeConfig({ ignorePatterns: many }, DEFAULT_CONFIG);
  assert.equal(c.ignorePatterns.length, MAX_IGNORE_PATTERNS, 'ignorePatterns capped');
}
{
  const c = normalizeConfig({ ignorePatterns: 'not-an-array', paused: 'yes' }, DEFAULT_CONFIG);
  assert.deepEqual(c.ignorePatterns, [], 'non-array ignorePatterns dropped');
  assert.equal(c.paused, true, 'paused coerced to boolean');
}

{
  const store = sanitizeStore({
    boards: [{ id: 'b_ok', name: 'B', color: '#32D74B' }, { id: '../evil', name: 'X' }],
    clips: [
      { id: 'good1', type: 'text', text: 'hi', boardIds: ['b_ok', 'b_gone'] },
      { id: '../../etc/passwd', type: 'text', text: 'traversal' },
      { id: 'img1', type: 'image', imageFile: 'images/img1.png' },
      { id: 'img2', type: 'image', imageFile: '../../../etc/shadow' },
      { id: 'img3', type: 'image' },
      { id: 'file1', type: 'file', files: ['/tmp/a'] },
      { id: 'file2', type: 'file', files: 'nope' },
    ],
  });

  assert.deepEqual(store.boards.map((b) => b.id), ['b_ok'], 'board id must match ID_RE');

  const ids = store.clips.map((c) => c.id);
  assert.ok(!ids.includes('../../etc/passwd'), 'clip id must match ID_RE');
  assert.deepEqual(ids, ['good1', 'img1', 'file1']);

  const good = store.clips.find((c) => c.id === 'good1');
  assert.deepEqual(good.boardIds, ['b_ok'], 'boardIds pointing at dropped boards are stripped');
  assert.equal(store.clips.find((c) => c.id === 'img1').imageFile, 'images/img1.png');
}
{
  const store = sanitizeStore({ boards: 'nope', clips: null });
  assert.deepEqual(store.boards, []);
  assert.deepEqual(store.clips, []);
  assert.equal(store.version, 1);
}
{
  const store = sanitizeStore({ boards: [], clips: [{ id: 'x1', type: 'wat', text: 42, createdAt: 'soon' }] });
  const c = store.clips[0];
  assert.equal(c.type, 'text', 'unknown type falls back to text');
  assert.equal(c.text, '', 'non-string text dropped');
  assert.equal(c.createdAt, 0, 'non-finite createdAt zeroed');
  assert.equal(c.pinned, false);
}

assert.equal(riskyToOpen('/tmp/notes.txt', stat({}), 'hello'), false, 'plain text file is fine');
assert.equal(riskyToOpen('/tmp/pics', stat({ dir: true, file: false }), ''), false, 'directory is fine');
assert.equal(riskyToOpen('/dev/sda', stat({ file: false }), ''), true, 'non-regular file is risky');
assert.equal(riskyToOpen('/tmp/notes.txt', stat({ mode: 0o755 }), 'hello'), true, 'executable bit is risky');
assert.equal(riskyToOpen('/tmp/notes.txt', stat({}), '#!/bin/sh\n'), true, 'shebang is risky');
assert.equal(riskyToOpen('/tmp/x', stat({}), '[Desktop Entry]\nExec=rm -rf'), true, 'desktop entry is risky');
assert.equal(riskyToOpen('/tmp/run.sh', stat({}), 'echo hi'), true, 'risky extension');
assert.equal(riskyToOpen('/tmp/evil.desktop ', stat({}), ''), true, 'extension trimmed before the check');
assert.equal(riskyToOpen('/tmp/EVIL.DESKTOP', stat({}), ''), true, 'extension lowercased before the check');

assert.equal(matchesIgnore('anything', []), false, 'no patterns, no match');
assert.equal(matchesIgnore('anything', undefined), false, 'missing patterns, no match');
assert.equal(matchesIgnore('My SECRET token', ['secret']), true, 'case-insensitive match');
assert.equal(matchesIgnore('nothing here', ['secret']), false);

console.log('ok — validate.js');
