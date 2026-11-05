import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {WebSocket,WebSocketServer} from 'ws';
import {openStore,setUser} from '../src/store.mjs';
import {createApp} from '../src/server.mjs';
import {cameras,engineConfig} from '../src/config.mjs';
import {rtspProxy} from '../src/rtsp-proxy.mjs';
const listen=async s=>{s.listen(0,'127.0.0.1');await once(s,'listening');return s.address().port;};
test('Reject executable sources, URL extensions, metadata endpoints and duplicate camera IDs',()=>{
  const dir=mkdtempSync(join(tmpdir(),'wall-config-')),path=join(dir,'cameras.json');
  try{for(const url of ['exec:touch /tmp/pwn','ffmpeg:rtsp://192.168.1.1/live','echo:test','file:///etc/passwd','http://169.254.169.254/','rtsp://127.0.0.1/live','rtsp://example.com/live','rtsp://192.168.1.1/live#exec=test','rtsp://192.168.1.1/live%0aexec','rtsp://192.168.1.1/live%23test']){writeFileSync(path,JSON.stringify([{id:'front',name:'Front',url}]));assert.throws(()=>cameras(path),url);}
  const c={id:'front',name:'Front',url:'rtsp://user:pass@192.168.1.2/live'};writeFileSync(path,JSON.stringify([c]));assert.equal(cameras(path)[0].id,'front');writeFileSync(path,JSON.stringify([c,c]));assert.throws(()=>cameras(path));
  const config=engineConfig([c],'a'.repeat(64),'192.168.1.20','b'.repeat(64));for(const mod of ['exec','ffmpeg','echo','expr'])assert.ok(!config.app.modules.includes(mod));assert.ok(!config.api.allow_paths.includes('/api/config'));assert.equal(config.api.local_auth,true);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Authentication, CSRF, role isolation, payload rejection, MSE restriction and revocation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wall-test-')),db=openStore(join(dir,'db.sqlite'));let called=[];
  await setUser(db,'admin','a-long-admin-password','admin');await setUser(db,'viewer','a-long-viewer-password','viewer');
  const upstream=http.createServer(async(req,res)=>{called.push(req.url);if(req.url.startsWith('/api/webrtc')){res.setHeader('Content-Type','application/sdp');res.end('v=0\r\n');}else if(req.url.startsWith('/api/stream.flv')){res.setHeader('Content-Type','video/x-flv');res.end('FLV-test');}else{res.writeHead(404);res.end();}});
  const wss=new WebSocketServer({server:upstream});let upstreamMessage;
  wss.on('connection',(ws,req)=>{called.push(req.url);ws.on('message',d=>{upstreamMessage=JSON.parse(d);ws.send(JSON.stringify({type:'mse',value:'video/mp4; codecs="avc1.640029"'}));});});
  const up=await listen(upstream);const origin='http://localhost:8080';
  const app=await createApp({db,list:[{id:'front',name:'Front',url:'rtsp://secret:password@192.168.1.2/live'}],origin,upstream:`http://127.0.0.1:${up}`,secret:'secret'});const port=await listen(app),base=`http://127.0.0.1:${port}`;
  const request=(path,{method='GET',cookie,csrf,value,originHeader=origin,...rest}={})=>new Promise((resolve,reject)=>{const r=http.request(base+app.entrance+path.slice(1),{method,headers:{host:'localhost:8080',origin:originHeader,...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...(value?{'content-type':'application/json'}:{}),...rest.headers}},response=>{const chunks=[];response.on('data',c=>chunks.push(c));response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:response.headers})));});r.on('error',reject);r.end(value?JSON.stringify(value):rest.body);});
  const login=async username=>{const r=await request('/api/login',{method:'POST',value:{username,password:`a-long-${username}-password`}});assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie').split(';')[0],...(await r.json())};};
  try{
    assert.equal((await request('/api/cameras')).status,401);
    assert.equal((await request('/api/login',{method:'POST',value:{username:'admin',password:'a-long-admin-password'},originHeader:'https://evil.example'})).status,403);
    const a=await login('admin'),v=await login('viewer');
    assert.equal((await request('/api/cameras',{method:'POST',cookie:v.cookie,csrf:v.csrf,value:{name:'Bad',url:'rtsp://192.168.1.3/live'}})).status,403);
    assert.equal((await request('/api/cameras',{method:'POST',cookie:a.cookie,csrf:a.csrf,value:{name:'Bad',url:'exec:malicious'}})).status,400);
    assert.equal((await request('/api/cameras',{method:'POST',cookie:a.cookie,value:{name:'Bad',url:'rtsp://192.168.1.3/live'}})).status,403);
    const added=await request('/api/cameras',{method:'POST',cookie:a.cookie,csrf:a.csrf,value:{name:'Side',url:'rtsp://user:secret@192.168.1.3/live'}});assert.equal(added.status,201);
    assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE name='cameras'").get().value).length,2);
    const json=await (await request('/api/cameras',{cookie:v.cookie})).text();assert.ok(!json.includes('password'));assert.ok(!json.includes('rtsp:'));
    assert.equal((await request('/api/audit',{cookie:v.cookie})).status,403);assert.equal((await request('/api/audit',{cookie:a.cookie})).status,200);
    assert.equal((await request('/api/layout',{method:'PUT',cookie:a.cookie,value:[]})).status,403);
    const layout=[{id:'front',x:1,y:2,w:6,h:4,mode:'mse'}];
    assert.equal((await request('/api/layout',{method:'PUT',cookie:a.cookie,csrf:a.csrf,value:layout})).status,200);
    assert.deepEqual(await (await request('/api/layout',{cookie:a.cookie})).json(),layout);
    assert.equal(await (await request('/api/layout',{cookie:v.cookie})).json(),null);
    assert.equal((await request('/api/layout',{method:'PUT',cookie:a.cookie,csrf:a.csrf,value:[{...layout[0],x:-1}]})).status,400);
    for(const path of ['/api/config','/api/restart','/api/streams','/api/exec'])assert.equal((await request(path,{method:'POST',cookie:a.cookie,csrf:a.csrf,value:{src:'exec:malicious'}})).status,404);
    assert.equal((await request('/api/play/front?src=exec:bad',{method:'POST',cookie:a.cookie,csrf:a.csrf})).status,400);
    assert.equal((await request('/api/play/unknown',{method:'POST',cookie:a.cookie,csrf:a.csrf})).status,404);
    assert.equal(called.length,0);
    assert.equal((await request('/api/play/front',{method:'POST',cookie:a.cookie,csrf:a.csrf,headers:{'content-type':'application/sdp'},body:'v=0\r\n'})).status,200);
    assert.equal(called[0],'/api/webrtc?src=front');
    const flv=await request('/api/flv/front',{cookie:a.cookie});assert.equal(await flv.text(),'FLV-test');
    const options={headers:{host:'localhost:8080',origin,cookie:a.cookie}};
    const bad=new WebSocket(`ws://127.0.0.1:${port}${app.entrance}api/mse/front`,options);await once(bad,'open');bad.send(JSON.stringify({type:'webrtc/offer',value:'exec:bad'}));await once(bad,'close');assert.equal(upstreamMessage,undefined);
    const good=new WebSocket(`ws://127.0.0.1:${port}${app.entrance}api/mse/front`,options);await once(good,'open');good.send(JSON.stringify({type:'mse',value:'avc1.640029'}));await once(good,'message');assert.equal(upstreamMessage.type,'mse');
    const revoked=once(good,'close');await request('/api/logout',{method:'POST',cookie:a.cookie,csrf:a.csrf});await revoked;
    assert.equal((await request('/api/session',{cookie:a.cookie})).status,401);
    for(let i=0;i<8;i++)await request('/api/login',{method:'POST',value:{username:'nobody',password:'bad-password'}});
    assert.equal((await request('/api/login',{method:'POST',value:{username:'nobody',password:'bad-password'}})).status,429);
  }finally{for(const ws of wss.clients)ws.terminate();wss.close();app.closeAllConnections();await new Promise(r=>app.close(r));upstream.closeAllConnections();await new Promise(r=>upstream.close(r));db.close();rmSync(dir,{recursive:true,force:true});}
});
test('RTSP relay rejects publishing, arbitrary sources and UDP setup',async()=>{
  let requests=0;const upstream=net.createServer(s=>{s.on('data',()=>{requests++;s.end('RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\n\r\n');});});const up=await listen(upstream);const relay=rtspProxy(new Set(['front']),'127.0.0.1',up),port=await listen(relay);
  async function send(text){const client=net.connect(port,'127.0.0.1');client.on('error',()=>{});client.on('data',()=>{});await once(client,'connect');client.write(text);await once(client,'close');}
  try{for(const line of ['ANNOUNCE rtsp://wall/front RTSP/1.0','DESCRIBE rtsp://wall/exec:bad RTSP/1.0','DESCRIBE rtsp://wall/front?src=exec:bad RTSP/1.0','SETUP rtsp://wall/front RTSP/1.0'])await send(line+'\r\nCSeq: 1\r\n\r\n');assert.equal(requests,0);await send('DESCRIBE rtsp://wall/front RTSP/1.0\r\nCSeq: 1\r\n\r\n');assert.equal(requests,1);}finally{await new Promise(r=>relay.close(r));await new Promise(r=>upstream.close(r));}
});
test('Persisted RTSP additions are restored into a restarted engine using only GET/PATCH',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wall-reconcile-'));const db=openStore(join(dir,'db.sqlite'));
  const source={id:'cam_restore',name:'Restore',url:'rtsp://user:secret@192.168.1.4/live'};
  db.prepare("INSERT INTO settings VALUES('cameras',?)").run(JSON.stringify([source]));
  let restored;let resolvePatch;const patched=new Promise(r=>resolvePatch=r);
  const upstream=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost');if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end('{}');}else{restored={method:req.method,path:u.pathname,id:u.searchParams.get('name'),url:u.searchParams.get('src')};res.end();resolvePatch();}});
  const port=await listen(upstream);let app;
  try{app=await createApp({db,list:[],syncEngine:true,upstream:`http://127.0.0.1:${port}`});await listen(app);await patched;assert.deepEqual(restored,{method:'PATCH',path:'/api/streams',id:source.id,url:source.url});assert.ok(app.cameraIds.has(source.id));}finally{if(app){app.closeAllConnections();await new Promise(r=>app.close(r));}upstream.closeAllConnections();await new Promise(r=>upstream.close(r));db.close();rmSync(dir,{recursive:true,force:true});}
});
