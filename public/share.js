const video=document.querySelector('#video'),status=document.querySelector('#status'),mode=document.querySelector('#mode');
const base=new URL('.',location.href);let cleanup=()=>{};let generation=0;
const codecs=['avc1.640029','avc1.64002A','avc1.640033','hvc1.1.6.L153.B0','mp4a.40.2','mp4a.40.5','flac','opus'];
async function start(){
  cleanup();cleanup=()=>{};const run=++generation;video.srcObject=null;video.removeAttribute('src');video.load();status.textContent='正在連線…';
  try{const r=await fetch(new URL('info',base),{credentials:'omit'});if(!r.ok)throw Error('分享已到期、已撤銷或無法使用');const info=await r.json();if(run!==generation)return;document.querySelector('#name').textContent=info.name;}
  catch(e){if(run===generation)status.textContent=e.message;return;}
  if(mode.value==='flv'){
    if(!window.mpegts?.isSupported()){status.textContent='此瀏覽器不支援 FLV';return;}
    const p=mpegts.createPlayer({type:'flv',isLive:true,url:new URL('stream.flv',base).href},{enableWorker:false,enableStashBuffer:false,autoCleanupSourceBuffer:true,liveBufferLatencyChasing:true});
    cleanup=()=>p.destroy();p.on(mpegts.Events.ERROR,()=>{if(run===generation)status.textContent='連線失敗或分享失效，請重新連線';});p.on(mpegts.Events.MEDIA_INFO,()=>status.textContent='即時畫面 · FLV');p.attachMediaElement(video);p.load();p.play()?.catch(()=>{});return;
  }
  const MS=window.ManagedMediaSource||window.MediaSource;if(!MS){status.textContent='此瀏覽器不支援 MSE';return;}
  const ms=new MS();let ws,sb,url,queue=[],bytes=0,closed=false;
  cleanup=()=>{closed=true;ws?.close();if(url)URL.revokeObjectURL(url);};
  const fail=message=>{if(run!==generation)return;status.textContent=message;cleanup();};
  function pump(){if(closed||!sb||sb.updating)return;try{if(sb.buffered.length){const end=sb.buffered.end(sb.buffered.length-1);if(video.currentTime<end-3)video.currentTime=Math.max(0,end-.5);if(sb.buffered.start(0)<end-12){sb.remove(sb.buffered.start(0),end-10);return;}}if(queue.length){const chunk=queue.shift();bytes-=chunk.byteLength;sb.appendBuffer(chunk);}}catch{fail('播放器緩衝失敗，請重新連線');}}
  ms.addEventListener('sourceopen',()=>{if(closed)return;const endpoint=new URL('mse',base);endpoint.protocol=endpoint.protocol==='https:'?'wss:':'ws:';ws=new WebSocket(endpoint);ws.binaryType='arraybuffer';
    ws.onopen=()=>ws.send(JSON.stringify({type:'mse',value:codecs.filter(c=>MS.isTypeSupported(`video/mp4; codecs="${c}"`)).join(',')}));
    ws.onmessage=e=>{if(closed)return;try{if(typeof e.data==='string'){const m=JSON.parse(e.data);if(m.type==='error')return fail(m.value);if(m.type==='mse'&&!sb){sb=ms.addSourceBuffer(m.value);sb.addEventListener('updateend',pump);pump();status.textContent='即時畫面 · MSE';video.play().catch(()=>{});}}else{bytes+=e.data.byteLength;if(bytes>8*1024*1024)return fail('連線過慢，請降低來源碼率');queue.push(e.data);pump();}}catch{fail('來源編碼不受此瀏覽器支援');}};
    ws.onerror=()=>fail('連線失敗或分享失效');ws.onclose=()=>{if(!closed)fail('連線已中斷或分享已失效');};
  },{once:true});
  if(window.ManagedMediaSource){video.disableRemotePlayback=true;video.srcObject=ms;}else{url=URL.createObjectURL(ms);video.src=url;}video.play().catch(()=>{});
}
mode.onchange=()=>void start();document.querySelector('#retry').onclick=()=>void start();window.addEventListener('pagehide',()=>cleanup());void start();
