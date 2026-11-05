import net from 'node:net';
// TCP-interleaved RTSP only. Publish methods and URL query extensions never reach go2rtc.
export function rtspProxy(ids, host='go2rtc', port=8554,recordAccess=()=>({finish(){}})) {
  const server=net.createServer(client=>{
    const access=recordAccess({socket:client,headers:{},method:'CONNECT',url:'[rtsp]'},'rtsp');
    client.once('close',()=>access.finish(0));
    if(server.getConnections)server.getConnections((err,n)=>{if(!err&&n>128)client.destroy();});
    const upstream=net.connect(port,host);let pending=Buffer.alloc(0);
    const close=()=>{client.destroy();upstream.destroy();};
    client.setTimeout(120000,close);upstream.setTimeout(120000,close);
    client.on('error',close);upstream.on('error',close);client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());
    upstream.pipe(client);
    client.on('data',chunk=>{
      pending=Buffer.concat([pending,chunk]);
      if(pending.length>131072)return close();
      while(pending.length){
        if(pending[0]===36){if(pending.length<4)return;const size=4+pending.readUInt16BE(2);if(pending.length<size)return;if(!upstream.write(pending.subarray(0,size)))client.pause();pending=pending.subarray(size);continue;}
        const end=pending.indexOf('\r\n\r\n');if(end<0){if(pending.length>8192)close();return;}
        const head=pending.subarray(0,end).toString();const lines=head.split('\r\n');
        if(lines.slice(1).some(l=>! /^[A-Za-z0-9-]+:[ \t]*[^\x00-\x08\x0a-\x1f\x7f]*$/.test(l))||lines.filter(l=>/^transport:/i.test(l)).length>1)return close();const match=lines[0].match(/^(OPTIONS|DESCRIBE|SETUP|PLAY|PAUSE|TEARDOWN|GET_PARAMETER) (\S+) RTSP\/1\.0$/);
        if(!match)return close();
        try {if(match[2]!=='*'){const u=new URL(match[2]);if(u.protocol!=='rtsp:'||u.search||u.hash||u.username||u.password||!ids.has(u.pathname.split('/')[1])||!/^\/[a-z][a-z0-9_-]{0,47}(?:\/[a-zA-Z0-9_=.-]+)?$/.test(u.pathname))return close();}else if(match[1]!=='OPTIONS')return close();}catch{return close();}
        const lengths=lines.filter(l=>/^content-length:/i.test(l));if(lengths.length>1||lengths.some(l=>!/^content-length:\s*0\s*$/i.test(l)))return close();
        if(match[1]==='SETUP'&&!lines.some(l=>/^transport:\s*RTP\/AVP\/TCP;/i.test(l)))return close();
        if(lines.some(l=>/^transport:/i.test(l)&&/multicast|destination\s*=|client_port\s*=|mode\s*=\s*"?record/i.test(l)))return close();
        if(!upstream.write(pending.subarray(0,end+4)))client.pause();pending=pending.subarray(end+4);
      }
    });upstream.on('drain',()=>client.resume());
  });return server;
}
