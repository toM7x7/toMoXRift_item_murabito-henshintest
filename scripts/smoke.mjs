// Opens the walk-around page (the official DevEnvironment) and the lab page, and reports page errors and failed requests.
import {chromium} from 'playwright'
import {mkdirSync} from 'node:fs'
import {join} from 'node:path'
const exe=join(process.env.LOCALAPPDATA??'','ms-playwright','chromium-1243','chrome-win64','chrome.exe')
const browser=await chromium.launch({executablePath:exe,args:['--use-angle=d3d11','--ignore-gpu-blocklist','--enable-gpu']})
const OUT=join(import.meta.dirname,'..','output','capture')
mkdirSync(OUT,{recursive:true})
let bad=0
for(const q of ['','?lab']){
 const page=await browser.newPage({viewport:{width:1280,height:800}})
 const errors=[]
 page.on('pageerror',e=>errors.push('pageerror '+e))
 page.on('console',m=>{if(m.type()==='error')errors.push('console '+m.text())})
 page.on('response',r=>{if(r.status()>=400)errors.push(r.status()+' '+r.url())})
 await page.goto('http://127.0.0.1:5323/'+q)
 await page.waitForTimeout(7000)
 const n=await page.evaluate(()=>globalThis.__villagerDev?.actors?.size??-1)
 await page.screenshot({path:join(OUT,'smoke'+(q?'-lab':'-walk')+'.png')})
 console.log(q||'(walk)','villagers',n,errors.length?errors:'no errors')
 if(n<1||errors.some(e=>!/favicon/.test(e)))bad++
 await page.close()
}
await browser.close()
process.exit(bad?1:0)
