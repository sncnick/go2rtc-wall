// Isolated UI fixture. Never imported by the production app or copied to its image.
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,setUser} from '../src/store.mjs';
import {createApp} from '../src/server.mjs';
const directory=mkdtempSync(join(tmpdir(),'wall-preview-'));
const db=openStore(join(directory,'wall.sqlite'));
await setUser(db,'preview','local-preview-only-2026','admin');
const list=['正門 · 測試來源','倉庫 · 測試來源','走廊 · 測試來源','停車場 · 測試來源'].map((name,i)=>({id:'camera'+i,name,url:'rtsp://192.168.1.2/synthetic'+i}));
const server=await createApp({db,list,origin:'http://localhost:8081',upstream:'http://127.0.0.1:11984',secret:'preview'});
server.listen(8081,'127.0.0.1',()=>console.log('Isolated UI fixture http://localhost:8081'+server.entrance));
process.on('SIGINT',()=>server.close(()=>{db.close();rmSync(directory,{recursive:true,force:true});process.exit(0);}));
