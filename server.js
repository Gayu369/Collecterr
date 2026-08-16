const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8000);
const ROOT = __dirname;
const DB_FILE = path.join(ROOT, 'collectorrs-db.json');
const clients = new Set();

function defaultDb() {
  return { users: [], privateMessages: [], groups: [] };
}
function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (_) { const db = defaultDb(); saveDb(db); return db; }
}
function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
let db = loadDb();
function id(prefix) { return prefix + '-' + crypto.randomUUID(); }
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  res.end(body);
}
function sendText(res, status, text, contentType='text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(text);
}
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw=''; req.on('data', c => { raw += c; if (raw.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function publicUser(u) { return { name:u.name, email:u.email, profileImage:u.profileImage || '', paletteKey:u.paletteKey || 'sunrise' }; }
function notify(type, payload) {
  const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) {
    if (!c.userEmail) continue;
    if (payload.recipients && !payload.recipients.includes(c.userEmail)) continue;
    try { c.res.write(message); } catch (_) {}
  }
}
function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'}[ext] || 'application/octet-stream');
}
function safeStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = decoded === '/' ? '/index.html' : decoded;
  const full = path.normalize(path.join(ROOT, rel));
  return full.startsWith(ROOT) ? full : null;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'}); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/health') return sendJson(res, 200, { ok:true, time:Date.now() });

  if (url.pathname === '/api/events' && req.method === 'GET') {
    const userEmail = (url.searchParams.get('user') || '').trim().toLowerCase();
    res.writeHead(200, {'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','Access-Control-Allow-Origin':'*'});
    res.write(`event: ready\ndata: ${JSON.stringify({ok:true})}\n\n`);
    const client = { res, userEmail }; clients.add(client);
    const timer = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
    req.on('close', () => { clearInterval(timer); clients.delete(client); });
    return;
  }

  try {
    if (url.pathname === '/api/auth/register' && req.method === 'POST') {
      const b = await parseBody(req); const email = String(b.email||'').trim().toLowerCase();
      if (!email || !b.name || !b.password) return sendJson(res,400,{error:'Name, email and password are required.'});
      if (db.users.some(u => u.email === email)) return sendJson(res,409,{error:'Account already exists.'});
      const user = { id:id('user'), name:String(b.name).trim(), email, password:String(b.password), profileImage:String(b.profileImage||''), paletteKey:String(b.paletteKey||'sunrise'), createdAt:Date.now() };
      db.users.push(user); saveDb(db); return sendJson(res,201,{user:publicUser(user)});
    }
    if (url.pathname === '/api/auth/sync' && req.method === 'POST') {
      const b = await parseBody(req); const email = String(b.email||'').trim().toLowerCase();
      if (!email || !b.name) return sendJson(res,400,{error:'Name and email are required.'});
      let user = db.users.find(u => u.email === email);
      if (!user) { user={id:id('user'), name:String(b.name).trim(), email, password:String(b.password||''), profileImage:String(b.profileImage||''), paletteKey:String(b.paletteKey||'sunrise'), createdAt:Date.now()}; db.users.push(user); }
      else { user.name=String(b.name).trim(); if (b.password) user.password=String(b.password); user.profileImage=String(b.profileImage||user.profileImage||''); user.paletteKey=String(b.paletteKey||user.paletteKey||'sunrise'); }
      saveDb(db); return sendJson(res,200,{user:publicUser(user)});
    }
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const b = await parseBody(req); const email=String(b.email||'').trim().toLowerCase();
      const user=db.users.find(u=>u.email===email && u.password===String(b.password||''));
      if (!user) return sendJson(res,401,{error:'Invalid email or password.'});
      return sendJson(res,200,{user:publicUser(user)});
    }
    if (url.pathname === '/api/users' && req.method === 'GET') return sendJson(res,200,{users:db.users.map(publicUser)});

    if (url.pathname === '/api/private/messages' && req.method === 'GET') {
      const a=(url.searchParams.get('a')||'').toLowerCase(); const b=(url.searchParams.get('b')||'').toLowerCase();
      if (!a || !b) return sendJson(res,400,{error:'Two users are required.'});
      const messages=db.privateMessages.filter(m => (m.senderEmail===a && m.recipientEmail===b) || (m.senderEmail===b && m.recipientEmail===a));
      return sendJson(res,200,{messages});
    }
    if (url.pathname === '/api/private/messages' && req.method === 'POST') {
      const b=await parseBody(req); const sender=String(b.senderEmail||'').trim().toLowerCase(); const recipient=String(b.recipientEmail||'').trim().toLowerCase(); const text=String(b.text||'').trim();
      if (!sender || !recipient || !text) return sendJson(res,400,{error:'senderEmail, recipientEmail and text are required.'});
      const message={id:id('msg'),senderEmail:sender,recipientEmail:recipient,text,createdAt:Date.now()}; db.privateMessages.push(message); saveDb(db); notify('private-message',{message,recipients:[sender,recipient]}); return sendJson(res,201,{message});
    }

    if (url.pathname === '/api/groups' && req.method === 'GET') {
      const user=(url.searchParams.get('user')||'').toLowerCase();
      return sendJson(res,200,{groups:db.groups.filter(g=>g.participants.includes(user))});
    }
    if (url.pathname === '/api/groups' && req.method === 'POST') {
      const b=await parseBody(req); const participants=[...new Set((Array.isArray(b.participants)?b.participants:[]).map(x=>String(x).trim().toLowerCase()).filter(Boolean))];
      if (participants.length<2) return sendJson(res,400,{error:'At least two participants are required.'});
      const existingUsers=new Set(db.users.map(u=>u.email)); if (participants.some(p=>!existingUsers.has(p))) return sendJson(res,400,{error:'Every participant must have an account on this server.'});
      const group={id:id('group'),name:String(b.name||'Collectors group').trim(),participants,createdAt:Date.now(),updatedAt:Date.now(),messages:[],lastMessage:''}; db.groups.unshift(group); saveDb(db); notify('group-created',{group,recipients:participants}); return sendJson(res,201,{group});
    }
    const groupMessageMatch = url.pathname.match(/^\/api\/groups\/([^/]+)\/messages$/);
    if (groupMessageMatch && req.method === 'GET') {
      const g=db.groups.find(x=>x.id===groupMessageMatch[1]); if(!g) return sendJson(res,404,{error:'Group not found.'}); return sendJson(res,200,{messages:g.messages||[]});
    }
    if (groupMessageMatch && req.method === 'POST') {
      const g=db.groups.find(x=>x.id===groupMessageMatch[1]); if(!g) return sendJson(res,404,{error:'Group not found.'}); const b=await parseBody(req); const sender=String(b.senderEmail||'').trim().toLowerCase(); const text=String(b.text||'').trim(); if(!g.participants.includes(sender)) return sendJson(res,403,{error:'You are not a member of this group.'}); if(!text) return sendJson(res,400,{error:'Message text is required.'}); const message={id:id('msg'),senderEmail:sender,text,createdAt:Date.now()}; g.messages.push(message); g.updatedAt=Date.now(); g.lastMessage=text; saveDb(db); notify('group-message',{groupId:g.id,message,recipients:g.participants}); return sendJson(res,201,{message});
    }

    if (req.method === 'GET') {
      const file=safeStaticPath(url.pathname); if(!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return sendText(res,404,'Not found');
      return sendText(res,200,fs.readFileSync(file),contentType(file));
    }
    return sendJson(res,404,{error:'Not found'});
  } catch (e) { console.error(e); return sendJson(res,500,{error:'Server error',detail:e.message}); }
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Collectorrs server listening on http://0.0.0.0:${PORT}`));
