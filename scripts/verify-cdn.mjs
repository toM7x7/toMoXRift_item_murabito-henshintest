// After an upload: ask the platform which version it serves, then compare every file of dist/ with the one on the CDN.
// Usage: node scripts/verify-cdn.mjs        (reads the CLI's own login from ~/.xrift/config.json; prints no secrets)
import {createHash} from 'node:crypto'
import {readFileSync,readdirSync,statSync} from 'node:fs'
import {homedir} from 'node:os'
import {join,relative,resolve} from 'node:path'

const here=resolve(import.meta.dirname,'..'),dist=join(here,'dist')
const id=JSON.parse(readFileSync(join(here,'.xrift','item.json'),'utf8')).id
const config=JSON.parse(readFileSync(join(homedir(),'.xrift','config.json'),'utf8'))
const token=config.token??config.accessToken??config.auth?.token
if(!token){console.log('no CLI login found');process.exit(1)}
const res=await fetch(`https://api.xrift.net/api/public/v1/items/${id}/resolve`,{headers:{authorization:`Bearer ${token}`}})
if(!res.ok){console.log('resolve failed',res.status);process.exit(1)}
const info=await res.json()
const scene=info.sceneUrl??info.item?.sceneUrl
console.log('served:',{name:info.name??info.item?.name,version:info.versionNumber??info.version,status:info.status,hash:scene?.split('/').at(-2)})
if(!scene){console.log(Object.keys(info));process.exit(1)}
const base=scene.slice(0,scene.lastIndexOf('/')+1)
const files=[]
const walk=d=>{for(const n of readdirSync(d)){const p=join(d,n);if(statSync(p).isDirectory())walk(p);else files.push(p)}}
walk(dist)
const sha=b=>createHash('sha256').update(b).digest('hex')
// what the upload leaves out (xrift.json item.ignore)
const skipped=p=>/\.map$|\.d\.ts$|(^|\/)index\.html$/.test(p)
let same=0,differ=[],missing=[]
for(const f of files){
 const rel=relative(dist,f).replace(/\\/g,'/')
 if(skipped(rel))continue
 const r=await fetch(base+rel)
 if(!r.ok){missing.push(rel+' '+r.status);continue}
 if(sha(Buffer.from(await r.arrayBuffer()))===sha(readFileSync(f)))same++;else differ.push(rel)
}
console.log({same,differ,missing})
process.exit(differ.length||missing.length?1:0)
