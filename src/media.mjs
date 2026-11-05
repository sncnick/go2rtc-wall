import {WebSocketServer,WebSocket} from 'ws';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
export const CODECS=['avc1.640029','avc1.64002A','avc1.640033','hvc1.1.6.L153.B0','mp4a.40.2','mp4a.40.5','flac','opus'];
export function mseGateway(server,{origin,ids,authenticate,valid,upstream,secret,entrance,recordAccess,shares}) {
  const wss=new WebSocketServer({noServer:true,maxPayload:1024,perMessageDeflate:false});
  server.on('upgrade',(req,socket,head)=>{
    const log=recordAccess(req,'websocket');
    const reject=()=>{log.finish(403);socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');};
    const match=(req.url.startsWith(entrance)?'/'+req.url.slice(entrance.length):'').match(/^\/api\/mse\/([a-z][a-z0-9_-]{0,47})$/);
    const shared=req.url.match(/^\/share\/([a-f0-9]{64})\/mse$/);
    const grant=shared?shares?.resolve(shared[1]):null;
    const session=shared?null:authenticate(req);
    const id=grant?.camera||match?.[1];
    if(req.headers.host!==new URL(origin).host||wss.clients.size>=128||!ids.has(id))return reject();
    if(shared?!grant:(!session||!match||req.headers.origin!==origin))return reject();
    const release=shared?shares.acquire(grant):()=>{};if(!release)return reject();
    let upgraded=false;
    const failedUpgrade=()=>{if(!upgraded){release();log.finish(400);}};
    socket.once('close',failedUpgrade);
    wss.handleUpgrade(req,socket,head,client=>{
      upgraded=true;socket.removeListener('close',failedUpgrade);
      log.finish(101,shared?'share:'+grant.id:session.name);
      let remote;let started=false;let closed=false;
      const close=()=>{if(closed)return;closed=true;release();clearInterval(lease);clearTimeout(startDeadline);client.terminate();remote?.terminate();};
      const lease=setInterval(()=>{if(shared?!shares.valid(grant):!valid(session))close();},5000);
      const startDeadline=setTimeout(()=>{if(!started)close();},5000);
      client.on('error',close);client.on('close',close);
      client.on('message',(data,binary)=>{
        if(binary||started)return close();let m;
        try {m=JSON.parse(data);}catch{return close();}
        if(m.type!=='mse'||typeof m.value!=='string'||!m.value||Object.keys(m).sort().join(',')!=='type,value'||m.value.split(',').some(c=>!CODECS.includes(c)))return close();
        started=true;clearTimeout(startDeadline);
        const url=new URL('/api/ws?src='+encodeURIComponent(id),upstream);url.protocol=url.protocol==='https:'?'wss:':'ws:';
        remote=new WebSocket(url,{headers:{Authorization:'Basic '+Buffer.from('gateway:'+secret).toString('base64')},handshakeTimeout:10000,maxPayload:8*1024*1024,perMessageDeflate:false});
        remote.on('open',()=>remote.send(JSON.stringify({type:'mse',value:m.value})));
        remote.on('message',(data,binary)=>{
          if(client.readyState!==WebSocket.OPEN||client.bufferedAmount>8*1024*1024)return close();
          if(binary)client.send(data,{binary:true});else{try{const msg=JSON.parse(data);if(msg.type==='mse'&&typeof msg.value==='string'&&msg.value.length<256)client.send(JSON.stringify(msg));else{client.send(JSON.stringify({type:'error',value:'Camera unavailable or unsupported codec'}));}}catch{close();}}
        });remote.on('close',close);remote.on('error',close);
      });
    });
  });
  server.on('close',()=>{for(const client of wss.clients)client.terminate();wss.close();});
}
export async function flvStream(req,res,{id,session,valid,upstream,secret}) {
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15000);
  const lease=setInterval(()=>{if(!valid(session))controller.abort();},5000);
  res.on('close',()=>controller.abort());
  try {
    const response=await fetch(new URL('/api/stream.flv?src='+encodeURIComponent(id),upstream),{headers:{Authorization:'Basic '+Buffer.from('gateway:'+secret).toString('base64')},signal:controller.signal,redirect:'error'});
    clearTimeout(timer);
    if(!response.ok)throw Error('Upstream unavailable');
    res.writeHead(200,{'Content-Type':'video/x-flv','X-Accel-Buffering':'no'});req.socket.setTimeout(0);
    await pipeline(Readable.fromWeb(response.body),res);
  }catch{if(!res.headersSent&&!res.destroyed){res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Camera unavailable or unsupported codec'}));}else res.destroy();}
  finally{clearTimeout(timer);clearInterval(lease);controller.abort();}
}
