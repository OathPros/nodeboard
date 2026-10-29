import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the dependency-free operation validator from the actual Worker source.
const worker=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const prelude=worker.slice(worker.indexOf('const MAX_NODES'),worker.indexOf('export default'));
function env(graph,ops=[]) {
  const context=vm.createContext({TextEncoder,Uint8Array,crypto:globalThis.crypto,structuredClone,Response,console,graph:structuredClone(graph),ops});
  vm.runInContext(prelude,context);
  return {context,validate:()=>vm.runInContext('validGraph(graph)',context),apply:()=>vm.runInContext('applyOps(graph,ops)',context)};
}
function fixture(){return {classes:[{id:'c1',key:1,name:'Service',shape:'rounded',color:'#e05a72'},{id:'c2',key:2,name:'Offering',shape:'pill',color:'#8c77cf'}],nodes:[{id:'n1',x:0,y:0,name:'Service A',classId:'c1'},{id:'n2',x:10,y:20,name:'Offering A',classId:'c2'}],edges:[{id:'e1',from:'n1',to:'n2',label:'HAS_OFFERING'}]}}

test('legacy short node and edge IDs are valid on session creation',()=>assert.equal(env(fixture()).validate(),true));
test('legacy numeric class references are rejected (must be migrated client-side first)',()=>{const g=fixture();g.classes=g.classes.map(({id,...c})=>c);g.nodes[0].classId=1;g.nodes[1].classId=2;assert.equal(env(g).validate(),false)});
test('nodes may not reference unknown class ids',()=>{const g=fixture();g.nodes[0].classId='nope';assert.equal(env(g).validate(),false)});
test('duplicate class ids are rejected',()=>{const g=fixture();g.classes[1].id='c1';assert.equal(env(g).validate(),false)});
test('class delete with transactional node reassignment is atomic',()=>{const g=fixture(),x=env(g,[{type:'classes.replace',classes:[{id:'c1',key:1,name:'Service',shape:'rounded',color:'#e05a72'}]},{type:'node.patch',id:'n2',patch:{classId:'c1'}}]);x.apply();assert.equal(x.context.graph.classes.length,1);assert.equal(x.context.graph.nodes[1].classId,'c1')});
test('dangling edges invalidate the graph',()=>{const g=fixture();g.edges[0].to='absent';assert.equal(env(g).validate(),false)});
test('duplicated class styles are allowed by backend after UI override',()=>{const g=fixture();g.classes[1].shape='rounded';g.classes[1].color='#e05a72';assert.equal(env(g).validate(),true)});
test('move and rename patches preserve both changes',()=>{const x=env(fixture(),[{type:'node.patch',id:'n1',patch:{x:25,y:30}},{type:'node.patch',id:'n1',patch:{name:'Changed'}}]);x.apply();assert.equal(x.context.graph.nodes[0].x,25);assert.equal(x.context.graph.nodes[0].y,30);assert.equal(x.context.graph.nodes[0].name,'Changed')});
test('deleting a node removes its incident edges',()=>{const x=env(fixture(),[{type:'node.delete',id:'n2'}]);x.apply();assert.equal(x.context.graph.nodes.length,1);assert.equal(x.context.graph.edges.length,0)});
test('a patch cannot change immutable entity ID',()=>{const x=env(fixture(),[{type:'node.patch',id:'n1',patch:{id:'x'}}]);assert.throws(x.apply,/Bad patch/)});
test('upsert + edge in the same message succeeds atomically in memory',()=>{const g=fixture(),x=env(g,[{type:'node.upsert',node:{id:'n_3',x:45,y:50,name:'Team',classId:'c1'}},{type:'edge.upsert',edge:{id:'e_3',from:'n1',to:'n_3',label:'SUPPORTS'}}]);x.apply();assert.equal(x.context.graph.nodes.length,3);assert.equal(x.context.graph.edges.length,2)});
test('invalid coordinate rejects a mutation',()=>{const x=env(fixture(),[{type:'node.patch',id:'n1',patch:{x:Infinity}}]);assert.throws(x.apply,/invalid graph/i)});
