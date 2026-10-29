import { DurableObject } from 'cloudflare:workers';

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
 const nodes = new Set();const classIds = new Set(g.classes.map(c=>c.id));if(classIds.size!==g.classes.length)return false;for(const n of g.nodes){if(!n||!validId(n.id)||nodes.has(n.id)||!Number.isFinite(n.x)||!Number.isFinite(n.y)||Math.abs(n.x)>1e7||Math.abs(n.y)>1e7||typeof n.name!=='string'||n.name.length>110||!classIds.has(n.classId))return false;if(n.shapeOverride!==undefined&&n.shapeOverride!==null&&!SHAPES.has(n.shapeOverride))return false;if(n.colorOverride!==undefined&&n.colorOverride!==null&&!/^#[0-9a-fA-F]{6}$/.test(n.colorOverride))return false;nodes.add(n.id)}
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

// Best-effort per-isolate rate limit for session creation (per client IP).
const createHits=new Map();
const CREATE_LIMIT=30,CREATE_WINDOW=3600_000;
function rateLimited(ip){const now=Date.now(),e=createHits.get(ip)||{count:0,reset:now+CREATE_WINDOW};if(now>e.reset){e.count=0;e.reset=now+CREATE_WINDOW}e.count++;createHits.set(ip,e);if(createHits.size>10000)createHits.clear();return e.count>CREATE_LIMIT}

export default {
 async fetch(request,env) {
  const url=new URL(request.url),path=url.pathname;
  if(path==='/api/health')return json({ok:true,service:'nodeboard-live',version:1});
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
 broadcast(m){for(const s of this.ctx.getWebSockets()){if(s.deserializeAttachment()?.authorized)wsSend(s,m)}}
 announce(){this.broadcast({type:'presence',participants:this.people()})}
 async fetch(request){const path=new URL(request.url).pathname;
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
  if(path==='/ws'||/^\/api\/sessions\/[A-Za-z0-9_-]{8,120}\/ws$/.test(path)){
   if(!this.ctx.storage.kv.get('meta'))return json({error:'Unknown session'},404);
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
   if(msg.type!=='auth'||typeof msg.token!=='string'||msg.token.length>160){wsSend(ws,{type:'error',code:'UNAUTHORIZED',message:'Invitation key required'});ws.close(1008,'Unauthorized');return}
   if((auth.attempts||0)>=5){wsSend(ws,{type:'error',code:'UNAUTHORIZED',message:'Too many attempts'});ws.close(1008,'Unauthorized');return}
   const meta=this.ctx.storage.kv.get('meta');if(!meta){wsSend(ws,{type:'error',code:'UNAUTHORIZED',message:'Session unavailable'});ws.close(1008,'Unauthorized');return}
   const hashed=await sha256(msg.token);const isEdit=equalHex(hashed,meta.editHash),isView=equalHex(hashed,meta.viewHash);
   if(!isEdit&&!isView){ws.serializeAttachment({...auth,attempts:(auth.attempts||0)+1});wsSend(ws,{type:'error',code:'UNAUTHORIZED',message:'Invalid invitation key'});ws.close(1008,'Unauthorized');return}
   const clientId=typeof msg.clientId==='string'&&msg.clientId.length<100?msg.clientId:crypto.randomUUID(),name=String(msg.name||'Guest').trim().slice(0,40)||'Guest';
   ws.serializeAttachment({authorized:true,role:isEdit?'editor':'viewer',clientId,name});const graph=this.readGraph();
   const acknowledgedOpIds=Array.isArray(msg.pendingOpIds)?msg.pendingOpIds.filter(id=>validId(id)).slice(0,100).filter(id=>this.sql.exec('SELECT op_id FROM processed_ops WHERE op_id=?',id).toArray().length>0):[];
   wsSend(ws,{type:'welcome',name:meta.name,role:isEdit?'editor':'viewer',graph,revision:meta.revision,classesRev:meta.classesRev,participants:this.people(),acknowledgedOpIds});this.announce();return;
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
    wsSend(ws,{type:'ack',opId:msg.opId,revision:next.revision,classesRev:next.classesRev});this.broadcast({type:'ops',opId:msg.opId,clientId:auth.clientId,ops:msg.ops,revision:next.revision,classesRev:next.classesRev});
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
   for(const s of this.ctx.getWebSockets()){if(s!==ws&&s.deserializeAttachment()?.authorized)wsSend(s,{type:'cursor',clientId:auth.clientId,name:auth.name,x,y,selection})}
   return;
  }
  wsSend(ws,{type:'error',code:'BAD_REQUEST',message:'Unsupported message type'});
 }
 async webSocketClose(ws,code,reason){try{ws.close(code,reason)}catch(_){}this.announce()}
 async webSocketError(ws){try{ws.close(1011,'Connection error')}catch(_){}this.announce()}
}
