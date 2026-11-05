import {writeFileSync, existsSync} from 'node:fs';
import {createInterface} from 'node:readline/promises';
import {randomBytes} from 'node:crypto';
import {openStore,setUser,audit} from './store.mjs';
import {cameras,engineConfig} from './config.mjs';
const [command,name,role='viewer'] = process.argv.slice(2);
if (command === 'setup') {
  if (existsSync('.env')) throw Error('.env already exists; refusing to overwrite secrets');
  writeFileSync('.env', `GO2RTC_PASSWORD=${randomBytes(32).toString('hex')}\nRTSP_PASSWORD=${randomBytes(32).toString('hex')}\nLOGIN_PATH=/${randomBytes(20).toString('hex')}/\nTRUSTED_PROXY_IPS=\nAPP_ORIGIN=http://localhost:8080\nBIND_ADDRESS=127.0.0.1\nMEDIA_HOST=127.0.0.1\n`, {mode:0o600,flag:'wx'});
  if (!existsSync('config/cameras.json')) writeFileSync('config/cameras.json','[]\n',{mode:0o600,flag:'wx'});
  console.log('Created .env and camera list. Set MEDIA_HOST to your Docker host LAN IPv4.');
} else if (command === 'entrance') {
  const db=openStore();const saved=db.prepare("SELECT value FROM settings WHERE name='login_path'").get();const path=process.env.LOGIN_PATH||(saved?JSON.parse(saved.value):null);if(!path)throw Error('Start gateway first');console.log((process.env.APP_ORIGIN||'http://localhost:8080')+path);db.close();
} else if (command === 'generate') {
  writeFileSync('/generated/go2rtc.json',JSON.stringify(engineConfig(cameras(),process.env.GO2RTC_PASSWORD,process.env.MEDIA_HOST,process.env.RTSP_PASSWORD),null,2),{mode:0o600});
  console.log('Validated camera configuration generated.');
} else if (command === 'user') {
  if (!process.stdin.isTTY) throw Error('Run interactively with docker compose run --rm gateway node src/cli.mjs user NAME ROLE');
  const rl=createInterface({input:process.stdin,output:process.stdout});
  // Disable terminal echo while readline collects the password.
  rl._writeToOutput = function(s) { if (!this.muted) process.stdout.write(s); };
  process.stdout.write('Password (14+ characters, hidden): '); rl.muted=true;
  const password=await rl.question(''); process.stdout.write('\nConfirm password: ');
  const confirm=await rl.question(''); rl.close(); process.stdout.write('\n');
  if(password!==confirm) throw Error('Passwords do not match');
  const db=openStore(); await setUser(db,name,password,role); audit(db,'console',`user.updated:${name}`); db.close();
} else { throw Error('Commands: setup | generate | user NAME admin|viewer'); }
