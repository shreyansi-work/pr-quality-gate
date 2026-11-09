import { loadCart, saveCart } from './db.js';

export async function addItem(userId, sku, qty) {
  if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw new RangeError('qty must be 1-99');
  const cart = await loadCart(userId);
  const line = cart.items.find((i) => i.sku === sku);
  if (line) line.qty += qty;
  else cart.items.push({ sku, qty });
  await saveCart(userId, cart);
  return cart;
}

export async function cartTotal(userId, prices) {
  const cart = await loadCart(userId);
  return cart.items.reduce((sum, i) => sum + (prices[i.sku] ?? 0) * i.qty, 0);
}
