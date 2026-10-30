import http from "node:http";
import { randomBytes, scrypt as sc, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, rename, readdir, lstat, rm, statfs } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";

const scrypt = promisify(sc);
const DATA = path.resolve(process.env.HOMECloud_DATA_DIR || "./data");
const LEGACY_FILES = path.join(DATA, "files");
const USERS = path.join(DATA, "users.json");
const USER_DATA = path.join(DATA, "users");
const PUB = path.resolve("public");
const sessions = new Map();
const PORT = +(process.env.HOMECloud_PORT || 6944);
const HOST = process.env.HOMECloud_HOST || "0.0.0.0";
const imageExt = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".heic", ".heif", ".bmp", ".tif", ".tiff"]);
const videoExt = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".3gp"]);
const mime = { ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".png":"image/png", ".gif":"image/gif", ".webp":"image/webp", ".avif":"image/avif", ".heic":"image/heic", ".heif":"image/heif", ".bmp":"image/bmp", ".tif":"image/tiff", ".tiff":"image/tiff", ".mp4":"video/mp4", ".mov":"video/quicktime", ".m4v":"video/mp4", ".webm":"video/webm", ".mkv":"video/x-matroska", ".avi":"video/x-msvideo", ".pdf":"application/pdf" };
await mkdir(LEGACY_FILES, { recursive: true, mode: 0o700 });
const userHome = username => path.join(USER_DATA, username);
const userFiles = username => path.join(userHome(username), "files");
const userAlbums = username => path.join(userHome(username), "albums.json");
const userFavorites = username => path.join(userHome(username), "favorites.json");
async function migrateLegacyFiles() {
  const accounts = await users();
  if (!accounts.length) return;
  const owner = accounts.find(account => account.role === "admin") || accounts[0];
  const destination = userFiles(owner.username);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const name of await readdir(LEGACY_FILES)) {
    const from = path.join(LEGACY_FILES, name), to = path.join(destination, name);
    try { await lstat(to); } catch (error) {
      if (error.code === "ENOENT") await rename(from, to);
      else throw error;
    }
  }
  for (const name of ["albums.json", "favorites.json"]) {
    const from = path.join(DATA, name), to = path.join(userHome(owner.username), name);
    try { await lstat(from); try { await lstat(to); } catch (error) { if (error.code === "ENOENT") await rename(from, to); else throw error; } }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await mkdir(USER_DATA, { recursive: true, mode: 0o700 });
}
await migrateLegacyFiles();

const send = (res, status, data, headers = {}) => {
  const bytes = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { "Content-Type":"application/json; charset=utf-8", "Content-Length":bytes.length, "X-Content-Type-Options":"nosniff", ...headers });
  res.end(bytes);
};
const cookies = req => Object.fromEntries((req.headers.cookie || "").split(";").map(x => x.trim().split("=")).filter(x => x.length === 2));
async function readJson(file, fallback) { try { return JSON.parse(await readFile(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return fallback; throw e; } }
async function saveJson(file, value) { const tmp = file + "." + randomBytes(5).toString("hex") + ".tmp"; await writeFile(tmp, JSON.stringify(value, null, 2), { mode:0o600 }); await rename(tmp, file); }
async function users() { return readJson(USERS, []); }
async function body(req, max = 1_000_000) { const chunks=[]; let length=0; for await (const chunk of req) { length += chunk.length; if (length > max) throw Object.assign(Error("Request too large"), { status:413 }); chunks.push(chunk); } try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw Object.assign(Error("Invalid JSON"), { status:400 }); } }
function auth(req) { const token=cookies(req).homecloud_session; const session=token && sessions.get(token); if (!session || session.exp < Date.now()) return null; return session.name; }
function safe(value = "", root = LEGACY_FILES) { if (typeof value !== "string" || value.includes("\0")) throw Error("Invalid path"); const parts=value.replaceAll("\\","/").split("/").filter(Boolean); if (parts.some(x => x === "." || x === "..")) throw Error("Invalid path"); const base=path.resolve(root), target=path.resolve(base,...parts); if (target !== base && !target.startsWith(base + path.sep)) throw Error("Invalid path"); return target; }
function relative(value = "") { return String(value).replaceAll("\\","/").split("/").filter(Boolean).join("/"); }
function sessionCookie(token, secure) { return "homecloud_session=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200" + (secure ? "; Secure" : ""); }
async function walk(dir, prefix = "") { const out=[]; for (const item of await readdir(dir,{withFileTypes:true})) { const rel=prefix ? prefix+"/"+item.name : item.name; const full=path.join(dir,item.name); const info=await lstat(full); if (info.isSymbolicLink()) continue; if (info.isDirectory()) out.push(...await walk(full,rel)); else if (info.isFile()) out.push({ name:item.name, path:rel, size:info.size, modified:info.mtime.toISOString(), ext:path.extname(item.name).toLowerCase() }); } return out; }
async function staticFile(req,res,url) { let pathname; try { pathname=decodeURIComponent(url.pathname); } catch { return send(res,400,{error:"Invalid URL"}); } if (pathname === "/") pathname="/index.html"; const file=path.resolve(PUB,"."+pathname); if (!file.startsWith(PUB+path.sep)) return send(res,403,{error:"Forbidden"}); try { const info=await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw Error(); const ext=path.extname(file); const types={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".svg":"image/svg+xml",".ico":"image/x-icon"}; res.writeHead(200,{"Content-Type":types[ext]||"application/octet-stream","Content-Length":info.size,"X-Content-Type-Options":"nosniff"}); createReadStream(file).pipe(res); } catch { send(res,404,{error:"Not found"}); } }

const server = http.createServer(async (req,res) => {
  try {
    const url=new URL(req.url,"http://localhost"), route=url.pathname;
    if (route === "/api/health") return send(res,200,{status:"ok",version:"2.0.0"});
    if (route === "/api/auth/status") return send(res,200,{setupRequired:!(await users()).length});
    if (route === "/api/auth/setup" && req.method === "POST") {
      const existing=await users(), data=await body(req);
      if (existing.length) return send(res,409,{error:"Administrator already configured"});
      if (!/^[\\w-]{3,32}$/.test(data.username||"") || typeof data.password!=="string" || data.password.length<12 || data.password.length>128) return send(res,400,{error:"Username must be 3-32 characters and password at least 12"});
      const salt=randomBytes(16).toString("hex"), hash=(await scrypt(data.password,salt,64)).toString("hex");
      await saveJson(USERS,[{username:data.username,salt,hash,role:"admin",createdAt:new Date().toISOString()}]);
      await mkdir(userFiles(data.username),{recursive:true,mode:0o700});
      const token=randomBytes(32).toString("hex"); sessions.set(token,{name:data.username,exp:Date.now()+43200000});
      return send(res,200,{ok:true,username:data.username,role:"admin"},{"Set-Cookie":sessionCookie(token,process.env.HOMECloud_SECURE_COOKIE==="1")});
    }
    if (route === "/api/auth/login" && req.method === "POST") {
      const data=await body(req), account=(await users()).find(x=>x.username===data.username);
      if (!account || typeof data.password!=="string") return send(res,401,{error:"Invalid credentials"});
      const actual=Buffer.from((await scrypt(data.password,account.salt,64)).toString("hex")), expected=Buffer.from(account.hash);
      if (actual.length!==expected.length || !timingSafeEqual(actual,expected)) return send(res,401,{error:"Invalid credentials"});
      const token=randomBytes(32).toString("hex"); sessions.set(token,{name:account.username,exp:Date.now()+43200000});
      return send(res,200,{ok:true,username:account.username,role:account.role||"user"},{"Set-Cookie":sessionCookie(token,process.env.HOMECloud_SECURE_COOKIE==="1")});
    }
    if (route.startsWith("/api/")) {
      const username=auth(req); if (!username) return send(res,401,{error:"Authentication required"});
      if (route === "/api/auth/me") { const account=(await users()).find(x=>x.username===username); return send(res,200,{username,role:account?.role||"user"}); }
      if (route === "/api/admin/users" && req.method === "GET") {
        const account=(await users()).find(x=>x.username===username);
        if (account?.role!=="admin") return send(res,403,{error:"Administrator access required"});
        return send(res,200,{users:(await users()).map(({username,role,createdAt})=>({username,role:role||"user",createdAt}))});
      }
      if (route === "/api/admin/users" && req.method === "POST") {
        const accounts=await users(), admin=accounts.find(x=>x.username===username);
        if (admin?.role!=="admin") return send(res,403,{error:"Administrator access required"});
        const data=await body(req), newName=String(data.username||"").trim().toLowerCase();
        if (!/^[a-z0-9_-]{3,32}$/.test(newName) || typeof data.password!=="string" || data.password.length<12 || data.password.length>128) return send(res,400,{error:"Use a username of 3-32 letters/numbers and a password of 12-128 characters"});
        if (accounts.some(x=>x.username.toLowerCase()===newName)) return send(res,409,{error:"This username already exists"});
        if (accounts.length>=100) return send(res,403,{error:"Maximum of 100 accounts reached"});
        const salt=randomBytes(16).toString("hex"), hash=(await scrypt(data.password,salt,64)).toString("hex");
        accounts.push({username:newName,salt,hash,role:"user",createdAt:new Date().toISOString()});
        await saveJson(USERS,accounts); await mkdir(userFiles(newName),{recursive:true,mode:0o700});
        return send(res,201,{ok:true,username:newName,role:"user"});
      }
      if (route === "/api/auth/logout" && req.method === "POST") { sessions.delete(cookies(req).homecloud_session); return send(res,200,{ok:true},{"Set-Cookie":"homecloud_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"}); }
      if (route === "/api/files" && req.method === "GET") {
        const dir=safe(relative(url.searchParams.get("path")||""),userFiles(username)), entries=await readdir(dir,{withFileTypes:true}), files=[];
        for (const entry of entries) { const info=await lstat(path.join(dir,entry.name)); if (!info.isSymbolicLink()) files.push({name:entry.name,type:info.isDirectory()?"folder":"file",size:info.size,modified:info.mtime.toISOString()}); }
        files.sort((a,b)=>a.type===b.type?a.name.localeCompare(b.name):a.type==="folder"?-1:1); return send(res,200,{files});
      }
      if (route === "/api/photos" && req.method === "GET") {
        const all=await walk(userFiles(username)), photos=all.filter(f=>imageExt.has(f.ext)||videoExt.has(f.ext)).sort((a,b)=>b.modified.localeCompare(a.modified));
        return send(res,200,{photos});
      }
      if (route === "/api/files/preview" && req.method === "GET") {
        const file=safe(relative(url.searchParams.get("path")||""),userFiles(username)), info=await lstat(file);
        if (!info.isFile() || info.isSymbolicLink()) return send(res,404,{error:"Not found"});
        const type=mime[path.extname(file).toLowerCase()]||"application/octet-stream";
        res.writeHead(200,{"Content-Type":type,"Content-Length":info.size,"Content-Disposition":"inline; filename*=UTF-8''"+encodeURIComponent(path.basename(file)),"X-Content-Type-Options":"nosniff","Cache-Control":"private, max-age=300"});
        return createReadStream(file).pipe(res);
      }
      if (route === "/api/albums" && req.method === "GET") return send(res,200,{albums:await readJson(userAlbums(username),[])});
      if (route === "/api/albums" && req.method === "POST") {
        const data=await body(req), name=String(data.name||"").trim();
        if (!name || name.length>80) return send(res,400,{error:"Album name must contain 1-80 characters"});
        const albums=await readJson(userAlbums(username),[]);
        if (albums.some(a=>a.name.toLowerCase()===name.toLowerCase())) return send(res,409,{error:"Album already exists"});
        const album={id:randomBytes(8).toString("hex"),name,paths:Array.isArray(data.paths)?data.paths.filter(p=>typeof p==="string"&&p.length<1024):[],createdAt:new Date().toISOString()};
        await saveJson(userAlbums(username),[album,...albums]); return send(res,201,{album});
      }
      if (route.startsWith("/api/albums/") && req.method === "DELETE") {
        const id=route.split("/").pop(), albums=await readJson(userAlbums(username),[]), next=albums.filter(a=>a.id!==id);
        if (next.length===albums.length) return send(res,404,{error:"Album not found"});
        await saveJson(userAlbums(username),next); return send(res,200,{ok:true});
      }
      if (route === "/api/favorites" && req.method === "GET") return send(res,200,{paths:await readJson(userFavorites(username),[])});
      if (route === "/api/favorites" && req.method === "POST") {
        const data=await body(req); if (typeof data.path!=="string" || data.path.length>1024) return send(res,400,{error:"Invalid path"});
        const favorites=await readJson(userFavorites(username),[]), next=favorites.includes(data.path)?favorites.filter(p=>p!==data.path):[...favorites,data.path];
        await saveJson(userFavorites(username),next); return send(res,200,{paths:next});
      }
      if (route === "/api/files/folder" && req.method === "POST") {
        const data=await body(req), name=String(data.name||"").trim();
        if (!name || name.length>120 || /[\\/\0]/.test(name) || name==="." || name==="..") return send(res,400,{error:"Invalid folder name"});
        await mkdir(safe(path.join(relative(data.path||""),name),userFiles(username))); return send(res,200,{ok:true});
      }
      if (route === "/api/files/upload" && req.method === "POST") {
        const name=url.searchParams.get("name")||"", parent=relative(url.searchParams.get("path")||"");
        if (!name || name.length>180 || /[\\/\0]/.test(name) || name==="." || name==="..") return send(res,400,{error:"Invalid file name"});
        const directory=safe(parent,userFiles(username)); await mkdir(directory,{recursive:true});
        const destination=safe(path.join(parent,name),userFiles(username)), temp=destination+"."+randomBytes(5).toString("hex")+".tmp"; let size=0;
        const {Transform}=await import("node:stream");
        const counter=new Transform({transform(chunk,encoding,callback){size+=chunk.length;callback(size>100*1024*1024?Object.assign(Error("Maximum upload size is 100 MB"),{status:413}):null,chunk);}});
        try { await pipeline(req,counter,createWriteStream(temp,{flags:"wx",mode:0o600})); await rename(temp,destination); }
        catch(error) { await rm(temp,{force:true}); throw error; }
        return send(res,200,{ok:true,size});
      }
      if (route === "/api/files/download") {
        const file=safe(relative(url.searchParams.get("path")||""),userFiles(username)), info=await lstat(file);
        if (!info.isFile() || info.isSymbolicLink()) return send(res,404,{error:"Not found"});
        res.writeHead(200,{"Content-Type":"application/octet-stream","Content-Length":info.size,"Content-Disposition":"attachment; filename*=UTF-8''"+encodeURIComponent(path.basename(file))}); return createReadStream(file).pipe(res);
      }
      if (route === "/api/files" && req.method === "DELETE") {
        const file=safe(relative(url.searchParams.get("path")||""),userFiles(username)); if (file===userFiles(username)) return send(res,403,{error:"Cannot delete root"});
        const info=await lstat(file); if (info.isSymbolicLink()) return send(res,403,{error:"Symlinks forbidden"});
        await rm(file,{recursive:info.isDirectory()}); return send(res,200,{ok:true});
      }
      if (route === "/api/metrics") {
        const account=(await users()).find(x=>x.username===username);
        if (account?.role!=="admin") return send(res,403,{error:"Administrator access required"});
        const cpus=os.cpus(), total=os.totalmem(), free=os.freemem(); let disk=null,temperature=null;
        try { const info=await statfs("/"); disk={total:info.blocks*info.bsize,used:(info.blocks-info.bavail)*info.bsize,free:info.bavail*info.bsize}; } catch {}
        try { temperature=+(await readFile("/sys/class/thermal/thermal_zone0/temp","utf8"))/1000; } catch {}
        return send(res,200,{hostname:os.hostname(),platform:os.platform(),arch:os.arch(),uptime:os.uptime(),cpu:{model:cpus[0]?.model,cores:cpus.length,load1:os.loadavg()[0],usageEstimate:Math.min(100,os.loadavg()[0]/cpus.length*100)},memory:{total,free,used:total-free,percent:(total-free)/total*100},disk,temperature});
      }
      if (route === "/api/services") return send(res,200,{services:[]});
      return send(res,404,{error:"Not found"});
    }
    return staticFile(req,res,url);
  } catch (error) { send(res,error.status||(error.code==="ENOENT"?404:error.code==="EEXIST"?409:500),{error:error.status?error.message:error.code==="ENOENT"?"Not found":error.code==="EEXIST"?"Already exists":"Internal server error"}); }
});
server.listen(PORT,HOST,()=>console.log("HomeCloud 2.0 on "+HOST+":"+PORT));
