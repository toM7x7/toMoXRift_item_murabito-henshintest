// Hold poses given as JSON and photograph each from three sides: node scripts/try-pose.mjs '{"name":{...pose...},...}'
// -> output/capture/try-<name>-<n>.png (then: python scripts/sheets.py try --cols 6)
import {chromium} from 'playwright'
import {join} from 'node:path'
const exe=join(process.env.LOCALAPPDATA??'','ms-playwright','chromium-1243','chrome-win64','chrome.exe')
const browser=await chromium.launch({executablePath:exe,args:['--use-angle=d3d11','--ignore-gpu-blocklist','--enable-gpu']})
const page=await browser.newPage({viewport:{width:420,height:560}})
await page.goto('http://127.0.0.1:5323/?lab')
await page.waitForFunction(()=>window.__villager?.ready?.(),null,{timeout:30000})
const OUT=join(import.meta.dirname,'..','output','capture')
const poses=JSON.parse(process.argv[2])
const degs=(process.argv[3]??'20,-70,160').split(',').map(Number)
await page.evaluate(()=>{const b=window.__villager;b.still(true);b.setTime(1000);b.eyes([0,1.6,30])})
for(const [name,p] of Object.entries(poses)){
 await page.evaluate(p=>window.__villager.pose(p),p)
 let i=0
 for(const deg of degs){
  const a=deg*Math.PI/180,d=2.6,t=[0,1.15,0]
  await page.evaluate(([p,t])=>window.__villager.view(p,t),[[t[0]+Math.sin(a)*d,t[1]+0.2,t[2]+Math.cos(a)*d],t])
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
  await page.screenshot({path:join(OUT,`try-${name}-${i++}.png`)})
 }
}
await browser.close()
