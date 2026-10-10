import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes, randomInt, createHmac, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB = path.join(DATA, 'store.json');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || '';
const ORIGIN = process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`;
const IS_VERCEL = process.env.VERCEL === '1';
const KV_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KV_STATE_KEY = 'lucky-quiz:state:v1';
const KV_LOCK_KEY = 'lucky-quiz:state-lock:v1';
const voucherCodes = ['999-489-654-733','999-370-349-509','999-386-460-696','999-387-395-702','999-310-220-632','999-124-998-613','999-105-596-671','999-848-216-413','999-123-628-442'];
const seed = { config:{name:'Vòng quay vị ngon',startAt:'2026-01-01T00:00:00+07:00',endAt:'2027-01-01T00:00:00+07:00',requireCorrect:false,fields:{name:true,phone:true,email:false},privacy:'Thông tin được sử dụng để xác minh lượt chơi và trao voucher theo thể lệ chương trình.'}, questions:[
 {id:'q1',type:'single',text:'Món gà ngon bắt đầu từ điều gì?',answers:['Nguyên liệu tươi ngon','May mắn','Một chiếc đĩa đẹp','Bí mật của đầu bếp'],correct:0},
 {id:'q2',type:'single',text:'Bạn thường chọn món ăn theo tiêu chí nào?',answers:['Hương vị','Giá cả','Khẩu phần','Tất cả những điều trên'],correct:3},
 {id:'q3',type:'single',text:'Bạn muốn thưởng thức món nào hôm nay?',answers:['Cơm gà sốt đậu nành','Gà rán','Burger','Món tráng miệng'],correct:0}],prizes:[{id:'set',name:'Soybean Chicken Rice Set',subtitle:'Mã voucher dùng cho một phần cơm gà sốt đậu nành',color:'#f4b942',weight:100,limit:9,remaining:9}],participants:[],issued:[],events:[],usedCodes:[] };
let state;
let saveQueue=Promise.resolve();
const sessions=new Map(), startAttempts=new Map(), answerAttempts=new Map(), configAttempts=new Map(), spins=new Map(), adminAttempts=new Map();
if(!IS_VERCEL){
 await mkdir(DATA,{recursive:true});
 try { state=JSON.parse(await readFile(DB,'utf8')); } catch { state=structuredClone(seed); await persist(); }
}else state=structuredClone(seed);
async function persist(){ if(IS_VERCEL)return; saveQueue=saveQueue.then(()=>writeFile(DB,JSON.stringify(state,null,2),'utf8')); return saveQueue; }
async function redisCommand(...command){
 const response=await fetch(KV_URL,{method:'POST',headers:{authorization:`Bearer ${KV_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(command)});
 const result=await response.json();if(!response.ok||result.error)throw new Error(`Storage request failed: ${result.error||response.status}`);return result.result;
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function restoreMap(map,entries){map.clear();for(const [key,value] of entries||[])map.set(key,value);}
async function withRemoteState(action){
 if(!KV_URL||!KV_TOKEN)return {status:503,body:{error:'Vercel storage is not configured. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.'}};
 if(!ADMIN_PASSWORD||SECRET.length<32)return {status:503,body:{error:'Admin credentials are not configured. Add ADMIN_PASSWORD and a SESSION_SECRET with at least 32 characters.'}};
 const lockToken=randomBytes(24).toString('hex');let locked=false;
 for(let i=0;i<60;i++){const result=await redisCommand('SET',KV_LOCK_KEY,lockToken,'NX','PX',25000);if(result==='OK'){locked=true;break;}await sleep(100);}
 if(!locked)return {status:503,body:{error:'Storage is busy. Please retry shortly.'}};
 try{
  const raw=await redisCommand('GET',KV_STATE_KEY);const saved=raw?JSON.parse(raw):null;
  state=saved?.data||structuredClone(seed);
  const maps=saved?.runtime||{};
  restoreMap(sessions,maps.sessions);restoreMap(spins,maps.spins);restoreMap(startAttempts,maps.startAttempts);restoreMap(answerAttempts,maps.answerAttempts);restoreMap(configAttempts,maps.configAttempts);restoreMap(adminAttempts,maps.adminAttempts);
  const result=await action();
  const runtime={sessions:[...sessions],spins:[...spins],startAttempts:[...startAttempts],answerAttempts:[...answerAttempts],configAttempts:[...configAttempts],adminAttempts:[...adminAttempts]};
  await redisCommand('SET',KV_STATE_KEY,JSON.stringify({data:state,runtime}));
  return result;
 }finally{
  await redisCommand('EVAL',"if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",1,KV_LOCK_KEY,lockToken).catch(()=>{});
 }
}
function event(type,detail={}){state.events.push({id:randomBytes(8).toString('hex'),type,at:new Date().toISOString(),...detail}); if(state.events.length>5000) state.events=state.events.slice(-5000);}
function json(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'same-origin'});res.end(JSON.stringify(data));}
function cookie(req,name){const c=req.headers.cookie||'';return c.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1)||'';}
function sign(v){return createHmac('sha256',SECRET).update(v).digest('hex');}
function getSession(req){const tok=cookie(req,'lq_session');if(!tok)return null; const [id,sig]=tok.split('.'); if(!id||!sig||!safeEq(sig,sign(id)))return null; const s=sessions.get(id); if(s&&s.expires>Date.now())return s; sessions.delete(id);return null;}
function safeEq(a,b){const aa=Buffer.from(String(a)),bb=Buffer.from(String(b));return aa.length===bb.length&&timingSafeEqual(aa,bb);}
function csrf(req){const normal=getSession(req);const adminToken=cookie(req,'lq_admin'),[adminId,adminSig]=adminToken.split('.'),admin=adminId&&adminSig&&safeEq(adminSig,sign(adminId))?sessions.get(adminId):null;return req.headers['x-csrf-token']&&(normal?.csrf===req.headers['x-csrf-token']||admin?.csrf===req.headers['x-csrf-token']);}
async function body(req){
 if(req.body!==undefined){if(typeof req.body==='string')return JSON.parse(req.body||'{}');if(req.body&&typeof req.body==='object')return req.body;}
 let s='';for await(const c of req){s+=c;if(s.length>20000)throw new Error('too_large');}return JSON.parse(s||'{}');
}
function limited(map,key,max,window){const now=Date.now(),a=(map.get(key)||[]).filter(t=>now-t<window);if(a.length>=max){map.set(key,a);return false;}a.push(now);map.set(key,a);return true;}
function phoneOk(s){return /^0\d{9}$/.test(s);}
function active(){const now=Date.now();return now>=Date.parse(state.config.startAt)&&now<Date.parse(state.config.endAt);}
function publicConfig(){return {name:state.config.name,active:active(),endAt:state.config.endAt,fields:state.config.fields,privacy:state.config.privacy,questions:state.questions.map(({id,type,text,answers})=>({id,type,text,answers})),prizes:state.prizes.map(({id,name,subtitle,color})=>({id,name,subtitle,color}))};}
async function routeRequest(req,res){
 try{
  const forwarded=req.headers['x-forwarded-for'];const url=new URL(req.url,ORIGIN),ip=(Array.isArray(forwarded)?forwarded.join(','):forwarded||req.socket?.remoteAddress||'').split(',')[0].trim();
  if(req.method==='GET'&&url.pathname==='/api/config') return json(res,200,publicConfig());
  if(req.method==='POST'&&url.pathname==='/api/start'){
   if(!limited(startAttempts,ip,15,60000))return json(res,429,{error:'Bạn thao tác quá nhanh. Vui lòng thử lại sau.'});
   const b=await body(req),f=state.config.fields;
   if(!b.consent)return json(res,400,{error:'Vui lòng xác nhận đã đọc thông báo quyền riêng tư.'});
   if(f.name&&(!b.name||String(b.name).trim().length<2||String(b.name).length>80))return json(res,400,{error:'Vui lòng nhập họ tên hợp lệ.'});
   if(f.phone&&!phoneOk(String(b.phone||'')))return json(res,400,{error:'Số điện thoại cần có 10 chữ số và bắt đầu bằng 0.'});
   if(f.email&&(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email||'')))return json(res,400,{error:'Vui lòng nhập email hợp lệ.'});
   if(!active())return json(res,410,{error:'Chương trình hiện không hoạt động.'});
   const identity=f.phone?String(b.phone):String(b.email||'');
   const prior=state.participants.find(p=>p.identity===identity&&p.program===state.config.name);
   if(prior)return json(res,200,{already:true,message:'Số điện thoại này đã tham gia chương trình.'});
   const id=randomBytes(18).toString('hex'),csrfToken=randomBytes(24).toString('hex');sessions.set(id,{id,csrf:csrfToken,expires:Date.now()+2*60*60*1000,identity,answers:0,score:0,played:false,person:{name:String(b.name||'').trim(),phone:String(b.phone||''),email:String(b.email||'')}});
   state.participants.push({identity,program:state.config.name,createdAt:new Date().toISOString()});event('start');await persist();
   res.setHeader('set-cookie',`lq_session=${id}.${sign(id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=7200${process.env.NODE_ENV==='production'?'; Secure':''}`);
   return json(res,201,{csrf:csrfToken,questions:publicConfig().questions});
  }
  let session=getSession(req);
  if(req.method==='POST'&&url.pathname==='/api/answer'){
   if(!session||!csrf(req))return json(res,401,{error:'Phiên chơi đã hết hạn. Vui lòng bắt đầu lại.'});
   if(!limited(answerAttempts,ip,50,60000))return json(res,429,{error:'Bạn thao tác quá nhanh.'});
   const b=await body(req),q=state.questions.find(x=>x.id===b.questionId);if(!q)return json(res,404,{error:'Không tìm thấy câu hỏi.'});
   if(session.answers!==state.questions.findIndex(x=>x.id===q.id))return json(res,409,{error:'Câu hỏi không đúng thứ tự.'});
   const idx=Number(b.answer);if(!Number.isInteger(idx)||idx<0||idx>=q.answers.length)return json(res,400,{error:'Đáp án không hợp lệ.'});
   const correct=idx===q.correct;session.answers++;if(correct)session.score++;event('answer',{correct});await persist();return json(res,200,{correct,complete:session.answers>=state.questions.length,score:session.score});
  }
  if(req.method==='POST'&&url.pathname==='/api/spin'){
   if(!session||!csrf(req))return json(res,401,{error:'Phiên chơi đã hết hạn. Vui lòng bắt đầu lại.'});
   const key=session.id;if(spins.has(key))return json(res,200,spins.get(key));
   if(session.played)return json(res,409,{error:'Lượt chơi này đã được sử dụng.'});
   if(session.answers<state.questions.length)return json(res,403,{error:'Hãy hoàn thành tất cả câu hỏi trước khi quay.'});
   if(state.config.requireCorrect&&session.score<state.questions.length)return json(res,403,{error:'Bạn cần trả lời đúng tất cả câu hỏi để nhận lượt quay.'});
   if(!active())return json(res,410,{error:'Chương trình đã kết thúc.'});
   session.played=true;
   const prize=state.prizes.find(p=>p.id==='set'&&p.remaining>0);
   if(!prize){event('out_of_stock');await persist();const result={won:false,message:'Rất tiếc, voucher đã được nhận hết.'};spins.set(key,result);return json(res,200,result);}
   const used=new Set(state.usedCodes),code=voucherCodes.find(c=>!used.has(c));if(!code){event('out_of_stock');await persist();return json(res,200,{won:false,message:'Rất tiếc, voucher đã được nhận hết.'});}
   prize.remaining--;state.usedCodes.push(code);const issued={id:randomBytes(10).toString('hex'),participant:session.person,code,prize:prize.name,issuedAt:new Date().toISOString(),expiresAt:state.config.endAt,status:'unused'};state.issued.push(issued);event('voucher_issued',{prize:prize.id});await persist();
   const result={won:true,prize:{name:prize.name,subtitle:prize.subtitle,code,issuedAt:issued.issuedAt,expiresAt:issued.expiresAt,terms:'Áp dụng cho món Soybean Chicken Rice Set. Xuất trình mã voucher tại quầy khi đặt món. Mỗi mã chỉ sử dụng một lần.'}};spins.set(key,result);return json(res,200,result);
  }
  if(url.pathname.startsWith('/api/admin')){
   if(req.method==='POST'&&url.pathname==='/api/admin/login'){
    if(!ADMIN_PASSWORD||!SECRET)return json(res,503,{error:'Admin chưa cấu hình. Hãy thiết lập ADMIN_PASSWORD và SESSION_SECRET.'});
    if(!limited(adminAttempts,ip,6,15*60*1000))return json(res,429,{error:'Thử đăng nhập quá nhiều lần. Vui lòng chờ 15 phút.'});
    const b=await body(req);if(!safeEq(b.password||'',ADMIN_PASSWORD))return json(res,401,{error:'Mật khẩu không chính xác.'});const id=randomBytes(24).toString('hex'),csrfToken=randomBytes(24).toString('hex');sessions.set(id,{id,csrf:csrfToken,expires:Date.now()+8*60*60*1000,admin:true});res.setHeader('set-cookie',`lq_admin=${id}.${sign(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.NODE_ENV==='production'?'; Secure':''}`);return json(res,200,{csrf:csrfToken});
   }
   const token=cookie(req,'lq_admin'),[id,sig]=token.split('.'),admin=id&&sig&&safeEq(sig,sign(id))?sessions.get(id):null;if(!admin?.admin||admin.expires<Date.now())return json(res,401,{error:'Vui lòng đăng nhập quản trị.'});
   if(req.method==='GET'&&url.pathname==='/api/admin/summary')return json(res,200,{config:state.config,questions:state.questions,prizes:state.prizes,issued:state.issued,stats:{participants:state.participants.length,spins:state.events.filter(e=>e.type==='voucher_issued'||e.type==='out_of_stock').length,issued:state.issued.length,remaining:state.prizes.reduce((n,p)=>n+p.remaining,0)},events:state.events.slice(-30).reverse()});
   if(req.method==='POST'&&url.pathname==='/api/admin/config'){
    if(!csrf(req)||!limited(configAttempts,ip,20,60000))return json(res,403,{error:'Yêu cầu không hợp lệ.'});const b=await body(req);if(!b.name||!Number.isFinite(Date.parse(b.startAt))||!Number.isFinite(Date.parse(b.endAt))||Date.parse(b.endAt)<=Date.parse(b.startAt))return json(res,400,{error:'Tên chương trình và khoảng thời gian hợp lệ là bắt buộc.'});state.config={...state.config,name:String(b.name).slice(0,100),startAt:b.startAt,endAt:b.endAt,requireCorrect:!!b.requireCorrect,privacy:String(b.privacy||'').slice(0,500),fields:{name:true,phone:true,email:!!b.fields?.email}};event('config_updated');await persist();return json(res,200,{ok:true});
   }
   if(req.method==='POST'&&url.pathname==='/api/admin/question'){
    if(!csrf(req))return json(res,403,{error:'Yêu cầu không hợp lệ.'});const b=await body(req);if(!b.text||!Array.isArray(b.answers)||b.answers.length<2||b.answers.length>5||!Number.isInteger(b.correct)||b.correct<0||b.correct>=b.answers.length)return json(res,400,{error:'Câu hỏi cần có 2-5 đáp án và đáp án đúng hợp lệ.'});if(state.questions.length>=10)return json(res,400,{error:'Tối đa 10 câu hỏi.'});state.questions.push({id:randomBytes(6).toString('hex'),type:'single',text:String(b.text).slice(0,240),answers:b.answers.map(x=>String(x).slice(0,120)),correct:b.correct});event('question_added');await persist();return json(res,200,{ok:true});
   }
   if(req.method==='POST'&&url.pathname==='/api/admin/export'){
    if(!csrf(req))return json(res,403,{error:'Yêu cầu không hợp lệ.'});const csv=['Mã voucher,Phần thưởng,Thời gian phát hành,Hết hạn,Trạng thái,Họ tên,Số điện thoại',...state.issued.map(v=>[v.code,v.prize,v.issuedAt,v.expiresAt,v.status,v.participant.name,v.participant.phone].map(x=>'"'+String(x||'').replaceAll('"','""')+'"').join(','))].join('\r\n');res.writeHead(200,{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="lucky-quiz-vouchers.csv"','cache-control':'no-store'});return res.end('\ufeff'+csv);
   }
   return json(res,404,{error:'Không tìm thấy API quản trị.'});
  }
  if(req.method==='GET'){
   const rel=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));const full=path.resolve(PUBLIC,rel);if(!full.startsWith(PUBLIC+path.sep)&&full!==PUBLIC)return json(res,403,{error:'Forbidden'});
   let bytes;try{bytes=await readFile(full);}catch{return json(res,404,{error:'Không tìm thấy trang.'});}const ext=path.extname(full);const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'}[ext]||'application/octet-stream';res.writeHead(200,{'content-type':mime,'cache-control':'no-cache','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'"});return res.end(bytes);
  }
  json(res,404,{error:'Not found'});
 }catch(e){console.error(e);json(res,e.message==='too_large'?413:500,{error:e.message==='too_large'?'Dữ liệu quá lớn':'Đã có lỗi máy chủ. Vui lòng thử lại.'});}
}
export async function handle(req,res){
 if(!IS_VERCEL)return routeRequest(req,res);
 try{
  const result=await withRemoteState(()=>routeRequest(req,res));
  if(result?.status)return json(res,result.status,result.body);
 }catch(error){console.error('Vercel function error:',error);if(!res.headersSent)return json(res,503,{error:'Temporary server or storage error. Check Vercel environment variables and retry.'});}
}
if(!IS_VERCEL)http.createServer(handle).listen(PORT,()=>console.log(`Lucky Quiz running on ${ORIGIN}`));
