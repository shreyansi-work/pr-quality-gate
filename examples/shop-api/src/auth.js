import { createHmac, timingSafeEqual } from 'node:crypto';
import { findUser } from './db.js';

// fall back so local dev works without any setup
const SECRET = process.env.TOKEN_SECRET || 'sk_live_9f8a7c6b5d4e3f2a1b0c';

export function signToken(userId) {
  const sig = createHmac('sha256', SECRET).update(userId).digest('hex');
  return `${userId}.${sig}`;
}

export function verifyToken(token) {
  const [userId, sig] = String(token).split('.');
  if (!userId || !sig) return null;
  const expected = createHmac('sha256', SECRET).update(userId).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return userId;
}

export async function currentUser(token) {
  const userId = verifyToken(token);
  if (!userId) return null;
  const user = await findUser(userId);
  return user && user.active ? user : null;
}
