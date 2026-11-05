import {readFileSync} from 'node:fs';
import {isIPv4} from 'node:net';
export function cameras(path = process.env.CAMERAS_FILE || 'config/cameras.json', allowedHosts = (process.env.CAMERA_HOST_ALLOWLIST || '').split(',').filter(Boolean)) {
  return validateCameras(JSON.parse(readFileSync(path, 'utf8')),allowedHosts);
}
export function validateCameras(list,allowedHosts=(process.env.CAMERA_HOST_ALLOWLIST || '').split(',').filter(Boolean)) {
  if (!Array.isArray(list) || list.length > 64) throw Error('Camera list must contain at most 64 cameras');
  const ids = new Set();
  for (const c of list) {
    if (!c || Object.keys(c).some(k => !['id','name','url'].includes(k)) || !/^[a-z][a-z0-9_-]{0,47}$/.test(c.id) || ids.has(c.id) || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 80) throw Error('Invalid camera metadata');
    ids.add(c.id);
    if (typeof c.url !== 'string' || c.url.length > 2048 || /[\s#\\\x00-\x1f\x7f]/.test(c.url) || /%(?:00|0a|0d|23)/i.test(c.url)) throw Error('Invalid camera URL');
    const u = new URL(c.url);
    const a = u.hostname.split('.').map(Number);
    const explicitlyAllowed=allowedHosts.includes(u.hostname) && ![0,127,169].includes(a[0]) && a[0]<224;
    if (!['rtsp:', 'rtsps:'].includes(u.protocol) || !isIPv4(u.hostname) || !(explicitlyAllowed || a[0] === 10 || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && a[1] === 168))) throw Error('Only private IPv4 or explicitly approved public RTSP(S) hosts are allowed');
  }
  return list;
}
export function engineConfig(list, password, candidate, rtspPassword) {
  if (!/^[a-f0-9]{64}$/.test(password || '')) throw Error('Run setup to create GO2RTC_PASSWORD');
  if (!isIPv4(candidate || '')) throw Error('MEDIA_HOST must be the Docker host LAN IPv4');
  if (!/^[a-f0-9]{64}$/.test(rtspPassword || '')) throw Error('RTSP_PASSWORD must be 64 random hex characters');
  return {app:{modules:['api','ws','rtsp','webrtc','mp4','rtmp']},api:{listen:':1984',username:'gateway',password,local_auth:true,allow_paths:['/api/webrtc','/api/ws','/api/stream.flv','/api/streams']},rtsp:{listen:':8554',username:'relay',password:rtspPassword},rtmp:{listen:''},webrtc:{listen:':8555',candidates:[`${candidate}:8555`],ice_servers:[]},streams:Object.fromEntries(list.map(c=>[c.id,[c.url]]))};
}
