// First-person look while wearing him: node scripts/fp-look.mjs -> output/capture/fp-<mode>.png
import {chromium} from 'playwright'
import {join} from 'node:path'
const exe=join(process.env.LOCALAPPDATA??'','ms-playwright','chromium-1243','chrome-win64','chrome.exe')
const browser=await chromium.launch({executablePath:exe,args:['--use-angle=d3d11','--ignore-gpu-blocklist','--enable-gpu']})
const page=await browser.newPage({viewport:{width:640,height:560}})
await page.goto('http://127.0.0.1:5323/?lab&wear')
await page.waitForFunction(()=>window.__villager?.ready?.(),null,{timeout:30000})
const OUT=join(import.meta.dirname,'..','output','capture')
const frames=n=>page.evaluate(async n=>{for(let i=0;i<n;i++)await new Promise(r=>requestAnimationFrame(r))},n)
await page.evaluate(()=>{const b=window.__villager;b.eyes([0,1.6,40]);b.wear('user-me');b.viewpoint('first-person',true)})
await frames(30)
for(const [m,t] of [[0,[0.9,0,1.9]],[1,[0.9,0,1.9]],[0,[0.9,0.6,2.6]]]){
 await page.evaluate(([m,t])=>{const b=window.__villager;b.clay(m);b.view([0.9,1.57,1.6+0.09],t)},[m,t])
 await frames(3);await page.screenshot({path:join(OUT,`fp-${m}-${t[1]}.png`)})
}
await browser.close()
