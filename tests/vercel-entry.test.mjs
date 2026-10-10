import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VERCEL='1';
process.env.UPSTASH_REDIS_REST_URL='https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN='test-token';
process.env.ADMIN_PASSWORD='vercel-test-password';
process.env.SESSION_SECRET='vercel-adapter-test-secret-has-more-than-32-chars';
const values=new Map();
globalThis.fetch=async(url,options)=>{
 assert.equal(String(url),'https://redis.test');
 assert.equal(options.headers.authorization,'Bearer test-token');
 const [command,...args]=JSON.parse(options.body);let result=null;
 if(command==='GET')result=values.get(args[0])??null;
 else if(command==='SET'){const [key,value,...flags]=args;if(flags.includes('NX')&&values.has(key))result=null;else{values.set(key,String(value));result='OK';}}
 else if(command==='EVAL'){values.delete(args[2]);result=1;}
 else throw Error(`Unsupported mock Redis command: ${command}`);
 return new Response(JSON.stringify({result}),{status:200,headers:{'content-type':'application/json'}});
};
const {default:handler}=await import('../api/[...path].mjs');
function request(method,url,{body,headers={}}={}){
 const req={method,url,body,headers,socket:{remoteAddress:'127.0.0.1'},async *[Symbol.asyncIterator](){if(body!==undefined)yield JSON.stringify(body);}};
 const res={headers:{},headersSent:false,statusCode:200,writeHead(status,headers){this.statusCode=status;Object.assign(this.headers,headers);this.headersSent=true;},setHeader(key,value){this.headers[key]=value;},end(value=''){this.body=String(value);this.finished=true;}};
 return {req,res};
}
async function call(method,url,options){const pair=request(method,url,options);await handler(pair.req,pair.res);return pair.res;}

test('Vercel catch-all API persists campaign and player session through Redis between invocations',async()=>{
 const config=await call('GET','/api/config');assert.equal(config.statusCode,200);assert.equal(JSON.parse(config.body).questions.length,3);
 const start=await call('POST','/api/start',{body:{name:'Người chơi kiểm thử',phone:'0912345678',consent:true}});assert.equal(start.statusCode,201);
 const cookie=start.headers['set-cookie'].split(';')[0],csrf=JSON.parse(start.body).csrf;
 for(const [questionId,answer] of [['q1',0],['q2',3],['q3',0]]){
  const response=await call('POST','/api/answer',{headers:{cookie,'x-csrf-token':csrf},body:{questionId,answer}});assert.equal(response.statusCode,200);
 }
 const spin=await call('POST','/api/spin',{headers:{cookie,'x-csrf-token':csrf},body:{}});assert.equal(spin.statusCode,200);const result=JSON.parse(spin.body);assert.equal(result.won,true);assert.equal(result.prize.code,'999-489-654-733');
 const persisted=JSON.parse(values.get('lucky-quiz:state:v1'));assert.equal(persisted.data.issued.length,1);assert.equal(persisted.runtime.sessions.length,1);
});
