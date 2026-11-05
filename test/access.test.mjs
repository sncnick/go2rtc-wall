import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {clientAddress,trustedIPs,safePath} from '../src/access.mjs';
import {openStore,setUser} from '../src/store.mjs';
import {createApp} from '../src/server.mjs';
test('Client IP cannot be forged by untrusted forwarding headers',()=>{
  const req={socket:{remoteAddress:'::ffff:192.0.2.9'},headers:{'x-forwarded-for':'1.2.3.4'}};
  assert.deepEqual(clientAddress(req),{ip:'192.0.2.9',peer:'192.0.2.9',ip_source:'socket'});
  assert.equal(clientAddress(req,trustedIPs('192.0.2.9')).ip,'1.2.3.4');
  req.headers['x-forwarded-for']='9.9.9.9, 203.0.113.7';
  assert.equal(clientAddress(req,trustedIPs('192.0.2.9')).ip,'203.0.113.7');
  req.headers['x-forwarded-for']='invalid, 203.0.113.7';
  assert.equal(clientAddress(req,trustedIPs('192.0.2.9')).ip,'192.0.2.9');
  assert.throws(()=>trustedIPs('0.0.0.0/0'));
  assert.equal(safePath('/private-entrance-abcdefgh/api/login?password=secret','/private-entrance-abcdefgh/'),'[entry]/api/login');
});
test('Blocked landing page, private login, durable access logs and admin-only CSV',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wall-access-'));const db=openStore(join(dir,'db'));
  await setUser(db,'admin','a-long-admin-password','admin');await setUser(db,'viewer','a-long-viewer-password','viewer');
  const app=await createApp({db,list:[]});app.listen(0,'127.0.0.1');await once(app,'listening');const port=app.address().port;
  const request=(path,method='GET',value,headers={})=>new Promise((resolve,reject)=>{const r=http.request({host:'127.0.0.1',port,path,method,headers:{host:'localhost:8080',origin:'http://localhost:8080','content-type':'application/json',...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});r.on('error',reject);r.end(value?JSON.stringify(value):undefined);});
  try{
    const landing=await request('/');assert.equal(landing.status,403);assert.match(landing.text,/存取/);assert.ok(!landing.text.includes(app.entrance));assert.ok(!landing.text.includes('<script'));assert.ok(!landing.text.includes('<form'));
    for(const path of ['/login','/app.js','/index.html','/api/login'])assert.equal((await request(path)).status,404);
    assert.equal((await request(app.entrance)).status,200);
    const attempt=await request(app.entrance+'api/login','POST',{username:'admin',password:'wrong-password'},{'x-forwarded-for':'8.8.8.8'});assert.equal(attempt.status,401);
    const a=await request(app.entrance+'api/login','POST',{username:'admin',password:'a-long-admin-password'});assert.equal(a.status,200);
    const headers={cookie:a.headers['set-cookie'][0].split(';')[0]};
    const logs=await request(app.entrance+'api/access','GET',undefined,headers);assert.equal(logs.status,200);
    const data=JSON.parse(logs.text);const failed=data.rows.find(r=>r.status===401&&r.actor==='admin');assert.equal(failed.ip,'127.0.0.1');assert.equal(failed.path,'[entry]/api/login');
    assert.ok(!logs.text.includes('wrong-password'));assert.ok(!logs.text.includes(app.entrance));
    assert.equal((await request(app.entrance+'api/access.csv','GET',undefined,headers)).status,200);
    const v=await request(app.entrance+'api/login','POST',{username:'viewer',password:'a-long-viewer-password'});assert.equal((await request(app.entrance+'api/access','GET',undefined,{cookie:v.headers['set-cookie'][0].split(';')[0]})).status,403);
    await request('/scan?token=secret');assert.ok(!JSON.stringify(db.prepare('SELECT * FROM access_log').all()).includes('token=secret'));
    const path=app.entrance;app.closeAllConnections();await new Promise(r=>app.close(r));
    const reopened=await createApp({db,list:[]});assert.equal(reopened.entrance,path);reopened.listen(0,'127.0.0.1');await once(reopened,'listening');await new Promise(r=>reopened.close(r));
  }finally{if(app.listening){app.closeAllConnections();await new Promise(r=>app.close(r));}db.close();rmSync(dir,{recursive:true,force:true});}
});
