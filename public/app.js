const base=new URL('.',import.meta.url).pathname;
const $=s=>document.querySelector(s);let session=null,cameras=[],tiles=[],players=new Map(),dirty=false,z=1;
let noticeTimer;function notice(text){$('#notice').textContent=text;$('#notice').classList.add('show');clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('#notice').classList.remove('show'),4500);}
async function api(path,{method='GET',value,sdp}={}){
  const headers={};if(method!=='GET'){headers['X-CSRF-Token']=session?.csrf||'';if(value!==undefined)headers['Content-Type']='application/json';if(sdp!==undefined)headers['Content-Type']='application/sdp';}
  const r=await fetch(base+path.slice(1),{method,headers,body:sdp??(value===undefined?undefined:JSON.stringify(value))});
  if(!r.ok){const e=await r.json().catch(()=>({error:'連線失敗'}));if(r.status===401&&session)exit();throw Error(e.error);}
  return sdp!==undefined?r.text():r.json();
}
function changed(){dirty=true;$('#save-state').textContent='有未儲存的變更';$('#preset').value='custom';}
function stop(id){const p=players.get(id);if(p){p.abort.abort();p.pc?.close();p.cleanup?.();players.delete(id);}}
function exit(){for(const id of players.keys())stop(id);session=null;tiles=[];$('#wall').querySelectorAll('.tile').forEach(t=>t.remove());$('#workspace').hidden=true;$('#login').hidden=false;}
async function enter(){
  [cameras,tiles]=await Promise.all([api('/api/cameras'),api('/api/layout')]);tiles=(tiles||[]).filter(t=>cameras.some(c=>c.id===t.id));
  $('#identity').textContent=session.name;$('#audit').hidden=session.role!=='admin';$('#access-log').hidden=session.role!=='admin';$('#add-camera').hidden=session.role!=='admin';$('#count').textContent=cameras.length;
  $('#setup-hint').hidden=cameras.length>0;$('#camera-list').replaceChildren();
  for(const c of cameras){const b=document.createElement('button');b.className='camera-add';const name=document.createElement('span');name.textContent=c.name;const plus=document.createElement('span');plus.textContent='+';b.append(name,plus);b.onclick=()=>add(c.id);$('#camera-list').append(b);}
  $('#login').hidden=true;$('#workspace').hidden=false;dirty=false;$('#save-state').textContent='已載入版面';render();
}
function add(id){if(tiles.some(t=>t.id===id)){notice('攝影機已在電視牆上');return;}const y=Math.min(44,tiles.reduce((v,t)=>Math.max(v,t.y+t.h),0));tiles.push({id,x:0,y,w:6,h:4});changed();render();}
function metrics(){const unit=$('#wall').clientWidth/12;return {unit,row:Math.max(34,unit*.58)};}
function position(){const {unit,row}=metrics();for(const t of tiles){const el=document.getElementById('tile-'+t.id);if(el)Object.assign(el.style,{left:t.x*unit+'px',top:t.y*row+'px',width:t.w*unit+'px',height:t.h*row+'px'});}$('#wall').style.height=Math.max(520,...tiles.map(t=>(t.y+t.h)*row+8))+'px';$('#empty').hidden=tiles.length>0;}
function button(text,label,fn){const b=document.createElement('button');b.textContent=text;b.className='tile-action';b.setAttribute('aria-label',label);b.title=label;b.onclick=fn;return b;}
function render(){
  for(const [id] of players)if(!tiles.some(t=>t.id===id))stop(id);
  for(const el of $('#wall').querySelectorAll('.tile'))if(!tiles.some(t=>'tile-'+t.id===el.id))el.remove();
  for(const t of tiles){if(document.getElementById('tile-'+t.id))continue;
    const c=cameras.find(c=>c.id===t.id),el=document.createElement('article');el.className='tile';el.id='tile-'+t.id;
    const inner=document.createElement('div');inner.className='tile-inner';const bar=document.createElement('div');bar.className='tile-bar';
    const handle=document.createElement('button');handle.className='tile-title';handle.textContent='⠿  '+c.name;handle.setAttribute('aria-label',c.name+'：拖拉或使用方向鍵移動');
    const video=document.createElement('video');video.autoplay=true;video.playsInline=true;video.muted=true;
    const status=document.createElement('span');status.className='tile-status';status.textContent='準備連線';
    const mode=document.createElement('select');mode.className='mode';mode.setAttribute('aria-label','播放方式');for(const value of ['WebRTC','MSE','FLV','RTSP']){const o=document.createElement('option');o.value=value.toLowerCase();o.textContent=value;mode.append(o);}mode.value=t.mode||'webrtc';mode.onchange=()=>{t.mode=mode.value;changed();play(t.id,video,status);};
    const resize=button('◢','調整大小',()=>{});resize.className='resize';resize.tabIndex=-1;
    bar.append(handle,mode,button('↻','重新連線',()=>play(t.id,video,status)),button('×','移除畫面',()=>{tiles=tiles.filter(a=>a.id!==t.id);changed();render();}));
    inner.append(bar,video,status,resize);el.append(inner);$('#wall').append(el);
    el.addEventListener('pointerdown',()=>{el.style.zIndex=++z;$('#wall').querySelectorAll('.selected').forEach(e=>e.classList.remove('selected'));el.classList.add('selected');});
    drag(handle,t,false);drag(resize,t,true);
    handle.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const dx=(e.key==='ArrowRight')-(e.key==='ArrowLeft'),dy=(e.key==='ArrowDown')-(e.key==='ArrowUp');if(e.shiftKey){t.w=Math.max(2,Math.min(12-t.x,t.w+dx));t.h=Math.max(2,Math.min(12,48-t.y,t.h+dy));}else{t.x=Math.max(0,Math.min(12-t.w,t.x+dx));t.y=Math.max(0,Math.min(48-t.h,t.y+dy));}changed();position();});
    play(t.id,video,status);
  }position();
}
function drag(handle,t,resize){handle.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();handle.setPointerCapture(e.pointerId);const start={...t},m=metrics();
  // Pointer coordinates and grid coordinates must be kept separate.
  const px=e.clientX,py=e.clientY;
  const move=ev=>{const dx=Math.round((ev.clientX-px)/m.unit),dy=Math.round((ev.clientY-py)/m.row);if(resize){t.w=Math.max(2,Math.min(12-t.x,start.w+dx));t.h=Math.max(2,Math.min(12,48-t.y,start.h+dy));}else{t.x=Math.max(0,Math.min(12-t.w,start.x+dx));t.y=Math.max(0,Math.min(48-t.h,start.y+dy));}changed();position();};
  const end=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);};handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
});}
async function play(id,video,status){stop(id);video.removeAttribute('src');video.srcObject=null;video.load();status.textContent='連線中…';
  const mode=tiles.find(t=>t.id===id)?.mode||'webrtc';
  if(mode==='rtsp'){status.textContent=`RTSP：使用 VLC 開啟 rtsp://${location.hostname}:8554/${id}，帳號 relay，密碼請向管理員索取（TCP）`;return;}
  if(mode==='mse')return playMSE(id,video,status);
  if(mode==='flv')return playFLV(id,video,status);
  if(!window.RTCPeerConnection){status.textContent='瀏覽器不支援 WebRTC';return;}
  const pc=new RTCPeerConnection({iceServers:[]}),abort=new AbortController();players.set(id,{pc,abort});
  pc.ontrack=e=>{video.srcObject=e.streams[0]||new MediaStream([e.track]);video.play().catch(()=>{});};
  pc.onconnectionstatechange=()=>{if(pc.connectionState==='connected')status.textContent='即時畫面';if(['failed','disconnected'].includes(pc.connectionState))status.textContent='連線中斷 · 按 ↻ 重試';};
  try{pc.addTransceiver('video',{direction:'recvonly'});pc.addTransceiver('audio',{direction:'recvonly'});await pc.setLocalDescription(await pc.createOffer());
    await new Promise((resolve,reject)=>{let timer;const finish=()=>{clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',check);abort.signal.removeEventListener('abort',cancel);resolve();};const check=()=>{if(pc.iceGatheringState==='complete')finish();};const cancel=()=>{finish();reject(Error('Cancelled'));};pc.addEventListener('icegatheringstatechange',check);abort.signal.addEventListener('abort',cancel,{once:true});timer=setTimeout(finish,2500);check();});
    if(abort.signal.aborted)return;const answer=await api('/api/play/'+id,{method:'POST',sdp:pc.localDescription.sdp});if(abort.signal.aborted)return;await pc.setRemoteDescription({type:'answer',sdp:answer});
  }catch(e){if(!abort.signal.aborted){status.textContent=e.message;pc.close();}}
}
$('#login-form').onsubmit=async e=>{e.preventDefault();const b=e.currentTarget.querySelector('button');b.disabled=true;$('#login-error').textContent='';try{session=await api('/api/login',{method:'POST',value:Object.fromEntries(new FormData(e.currentTarget))});e.target.reset();await enter();}catch(err){$('#login-error').textContent=err.message;}finally{b.disabled=false;}};
$('#logout').onclick=async()=>{try{await api('/api/logout',{method:'POST'});exit();}catch(e){notice(e.message);}};
$('#save').onclick=async()=>{const b=$('#save');b.disabled=true;try{await api('/api/layout',{method:'PUT',value:tiles});dirty=false;$('#save-state').textContent='版面已儲存';notice('已儲存你的電視牆');}catch(e){notice(e.message);}finally{b.disabled=false;}};
$('#preset').onchange=e=>{const mode=e.target.value;if(mode==='custom')return;const n=mode==='9'?3:2;tiles=cameras.slice(0,mode==='focus'?5:Number(mode)).map((c,i)=>mode==='focus'?(i===0?{id:c.id,x:0,y:0,w:8,h:8}:{id:c.id,x:8,y:(i-1)*2,w:4,h:2}):{id:c.id,x:(i%n)*(12/n),y:Math.floor(i/n)*4,w:12/n,h:4});for(const id of players.keys())stop(id);$('#wall').querySelectorAll('.tile').forEach(el=>el.remove());changed();render();};
$('#fullscreen').onclick=()=>$('#wall').requestFullscreen().catch(()=>notice('瀏覽器不支援全螢幕'));
$('#audit').onclick=async()=>{try{const rows=await api('/api/audit');$('#audit-content').textContent=rows.map(r=>`${r.time}  ${r.actor}  ${r.event}`).join('\n')||'尚無記錄';$('#audit-dialog').showModal();}catch(e){notice(e.message);}};
$('#close-audit').onclick=()=>$('#audit-dialog').close();new ResizeObserver(position).observe($('#wall'));
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
// Close media locally when an expired or revoked session is observed.
setInterval(()=>{if(session)api('/api/session').catch(()=>{});},30000);
try{session=await api('/api/session');await enter();}catch{exit();}
function playFLV(id,video,status){
  if(!window.mpegts?.isSupported()){status.textContent='此瀏覽器不支援 FLV，請選 WebRTC';return;}
  const abort=new AbortController();const p=mpegts.createPlayer({type:'flv',isLive:true,url:base+'api/flv/'+id},{enableWorker:false,enableStashBuffer:false,liveBufferLatencyChasing:true,autoCleanupSourceBuffer:true});
  players.set(id,{abort,cleanup:()=>{p.destroy();video.removeAttribute('src');video.load();}});
  p.on(mpegts.Events.ERROR,()=>{status.textContent='FLV 無法播放：請確認來源為 H.264 / AAC';});
  p.on(mpegts.Events.MEDIA_INFO,()=>{status.textContent='即時畫面 · FLV';});
  p.attachMediaElement(video);p.load();p.play()?.catch(()=>{});
}
function playMSE(id,video,status){
  const MS=window.ManagedMediaSource||window.MediaSource;
  if(!MS){status.textContent='此瀏覽器不支援 MSE，請選 WebRTC';return;}
  const abort=new AbortController(),ms=new MS();let ws,sb,queue=[],bytes=0,url;
  const cleanup=()=>{ws?.close();if(url)URL.revokeObjectURL(url);video.removeAttribute('src');video.srcObject=null;video.load();};players.set(id,{abort,cleanup});
  const error=message=>{status.textContent=message;stop(id);};
  function pump(){if(!sb||sb.updating||abort.signal.aborted)return;try{if(sb.buffered.length){const end=sb.buffered.end(sb.buffered.length-1);if(video.currentTime<end-3)video.currentTime=Math.max(0,end-.5);if(sb.buffered.start(0)<end-12){sb.remove(sb.buffered.start(0),end-10);return;}}if(queue.length){const data=queue.shift();bytes-=data.byteLength;sb.appendBuffer(data);}}catch{error('MSE 緩衝失敗，請重新連線');}}
  ms.addEventListener('sourceopen',()=>{
    if(abort.signal.aborted)return;ws=new WebSocket(location.origin.replace(/^http/,'ws')+base+'api/mse/'+id);ws.binaryType='arraybuffer';
    ws.onopen=()=>ws.send(JSON.stringify({type:'mse',value:['avc1.640029','avc1.64002A','avc1.640033','hvc1.1.6.L153.B0','mp4a.40.2','mp4a.40.5','flac','opus'].filter(c=>MS.isTypeSupported(`video/mp4; codecs="${c}"`)).join(',')}));
    ws.onmessage=e=>{if(abort.signal.aborted)return;if(typeof e.data==='string'){try{const m=JSON.parse(e.data);if(m.type==='error')return error(m.value);if(m.type==='mse'&&!sb){sb=ms.addSourceBuffer(m.value);sb.addEventListener('updateend',pump);status.textContent='即時畫面 · MSE';pump();video.play().catch(()=>{});}}catch{error('來源編碼不受瀏覽器支援');}}else{bytes+=e.data.byteLength;if(bytes>8*1024*1024)return error('連線過慢，請降低攝影機碼率');queue.push(e.data);pump();}};
    ws.onerror=()=>error('MSE 連線失敗');ws.onclose=()=>{if(!abort.signal.aborted)error('MSE 已中斷，請重新連線');};
  },{once:true});
  if(window.ManagedMediaSource){video.disableRemotePlayback=true;video.srcObject=ms;}else{url=URL.createObjectURL(ms);video.src=url;}video.play().catch(()=>{});
}

$('#add-camera').onclick=()=>{$('#add-form').reset();$('#add-form input[name=url]').type='password';$('#add-error').textContent='';$('#add-dialog').showModal();};
$('#show-url').onchange=e=>{$('#add-form input[name=url]').type=e.target.checked?'text':'password';};
$('#close-add').onclick=()=>{$('#add-form').reset();$('#add-dialog').close();};
$('#add-form').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button[type=submit]');b.disabled=true;$('#add-error').textContent='';try{const form=new FormData(e.target);const c=await api('/api/cameras',{method:'POST',value:{name:form.get('name'),url:form.get('url')}});e.target.reset();$('#add-dialog').close();cameras.push({id:c.id,name:c.name});$('#count').textContent=cameras.length;$('#setup-hint').hidden=true;const button=document.createElement('button');button.className='camera-add';button.textContent=c.name+' +';button.onclick=()=>add(c.id);$('#camera-list').append(button);add(c.id);notice(c.ready?'已加入 RTSP 播放來源':'已儲存來源，等待串流服務套用');}catch(err){$('#add-error').textContent=err.message;}finally{b.disabled=false;}};

$('#access-log').onclick=async()=>{try{const data=await api('/api/access');const when=t=>new Date(t).toLocaleString('zh-HK',{timeZone:'Asia/Hong_Kong',hour12:false});$('#access-summary').textContent=data.summary.map(r=>`${r.ip}  [${r.ip_source}]  ${r.requests} 次 / ${r.rejected} 次拒絕  最後 ${when(r.last_seen)}`).join('\n')||'尚無記錄';$('#access-content').textContent=data.rows.map(r=>`${when(r.time)}  ${r.ip}  ${r.method} ${r.path}  ${r.status||'連線中／TCP'}  ${r.actor||'未登入'}  [${r.kind}; peer=${r.peer}]`).join('\n');$('#access-dialog').showModal();}catch(e){notice(e.message);}};
$('#close-access').onclick=()=>$('#access-dialog').close();
$('#export-access').onclick=()=>{const a=document.createElement('a');a.href=base+'api/access.csv';a.download='access-log.csv';a.click();};
