import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addItem, cartTotal } from '../src/cart.js';

test('adds and totals items', async () => {
  await addItem('u1', 'A', 2);
  await addItem('u1', 'A', 1);
  assert.equal(await cartTotal('u1', { A: 10 }), 30);
});

test('rejects bad quantity', async () => {
  await assert.rejects(() => addItem('u1', 'A', 0), RangeError);
});
