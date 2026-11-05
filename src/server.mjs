import http from 'node:http';
import {sharing} from './shares.mjs';
import {accessLogger,trustedIPs} from './access.mjs';
import {mseGateway,flvStream} from './media.mjs';
import {rtspProxy} from './rtsp-proxy.mjs';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {openStore,verifyPassword,hashPassword,token,digest,audit} from './store.mjs';
import {cameras,validateCameras} from './config.mjs';
const root = fileURLToPath(new URL('../public/',import.meta.url));
const files = new Map([['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript']],['/style.css',['style.css','text/css']]].map(([url,[file,type]])=>[url,{body:readFileSync(root+file),type}]));
files.set('/vendor/mpegts.js',{body:readFileSync(fileURLToPath(new URL('../node_modules/mpegts.js/dist/mpegts.js',import.meta.url))),type:'text/javascript'});
const blocked=readFileSync(root+'blocked.html');
const blockedCSS=readFileSync(root+'blocked.css');
const fail = (status,message) => Object.assign(Error(message),{status});
export function validateLayout(value, ids) {
  if (!Array.isArray(value) || value.length>64) throw fail(400,'Invalid layout');
  const seen = new Set();
  for (const t of value) {
    if (!t || !['h,id,w,x,y','h,id,mode,w,x,y'].includes(Object.keys(t).sort().join(',')) || (t.mode!==undefined&&!['webrtc','mse','flv','rtsp'].includes(t.mode)) || !ids.has(t.id) || seen.has(t.id) || ![t.x,t.y,t.w,t.h].every(Number.isInteger) || t.x<0 || t.y<0 || t.w<2 || t.h<2 || t.w>12 || t.h>12 || t.x+t.w>12 || t.y+t.h>48) throw fail(400,'Invalid tile');
    seen.add(t.id);
  }
  return value;
}
async function body(req,limit=65536) {
  let data=''; let size=0;
  for await (const chunk of req) { size+=chunk.length; if(size>limit) throw fail(413,'Request too large'); data+=chunk; }
  return data;
}
export async function createApp({db=openStore(),list=cameras(),origin=process.env.APP_ORIGIN || 'http://localhost:8080',upstream=process.env.GO2RTC_URL || 'http://127.0.0.1:1984',secret=process.env.GO2RTC_PASSWORD || '',syncEngine=process.env.SYNC_ENGINE==='1',entrance=process.env.LOGIN_PATH,proxyIPs=process.env.TRUSTED_PROXY_IPS||'',rtspBase=process.env.RTSP_PUBLIC_BASE}={}) {
  if(!entrance){const stored=db.prepare("SELECT value FROM settings WHERE name='login_path'").get();entrance=stored?JSON.parse(stored.value):'/'+token().slice(0,40)+'/';if(!stored)db.prepare("INSERT INTO settings VALUES('login_path',?)").run(JSON.stringify(entrance));}
  if(!/^\/[a-zA-Z0-9_-]{24,80}\/$/.test(entrance))throw Error('LOGIN_PATH must be / followed by 24–80 URL-safe characters and a trailing /');
  const recordAccess=accessLogger(db,entrance,trustedIPs(proxyIPs));
  const publicURL=new URL(origin); const secure=publicURL.protocol==='https:';
  if(publicURL.origin!==origin || (!secure && !['localhost','127.0.0.1','[::1]'].includes(publicURL.hostname))) throw Error('APP_ORIGIN requires HTTPS outside localhost');
  const saved=db.prepare("SELECT value FROM settings WHERE name='cameras'").get();
  if(saved)list=validateCameras(JSON.parse(saved.value));
  else db.prepare("INSERT INTO settings VALUES('cameras',?)").run(JSON.stringify(list));
  const ids=new Set(list.map(c=>c.id)); const dummy=await hashPassword(token());
  const shares=sharing({db,ids,list,origin,upstream,secret,rtspBase});
  const attempts=new Map(); let activeLogins=0; let activeOffers=0;
  const cleanup=setInterval(()=>{const now=Date.now();for(const [key,v] of attempts) if(v.until<now)attempts.delete(key);db.prepare('DELETE FROM sessions WHERE expires<?').run(now);db.prepare('DELETE FROM access_log WHERE time<?').run(new Date(now-30*86400000).toISOString());},60000); cleanup.unref();
  const cookieName=secure?'__Host-wall':'wall';
  const cookie=(value,age)=>`${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure?'; Secure':''}`;
  function authenticate(req) {
    const raw=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1)||'';
    return /^[a-f0-9]{64}$/.test(raw)?db.prepare('SELECT s.*,u.role FROM sessions s JOIN users u ON u.name=s.name WHERE s.id=? AND s.expires>?').get(digest(raw),Date.now()):null;
  }
  const valid=session=>Boolean(db.prepare('SELECT id FROM sessions WHERE id=? AND expires>?').get(session.id,Date.now()));
  let activeFLV=0;
  function limit(key,max,window=600000) {
    const now=Date.now();if(attempts.size>=10000&&!attempts.has(key))throw fail(429,'Please try later');let v=attempts.get(key);if(!v||v.until<now){v={count:0,until:now+window};attempts.set(key,v);}
    if(++v.count>max)throw fail(429,'Too many attempts. Please try later.');
  }
  let syncing=false;
  async function syncSources() {
    if(!syncEngine||syncing)return false;syncing=true;
    try {
      const headers={Authorization:'Basic '+Buffer.from('gateway:'+secret).toString('base64')};
      const r=await fetch(new URL('/api/streams',upstream),{headers,redirect:'error',signal:AbortSignal.timeout(5000)});
      if(!r.ok)throw Error('Engine unavailable');const existing=await r.json();
      for(const c of list){if(Object.hasOwn(existing,c.id))continue;
        const url=new URL('/api/streams',upstream);url.searchParams.set('name',c.id);url.searchParams.set('src',c.url);
        const result=await fetch(url,{method:'PATCH',headers,redirect:'error',signal:AbortSignal.timeout(5000)});
        if(!result.ok)throw Error('Cannot apply source');
      }return true;
    }catch{return false;}finally{syncing=false;}
  }
  const reconcile=setInterval(()=>{void syncSources();},15000);reconcile.unref();
  if(syncEngine)void syncSources();
  const server=http.createServer(async(req,res)=>{
    const access=recordAccess(req);let actor='';
    res.once('finish',()=>access.finish(res.statusCode,actor));res.once('close',()=>access.finish(res.writableFinished?res.statusCode:499,actor));
    const send=(status,data,type='application/json')=>{res.writeHead(status,{'Content-Type':type});res.end(type==='application/json'?JSON.stringify(data):data);};
    res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    try {
      if(req.headers.host!==publicURL.host)return send(403,blocked,'text/html; charset=utf-8');
      const url=new URL(req.url,origin);
      if(await shares.handle(req,res,url,send,value=>{actor=value;}))return;
      if(req.method==='GET'&&url.pathname==='/notice.css')return send(200,blockedCSS,'text/css');
      if(req.method==='GET'&&url.pathname==='/healthz')return send(200,{ok:true});
      if(req.method==='GET'&&url.pathname===entrance.slice(0,-1)&&!url.search){res.setHeader('Location',entrance);return send(308,'','text/plain');}
      if(!url.pathname.startsWith(entrance))return send(url.pathname==='/'?403:404,blocked,'text/html; charset=utf-8');
      const path='/'+url.pathname.slice(entrance.length);
      if(url.search)throw fail(400,'Query parameters are not accepted');
      if(!['GET','POST','PUT'].includes(req.method))throw fail(405,'Method not allowed');
      if(req.method!=='GET' && (req.headers.origin!==origin || !['same-origin','none',undefined].includes(req.headers['sec-fetch-site'])))throw fail(403,'Invalid origin');
      if(req.method==='GET' && files.has(path)){const f=files.get(path);return send(200,f.body,f.type);}

      if(req.method==='POST' && path==='/api/login'){
        if(req.headers['content-type']!=='application/json')throw fail(415,'JSON required');
        limit('ip:'+access.address.ip,30);
        const b=JSON.parse(await body(req,1024));
        if(typeof b.username!=='string'||! /^[a-zA-Z0-9_-]{3,40}$/.test(b.username)||typeof b.password!=='string'||b.password.length>128)throw fail(400,'Invalid credentials');
        actor=b.username;limit('user:'+b.username,8);
        if(activeLogins>=4)throw fail(429,'Please try later');
        const user=db.prepare('SELECT * FROM users WHERE name=?').get(b.username);
        let valid;activeLogins++;try {valid=await verifyPassword(b.password,user?.hash||dummy);}finally{activeLogins--;}
        if(!valid||!user){audit(db,b.username,'login.failed');throw fail(401,'Invalid credentials');}
        // Recheck after the asynchronous hash: a console reset must win over an in-flight login.
        if(db.prepare('SELECT hash FROM users WHERE name=?').get(user.name)?.hash!==user.hash)throw fail(401,'Invalid credentials');
        const id=token(),csrf=token();
        db.prepare('DELETE FROM sessions WHERE name=?').run(user.name);
        db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(id),user.name,csrf,Date.now()+8*3600000);
        audit(db,user.name,'login.success');res.setHeader('Set-Cookie',cookie(id,28800));return send(200,{name:user.name,role:user.role,csrf});
      }
      const session=authenticate(req);
      if(!session)throw fail(401,'Please sign in');actor=session.name;
      if(req.method!=='GET' && req.headers['x-csrf-token']!==session.csrf)throw fail(403,'Invalid CSRF token');
      if(req.method==='GET' && path==='/api/session')return send(200,{name:session.name,role:session.role,csrf:session.csrf});
      if(req.method==='POST' && path==='/api/logout'){db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);audit(db,session.name,'logout');res.setHeader('Set-Cookie',cookie('',0));return send(200,{ok:true});}
      if(path==='/api/shares'||/^\/api\/shares\/[a-f0-9]{24}\/revoke$/.test(path)){
        if(session.role!=='admin')throw fail(403,'Administrator required');
        if(req.method==='GET'&&path==='/api/shares')return send(200,shares.list());
        if(req.method==='POST'&&path==='/api/shares'){
          if(req.headers['content-type']!=='application/json')throw fail(415,'JSON required');
          limit('share-create:'+session.name,30,60000);
          return send(201,shares.create(JSON.parse(await body(req,2048)),session.name));
        }
        if(req.method==='POST'&&path.endsWith('/revoke')){shares.revoke(path.split('/')[3],session.name);return send(200,{ok:true});}
        throw fail(405,'Method not allowed');
      }
      if(req.method==='POST' && path==='/api/cameras'){
        if(session.role!=='admin')throw fail(403,'Administrator required');
        if(req.headers['content-type']!=='application/json')throw fail(415,'JSON required');
        limit('camera-add:'+session.name,30,60000);
        const b=JSON.parse(await body(req,4096));
        if(!b||Object.keys(b).sort().join(',')!=='name,url')throw fail(400,'Only name and RTSP URL are accepted');
        const c={id:'cam_'+token().slice(0,16),name:b.name,url:b.url};
        try{validateCameras([...list,c]);if(ids.has(new URL(c.url).pathname.slice(1)))throw Error('Source path conflicts with an existing stream ID');}catch(e){throw fail(400,e.message);}
        // Persist before applying; reconciliation restores these sources after an engine restart.
        const next=[...list,c];db.prepare("UPDATE settings SET value=? WHERE name='cameras'").run(JSON.stringify(next));list.push(c);ids.add(c.id);
        audit(db,session.name,'camera.added:'+c.id);const ready=await syncSources();
        return send(201,{id:c.id,name:c.name,ready});
      }
      if(req.method==='GET' && path==='/api/cameras')return send(200,list.map(({id,name})=>({id,name})));
      if(req.method==='GET' && path==='/api/layout')return send(200,JSON.parse(db.prepare('SELECT value FROM layouts WHERE name=?').get(session.name)?.value||'null'));
      if(req.method==='PUT' && path==='/api/layout'){
        if(req.headers['content-type']!=='application/json')throw fail(415,'JSON required');
        const layout=validateLayout(JSON.parse(await body(req,8192)),ids);
        db.prepare('INSERT INTO layouts VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(session.name,JSON.stringify(layout));
        audit(db,session.name,'layout.saved');return send(200,{ok:true});
      }
      if(req.method==='GET' && ['/api/access','/api/access.csv'].includes(path)){
        if(session.role!=='admin')throw fail(403,'Administrator required');
        if(path.endsWith('.csv')){
          const rows=db.prepare('SELECT time,ip,peer,ip_source,method,path,status,actor,kind FROM access_log ORDER BY id DESC LIMIT 50000').all();
          const fields=['time','ip','peer','ip_source','method','path','status','actor','kind'];
          const quote=value=>'"'+String(value).replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';
          res.setHeader('Content-Disposition','attachment; filename="access-log.csv"');
          return send(200,fields.join(',')+'\r\n'+rows.map(row=>fields.map(f=>quote(row[f])).join(',')).join('\r\n'),'text/csv; charset=utf-8');
        }
        return send(200,{rows:db.prepare('SELECT time,ip,peer,ip_source,method,path,status,actor,kind FROM access_log ORDER BY id DESC LIMIT 500').all(),summary:db.prepare('SELECT ip,ip_source,COUNT(*) AS requests,SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) AS rejected,MAX(time) AS last_seen FROM access_log GROUP BY ip,ip_source ORDER BY last_seen DESC LIMIT 200').all()});
      }
      if(req.method==='GET' && path==='/api/audit'){
        if(session.role!=='admin')throw fail(403,'Administrator required');
        return send(200,db.prepare('SELECT time,actor,event FROM audit ORDER BY id DESC LIMIT 100').all());
      }
      const flv=path.match(/^\/api\/flv\/([a-z][a-z0-9_-]{0,47})$/);
      if(req.method==='GET'&&flv){
        if(!ids.has(flv[1]))throw fail(404,'Camera not found');
        if(activeFLV>=64)throw fail(429,'Too many streams');
        activeFLV++;try{await flvStream(req,res,{id:flv[1],session,valid,upstream,secret});}finally{activeFLV--;}return;
      }
      const match=path.match(/^\/api\/play\/([a-z][a-z0-9_-]{0,47})$/);
      if(req.method==='POST' && match){
        if(!ids.has(match[1]))throw fail(404,'Camera not found');
        if(req.headers['content-type']!=='application/sdp')throw fail(415,'SDP required');
        limit('play:'+session.name,120,60000);
        const offer=await body(req);if(!offer.startsWith('v=0\r\n')&&!offer.startsWith('v=0\n'))throw fail(400,'Invalid SDP');
        if(activeOffers>=16)throw fail(429,'Too many connections');activeOffers++;
        try {
          // No generic reverse proxy: URL, path, query, credentials and content type are server-owned.
          const answer=await fetch(new URL('/api/webrtc?src='+encodeURIComponent(match[1]),upstream),{method:'POST',headers:{'Content-Type':'application/sdp',Authorization:'Basic '+Buffer.from('gateway:'+secret).toString('base64')},body:offer,redirect:'error',signal:AbortSignal.timeout(15000)});
          if(!answer.ok)throw fail(502,'Camera unavailable. Check source and codec.');
          const sdp=await answer.text();if(sdp.length>131072)throw fail(502,'Invalid upstream response');
          return send(200,sdp,'application/sdp');
        } catch(e){if(e.status)throw e;throw fail(502,'Streaming service unavailable');}finally{activeOffers--;}
      }
      throw fail(404,'Not found');
    }catch(e){if(!res.headersSent)send(e.status||(e instanceof SyntaxError?400:500),{error:e.status?e.message:e instanceof SyntaxError?'Invalid JSON':'Server error'});else res.end();}
  });
  mseGateway(server,{origin,ids,authenticate,valid,upstream,secret,entrance,recordAccess,shares});
  server.on('clientError',(_error,socket)=>{const log=recordAccess({socket,headers:{},method:'INVALID',url:'[malformed]'},'http');log.finish(400);if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
  server.requestTimeout=20000;server.headersTimeout=10000;server.timeout=25000;server.maxHeadersCount=30;
  server.entrance=entrance;server.recordAccess=recordAccess;server.cameraIds=ids;server.on('close',()=>{clearInterval(cleanup);clearInterval(reconcile);});return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const server=await createApp();
  if(process.env.RTSP_PROXY==='1'){const relay=rtspProxy(server.cameraIds,'go2rtc',8554,server.recordAccess);relay.listen(8554,'0.0.0.0');}
  server.listen(Number(process.env.PORT||8080),process.env.HOST||'127.0.0.1',()=>console.log('TV Wall listening'));
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit(0)));
}
