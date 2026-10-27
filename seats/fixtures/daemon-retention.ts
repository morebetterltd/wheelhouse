// Logical footprint of the audited daemon-owned roots, NOT VM heap/capacity.
// A shared/cyclic object is visited once; strings/keys and primitive payload are
// counted per reference (no assumptions about JSC interning or GC timing).
export type Retention = { objects:number; slots:number; functions:number; payloadBytes:number };
export function retainedFootprint(root:unknown): Retention {
  const seen=new WeakSet<object>(), out:Retention={objects:0,slots:0,functions:0,payloadBytes:0};
  const visit=(value:any):void=>{
    if(typeof value==='string'){out.payloadBytes+=Buffer.byteLength(value);return;}
    if(typeof value==='number'||typeof value==='bigint'){out.payloadBytes+=8;return;}
    if(typeof value==='boolean'){out.payloadBytes++;return;}
    if(value===null||value===undefined)return;
    if(typeof value!=='object'&&typeof value!=='function')throw Error('unsupported retained primitive');
    if(seen.has(value))return;seen.add(value);
    if(typeof value==='function'){out.functions++;return;}
    out.objects++;
    if(ArrayBuffer.isView(value)){out.payloadBytes+=value.byteLength;return;}
    if(value instanceof ArrayBuffer){out.payloadBytes+=value.byteLength;return;}
    if(!Array.isArray(value)&&!(value instanceof Map)&&!(value instanceof Set)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('unsupported retained object');
    if(value instanceof Map){for(const [k,v] of value){out.slots+=2;visit(k);visit(v);}}
    if(value instanceof Set){for(const v of value){out.slots++;visit(v);}}
    for(const key of Object.keys(value)){
      const d=Object.getOwnPropertyDescriptor(value,key)!;
      if(!('value' in d))throw Error('retained roots must not invoke getters');
      out.slots++;out.payloadBytes+=Buffer.byteLength(key);visit(d.value);
    }
  };
  visit(root);return out;
}
export function retentionViolation(value:Retention, limit:Retention): string|null {
  for(const key of ['objects','slots','functions','payloadBytes'] as const)if(value[key]>limit[key])return `${key}=${value[key]} exceeds ${limit[key]}`;
  return null;
}
