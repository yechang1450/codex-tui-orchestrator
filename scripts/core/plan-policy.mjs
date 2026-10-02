import {levelWaves, keysOverlap, canonicalKey} from './contracts.mjs';

// Dependency and resource edges belong inside a serial block. Memory pressure
// must never change these components or discard tasks.
export function partitionIndependentBlocks(input, infer = () => []) {
  const blocks=structuredClone(input||[]);
  const recs=blocks.map((b,i)=>({key:'B'+(i+1),title:b.title,b,dependsOn:b.dependsOn||[]}));
  const order=levelWaves(recs).flat();
  const parent=blocks.map((_,i)=>i);
  const root=i=>parent[i]===i?i:(parent[i]=root(parent[i]));
  const join=(a,b)=>{a=root(a);b=root(b);parent[Math.max(a,b)]=Math.min(a,b);};
  const index=new Map(recs.map((r,i)=>[r.key,i]));
  const keys=blocks.map(b=>[...new Set([...(b.conflictKeys||[]),...infer(b)])]);
  const canonicalKeys=keys.map(list=>list.map(key=>canonicalKey(key)));
  for(let i=0;i<blocks.length;i++){
    for(const dep of recs[i].dependsOn)join(i,index.get(dep));
    for(let j=0;j<i;j++)if(!keys[i].length||!keys[j].length||keysOverlap(canonicalKeys[i],canonicalKeys[j],{canonical:true}))join(i,j);
  }
  const groups=new Map();
  for(const r of order){const i=index.get(r.key),key=root(i);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(i);}
  return [...groups].sort(([a],[b])=>a-b).map(([,ids])=>({
    type:ids.length>1?'linked':blocks[ids[0]].type||'independent',
    title:blocks[ids[0]].title,dependsOn:[],
    conflictKeys:[...new Set(ids.flatMap(i=>keys[i]))],
    tasks:ids.flatMap(i=>blocks[i].tasks||[]),
  }));
}
