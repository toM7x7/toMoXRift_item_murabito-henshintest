// Screenshots and checks on the lab page (?lab) with GPU Chrome. The dev server must be running on 5323.
// Usage: node scripts/capture.mjs [scenario ...]     (default: all)
// Scenarios: shape, face, poses, gestures, walk, people, talk, preview
// node scripts/try-pose.mjs '<json>' holds any pose and photographs it from three sides (for writing a new gesture).
// The built-in browser pane stops rendering while it is hidden, so this drives its own browser.
// python scripts/sheets.py puts each scenario's pictures side by side (output/sheet-*.png).
import {chromium} from 'playwright'
import {mkdirSync} from 'node:fs'
import {join} from 'node:path'

const BASE=process.env.VILLAGER_BASE??'http://127.0.0.1:5323/'
const ROOT=join(import.meta.dirname,'..')
const OUT=join(ROOT,'output','capture')
const exe=join(process.env.LOCALAPPDATA??'','ms-playwright','chromium-1243','chrome-win64','chrome.exe')
mkdirSync(OUT,{recursive:true})
const browser=await chromium.launch({executablePath:exe,args:['--use-angle=d3d11','--ignore-gpu-blocklist','--enable-gpu','--autoplay-policy=no-user-gesture-required']})
const results={},errors=[]
const check=(name,ok,detail)=>{results[name]={ok:!!ok,detail};console.log(ok?'PASS':'FAIL',name,detail===undefined?'':JSON.stringify(detail).slice(0,500))}
const r3=x=>Math.round(x*1000)/1000

async function open(query='lab',size={width:560,height:760}){
 const page=await browser.newPage({viewport:size})
 page.on('pageerror',e=>errors.push(String(e)))
 // (three's own notices about things the dev page's helpers use are not ours to fix)
 page.on('console',m=>{if(/deprecated/i.test(m.text()))return;if(m.type()==='error'||(m.type()==='warning'&&/villager|THREE/.test(m.text())))errors.push(m.text())})
 await page.goto(BASE+'?'+query)
 await page.waitForFunction(()=>window.__villager?.ready?.(),null,{timeout:30000})
 await page.waitForTimeout(400)
 return page
}
/** stop the clock at t (seconds) and let the pose settle there */
const at=(page,t,settle=1.0)=>page.evaluate(async([t,settle])=>{
 const b=window.__villager
 b.setTime(t-settle)
 const n=Math.round(settle*60)
 for(let i=0;i<n;i++){b.advance(1/60);await new Promise(r=>requestAnimationFrame(r))}
 await new Promise(r=>requestAnimationFrame(r))
},[t,settle])
/** advance the stopped clock by s seconds, one rendered frame per 1/60 s */
const step=(page,s)=>page.evaluate(async s=>{
 const n=Math.round(s*60)
 for(let i=0;i<n;i++){window.__villager.advance(1/60);await new Promise(r=>requestAnimationFrame(r))}
 await new Promise(r=>requestAnimationFrame(r))
},s)
/** advance s seconds a frame at a time and bring back what he did in every frame */
const record=(page,s)=>page.evaluate(async s=>{
 const b=window.__villager,out=[],n=Math.round(s*60)
 for(let i=0;i<n;i++){
  b.advance(1/60);await new Promise(r=>requestAnimationFrame(r))
  const q=b.report()
  out.push({x:q.position[0],z:q.position[2],yaw:q.yaw,walk:q.walk,going:q.going,turning:q.turning,gesture:q.gesture,talking:q.talking,
   kneeL:q.solved.kneeL,kneeR:q.solved.kneeR,reach:Math.max(q.solved.reachL,q.solved.reachR),lly:q.pose.lly,rly:q.pose.rly,llz:q.pose.llz,rlz:q.pose.rlz,
   hy:q.pose.hy,jaw:q.pose.jaw,blink:q.pose.blink,blips:q.blips,lookYaw:q.lookYaw,py:q.pose.py})
 }
 return out
},s)
const report=page=>page.evaluate(()=>window.__villager.report())
const view=(page,p,t)=>page.evaluate(([p,t])=>window.__villager.view(p,t),[p,t])
const shot=async(page,name)=>{await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await page.screenshot({path:join(OUT,name+'.png')})}
/** look at a point from `dist` away, `deg` round from his front (0 = facing him) */
const orbit=(page,deg,dist=4.2,target=[0,0.9,0],lift=0.1)=>{
 const a=deg*Math.PI/180
 return view(page,[target[0]+Math.sin(a)*dist,target[1]+lift,target[2]+Math.cos(a)*dist],target)
}
const pose=(page,p)=>page.evaluate(async p=>{window.__villager.pose(p);for(let i=0;i<3;i++)await new Promise(r=>requestAnimationFrame(r))},p)

const scenarios={
 /** the model itself, from all round: as photographed, and standing at ease */
 async shape(){
  const page=await open()
  await page.evaluate(()=>{window.__villager.still(true);window.__villager.setTime(1000);window.__villager.eyes([0,1.6,30])})
  await pose(page,'rest')
  for(const deg of [0,45,90,135,180,225,270,315]){await orbit(page,deg);await shot(page,`shape-rest-${String(deg).padStart(3,'0')}`)}
  await pose(page,{})
  for(const deg of [0,45,90,135,180,225,270,315]){await orbit(page,deg);await shot(page,`shape-stand-${String(deg).padStart(3,'0')}`)}
  await view(page,[0.4,3.6,2.2],[0,0.9,0]);await shot(page,'shape-stand-top')
  const r=await report(page)
  check('the model loads and stands',r&&r.visible,{reach:r3(Math.max(r.solved.reachL,r.solved.reachR)),knee:r3(r.solved.kneeL)})
  await page.close()
 },
 /** the head close up: the photos, the bare shape, and which photo goes where */
 async face(){
  const page=await open('lab',{width:520,height:560})
  await page.evaluate(()=>{window.__villager.still(true);window.__villager.setTime(1000);window.__villager.eyes([0,1.6,30])})
  await pose(page,{})
  const degs=[0,25,50,90,135,180,-50,-90]
  for(const [mode,name] of [[0,'face'],[1,'clay'],[2,'map']]){
   await page.evaluate(m=>window.__villager.clay(m),mode)
   for(let i=0;i<degs.length;i++){await orbit(page,degs[i],1.25,[0,1.56,0.02],0.0);await shot(page,`${name}-${i}`)}
  }
  await page.evaluate(()=>window.__villager.clay(0))
  await orbit(page,15,0.85,[0,1.58,0.02],0)
  await pose(page,{blink:1});await shot(page,'lids-0')
  await pose(page,{blink:0.5});await shot(page,'lids-1')
  await pose(page,{jaw:0.09});await shot(page,'lids-2')
  await pose(page,{hy:0.7,hp:0.15});await shot(page,'lids-3')
  await page.close()
 },
 /** standing at ease and a few held poses, close enough to see the joints */
 async poses(){
  const page=await open('lab',{width:520,height:700})
  await page.evaluate(()=>{window.__villager.still(true);window.__villager.setTime(1000);window.__villager.eyes([0,1.6,30])})
  const P={
   stand:{},
   bow:{pp:0.3,sp:0.3,hp:0.12,pz:-0.075,lf:-0.2,rf:-0.2},
   crouch:{py:-0.22,pp:0.25,sp:0.2},
   step:{llz:0.25,rlz:-0.25,rlp:0.3,py:-0.03,lf:-0.28,rf:0.32,re:0.3},
   lean:{px:0.03,pr:-0.045,sr:0.05,rlz:0.035},
   armsup:{lo:0.35,lu:1,lf:0.06,lr:-0.5,le:0.3,lt:0.9,ro:0.35,ru:1,rf:0.06,rr:-0.5,re:0.3,rt:0.9,sp:-0.1,hp:-0.15},
   wave:{ro:0.86,ru:0.2,rf:0.34,rr:-1.25,re:1.5,rt:1.25},
   talk:{lo:0.3,lu:-0.82,lf:0.42,lr:0.15,le:1.25,lt:0.25,lwf:-0.1},
   hips:{lo:0.62,lu:-0.74,lf:-0.2,lr:0.95,le:1.55,lt:1.6,lwf:0.5,ro:0.62,ru:-0.74,rf:-0.2,rr:0.95,re:1.55,rt:1.6,rwf:0.5},
   scratch:{ro:0.62,ru:0.62,rf:0.3,rr:-1.9,re:2.25,rt:1.5,rwf:0.25,hp:0.1},
   sky:{lo:0.5,lu:0.42,lf:0.75,lr:-0.55,le:2.1,lt:1.75,lwf:0.1,hp:-0.36,sp:-0.06},
   twist:{sy:0.5,hy:0.6,pw:0.1},
  }
  for(const [name,p] of Object.entries(P)){
   await pose(page,p)
   let i=0
   for(const deg of [20,-70,160]){await orbit(page,deg,3.3,[0,0.95,0],0.25);await shot(page,`pose-${name}-${i++}`)}
   const r=await report(page)
   check(`pose ${name}: the feet reach the ground`,Math.max(r.solved.reachL,r.solved.reachR)<0.06,{reach:r3(Math.max(r.solved.reachL,r.solved.reachR)),kneeL:r3(r.solved.kneeL),kneeR:r3(r.solved.kneeR)})
  }
  await page.close()
 },
 /** every gesture, a frame every so often */
 async gestures(){
  const page=await open('lab',{width:400,height:560})
  await page.evaluate(()=>{window.__villager.still(true);window.__villager.setTime(5000);window.__villager.eyes([0,1.6,30])})
  await step(page,0.5)
  for(const name of ['wave','bow','stretch','scratch','hips','sky','clasp','neck']){
   await page.evaluate(n=>window.__villager.gesture(n,-1),name)
   const dur={wave:2.7,bow:2.5,stretch:4.4,scratch:3.2,hips:6.4,sky:4.4,clasp:6.6,neck:3.6}[name]
   await orbit(page,25,3.0,[0,1.0,0],0.2)
   let seen=false
   for(let i=0;i<6;i++){
    await step(page,dur/6.5)
    const r=await report(page)
    seen=seen||r.gesture===name
    await shot(page,`gesture-${name}-${i}`)
   }
   await step(page,dur/6.5+0.6)
   const r=await report(page)
   check(`gesture ${name} plays and ends`,seen&&r.gesture==='',{after:r.gesture})
  }
  await page.close()
 },
 /** he walks from one spot to the next: seen from the side, and whether the planted foot stays put */
 async walk(){
  const page=await open('lab',{width:900,height:520})
  await page.evaluate(()=>{window.__villager.eyes([0,1.6,40])})
  // find a moment when the place he should stand changes
  const t0=await page.evaluate(async()=>{
   const b=window.__villager
   let prev=null
   for(let t=2000;t<2600;t+=1){
    b.setTime(t);await new Promise(r=>requestAnimationFrame(r))
    const g=b.report().goal
    if(prev&&Math.hypot(g[0]-prev[0],g[1]-prev[1])>0.9)return t
    prev=g
   }
   return null
  })
  check('a walk is found',t0!==null,{t0})
  if(t0===null){await page.close();return}
  await at(page,t0-0.6,3)
  const before=await report(page)
  await view(page,[before.position[0]+3.2,1.0,before.position[2]+3.2],[before.position[0]*0.5,0.85,before.position[2]*0.5])
  const rec=[]
  for(let i=0;i<14;i++){
   rec.push(...await record(page,0.3))
   await shot(page,`walk-${String(i).padStart(2,'0')}`)
  }
  rec.push(...await record(page,4))
  const after=await report(page)
  const moved=Math.hypot(after.position[0]-before.position[0],after.position[2]-before.position[2])
  check('he walks to the new spot',moved>0.8&&Math.hypot(after.position[0]-after.goal[0],after.position[2]-after.goal[1])<0.2,{moved:r3(moved),goal:after.goal.map(r3),at:[after.position[0],after.position[2]].map(r3)})
  check('he stops there and stands',after.walk<0.01&&!after.going,{walk:r3(after.walk)})
  // a foot that is on the ground must not slide: its place in the world while it is planted
  const slips=[]
  for(const [zk,yk,side] of [['llz','lly',1],['rlz','rly',-1]]){
   let start=null
   for(const q of rec){
    const planted=q[yk]<0.002&&q.walk>0.9
    const wx=q.x+Math.sin(q.yaw)*q[zk],wz=q.z+Math.cos(q.yaw)*q[zk]
    if(planted){if(!start)start=[wx,wz];else slips.push(Math.hypot(wx-start[0],wz-start[1]))}else start=null
   }
   void side
  }
  const slip=slips.length?Math.max(...slips):0
  check('a planted foot does not slide',slip<0.05,{slip:r3(slip),samples:slips.length})
  const reach=Math.max(...rec.map(q=>q.reach))
  check('the legs are never stretched past their length',reach<0.03,{reach:r3(reach)})
  const lift=Math.max(...rec.map(q=>Math.max(q.lly,q.rly)))
  check('the feet lift off the ground',lift>0.04&&lift<0.12,{lift:r3(lift)})
  await page.close()
 },
 /** somebody comes up to him: he looks, greets, and turns to face them when they go round behind */
 async people(){
  const page=await open('lab',{width:760,height:560})
  // nobody near: I am far away
  await page.evaluate(()=>{window.__villager.eyes([0,1.6,40])})
  await at(page,3000,2)
  const alone=await report(page)
  check('nobody near: he does not notice anyone',!alone.noticed,{nearest:r3(alone.nearest)})
  // I walk up in front of him and to one side
  const p=alone.position,yaw=alone.yaw
  const front=(d,side)=>[p[0]+Math.sin(yaw)*d+Math.cos(yaw)*side,1.6,p[2]+Math.cos(yaw)*d-Math.sin(yaw)*side]
  await view(page,[p[0]+Math.sin(yaw+0.5)*4.2,1.3,p[2]+Math.cos(yaw+0.5)*4.2],[p[0],1.0,p[2]])
  await page.evaluate(e=>window.__villager.eyes(e),front(2.2,0.9))
  const rec=await record(page,0.9)
  await shot(page,'people-0')
  const r1=await report(page)
  check('somebody comes up: he notices and looks at them',r1.noticed&&Math.abs(r1.lookYaw)>0.15,{lookYaw:r3(r1.lookYaw),headYaw:r3(r1.pose.hy)})
  check('he greets them',r1.gesture==='wave'||r1.gesture==='bow',{gesture:r1.gesture})
  void rec
  await step(page,0.9);await shot(page,'people-1')
  await step(page,2.5)
  // they go round behind him: he turns on the spot to face them
  const back=[p[0]-Math.sin(yaw)*1.8,1.6,p[2]-Math.cos(yaw)*1.8]
  await page.evaluate(e=>window.__villager.eyes(e),back)
  const turn=await record(page,2.6)
  await shot(page,'people-2')
  const r2=await report(page)
  const want=Math.atan2(back[0]-r2.position[0],back[2]-r2.position[2])
  const err=Math.abs(((r2.yaw-want+Math.PI*3)%(Math.PI*2))-Math.PI)
  check('they go behind him: he turns round to face them',err<0.25&&turn.some(q=>q.turning),{err:r3(err)})
  check('he steps as he turns',Math.max(...turn.map(q=>Math.max(q.lly,q.rly)))>0.015,{lift:r3(Math.max(...turn.map(q=>Math.max(q.lly,q.rly))))})
  // somebody else, close by on the other side
  await page.evaluate(([e,q])=>{window.__villager.eyes(e);window.__villager.person('user-a',q)},[[0,1.6,40],[r2.position[0]+1.2,0,r2.position[2]+0.4]])
  await step(page,1.6);await shot(page,'people-3')
  const r3_=await report(page)
  check('another person near: he notices them too',r3_.noticed&&r3_.nearest<2,{nearest:r3(r3_.nearest)})
  await page.close()
 },
 /** talking to him: a line appears as the hint, his jaw moves, the voice plays, and he faces the speaker */
 async talk(){
  const page=await open('lab',{width:560,height:560})
  await page.evaluate(()=>{window.__villager.eyes([0,1.6,40])})
  await at(page,4000,2)
  const r0=await report(page)
  const p=r0.position
  const me=[p[0]+Math.sin(r0.yaw+1.9)*1.5,1.6,p[2]+Math.cos(r0.yaw+1.9)*1.5]
  await page.evaluate(e=>window.__villager.eyes(e),me)
  await step(page,3.2)
  await view(page,[me[0]+(me[0]-p[0])*0.35,1.62,me[2]+(me[2]-p[2])*0.35],[p[0],1.48,p[2]])
  const hint=await page.evaluate(()=>window.__villager.text(':talk'))
  check('the hint says what clicking does',hint==='話しかける',{hint})
  const clicked=await page.evaluate(()=>window.__villager.click(':talk'))
  const rec=await record(page,0.5)
  const line=await page.evaluate(()=>window.__villager.text(':talk'))
  check('clicking makes him speak: the line is shown as the hint',clicked&&line&&line!=='話しかける',{line})
  await shot(page,'talk-0')
  rec.push(...await record(page,0.7));await shot(page,'talk-1')
  rec.push(...await record(page,0.7));await shot(page,'talk-2')
  const again=await page.evaluate(()=>window.__villager.click(':talk'))
  const same=await page.evaluate(()=>window.__villager.text(':talk'))
  check('clicking again while he speaks changes nothing',again&&same===line,{same})
  rec.push(...await record(page,5))
  await shot(page,'talk-3')
  const r1=await report(page)
  check('his jaw moves while he speaks',Math.max(...rec.map(q=>q.jaw))>0.03,{jaw:r3(Math.max(...rec.map(q=>q.jaw)))})
  check('the voice plays one sound per syllable',r1.blips>=5&&r1.blips<=20,{blips:r1.blips})
  const want=Math.atan2(me[0]-r1.position[0],me[2]-r1.position[2])
  const err=Math.abs(((r1.yaw-want+Math.PI*3)%(Math.PI*2))-Math.PI)
  check('he turns to whoever spoke to him',err<0.4,{err:r3(err)})
  const after=await page.evaluate(()=>window.__villager.text(':talk'))
  check('when he has finished the hint is back',!r1.talking&&after==='話しかける',{after})
  await page.evaluate(()=>window.__villager.click(':talk'))
  await step(page,0.4)
  const line2=await page.evaluate(()=>window.__villager.text(':talk'))
  check('the next time he says something else',line2&&line2!==line&&line2!=='話しかける',{line2})
  check('what is clicked stands where he stands',Math.hypot(r1.hit[0]-r1.position[0],r1.hit[2]-r1.position[2])<0.01,{hit:r1.hit.map(r3)})
  await page.close()
 },
 /** before it is put down: he just stands, and cannot be clicked */
 async preview(){
  const page=await open('lab&preview',{width:400,height:560})
  await page.evaluate(()=>{window.__villager.eyes([0.5,1.6,1.5])})
  await at(page,2140,3)
  await orbit(page,20,3.4,[0,0.95,0],0.2)
  await shot(page,'preview-0')
  const r=await report(page)
  check('preview: he stands still where he will be put',Math.hypot(r.position[0],r.position[2])<0.01&&r.walk===0&&r.gesture==='',{position:r.position.map(r3),gesture:r.gesture})
  const hint=await page.evaluate(()=>window.__villager.text(':talk'))
  check('preview: nothing to click',hint===null,{hint})
  await page.close()
 },
 /** wearing him: the mat, my own avatar, first person, a warm-up routine, taking him off, somebody else, leaving */
 async wear(){
  const page=await open('lab&wear',{width:640,height:560})
  await page.evaluate(()=>{window.__villager.eyes([0,1.6,40])})
  await page.waitForFunction(()=>window.__villager.shown('user-me').meshes>0&&window.__villager.shown('user-a').meshes>0,null,{timeout:30000})
  await at(page,6000,1)
  const v=window=>0;void v
  check('the mat says what it does',await page.evaluate(()=>window.__villager.text(':mat'))==='村人Aになる')
  await page.evaluate(()=>window.__villager.click(':mat'))
  await step(page,0.6)
  let d=await page.evaluate(()=>window.__villager.bridge().debug())
  check('clicking the mat: I wear him (my skeleton is read)',d.status==='worn'&&d.wearer==='user-me',{status:d.status,read:d.read})
  check('my avatar is hidden while it is drawn, and shown again after',d.hidden>0&&(await page.evaluate(()=>window.__villager.shown('user-me'))).visible>0,{hidden:d.hidden})
  check('his size follows my avatar',d.scale>0.7&&d.scale<1.3,{scale:r3(d.scale)})
  check('nobody can talk to him while he is worn',await page.evaluate(()=>window.__villager.text(':talk'))===null)
  check('the mat now takes him off',await page.evaluate(()=>window.__villager.text(':mat'))==='村人Aをやめる')
  const me=[0.9,0,1.6]
  await view(page,[me[0]+1.6,1.3,me[2]+2.2],[me[0],0.95,me[2]]);await shot(page,'wear-0')
  // first person: his head folds away (the camera is in it)
  await page.evaluate(()=>window.__villager.viewpoint('first-person',true))
  await step(page,0.1)
  check('first person: his head is folded away for me',await page.evaluate(()=>window.__villager.actor().skin.uniforms.uHideHead.value)===1)
  await view(page,[me[0],1.57,me[2]+0.09],[me[0],0,me[2]+0.3]);await shot(page,'wear-1')
  await page.evaluate(()=>window.__villager.viewpoint('third-person'))
  // the warm-up routine, a frame at a time
  await page.evaluate(()=>window.__villager.avatar('user-me',{motion:'routine'}))
  await view(page,[me[0]+1.6,1.3,me[2]+2.2],[me[0],0.95,me[2]])
  let reach=0,n=0
  for(let i=0;i<8;i++){
   await step(page,1.1)
   const q=await page.evaluate(()=>window.__villager.bridge().debug())
   reach=Math.max(reach,q.reach);n+=q.status==='worn'?1:0
   if(i%2===0)await shot(page,'wear-'+(2+i/2))
  }
  check('through the routine he keeps following, his feet on the floor',n===8&&reach<0.04,{reach:r3(reach)})
  await page.evaluate(()=>window.__villager.avatar('user-me',{motion:'idle'}))
  // taking him off: he steps out where I stood and walks home
  await page.evaluate(()=>window.__villager.click(':mat'))
  await step(page,0.3)
  let r=await report(page)
  d=await page.evaluate(()=>window.__villager.bridge().debug())
  check('taking him off: he is himself again, where I stood',d.status==='off'&&Math.hypot(r.position[0]-me[0],r.position[2]-me[2])<0.3&&r.visible,{at:r.position.map(r3)})
  check('my avatar is shown again',(await page.evaluate(()=>window.__villager.shown('user-me'))).visible>0)
  check('and he can be talked to again',await page.evaluate(()=>window.__villager.text(':talk'))==='話しかける')
  await step(page,5)
  r=await report(page)
  check('he walks back towards his place',Math.hypot(r.position[0]-me[0],r.position[2]-me[2])>0.4,{at:r.position.map(r3),goal:r.goal.map(r3)})
  // somebody else wears him: I cannot take him from them
  await page.evaluate(()=>window.__villager.wear('user-a'))
  await step(page,0.6)
  d=await page.evaluate(()=>window.__villager.bridge().debug())
  check('somebody else wears him (their skeleton is read)',d.status==='worn'&&d.wearer==='user-a',{status:d.status})
  check('the mat is not for me meanwhile',await page.evaluate(()=>window.__villager.enabled(':mat'))===false)
  await view(page,[-1.0+1.4,1.3,1.5+2.4],[-1.0,0.95,1.5]);await shot(page,'wear-6')
  // they leave the room: after a while he is let go
  await page.evaluate(()=>window.__villager.person('user-a',null))
  await step(page,7)
  d=await page.evaluate(()=>window.__villager.bridge().debug())
  check('the wearer leaves the room: he is let go',d.status==='off'&&await page.evaluate(()=>window.__villager.text(':mat'))==='村人Aになる',{status:d.status})
  await page.close()
 },
 /** worn: his size for each viewer, and what the wearer can make him do (keys, the room, the key strip) */
 async henshin(){
  const page=await open('lab&wear',{width:640,height:560})
  await page.evaluate(()=>{window.__villager.eyes([0,1.6,40])})
  await page.waitForFunction(()=>window.__villager.shown('user-me').meshes>0&&window.__villager.shown('user-a').meshes>0,null,{timeout:30000})
  await at(page,7000,1)
  const B=()=>page.evaluate(()=>window.__villager.bridge().debug())
  const press=code=>page.evaluate(c=>window.__villager.key(c),code)
  check('a key does nothing while I do not wear him',await press('KeyZ')===false)
  await page.evaluate(()=>window.__villager.wear('user-me'))
  await step(page,0.5)
  let d=await B()
  check('third person: he is his own size',Math.abs(d.scale-1)<0.01,{scale:r3(d.scale)})
  await page.evaluate(()=>window.__villager.viewpoint('first-person',true));await step(page,0.1)
  const fp=(await B()).scale
  await page.evaluate(()=>window.__villager.viewpoint('third-person'));await step(page,0.1)
  const eye=await page.evaluate(()=>window.__villager.eye('user-me'))
  check('my own first person: matched to my eyes',Math.abs(fp-eye/1.5924)<0.01,{scale:r3(fp),eye:r3(eye)})
  const hint=await page.evaluate(()=>window.__villager.hintText())
  check('the key strip is on my screen',!!hint&&hint.includes('手を振る')&&hint.includes('ひとこと'),{hint})
  const me=[0.9,0,1.6]
  await view(page,[me[0]+1.2,1.35,me[2]+2.6],[me[0],1.0,me[2]])
  // Z: wave
  check('Z is taken by him',await press('KeyZ')===true)
  for(let i=0;i<4;i++){await step(page,0.55);if(i===1)d=await B();await shot(page,'henshin-wave-'+i)}
  check('Z: he waves (over the avatar pose)',d.gesture==='wave'&&d.status==='worn',{gesture:d.gesture})
  await step(page,1.5)
  // a key while a gesture runs is ignored; after it, X bows
  await press('KeyX');await step(page,0.9);d=await B()
  check('X: he bows',d.gesture==='bow',{gesture:d.gesture});await shot(page,'henshin-bow-0')
  await step(page,2.2)
  // C: a line, said with the voice and the jaw; shown on my strip
  const blips0=(await report(page)).blips
  await press('KeyR');let jaw=0
  for(let i=0;i<10;i++){await step(page,0.2);const q=await B();jaw=Math.max(jaw,q.follow.jaw)}
  const r=await report(page),strip=await page.evaluate(()=>window.__villager.hintText())
  check('R: he says a line (voice and jaw), and I can read it',r.blips>blips0&&jaw>0.02&&strip.length>hint.length,{blips:r.blips-blips0,jaw:r3(jaw),strip})
  await shot(page,'henshin-say-0')
  await step(page,6)
  // V: the next of his idle gestures each time
  const seen=[]
  for(let i=0;i<2;i++){await press('KeyF');await step(page,1.2);seen.push((await B()).gesture);await shot(page,'henshin-idle-'+i);await step(page,6.5)}
  check('F: a different gesture each time',seen[0]&&seen[1]&&seen[0]!==seen[1],{seen})
  // somebody else wears him: what they ask for arrives from the room; nobody else can make him do things
  await page.evaluate(()=>window.__villager.wear('user-a'))
  await step(page,0.5)
  check('my keys do nothing when somebody else wears him',await press('KeyZ')===false)
  await page.evaluate(()=>window.__villager.receive({a:'gesture',g:'wave',side:-1},'user-me'))
  await step(page,0.6)
  check('a request from someone who is not wearing him is ignored',(await B()).gesture==='')
  await page.evaluate(()=>window.__villager.receive({a:'say',line:2},'user-a'))
  await step(page,0.6)
  d=await B()
  const shown=await page.evaluate(()=>window.__villager.text(':worn'))
  check('what the wearer says arrives: he speaks, and aiming at him shows the line',d.gesture==='talk'&&shown==='わたしは村人A。ただの村人さ。',{gesture:d.gesture,shown})
  await view(page,[-1.0+1.2,1.35,1.5+2.6],[-1.0,1.0,1.5]);await shot(page,'henshin-other-0')
  check('no key strip on my screen when I do not wear him',await page.evaluate(()=>window.__villager.hintText())===null)
  await page.close()
 },
}

const wanted=process.argv.slice(2)
for(const name of (wanted.length?wanted:Object.keys(scenarios))){
 if(!scenarios[name]){console.log('unknown scenario',name);continue}
 try{await scenarios[name]()}catch(e){check(name+' ran',false,String(e))}
}
await browser.close()
if(errors.length)console.log('PAGE ERRORS',[...new Set(errors)].slice(0,12))
const bad=Object.entries(results).filter(([,v])=>!v.ok).map(([k])=>k)
console.log(bad.length?`FAILED ${bad.length}: ${bad.join(', ')}`:`all ${Object.keys(results).length} checks passed`,errors.length?`(${errors.length} page errors)`:'')
process.exit(bad.length||errors.length?1:0)
