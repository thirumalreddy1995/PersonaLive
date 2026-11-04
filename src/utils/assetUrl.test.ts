import test from 'node:test';
import assert from 'node:assert/strict';
import { publicAssetUrl, resolvePublicAssetUrl } from './assetUrl.ts';

test('resolvePublicAssetUrl keeps root-served paths unchanged', () => {
  assert.equal(resolvePublicAssetUrl('/assets/a.jpg', '/'), '/assets/a.jpg');
  assert.equal(resolvePublicAssetUrl('assets/a.jpg', '/'), '/assets/a.jpg');
});

test('resolvePublicAssetUrl prefixes a sub-path base such as GitHub Pages', () => {
  assert.equal(resolvePublicAssetUrl('/assets/a.jpg', '/PersonaLive/'), '/PersonaLive/assets/a.jpg');
  assert.equal(resolvePublicAssetUrl('assets/a.jpg', '/PersonaLive'), '/PersonaLive/assets/a.jpg');
  assert.equal(resolvePublicAssetUrl('//assets/a.jpg', '/PersonaLive/'), '/PersonaLive/assets/a.jpg');
});

test('resolvePublicAssetUrl works with absolute origins', () => {
  assert.equal(resolvePublicAssetUrl('icon.svg', 'https://example.com/app/'), 'https://example.com/app/icon.svg');
});

test('publicAssetUrl falls back to "/" when import.meta.env is unavailable (node test runtime)', () => {
  assert.equal(publicAssetUrl('/assets/a.jpg'), '/assets/a.jpg');
});
