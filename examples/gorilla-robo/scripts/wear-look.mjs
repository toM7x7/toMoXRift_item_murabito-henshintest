// Going into it, a first look: node scripts/wear-look.mjs -> output/capture/gw-*.png and numbers
import {chromium} from 'playwright'
import {join} from 'node:path'
const exe=join(process.env.LOCALAPPDATA??'','ms-playwright','chromium-1243','chrome-win64','chrome.exe')
const browser=await chromium.launch({executablePath:exe,args:['--use-angle=d3d11','--ignore-gpu-blocklist','--enable-gpu']})
const page=await browser.newPage({viewport:{width:640,height:480}})
const logs=[];page.on('console',m=>{if(!/deprecated|React DevTools|vite/i.test(m.text()))logs.push(m.type()+' '+m.text())});page.on('pageerror',e=>logs.push('pageerror '+e))
await page.goto('http://127.0.0.1:5325/?lab&wear')
await page.waitForFunction(()=>window.__beast?.ready?.(),null,{timeout:30000})
await page.waitForFunction(()=>window.__beast.shown('user-me').meshes>0,null,{timeout:30000})
const OUT=join(import.meta.dirname,'..','output','capture')
const B=()=>page.evaluate(()=>window.__beast.bridge()?.debug())
const step=s=>page.evaluate(async s=>{const n=Math.round(s*60);for(let i=0;i<n;i++){window.__beast.advance(1/60);await new Promise(r=>requestAnimationFrame(r))}},s)
const shot=async(name,at,deg=40,dist=4.2,h=1.5)=>{const a=deg*Math.PI/180;await page.evaluate(([at,a,dist,h])=>window.__beast.view([at[0]+Math.sin(a)*dist,h,at[2]+Math.cos(a)*dist],[at[0],0.8,at[2]]),[at,a,dist,h]);await step(0.05);await page.screenshot({path:join(OUT,name+'.png')})}
const r3=x=>Math.round(x*100)/100
await page.evaluate(()=>{const b=window.__beast;b.setTime(5000);b.eyes([0,1.6,40]);b.wear('user-me')})
await step(1)
let d=await B();console.log('worn',d.status,d.read,'scale',r3(d.scale),'motion',d.motion,'hidden',d.hidden)
const me=()=>page.evaluate(()=>{const p=window.__beast;return [0,0,0]})
let at=[1.6,0,3.2]
await shot('gw-0-idle',at)
// walk forward (+Z) at 1.6 m/s
await page.evaluate(()=>window.__beast.avatar('user-me',{walk:[0,1.6]}))
await step(1.5);d=await B();console.log('walk',d.motion,'speed',r3(d.speed),'heading',r3(d.heading))
at=[1.6,0,3.2+1.6*1.5];await shot('gw-1-walk',at,80)
await page.evaluate(()=>window.__beast.avatar('user-me',{walk:[3.5,0]}))
await step(1.2);d=await B();console.log('run',d.motion,'speed',r3(d.speed),'heading',r3(d.heading))
await page.evaluate(()=>window.__beast.avatar('user-me',{walk:[0,0]}))
await step(1);at=await page.evaluate(()=>window.__beast.bone? null:null)
const p=await page.evaluate(()=>{const s=window.__beast;return s.avatar&&null})
const pos=await page.evaluate(()=>{const c=window.__beast.bridge();return null})
// where is the mannequin now
const feet=await page.evaluate(()=>{let p=null;window.__beast.scene.traverse(o=>{if(o.name==='dev-vrm-user-me')p=o.getWorldPosition(new window.__beast.scene.position.constructor()).toArray()});return p})
console.log('feet',feet&&feet.map(r3))
await shot('gw-2-stop',feet)
// hands up
await page.evaluate(()=>window.__beast.avatar('user-me',{motion:'up'}))
await step(1.2);d=await B();console.log('hands up: reach',r3(d.reach),'motion',d.motion)
await shot('gw-3-reach',feet,30)
await page.evaluate(()=>window.__beast.avatar('user-me',{motion:'idle'}))
await step(1)
// X: drumming
console.log('X taken',await page.evaluate(()=>window.__beast.key('KeyX')))
await step(1.6);d=await B();console.log('X ->',d.motion)
await shot('gw-4-beat',feet,20)
await step(3.5)
// Z: to robot
console.log('Z taken',await page.evaluate(()=>window.__beast.key('KeyZ')))
await step(1.8);await shot('gw-5-changing',feet,30,5,1.8)
await step(3);d=await B();console.log('robot',d.motion,'scale',r3(d.scale))
await shot('gw-6-robot',feet,30,5,1.8)
for(const k of ['front','side','up','bendL']){await page.evaluate(k=>window.__beast.avatar('user-me',{motion:k}),k);await step(0.3);await shot('gw-7-robot-'+k,feet,20,5,1.8)}
await page.evaluate(()=>window.__beast.avatar('user-me',{motion:'idle'}))
console.log('hint',await page.evaluate(()=>window.__beast.hintText()))
console.log(logs.slice(0,10).join('\n'))
await browser.close()
