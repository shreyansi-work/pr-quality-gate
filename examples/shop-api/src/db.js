// In-memory stand-in for a database, async to mimic real I/O.
const users = new Map([['u1', { id: 'u1', email: 'ana@example.com', passwordHash: 'x1', active: true }]]);
const carts = new Map();

export async function findUser(id) {
  return users.get(id) ?? null;
}

export async function saveCart(userId, cart) {
  carts.set(userId, structuredClone(cart));
}

export async function loadCart(userId) {
  return carts.get(userId) ?? { items: [] };
}
