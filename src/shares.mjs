import {token,digest,audit} from './store.mjs';
import {flvStream} from './media.mjs';
import {readFileSync} from 'node:fs';
const assets=new Map([
  ['', ['share.html','text/html; charset=utf-8']],
  ['player.js',['share.js','text/javascript']],
  ['player.css',['share.css','text/css']],
].map(([path,[file,type]])=>[path,{body:readFileSync(new URL('../public/'+file,import.meta.url)),type}]));
assets.set('mpegts.js',{body:readFileSync(new URL('../node_modules/mpegts.js/dist/mpegts.js',import.meta.url)),type:'text/javascript'});
const failure=(status,message)=>Object.assign(Error(message),{status});
export function sharing({db,ids,list,origin,upstream,secret,rtspBase}) {
  const relay=new URL(rtspBase||`rtsp://${new URL(origin).hostname}:8554`);
  if(relay.protocol!=='rtsp:'||relay.username||relay.password||relay.search||relay.hash||!['','/'].includes(relay.pathname))throw Error('RTSP_PUBLIC_BASE must be rtsp://host:port without credentials or a path');
  const live=db.prepare("SELECT s.* FROM shares s JOIN users u ON u.name=s.creator WHERE s.id=? AND s.revoked=0 AND s.expires>? AND u.role='admin'");
  const lookup=db.prepare("SELECT s.* FROM shares s JOIN users u ON u.name=s.creator WHERE s.digest=? AND s.revoked=0 AND s.expires>? AND u.role='admin'");
  function valid(grant){return ids.has(grant.camera)&&Boolean(live.get(grant.id,Date.now()));}
  function resolve(raw){if(!/^[a-f0-9]{64}$/.test(raw))return null;const g=lookup.get(digest(raw),Date.now());return g&&ids.has(g.camera)?g:null;}
  const counts=new Map();let total=0;
  function acquire(g){if(total>=64||(counts.get(g.id)||0)>=8)return null;total++;counts.set(g.id,(counts.get(g.id)||0)+1);let done=false;return ()=>{if(done)return;done=true;total--;const n=counts.get(g.id)-1;if(n)counts.set(g.id,n);else counts.delete(g.id);};}
  function listShares(){return {grants:db.prepare('SELECT id,camera,label,created,expires,revoked,creator FROM shares ORDER BY CASE WHEN revoked=0 AND expires>? THEN 0 ELSE 1 END,created DESC LIMIT 200').all(Date.now()),rtsp:list.map(c=>({camera:c.id,url:relay.href.replace(/\/$/,'')+'/'+c.id})),origin};}
  function create(b,creator){
    if(!b||Object.keys(b).sort().join(',')!=='camera,hours,label'||!ids.has(b.camera)||typeof b.label!=='string'||b.label.length>80||/[\x00-\x1f\x7f]/.test(b.label)||![1,24,168,720].includes(b.hours))throw failure(400,'Choose a camera and an expiry of 1 hour, 1 day, 7 days or 30 days');
    db.prepare('DELETE FROM shares WHERE expires<?').run(Date.now()-30*86400000);
    if(db.prepare('SELECT COUNT(*) AS n FROM shares WHERE revoked=0 AND expires>?').get(Date.now()).n>=200)throw failure(409,'Too many active shares; revoke unused links first');
    if(db.prepare('SELECT COUNT(*) AS n FROM shares').get().n>=2000)throw failure(429,'Share history is full; try later');
    const raw=token(),id=token().slice(0,24),created=Date.now(),expires=created+b.hours*3600000;
    db.prepare('INSERT INTO shares(id,digest,camera,label,created,expires,revoked,creator) VALUES(?,?,?,?,?,?,0,?)').run(id,digest(raw),b.camera,b.label,created,expires,creator);
    audit(db,creator,'share.created:'+id);
    const page=origin+'/share/'+raw+'/';
    return {id,camera:b.camera,expires,page,flv:page+'stream.flv',mse:page.replace(/^http/,'ws')+'mse',embed:`<iframe src="${page}" title="Live camera" allow="autoplay; fullscreen" allowfullscreen referrerpolicy="no-referrer" style="width:100%;aspect-ratio:16/9;border:0"></iframe>`};
  }
  function revoke(id,actor){if(!/^[a-f0-9]{24}$/.test(id))throw failure(404,'Share not found');const r=db.prepare('UPDATE shares SET revoked=1 WHERE id=?').run(id);if(!r.changes)throw failure(404,'Share not found');audit(db,actor,'share.revoked:'+id);}
  async function handle(req,res,url,send,setActor){
    const m=url.pathname.match(/^\/share\/([a-f0-9]{64})\/(.*)$/);
    if(!m)return false;
    const grant=resolve(m[1]);if(!grant){send(404,{error:'Share expired, revoked or unavailable'});return true;}
    setActor('share:'+grant.id);
    if(url.search||!['GET','OPTIONS'].includes(req.method)){send(400,{error:'Invalid share request'});return true;}
    const resource=m[2];
    if(!assets.has(resource)&&resource!=='info'&&resource!=='stream.flv'){send(404,{error:'Not found'});return true;}
    // The bearer grants playback to whoever has the link; it never uses login cookies.
    res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors *; base-uri 'none'; form-action 'none'");
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return true;}
    if(assets.has(resource)){const f=assets.get(resource);send(200,f.body,f.type);return true;}
    if(resource==='info'){send(200,{name:list.find(c=>c.id===grant.camera)?.name,expires:grant.expires});return true;}
    const release=acquire(grant);if(!release){send(429,{error:'Share connection limit reached'});return true;}
    try{await flvStream(req,res,{id:grant.camera,session:grant,valid,upstream,secret});}finally{release();}return true;
  }
  return {resolve,valid,acquire,handle,list:listShares,create,revoke};
}
