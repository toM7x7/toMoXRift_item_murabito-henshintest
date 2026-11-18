// Every key of the dev warm-up routine on the mannequin, worn: the villager alone and over the mannequin.
// node scripts/wear-keys.mjs [deg] -> output/capture/wkey-<key>-<0|1>.png
import {chromium} from 'playwright'
import {join} from 'node:path'
const exe=join(process.env.LOCALAPPDATA??'','ms-playwright','chromium-1243','chrome-win64','chrome.exe')
const browser=await chromium.launch({executablePath:exe,args:['--use-angle=d3d11','--ignore-gpu-blocklist','--enable-gpu']})
const page=await browser.newPage({viewport:{width:420,height:560}})
await page.goto('http://127.0.0.1:5323/?lab&wear')
await page.waitForFunction(()=>window.__villager?.ready?.(),null,{timeout:30000})
const deg=Number(process.argv[2]??30)
const OUT=join(import.meta.dirname,'..','output','capture')
const frames=n=>page.evaluate(async n=>{for(let i=0;i<n;i++)await new Promise(r=>requestAnimationFrame(r))},n)
await page.evaluate(()=>{const b=window.__villager;b.eyes([0,1.6,40]);b.wear('user-me')})
await frames(30)
const keys=await page.evaluate(()=>window.__villager.keys())
const at=[0.9,0,1.6],a=deg*Math.PI/180
await page.evaluate(([at,a])=>window.__villager.view([at[0]-Math.sin(a)*3.0,1.2,at[2]+Math.cos(a)*3.0],[at[0],0.95,at[2]]),[at,a])
const worst=[]
for(const k of keys){
 await page.evaluate(k=>window.__villager.avatar('user-me',{motion:k}),k)
 for(const show of [false,true]){
  await page.evaluate(s=>{window.__villager.bridge().showAvatar=s},show)
  await frames(4)
  await page.screenshot({path:join(OUT,`wkey-${k}-${show?1:0}.png`)})
 }
 const d=await page.evaluate(()=>window.__villager.bridge().debug())
 worst.push([k,Math.round(d.reach*1000)])
}
console.log(keys.join(' '),'\nreach mm',JSON.stringify(worst))
await browser.close()
