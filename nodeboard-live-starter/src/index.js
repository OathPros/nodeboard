import { DurableObject } from 'cloudflare:workers';
export { DocumentDirectory } from './directory.js';

const MAX_NODES = 3000;
const MAX_EDGES = 6000;
const MAX_CLASSES = 1500;
const MAX_OPS = 100;
const MAX_MESSAGE = 500_000;
const SHAPES = new Set(['rounded','rectangle','pill','ellipse','diamond','hexagon','document','circle']);
const CORS_HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };

function json(data, status=200) { return new Response(JSON.stringify(data), {status,headers:{'content-type':'application/json; charset=utf-8',...CORS_HEADERS}}); }
function token(bytes=24) { const raw=crypto.getRandomValues(new Uint8Array(bytes)); return Array.from(raw,b=>b.toString(16).padStart(2,'0')).join(''); }
async function sha256(s) { const bytes = new TextEncoder().encode(s); const digest = await crypto.subtle.digest('SHA-256', bytes); return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''); }
function equalHex(a,b) { if(!a||!b||a.length!==b.length) return false; let d=0; for(let i=0;i<a.length;i++)d |= a.charCodeAt(i)^b.charCodeAt(i); return d===0; }
function validId(s) { return typeof s==='string'&&/^[a-zA-Z0-9_-]{1,120}$/.test(s); }
function validClass(c,i) {return !!c && validId(c.id) && Number.isInteger(c.key)&&c.key===i+1&&typeof c.name==='string'&&c.name.length>0&&c.name.length<=34&&SHAPES.has(c.shape)&&/^#[0-9a-fA-F]{6}$/.test(c.color);}
function validGraph(g) {
 if(!g||!Array.isArray(g.nodes)||!Array.isArray(g.edges)||!Array.isArray(g.classes)||!g.classes.length||g.nodes.length>MAX_NODES||g.edges.length>MAX_EDGES||g.classes.length>MAX_CLASSES||!g.classes.every(validClass))return false;
 const nodes = new Set();const classIds = new Set(g.classes.map(c=>c.id));if(classIds.size!==g.classes.length)return false;
 const pairs=new Set();for(const c of g.classes){if(c.relations===undefined)continue;if(!Array.isArray(c.relations)||c.relations.length>MAX_CLASSES)return false;for(const r of c.relations){if(!r||!classIds.has(r.to)||typeof r.label!=='string'||!r.label.trim()||r.label.length>90||typeof r.inverse!=='string'||r.inverse.length>90||(r.to===c.id&&r.inverse))return false;const key=JSON.stringify([c.id,r.to].sort());if(pairs.has(key))return false;pairs.add(key)}}
 for(const n of g.nodes){if(!n||!validId(n.id)||nodes.has(n.id)||!Number.isFinite(n.x)||!Number.isFinite(n.y)||Math.abs(n.x)>1e7||Math.abs(n.y)>1e7||typeof n.name!=='string'||n.name.length>110||!classIds.has(n.classId))return false;if(n.shapeOverride!==undefined&&n.shapeOverride!==null&&!SHAPES.has(n.shapeOverride))return false;if(n.colorOverride!==undefined&&n.colorOverride!==null&&!/^#[0-9a-fA-F]{6}$/.test(n.colorOverride))return false;nodes.add(n.id)}
 const edges=new Set();for(const e of g.edges){if(!e||!validId(e.id)||edges.has(e.id)||!nodes.has(e.from)||!nodes.has(e.to)||typeof e.label!=='string'||e.label.length>90)return false;edges.add(e.id)}return true;
}
function applyOps(g,ops) {
 for(const op of ops){if(!op||typeof op.type!=='string')throw new Error('Malformed operation');
  if(op.type==='classes.replace'){if(!Array.isArray(op.classes))throw new Error('Invalid class array');g.classes=structuredClone(op.classes);continue;}
  const m=/^(node|edge)\.(upsert|patch|delete)$/.exec(op.type);if(!m)throw new Error('Unsupported operation');
  const field=m[1]==='node'?'nodes':'edges',entity=m[1],action=m[2];const id=op.id||op[entity]?.id;if(!validId(id))throw new Error('Invalid entity ID');const list=g[field],index=list.findIndex(x=>x.id===id);
  if(action==='delete'){if(index>=0)list.splice(index,1);if(entity==='node')g.edges=g.edges.filter(e=>e.from!==id&&e.to!==id);continue;}
  if(action==='upsert'){const obj=op[entity];if(!obj||obj.id!==id)throw new Error('Bad upsert');if(index>=0)list[index]=structuredClone(obj);else list.push(structuredClone(obj));continue;}
  if(index<0)throw new Error('Entity removed by another participant');
  if(!op.patch||typeof op.patch!=='object'||Array.isArray(op.patch)||'id'in op.patch||Object.keys(op.patch).length>12)throw new Error('Bad patch');
  const allowed=entity==='node'?['x','y','name','classId','colorOverride','shapeOverride']:['label','from','to'];
  if(Object.keys(op.patch).some(k=>!allowed.includes(k)))throw new Error('Disallowed patch field');
  Object.assign(list[index],structuredClone(op.patch));
 }
 if(!validGraph(g))throw new Error('Changes would produce an invalid graph');
 return g;
}
function wsSend(ws,msg){try{ws.send(JSON.stringify(msg))}catch(_){}}

function directory(env){return env.DOCUMENT_DIRECTORY.get(env.DOCUMENT_DIRECTORY.idFromName('directory'))}
async function directoryCall(env,path,data){return directory(env).fetch('https://directory.internal'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)})}
async function authenticatedUser(env,accessToken){
 if(!env.SUPABASE_URL||!env.SUPABASE_PUBLISHABLE_KEY)throw new Error('Accounts are not configured');
 if(typeof accessToken!=='string'||accessToken.length>8192||!accessToken)return null;
 const response=await fetch(`${env.SUPABASE_URL}/auth/v1/user`,{headers:{apikey:env.SUPABASE_PUBLISHABLE_KEY,authorization:`Bearer ${accessToken}`}});
 if(response.status===401||response.status===403)return null;
 if(!response.ok)throw new Error('Authentication service unavailable');
 const user=await response.json();
 if(!validId(user.id)||typeof user.email!=='string'||!user.email_confirmed_at)return null;
 return {id:user.id,email:user.email.trim().toLowerCase()};
}
async function requestUser(request,env){const auth=request.headers.get('authorization')||'';return authenticatedUser(env,auth.startsWith('Bearer ')?auth.slice(7):'')}
function tokenExpiry(token){try{const payload=token.split('.')[1];return JSON.parse(atob(payload.replace(/-/g,'+').replace(/_/g,'/'))).exp||0}catch{return 0}}
function documentStub(env,id){return env.BOARD_SESSIONS.get(env.BOARD_SESSIONS.idFromName(id))}

// Best-effort per-isolate rate limit for session creation (per client IP).
const createHits=new Map();
const CREATE_LIMIT=30,CREATE_WINDOW=3600_000;
function rateLimited(ip){const now=Date.now(),e=createHits.get(ip)||{count:0,reset:now+CREATE_WINDOW};if(now>e.reset){e.count=0;e.reset=now+CREATE_WINDOW}e.count++;createHits.set(ip,e);if(createHits.size>10000)createHits.clear();return e.count>CREATE_LIMIT}

export default {
 async fetch(request,env) {
  const url=new URL(request.url),path=url.pathname;
  if(path==='/api/health')return json({ok:true,service:'nodeboard-live',version:1});
  if(path==='/api/account/config'&&request.method==='GET')return json({enabled:!!(env.SUPABASE_URL&&env.SUPABASE_PUBLISHABLE_KEY),url:env.SUPABASE_URL||null,key:env.SUPABASE_PUBLISHABLE_KEY||null});
  if(path.startsWith('/api/documents')||path.startsWith('/api/templates')||path==='/api/account'){
   try {
    const wsMatch=/^\/api\/documents\/([A-Za-z0-9_-]{8,120})\/ws$/.exec(path);
    if(wsMatch){if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return json({error:'Expected WebSocket upgrade'},426);const origin=request.headers.get('Origin');if(origin&&origin!==url.origin)return json({error:'Cross-origin connections not allowed'},403);return documentStub(env,wsMatch[1]).fetch(request)}
    const user=await requestUser(request,env);if(!user)return json({error:'Sign in required'},401);
    const registered=await directoryCall(env,'/register',{user});if(!registered.ok)return registered;
    if(path==='/api/account'&&request.method==='GET')return json({user});
    if(path==='/api/templates'&&request.method==='GET')return directoryCall(env,'/templates-list',{user});
    if(path==='/api/templates'&&request.method==='POST'){
     if(rateLimited(request.headers.get('CF-Connecting-IP')||'local'))return json({error:'Too many templates created — try again later'},429);
     if(Number(request.headers.get('content-length')||0)>450_000)return json({error:'Template too large'},413);
     const data=await request.json(),name=typeof data.name==='string'?data.name.trim().slice(0,80):'';
     if(!name||!validGraph({classes:data.classes,nodes:[],edges:[]}))return json({error:'Invalid template name or classes'},400);
     const classes=data.classes.map(c=>({id:c.id,key:c.key,name:c.name,shape:c.shape,color:c.color,...(c.relations?{relations:c.relations.map(r=>({to:r.to,label:r.label,inverse:r.inverse}))}:{})}));
     if(JSON.stringify(classes).length>400_000)return json({error:'Template too large'},413);
     return directoryCall(env,'/templates-create',{user,id:token(16),name,classes});
    }
    const templateMatch=/^\/api\/templates\/([A-Za-z0-9_-]{8,120})$/.exec(path);
    if(templateMatch&&request.method==='DELETE')return directoryCall(env,'/templates-delete',{user,id:templateMatch[1]});
    if(path==='/api/documents'&&request.method==='GET')return directoryCall(env,'/list',{user});
    if(path==='/api/documents'&&request.method==='POST'){
     if(rateLimited(request.headers.get('CF-Connecting-IP')||'local'))return json({error:'Too many documents created — try again later'},429);
     if(Number(request.headers.get('content-length')||0)>450_000)return json({error:'Board too large'},413);
     const data=await request.json(),name=String(data.name||'').trim().slice(0,80);if(!name||!validGraph(data.graph))return json({error:'Invalid document name or graph'},400);
     const id=token(16),registeredDoc=await directoryCall(env,'/create',{id,user,name});if(!registeredDoc.ok)return registeredDoc;
     let initialized;try{initialized=await documentStub(env,id).fetch('https://room.internal/init-private',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,name,graph:data.graph})})}catch(e){console.error('Document initialization failed:',e.message)}
     if(!initialized?.ok){const cleanup=await directoryCall(env,'/delete',{id,user});if(!cleanup.ok)console.error('Failed to remove incomplete document');return json({error:'Unable to create document'},502)}
     return json({id,name},201);
    }
    const match=/^\/api\/documents\/([A-Za-z0-9_-]{8,120})(?:\/(members|share|unshare|rename))?$/.exec(path);if(!match)return json({error:'Not found'},404);
    const id=match[1],action=match[2];
    if(request.method==='GET'&&(action==='members'||!action))return directoryCall(env,action?'/members':'/access',{id,user});
    if(request.method==='POST'&&['share','unshare','rename'].includes(action)){
     const data=await request.json(),email=typeof data.email==='string'?data.email.trim().toLowerCase():'',name=typeof data.name==='string'?data.name.trim().slice(0,80):'';
     if((action==='share'||action==='unshare')&&(!email||email.length>254))return json({error:'Enter a valid email address'},400);
     if(action==='rename'&&!name)return json({error:'Enter a document name'},400);
     const result=await directoryCall(env,'/'+action,{id,user,email,name,role:data.role});
     if(!result.ok)return result;
     if(action==='share'||action==='unshare'){const body=await result.json();const closed=await documentStub(env,id).fetch('https://room.internal/recheck',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:body.userId})});if(!closed.ok)return json({error:'Access changed, but disconnect failed; retry the operation.'},502)}
     return json({ok:true});
    }
    if(request.method==='DELETE'&&!action){const result=await directoryCall(env,'/delete',{id,user});if(!result.ok)return result;const deleted=await documentStub(env,id).fetch('https://room.internal/delete-private',{method:'POST'});if(!deleted.ok)return json({error:'Access removed, but document cleanup failed.'},502);return json({ok:true})}
    return json({error:'Not found'},404);
   }catch(e){console.error('Document request failed:',e.message);return json({error:'Document service unavailable'},503)}
  }
  if(path==='/api/sessions'&&request.method==='POST'){
   try {
    const ip=request.headers.get('CF-Connecting-IP')||'local';
    if(rateLimited(ip))return json({error:'Too many sessions created — try again later'},429);
    if(Number(request.headers.get('content-length')||0)>450_000)return json({error:'Board too large'},413);
    const input=await request.json(); const title=String(input.name||'Untitled workshop').trim().slice(0,80);
    if(!validGraph(input.graph))return json({error:'Invalid graph'},400);
    const id=token(16),editToken=token(24),viewToken=token(24),ownerToken=token(24),stub=env.BOARD_SESSIONS.get(env.BOARD_SESSIONS.idFromName(id));
    const init=await stub.fetch('https://room.internal/init',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:title||'Untitled workshop',graph:input.graph,editHash:await sha256(editToken),viewHash:await sha256(viewToken),ownerHash:await sha256(ownerToken)})});
    if(!init.ok)return json({error:'Unable to initialize session'},502);
    return json({id,editToken,viewToken,ownerToken,revision:0},201);
   }catch(_){return json({error:'Invalid session request'},400)}
  }
  const ownerMatch=/^\/api\/sessions\/([A-Za-z0-9_-]{8,120})\/(rotate|delete)$/.exec(path);
  if(ownerMatch&&request.method==='POST'){
   try {
    const body=await request.json().catch(()=>({}));
    const ownerTok=String(body.ownerToken||'');
    if(!/^[0-9a-f]{48}$/.test(ownerTok))return json({error:'Owner token required'},401);
    const stub=env.BOARD_SESSIONS.get(env.BOARD_SESSIONS.idFromName(ownerMatch[1]));
    const res=await stub.fetch(`https://room.internal/${ownerMatch[2]}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ownerHash:await sha256(ownerTok)})});
    return new Response(res.body,{status:res.status,headers:{'content-type':'application/json; charset=utf-8',...CORS_HEADERS}});
   }catch(_){return json({error:'Invalid owner request'},400)}
  }
  const match=/^\/api\/sessions\/([A-Za-z0-9_-]{8,120})\/ws$/.exec(path);
  if(match){
   if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return json({error:'Expected WebSocket upgrade'},426);
   const origin=request.headers.get('Origin');if(origin&&origin!==url.origin)return json({error:'Cross-origin connections not allowed'},403);
   return env.BOARD_SESSIONS.get(env.BOARD_SESSIONS.idFromName(match[1])).fetch(request);
  }
  return json({error:'Not found'},404);
 }
};

export class BoardSession extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.sql=ctx.storage.sql;this.sql.exec('CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS edges (id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS processed_ops (op_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,created_at INTEGER NOT NULL)');}
 readGraph(){const meta=this.ctx.storage.kv.get('meta');return {classes:structuredClone(meta?.classes||[]),nodes:this.sql.exec('SELECT data FROM nodes').toArray().map(r=>JSON.parse(r.data)),edges:this.sql.exec('SELECT data FROM edges').toArray().map(r=>JSON.parse(r.data))};}
 saveGraph(g,old=null){if(!old){for(const n of g.nodes)this.sql.exec('INSERT INTO nodes (id,data) VALUES (?,?)',n.id,JSON.stringify(n));for(const e of g.edges)this.sql.exec('INSERT INTO edges (id,data) VALUES (?,?)',e.id,JSON.stringify(e));return;}
  for(const [field,table] of [['nodes','nodes'],['edges','edges']]){const before=new Map(old[field].map(x=>[x.id,JSON.stringify(x)])),after=new Map(g[field].map(x=>[x.id,JSON.stringify(x)]));for(const id of before.keys())if(!after.has(id))this.sql.exec(`DELETE FROM ${table} WHERE id = ?`,id);for(const [id,data] of after){if(before.get(id)!==data)this.sql.exec(`INSERT INTO ${table} (id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,id,data)}}
 }
 people(){return this.ctx.getWebSockets().map(s=>s.deserializeAttachment()).filter(x=>x?.authorized).map(x=>({clientId:x.clientId,name:x.name,role:x.role}));}
 async privateRole(meta,auth){if(!auth.userId||auth.expires<=Date.now()/1000)return null;const res=await directoryCall(this.env,'/access',{id:meta.documentId,user:{id:auth.userId}});if(!res.ok)return null;return (await res.json()).role}
 async broadcast(m){const meta=this.ctx.storage.kv.get('meta');for(const s of this.ctx.getWebSockets()){const auth=s.deserializeAttachment();if(!auth?.authorized)continue;if(meta?.documentId&&!await this.privateRole(meta,auth)){const expired=auth.expires<=Date.now()/1000;wsSend(s,{type:'error',code:expired?'AUTH_EXPIRED':'ACCESS_REVOKED',message:expired?'Sign-in expired':'Document access ended'});s.close(1008,'Access ended');continue}wsSend(s,m)}}
 async announce(){await this.broadcast({type:'presence',participants:this.people()})}
 async fetch(request){const path=new URL(request.url).pathname;
  if(path==='/init-private'&&request.method==='POST'){
   if(this.ctx.storage.kv.get('meta'))return json({error:'Already exists'},409);
   const data=await request.json();if(!validId(data.id)||!validGraph(data.graph))return json({error:'Bad initialization'},400);
   this.ctx.storage.transactionSync(()=>{this.saveGraph(data.graph);this.ctx.storage.kv.put('meta',{name:data.name,documentId:data.id,classes:data.graph.classes,revision:0,classesRev:0,createdAt:Date.now()})});return json({ok:true},201);
  }
  if(path==='/recheck'&&request.method==='POST'){const {userId}=await request.json();for(const s of this.ctx.getWebSockets()){if(s.deserializeAttachment()?.userId===userId){wsSend(s,{type:'error',code:'ACCESS_CHANGED',message:'Document access changed; reconnect to continue'});s.close(1008,'Access changed')}}await this.announce();return json({ok:true})}
  if(path==='/delete-private'&&request.method==='POST'){for(const s of this.ctx.getWebSockets()){wsSend(s,{type:'error',code:'SESSION_DELETED',message:'This document was deleted'});s.close(1000,'Document deleted')}await this.ctx.storage.deleteAll();return json({ok:true})}
  if(path==='/init'&&request.method==='POST'){
   if(this.ctx.storage.kv.get('meta'))return json({error:'Already exists'},409);
   const data=await request.json();if(!validGraph(data.graph)||!/^[0-9a-f]{64}$/.test(data.editHash)||!/^[0-9a-f]{64}$/.test(data.viewHash)||!/^[0-9a-f]{64}$/.test(data.ownerHash||''))return json({error:'Bad initialization'},400);
   this.ctx.storage.transactionSync(()=>{this.saveGraph(data.graph);this.ctx.storage.kv.put('meta',{name:String(data.name||'Untitled workshop').slice(0,80),editHash:data.editHash,viewHash:data.viewHash,ownerHash:data.ownerHash,classes:data.graph.classes,revision:0,classesRev:0,createdAt:Date.now()})});return json({ok:true},201);
  }
  if(path==='/rotate'&&request.method==='POST'){
   const meta=this.ctx.storage.kv.get('meta');if(!meta)return json({error:'Unknown session'},404);
   const data=await request.json().catch(()=>({}));
   if(!equalHex(String(data.ownerHash||''),meta.ownerHash))return json({error:'Forbidden'},403);
   const editToken=token(24),viewToken=token(24);
   this.ctx.storage.kv.put('meta',{...meta,editHash:await sha256(editToken),viewHash:await sha256(viewToken)});
   return json({editToken,viewToken});
  }
  if(path==='/delete'&&request.method==='POST'){
   const meta=this.ctx.storage.kv.get('meta');if(!meta)return json({error:'Unknown session'},404);
   const data=await request.json().catch(()=>({}));
   if(!equalHex(String(data.ownerHash||''),meta.ownerHash))return json({error:'Forbidden'},403);
   for(const s of this.ctx.getWebSockets()){try{wsSend(s,{type:'error',code:'SESSION_DELETED',message:'This session was deleted by its owner'});s.close(1000,'Session deleted')}catch(_){}}
   await this.ctx.storage.deleteAll();
   return json({ok:true});
  }
  if(path==='/ws'||/^\/api\/(?:sessions|documents)\/[A-Za-z0-9_-]{8,120}\/ws$/.test(path)){
   const meta=this.ctx.storage.kv.get('meta');if(!meta||!!meta.documentId!==path.startsWith('/api/documents/'))return json({error:'Unknown session'},404);
   if(this.ctx.getWebSockets().length>=50)return json({error:'Session capacity reached'},429);
   const pair=new WebSocketPair();const [client,server]=Object.values(pair);
   this.ctx.acceptWebSocket(server);server.serializeAttachment({authorized:false,attempts:0});return new Response(null,{status:101,webSocket:client,headers:CORS_HEADERS});
  }
  return json({error:'Not found'},404);
 }
 async webSocketMessage(ws,message){
  if(typeof message!=='string'||message.length>MAX_MESSAGE){wsSend(ws,{type:'error',code:'BAD_REQUEST',message:'Message too large'});return}
  let msg;try{msg=JSON.parse(message)}catch(_){wsSend(ws,{type:'error',code:'BAD_REQUEST',message:'Invalid JSON'});return}
  const auth=ws.deserializeAttachment()||{authorized:false,attempts:0};
  if(!auth.authorized){
   if(msg.type!=='auth'||typeof msg.token!=='string'||msg.token.length>8192){wsSend(ws,{type:'error',code:'UNAUTHORIZED',message:'Authentication required'});ws.close(1008,'Unauthorized');return}
   if((auth.attempts||0)>=5){wsSend(ws,{type:'error',code:'UNAUTHORIZED',message:'Too many attempts'});ws.close(1008,'Unauthorized');return}
   const meta=this.ctx.storage.kv.get('meta');if(!meta){wsSend(ws,{type:'error',code:'UNAUTHORIZED',message:'Session unavailable'});ws.close(1008,'Unauthorized');return}
   let isEdit=false,isView=false,userId=null,expires=0,documentName=meta.name;
   if(meta.documentId){try{const user=await authenticatedUser(this.env,msg.token);expires=tokenExpiry(msg.token);if(user&&expires>Date.now()/1000){const result=await directoryCall(this.env,'/access',{id:meta.documentId,user});if(result.ok){const access=await result.json();isEdit=access.role==='owner'||access.role==='editor';isView=access.role==='viewer';documentName=access.name;userId=user.id}}}catch(e){console.error('Document authentication failed:',e.message)}}
   else{const hashed=await sha256(msg.token);isEdit=equalHex(hashed,meta.editHash);isView=equalHex(hashed,meta.viewHash)}
   if(!isEdit&&!isView){ws.serializeAttachment({...auth,attempts:(auth.attempts||0)+1});wsSend(ws,{type:'error',code:'UNAUTHORIZED',message:'Invalid or unauthorized credentials'});ws.close(1008,'Unauthorized');return}
   const clientId=typeof msg.clientId==='string'&&msg.clientId.length<100?msg.clientId:crypto.randomUUID(),name=String(msg.name||'Guest').trim().slice(0,40)||'Guest';
   ws.serializeAttachment({authorized:true,role:isEdit?'editor':'viewer',clientId,name,userId,expires});const graph=this.readGraph();
   const acknowledgedOpIds=Array.isArray(msg.pendingOpIds)?msg.pendingOpIds.filter(id=>validId(id)).slice(0,100).filter(id=>this.sql.exec('SELECT op_id FROM processed_ops WHERE op_id=?',id).toArray().length>0):[];
   wsSend(ws,{type:'welcome',name:documentName,role:isEdit?'editor':'viewer',graph,revision:meta.revision,classesRev:meta.classesRev,participants:this.people(),acknowledgedOpIds});await this.announce();return;
  }
  const currentMeta=this.ctx.storage.kv.get('meta');if(currentMeta?.documentId){const role=await this.privateRole(currentMeta,auth);if(!role){const expired=auth.expires<=Date.now()/1000;wsSend(ws,{type:'error',code:expired?'AUTH_EXPIRED':'ACCESS_REVOKED',message:expired?'Sign-in expired':'Document access ended'});ws.close(1008,'Access ended');return}if(role==='viewer')auth.role='viewer';else auth.role='editor';}
  if(msg.type==='replace-graph'){
   const reject=(code,message)=>wsSend(ws,{type:'graph.replace-error',requestId:msg.requestId,code,message});
   if(auth.role!=='editor'){reject('FORBIDDEN','View-only participants cannot edit');return}
   if(!validId(msg.requestId)||!Number.isInteger(msg.baseRevision)||!validGraph(msg.graph)){reject('BAD_REQUEST','Invalid board or replacement request');return}
   const prior=this.sql.exec('SELECT revision FROM processed_ops WHERE op_id=?',msg.requestId).toArray()[0];
   if(prior){wsSend(ws,{type:'graph.replaced',requestId:msg.requestId});return}
   const meta=this.ctx.storage.kv.get('meta');
   if(msg.baseRevision!==meta.revision){reject('REVISION_CONFLICT','The board changed. Copy your JSON, close this view, and reopen it before trying again.');return}
   try{
    const old=this.readGraph(),updated={classes:msg.graph.classes,nodes:msg.graph.nodes,edges:msg.graph.edges};
    const next={...meta,classes:updated.classes,revision:meta.revision+1,classesRev:meta.classesRev+1};
    this.ctx.storage.transactionSync(()=>{this.saveGraph(updated,old);this.ctx.storage.kv.put('meta',next);this.sql.exec('INSERT INTO processed_ops(op_id,revision,created_at) VALUES(?,?,?)',msg.requestId,next.revision,Date.now())});
    wsSend(ws,{type:'graph.replaced',requestId:msg.requestId});
    for(const socket of this.ctx.getWebSockets())try{socket.close(1012,'Board replaced; reconnect to refresh')}catch(e){console.error('Could not reconnect participant:',e)}
   }catch(e){console.error('Graph replacement failed:',e);reject('REPLACE_FAILED','Could not save the replacement board.')}
   return;
  }
  if(msg.type==='ops'){
   if(auth.role!=='editor'){wsSend(ws,{type:'error',code:'FORBIDDEN',message:'View-only participants cannot edit'});return}
   if(!validId(msg.opId)||!Array.isArray(msg.ops)||!msg.ops.length||msg.ops.length>MAX_OPS){wsSend(ws,{type:'error',code:'BAD_REQUEST',message:'Invalid operations'});return}
   const prior=this.sql.exec('SELECT revision FROM processed_ops WHERE op_id = ?',msg.opId).toArray()[0];if(prior){wsSend(ws,{type:'ack',opId:msg.opId,revision:prior.revision,classesRev:this.ctx.storage.kv.get('meta').classesRev});return}
   const meta=this.ctx.storage.kv.get('meta');const changesClasses=msg.ops.some(o=>o.type==='classes.replace');
   if(changesClasses&&msg.baseClassesRev!==meta.classesRev){wsSend(ws,{type:'error',code:'CLASS_CONFLICT',message:'Node class definitions have changed. Reconnect to refresh.'});return}
   try{
    const old=this.readGraph(),updated=applyOps(structuredClone(old),msg.ops);
    const next={...meta,classes:updated.classes,revision:meta.revision+1,classesRev:meta.classesRev+(changesClasses?1:0)};
    this.ctx.storage.transactionSync(()=>{this.saveGraph(updated,old);this.ctx.storage.kv.put('meta',next);this.sql.exec('INSERT INTO processed_ops(op_id,revision,created_at) VALUES(?,?,?)',msg.opId,next.revision,Date.now());this.sql.exec('DELETE FROM processed_ops WHERE created_at < ?',Date.now()-7*86400_000)});
    wsSend(ws,{type:'ack',opId:msg.opId,revision:next.revision,classesRev:next.classesRev});await this.broadcast({type:'ops',opId:msg.opId,clientId:auth.clientId,ops:msg.ops,revision:next.revision,classesRev:next.classesRev});
   }catch(e){wsSend(ws,{type:'error',code:'REVISION_CONFLICT',message:String(e.message||'Could not apply edit')})}
   return;
  }
  if(msg.type==='presence'){
   const now=Date.now();
   if(now-(auth.lastPresence||0)<80)return;
   ws.serializeAttachment({...auth,lastPresence:now});
   const x=Number(msg.x),y=Number(msg.y);
   if(!Number.isFinite(x)||!Number.isFinite(y)||Math.abs(x)>1e7||Math.abs(y)>1e7)return;
   const selection=validId(msg.selection)?msg.selection:null;
   for(const s of this.ctx.getWebSockets()){const peer=s.deserializeAttachment();if(s!==ws&&peer?.authorized&&(!currentMeta?.documentId||await this.privateRole(currentMeta,peer)))wsSend(s,{type:'cursor',clientId:auth.clientId,name:auth.name,x,y,selection})}
   return;
  }
  wsSend(ws,{type:'error',code:'BAD_REQUEST',message:'Unsupported message type'});
 }
 async webSocketClose(ws,code,reason){try{ws.close(code,reason)}catch(_){}await this.announce()}
 async webSocketError(ws){try{ws.close(1011,'Connection error')}catch(_){}await this.announce()}
}
