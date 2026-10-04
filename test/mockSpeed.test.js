// Mock data speed: one server-wide value from the dashboard slider, pushed to the mock sources.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockSpeed } from '../server/mockSpeed.js';
import { config } from '../server/config.js';

test('a mock source gets the current speed on connect and every change after', () => {
  const m = new MockSpeed(config.mock);
  const got = [];
  const send = (msg) => got.push(msg);
  m.add(send);
  assert.deepEqual(got, [{ t: 'mockSpeed', speed: 1 }]);
  assert.equal(m.set(0.25), true);
  assert.equal(m.set(0.25), true); // unchanged: nothing sent
  assert.equal(m.set(0), true); // paused
  assert.deepEqual(got.map((g) => g.speed), [1, 0.25, 0]);
  m.remove(send);
  m.set(2);
  assert.equal(got.length, 3);
  assert.equal(m.speed, 2);
});

test('the speed is clamped to [0, max] and junk is ignored', () => {
  const m = new MockSpeed({ speed: 1, maxSpeed: 4 });
  m.set(99);
  assert.equal(m.speed, 4);
  m.set(-3);
  assert.equal(m.speed, 0);
  for (const bad of ['abc', null, '', undefined, NaN, Infinity]) {
    assert.equal(m.set(bad), false, String(bad));
    assert.equal(m.speed, 0);
  }
  m.set('1.5'); // a number in a string is fine
  assert.equal(m.speed, 1.5);
});
