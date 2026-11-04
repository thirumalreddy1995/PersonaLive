const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { resolveDistFile } = require('./resolveDistFile.cjs');

const ROOT = path.resolve(__dirname, 'fixture-dist');

test('maps the root and plain paths into the bundle directory', () => {
  assert.equal(resolveDistFile(ROOT, '/'), path.join(ROOT, 'index.html'));
  assert.equal(resolveDistFile(ROOT, ''), path.join(ROOT, 'index.html'));
  assert.equal(resolveDistFile(ROOT, '/assets/app.js'), path.join(ROOT, 'assets', 'app.js'));
  assert.equal(resolveDistFile(ROOT, '/mediapipe/wasm/vision.wasm'), path.join(ROOT, 'mediapipe', 'wasm', 'vision.wasm'));
});

test('rejects traversal out of the bundle directory', () => {
  assert.equal(resolveDistFile(ROOT, '/../package.json'), null);
  assert.equal(resolveDistFile(ROOT, '/assets/../../electron/main.cjs'), null);
  assert.equal(resolveDistFile(ROOT, '/..'), null);
});

test('rejects sibling directories that merely share the bundle prefix', () => {
  // A naive startsWith(rootDir) check would accept "<root>-old/secret".
  assert.equal(resolveDistFile(ROOT, '/../fixture-dist-old/secret.txt'), null);
});

test('leading separators are stripped so requests cannot become absolute', () => {
  assert.equal(resolveDistFile(ROOT, '//etc/passwd'), path.join(ROOT, 'etc', 'passwd'));
});

test('drive-qualified requests cannot escape on Windows', { skip: process.platform !== 'win32' }, () => {
  assert.equal(resolveDistFile(ROOT, '/C:/Windows/system32/drivers/etc/hosts'), null);
});

test('never resolves to the root directory itself', () => {
  assert.equal(resolveDistFile(ROOT, '/.'), null);
});
