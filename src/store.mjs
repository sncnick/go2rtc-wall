import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {scrypt, randomBytes, timingSafeEqual, createHash} from 'node:crypto';
import {promisify} from 'node:util';
const derive = promisify(scrypt);
export const digest = s => createHash('sha256').update(s).digest('hex');
export const token = () => randomBytes(32).toString('hex');
export async function hashPassword(p, salt = token()) {
  const key = await derive(p, salt, 64, {N:32768,r:8,p:1,maxmem:64*1024*1024});
  return `${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(p, hash) {
  const actual = await hashPassword(p, hash.split(':')[0]);
  return timingSafeEqual(Buffer.from(actual), Buffer.from(hash));
}
export function openStore(path = process.env.DB_FILE || 'data/wall.sqlite') {
  mkdirSync(dirname(path), {recursive:true,mode:0o700});
  const db = new DatabaseSync(path); chmodSync(path,0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','viewer')));
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, name TEXT REFERENCES users(name) ON DELETE CASCADE, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS layouts (name TEXT PRIMARY KEY REFERENCES users(name) ON DELETE CASCADE, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS access_log (id INTEGER PRIMARY KEY, time TEXT NOT NULL, ip TEXT NOT NULL, peer TEXT NOT NULL, ip_source TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS access_time ON access_log(time);
    CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, time TEXT NOT NULL, actor TEXT NOT NULL, event TEXT NOT NULL);
  `);
  return db;
}
export function audit(db,actor,event) {
  db.prepare('INSERT INTO audit(time,actor,event) VALUES(?,?,?)').run(new Date().toISOString(),actor,event);
  db.prepare('DELETE FROM audit WHERE id <= (SELECT MAX(id)-10000 FROM audit)').run();
  console.log(JSON.stringify({time:new Date().toISOString(),actor,event}));
}
export async function setUser(db,name,password,role) {
  if (!/^[a-zA-Z0-9_-]{3,40}$/.test(name) || !['admin','viewer'].includes(role) || typeof password !== 'string' || password.length < 14 || password.length > 128) throw Error('Username: 3–40 letters/numbers/_/-. Password: 14–128 characters. Role: admin/viewer.');
  const hash = await hashPassword(password);
  db.prepare('INSERT INTO users VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET hash=excluded.hash,role=excluded.role').run(name,hash,role);
  db.prepare('DELETE FROM sessions WHERE name=?').run(name);
}
