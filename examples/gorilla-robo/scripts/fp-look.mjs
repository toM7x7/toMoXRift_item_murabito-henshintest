// First person inside it: node scripts/fp-look.mjs -> output/capture/fp-*.png
import {chromium} from 'playwright'
import {join} from 'node:path'
const exe=join(process.env.LOCALAPPDATA??'','ms-playwright','chromium-1243','chrome-win64','chrome.exe')
const browser=await chromium.launch({executablePath:exe,args:['--use-angle=d3d11','--ignore-gpu-blocklist','--enable-gpu']})
const page=await browser.newPage({viewport:{width:640,height:480}})
await page.goto('http://127.0.0.1:5325/?lab&wear')
await page.waitForFunction(()=>window.__beast?.ready?.()&&window.__beast.shown('user-me').meshes>0,null,{timeout:30000})
const OUT=join(import.meta.dirname,'..','output','capture')
const step=s=>page.evaluate(async s=>{const n=Math.round(s*60);for(let i=0;i<n;i++){window.__beast.advance(1/60);await new Promise(r=>requestAnimationFrame(r))}},s)
await page.evaluate(()=>{const b=window.__beast;b.setTime(5000);b.eyes([0,1.6,40]);b.wear('user-me');b.viewpoint('first-person',true)})
await step(1)
const eye=await page.evaluate(()=>window.__beast.eye('user-me'))
const at=[1.6,0,3.2]
for(const [n,t] of [['ahead',[1.6,0.9,6]],['down',[1.6,0,3.8]],['below',[1.6,0,3.0]]]){
 await page.evaluate(([e,t])=>window.__beast.view([1.6,e,3.2+0.09],t),[eye,t]);await step(0.05)
 await page.screenshot({path:join(OUT,`fp-gorilla-${n}.png`)})
}
await page.evaluate(()=>window.__beast.key('KeyZ'));await step(5)
for(const [n,t] of [['ahead',[1.6,1.2,6]],['down',[1.6,0,3.8]]]){
 await page.evaluate(([e,t])=>window.__beast.view([1.6,e,3.2+0.09],t),[eye,t]);await step(0.05)
 await page.screenshot({path:join(OUT,`fp-robot-${n}.png`)})
}
await browser.close()
