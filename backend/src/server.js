import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, statfs, readdir, lstat, rm, createReadStream } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify as pify } from "node:util";

const scrypt = promisify(scryptCb);
const execFileAsync = pify(execFile);
const app = Fastify({ logger: { level: process.env.NODE_ENV === "production" ? "warn" : "info" }, bodyLimit: 100 * 1024 * 1024 });
const PORT = Number(process.env.HOMECloud_PORT || 6944);
const HOST = process.env.HOMECloud_HOST || "127.0.0.1";
const DATA = process.env.HOMECloud_DATA_DIR || path.resolve("data");
const USERS_FILE = path.join(DATA, "users.json");
const FILES_ROOT = path.join(DATA, "files");
await mkdir(FILES_ROOT, { recursive: true, mode: 0o700 });
app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: 100 * 1024 * 1024 }, (request, body, done) => done(null, body));
const COOKIE = "homecloud_session";
const sessions = new Map();
const allowedServices = (process.env.HOMECloud_SERVICES || "ssh.service,cron.service").split(",").map(x => x.trim()).filter(x => /^[a-zA-Z0-9_.@-]+\.service$/.test(x));

await mkdir(DATA, { recursive: true, mode: 0o700 });
await app.register(cookie, { secret: randomBytes(32).toString("hex"), hook: "onRequest" });

async function users() {
  try { return JSON.parse(await readFile(USERS_FILE, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
}
async function saveUsers(value) {
  const temp = USERS_FILE + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  const { rename } = await import("node:fs/promises");
  await rename(temp, USERS_FILE);
}
async function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const derived = await scrypt(password, salt, 64);
  return { salt, hash: derived.toString("hex") };
}
async function verifyPassword(password, user) {
  const derived = await scrypt(password, user.salt, 64);
  const expected = Buffer.from(user.hash, "hex");
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}
function issueSession(reply, username) {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, { username, expires: Date.now() + 12 * 60 * 60 * 1000 });
  reply.setCookie(COOKIE, token, { path: "/", httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production" && process.env.HOMECloud_SECURE_COOKIE === "1", maxAge: 43200 });
}
async function requireAuth(request, reply) {
  const token = request.cookies[COOKIE];
  const session = token && sessions.get(token);
  if (!session || session.expires < Date.now()) {
    if (token) sessions.delete(token);
    return reply.code(401).send({ error: "Authentication required" });
  }
  request.user = { username: session.username };
}
const loginAttempts = new Map();
function rateLimitLogin(ip) {
  const now = Date.now();
  const item = loginAttempts.get(ip) || { count: 0, until: now + 60000 };
  if (now > item.until) { item.count = 0; item.until = now + 60000; }
  item.count++;
  loginAttempts.set(ip, item);
  return item.count <= 8;
}

function safeFilePath(relative = "") {
  if (typeof relative !== "string" || relative.includes("\\0")) throw new Error("Invalid path");
  const target = path.resolve(FILES_ROOT, relative.replace(/^\\/+/, ""));
  if (target !== FILES_ROOT && !target.startsWith(FILES_ROOT + path.sep)) throw new Error("Invalid path");
  return target;
}
function relativeFilePath(value = "") {
  return String(value).replace(/\\\\/g, "/").split("/").filter(Boolean).join("/");
}
app.get("/api/files", { preHandler: requireAuth }, async (request, reply) => {
  let dir;
  try { dir = safeFilePath(relativeFilePath(request.query.path || "")); }
  catch { return reply.code(400).send({ error: "Invalid path" }); }
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries.map(async entry => {
      const full = path.join(dir, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) return null;
      return { name: entry.name, type: entry.isDirectory() ? "folder" : "file", size: info.isFile() ? info.size : 0, modified: info.mtime.toISOString() };
    }));
    return { path: relativeFilePath(request.query.path || ""), files: files.filter(Boolean).sort((a,b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1) };
  } catch (error) { if (error.code === "ENOENT") return reply.code(404).send({ error: "Folder not found" }); throw error; }
});
app.post("/api/files/folder", { preHandler: requireAuth }, async (request, reply) => {
  const { path: parent = "", name } = request.body || {};
  if (typeof name !== "string" || !name.trim() || name.length > 120 || /[\\\\/\\0]/.test(name) || name === "." || name === "..") return reply.code(400).send({ error: "Invalid folder name" });
  try { await mkdir(safeFilePath(path.join(relativeFilePath(parent), name.trim())), { recursive: false, mode: 0o700 }); return { ok: true }; }
  catch (error) { if (error.code === "EEXIST") return reply.code(409).send({ error: "An item with this name already exists" }); if (error.code === "ENOENT") return reply.code(404).send({ error: "Parent folder not found" }); throw error; }
});
app.post("/api/files/upload", { preHandler: requireAuth }, async (request, reply) => {
  const parent = relativeFilePath(request.query.path || "");
  const name = String(request.query.name || "");
  if (!name || name.length > 180 || /[\\\\/\\0]/.test(name) || name === "." || name === "..") return reply.code(400).send({ error: "Invalid file name" });
  const dir = safeFilePath(parent);
  const target = safeFilePath(path.join(parent, name));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    const handle = await import("node:fs/promises");
    await handle.writeFile(target, request.body, { flag: "wx", mode: 0o600 });
    return { ok: true, name, size: request.body.length };
  } catch (error) { if (error.code === "EEXIST") return reply.code(409).send({ error: "A file with this name already exists" }); throw error; }
});
app.get("/api/files/download", { preHandler: requireAuth }, async (request, reply) => {
  let target;
  try { target = safeFilePath(relativeFilePath(request.query.path || "")); }
  catch { return reply.code(400).send({ error: "Invalid path" }); }
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) return reply.code(404).send({ error: "File not found" });
    reply.header("Content-Type", "application/octet-stream");
    reply.header("Content-Length", info.size);
    reply.header("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(path.basename(target)));
    return reply.send(createReadStream(target));
  } catch (error) { if (error.code === "ENOENT") return reply.code(404).send({ error: "File not found" }); throw error; }
});
app.delete("/api/files", { preHandler: requireAuth }, async (request, reply) => {
  let target;
  try { target = safeFilePath(relativeFilePath(request.query.path || "")); }
  catch { return reply.code(400).send({ error: "Invalid path" }); }
  if (target === FILES_ROOT) return reply.code(403).send({ error: "Cannot delete storage root" });
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) return reply.code(403).send({ error: "Symbolic links are not allowed" });
    await rm(target, { recursive: info.isDirectory(), force: false });
    return { ok: true };
  } catch (error) { if (error.code === "ENOENT") return reply.code(404).send({ error: "Item not found" }); throw error; }
});

app.get("/api/health", async () => ({ status: "ok", name: "HomeCloud", version: "0.1.0" }));
app.get("/api/auth/status", async () => ({ setupRequired: (await users()).length === 0 }));
app.post("/api/auth/setup", async (request, reply) => {
  const existing = await users();
  if (existing.length) return reply.code(409).send({ error: "Administrator already configured" });
  const { username, password } = request.body || {};
  if (typeof username !== "string" || !/^[a-zA-Z0-9_-]{3,32}$/.test(username)) return reply.code(400).send({ error: "Username: 3-32 letters, numbers, _ or -" });
  if (typeof password !== "string" || password.length < 12 || password.length > 128) return reply.code(400).send({ error: "Password must contain 12 to 128 characters" });
  const credentials = await hashPassword(password);
  await saveUsers([{ username, ...credentials, role: "admin", createdAt: new Date().toISOString() }]);
  issueSession(reply, username);
  return { ok: true, username };
});
app.post("/api/auth/login", async (request, reply) => {
  if (!rateLimitLogin(request.ip)) return reply.code(429).send({ error: "Too many attempts. Try again in one minute." });
  const { username, password } = request.body || {};
  if (typeof username !== "string" || typeof password !== "string") return reply.code(400).send({ error: "Invalid credentials" });
  const user = (await users()).find(x => x.username === username);
  if (!user || !(await verifyPassword(password, user))) return reply.code(401).send({ error: "Invalid username or password" });
  issueSession(reply, username);
  return { ok: true, username };
});
app.post("/api/auth/logout", { preHandler: requireAuth }, async (request, reply) => {
  sessions.delete(request.cookies[COOKIE]);
  reply.clearCookie(COOKIE, { path: "/" });
  return { ok: true };
});
app.get("/api/auth/me", { preHandler: requireAuth }, async request => ({ username: request.user.username, role: "admin" }));

app.get("/api/metrics", { preHandler: requireAuth }, async () => {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const load = os.loadavg();
  let disk = null;
  try {
    const d = await statfs("/");
    disk = { total: d.blocks * d.bsize, free: d.bavail * d.bsize, used: (d.blocks - d.bavail) * d.bsize };
  } catch {}
  let temperature = null;
  for (const p of ["/sys/class/thermal/thermal_zone0/temp", "/sys/devices/virtual/thermal/thermal_zone0/temp"]) {
    try { temperature = Number((await readFile(p, "utf8")).trim()) / 1000; if (Number.isFinite(temperature)) break; } catch {}
  }
  return {
    hostname: os.hostname(), platform: os.platform(), arch: os.arch(), uptime: os.uptime(),
    cpu: { model: cpus[0]?.model || "Unknown", cores: cpus.length, load1: load[0], usageEstimate: Math.min(100, load[0] / Math.max(1, cpus.length) * 100) },
    memory: { total: totalMem, free: freeMem, used: totalMem - freeMem, percent: (totalMem - freeMem) / totalMem * 100 },
    disk, temperature, timestamp: new Date().toISOString()
  };
});
app.get("/api/services", { preHandler: requireAuth }, async () => {
  const results = await Promise.all(allowedServices.map(async name => {
    try {
      const { stdout } = await execFileAsync("/usr/bin/systemctl", ["is-active", name], { timeout: 2500 });
      return { name, status: stdout.trim() };
    } catch (e) { return { name, status: String(e.stdout || "inactive").trim() || "inactive" }; }
  }));
  return { services: results };
});

if (process.env.NODE_ENV === "production") {
  await app.register(fastifyStatic, { root: path.resolve("dist"), prefix: "/" });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
}
app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  reply.code(error.statusCode && error.statusCode < 500 ? error.statusCode : 500).send({ error: error.statusCode && error.statusCode < 500 ? error.message : "Internal server error" });
});
await app.listen({ port: PORT, host: HOST });
