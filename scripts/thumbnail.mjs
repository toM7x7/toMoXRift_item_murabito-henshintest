// Marketplace thumbnail (512 x 512) from the lab page. The dev server must be running on 5323.
// node scripts/thumbnail.mjs  ->  public/thumbnail.png
import {chromium} from 'playwright'
import {join} from 'node:path'
const exe=join(process.env.LOCALAPPDATA??'','ms-playwright','chromium-1243','chrome-win64','chrome.exe')
const browser=await chromium.launch({executablePath:exe,args:['--use-angle=d3d11','--ignore-gpu-blocklist','--enable-gpu']})
const page=await browser.newPage({viewport:{width:512,height:512},deviceScaleFactor:1})
await page.goto('http://127.0.0.1:5323/?lab')
await page.waitForFunction(()=>window.__villager?.ready?.(),null,{timeout:30000})
await page.evaluate(async()=>{
 const b=window.__villager
 b.still(true);b.setTime(999);b.eyes([0.9,1.6,2.4])
 for(let i=0;i<60;i++){b.advance(1/60);await new Promise(r=>requestAnimationFrame(r))}
 b.gesture('wave',-1)
 for(let i=0;i<78;i++){b.advance(1/60);await new Promise(r=>requestAnimationFrame(r))}
 b.view([0.95,1.42,2.55],[-0.03,1.2,0])
 for(let i=0;i<4;i++)await new Promise(r=>requestAnimationFrame(r))
})
await page.screenshot({path:join(import.meta.dirname,'..','public','thumbnail.png')})
await browser.close()
console.log('wrote public/thumbnail.png')
