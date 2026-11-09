import { createHmac, timingSafeEqual } from 'node:crypto';
import { findUser } from './db.js';

const SECRET = process.env.TOKEN_SECRET;
if (!SECRET) throw new Error('TOKEN_SECRET is required');

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
