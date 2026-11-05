import {isIP} from 'node:net';
export function normalizeIP(value='') {
  if(typeof value!=='string')return '';
  let ip=value.trim();if(ip.startsWith('::ffff:')&&isIP(ip.slice(7))===4)ip=ip.slice(7);
  if(!isIP(ip))return '';
  return isIP(ip)===6?new URL(`http://[${ip}]/`).hostname.slice(1,-1):ip;
}
export function trustedIPs(value='') {
  const parts=value.split(',').map(s=>s.trim()).filter(Boolean);
  if(parts.some(s=>!normalizeIP(s)))throw Error('TRUSTED_PROXY_IPS requires exact IPv4/IPv6 addresses, not wildcard ranges');
  return new Set(parts.map(normalizeIP));
}
export function clientAddress(req,trusted=new Set()) {
  const peer=normalizeIP(req.socket.remoteAddress)||'unknown';
  const fallback={ip:peer,peer,ip_source:'socket'};
  if(!trusted.has(peer))return fallback;
  const raw=req.headers['x-forwarded-for'];
  if(typeof raw!=='string'||raw.length>2048)return fallback;
  const chain=raw.split(',').map(normalizeIP);
  if(!chain.length||chain.length>20||chain.some(s=>!s))return fallback;
  let ip=peer;
  for(let i=chain.length-1;i>=0&&trusted.has(ip);i--)ip=chain[i];
  return {ip,peer,ip_source:'trusted-proxy'};
}
export function safePath(raw,entrance) {
  let path=String(raw||'/').split(/[?#]/)[0];
  path=path.replace(/(\/share\/)[^/]+/g,'$1[token]');
  if(entrance)path=path.replaceAll(entrance.slice(0,-1),'[entry]');
  // Do not retain URL credentials or other attacker-supplied absolute source URLs.
  path=path.replace(/(?:rtsp|rtsps|https?):\/\/.*$/i,'[url]');
  return path.replace(/[\x00-\x1f\x7f]/g,'').slice(0,256);
}
export function accessLogger(db,entrance,trusted) {
  const insert=db.prepare('INSERT INTO access_log(time,ip,peer,ip_source,method,path,status,actor,kind) VALUES(?,?,?,?,?,?,?,?,?)');
  const update=db.prepare('UPDATE access_log SET status=?,actor=? WHERE id=?');
  return function start(req,kind='http') {
    const addr=clientAddress(req,trusted);const row={time:new Date().toISOString(),...addr,method:String(req.method||'CONNECT').slice(0,16),path:safePath(req.url,entrance),status:0,actor:'',kind};
    const {lastInsertRowid:id}=insert.run(row.time,row.ip,row.peer,row.ip_source,row.method,row.path,0,'',kind);
    // Bound disk usage even during scans, without retaining request bodies, cookies or query strings.
    db.prepare('DELETE FROM access_log WHERE id<=?').run(Number(id)-50000);
    console.log(JSON.stringify({type:'access.open',...row}));let done=false;
    return {address:addr,finish(status,actor=''){if(done)return;done=true;update.run(status,actor,id);console.log(JSON.stringify({type:'access',...row,status,actor}));}};
  };
}
