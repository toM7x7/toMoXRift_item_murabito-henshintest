// Quick look at wearing: node scripts/wear-look.mjs [who] [motion] [show]  -> output/capture/wear-look-*.png
import {chromium} from 'playwright'
import {join} from 'node:path'
const exe=join(process.env.LOCALAPPDATA??'','ms-playwright','chromium-1243','chrome-win64','chrome.exe')
const browser=await chromium.launch({executablePath:exe,args:['--use-angle=d3d11','--ignore-gpu-blocklist','--enable-gpu']})
const page=await browser.newPage({viewport:{width:900,height:620}})
const logs=[];page.on('console',m=>{if(!/deprecated/i.test(m.text()))logs.push(m.type()+' '+m.text())});page.on('pageerror',e=>logs.push('pageerror '+e))
await page.goto('http://127.0.0.1:5323/?lab&wear')
await page.waitForFunction(()=>window.__villager?.ready?.(),null,{timeout:30000})
const [who='user-me',motion='idle',show='']=process.argv.slice(2)
const OUT=join(import.meta.dirname,'..','output','capture')
const frames=n=>page.evaluate(async n=>{for(let i=0;i<n;i++)await new Promise(r=>requestAnimationFrame(r))},n)
await page.evaluate(([who,motion])=>{const b=window.__villager;b.eyes([0,1.6,40]);b.avatar(who,{motion});b.wear(who)},[who,motion])
if(show)await page.evaluate(()=>{window.__villager.bridge().showAvatar=true})
await frames(40)
const d=await page.evaluate(()=>window.__villager.bridge()?.debug())
console.log(JSON.stringify(d,(k,v)=>typeof v==='number'?Math.round(v*1000)/1000:v).slice(0,900))
const at=await page.evaluate(w=>window.__villager.bone(w,'hips$'),who)
let i=0
for(const deg of [0,60,180]){
 const a=deg*Math.PI/180
 await page.evaluate(([at,a])=>window.__villager.view([at[0]+Math.sin(a)*2.6,1.25,at[2]-Math.cos(a)*2.6],[at[0],0.95,at[2]]),[at,a])
 await frames(3)
 await page.screenshot({path:join(OUT,`wear-look-${i++}.png`)})
}
console.log(await page.evaluate(w=>window.__villager.shown(w),who))
console.log(logs.slice(0,12).join('\n'))
await browser.close()
