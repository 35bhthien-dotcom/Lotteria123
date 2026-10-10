import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

let proc, base, dataDir, startupError='';
const adminPassword='test-password-for-lucky-quiz';
async function availablePort(){return await new Promise((resolve,reject)=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});s.on('error',reject);});}
async function waitServer(){for(let i=0;i<60;i++){try{const r=await fetch(base+'/api/config');if(r.ok)return;}catch{}if(proc.exitCode!==null)break;await new Promise(r=>setTimeout(r,150));}throw Error('Server did not start: '+startupError);}
async function api(route,{method='GET',data,cookie,csrf}={}){const r=await fetch(base+route,{method,headers:{...(data?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{})},body:data?JSON.stringify(data):undefined});let body;try{body=await r.json()}catch{body=await r.text()}return {r,body};}
async function startPlayer(n){const s=await api('/api/start',{method:'POST',data:{name:`Người chơi ${n}`,phone:`09${String(n).padStart(8,'0')}`,consent:true}});assert.equal(s.r.status,201);return {cookie:s.r.headers.get('set-cookie').split(';')[0],csrf:s.body.csrf};}

before(async()=>{dataDir=await mkdtemp(path.join(os.tmpdir(),'lucky-quiz-test-'));const port=await availablePort();base=`http://127.0.0.1:${port}`;proc=spawn(process.execPath,[path.resolve('server.mjs')],{env:{...process.env,PORT:String(port),PUBLIC_ORIGIN:base,ADMIN_PASSWORD:adminPassword,SESSION_SECRET:'testing-secret-at-least-32-characters',DATA_DIR:dataDir},stdio:['ignore','pipe','pipe']});proc.stderr.on('data',d=>startupError+=d.toString());proc.stdout.on('data',d=>startupError+=d.toString());await waitServer();});
after(async()=>{proc?.kill();if(dataDir)await rm(dataDir,{recursive:true,force:true});});

test('backend allocates nine unique vouchers, makes spin idempotent, and enforces duplicate and exhausted inventory rules',async()=>{
 const codes=new Set();
 for(let n=1;n<=9;n++){
  const player=await startPlayer(n);
  for(const [questionId,answer] of [['q1',0],['q2',3],['q3',0]]){const a=await api('/api/answer',{method:'POST',cookie:player.cookie,csrf:player.csrf,data:{questionId,answer}});assert.equal(a.r.status,200);}
  const first=await api('/api/spin',{method:'POST',cookie:player.cookie,csrf:player.csrf,data:{}});assert.equal(first.r.status,200);assert.equal(first.body.won,true);codes.add(first.body.prize.code);
  const retry=await api('/api/spin',{method:'POST',cookie:player.cookie,csrf:player.csrf,data:{}});assert.deepEqual(retry.body,first.body);
 }
 assert.equal(codes.size,9);
 const duplicate=await api('/api/start',{method:'POST',data:{name:'Người chơi mới',phone:'0900000001',consent:true}});assert.equal(duplicate.body.already,true);
 const last=await startPlayer(10);for(const [questionId,answer] of [['q1',0],['q2',3],['q3',0]])await api('/api/answer',{method:'POST',cookie:last.cookie,csrf:last.csrf,data:{questionId,answer}});
 const empty=await api('/api/spin',{method:'POST',cookie:last.cookie,csrf:last.csrf,data:{}});assert.equal(empty.body.won,false);
});

test('admin can configure a closed campaign and new participation is rejected',async()=>{
 const login=await api('/api/admin/login',{method:'POST',data:{password:adminPassword}});assert.equal(login.r.status,200);const adminCookie=login.r.headers.get('set-cookie').split(';')[0];
 const summary=await api('/api/admin/summary',{cookie:adminCookie});assert.equal(summary.r.status,200);const config=summary.body.config;
 const strict=await api('/api/admin/config',{method:'POST',cookie:adminCookie,csrf:login.body.csrf,data:{...config,startAt:'2026-01-01T00:00:00.000Z',endAt:'2027-01-01T00:00:00.000Z',requireCorrect:true,fields:{email:false}}});assert.equal(strict.r.status,200);
 const player=await startPlayer(11);for(const [questionId,answer] of [['q1',1],['q2',3],['q3',0]])await api('/api/answer',{method:'POST',cookie:player.cookie,csrf:player.csrf,data:{questionId,answer}});
 const gated=await api('/api/spin',{method:'POST',cookie:player.cookie,csrf:player.csrf,data:{}});assert.equal(gated.r.status,403);
 const changed=await api('/api/admin/config',{method:'POST',cookie:adminCookie,csrf:login.body.csrf,data:{...config,startAt:'2026-01-01T00:00:00.000Z',endAt:'2026-01-02T00:00:00.000Z',fields:{email:false}}});assert.equal(changed.r.status,200);
 const ended=await api('/api/start',{method:'POST',data:{name:'Người chơi hết hạn',phone:'0912345678',consent:true}});assert.equal(ended.r.status,410);
});
