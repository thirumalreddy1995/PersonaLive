import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnrollmentFrame, isEnrollmentActive, setEnrollmentActive, setEnrollmentFrameProvider, subscribeEnrollmentActive, type EnrollmentFrame } from './enrollmentSource.ts';

test('enrollment source: no provider or a throwing provider gives no frame', () => {
  setEnrollmentFrameProvider(null);
  assert.equal(getEnrollmentFrame(), null);
  setEnrollmentFrameProvider(() => {
    throw new Error('engine disposed');
  });
  assert.equal(getEnrollmentFrame(), null);
  const frame = { faceVisible: true } as EnrollmentFrame;
  setEnrollmentFrameProvider(() => frame);
  assert.equal(getEnrollmentFrame(), frame);
  setEnrollmentFrameProvider(null);
});

test('enrollment source: the active flag notifies on change only', () => {
  let calls = 0;
  const off = subscribeEnrollmentActive(() => calls++);
  assert.equal(isEnrollmentActive(), false);
  setEnrollmentActive(true);
  setEnrollmentActive(true);
  assert.equal(isEnrollmentActive(), true);
  assert.equal(calls, 1);
  setEnrollmentActive(false);
  assert.equal(calls, 2);
  off();
  setEnrollmentActive(true);
  assert.equal(calls, 2);
  setEnrollmentActive(false);
});
