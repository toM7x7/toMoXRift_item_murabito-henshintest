import {useCallback,useEffect,useMemo,useRef,useState} from 'react'
import {useFrame,useThree} from '@react-three/fiber'
import {Interactable,useInstanceEvent,useInstanceState,useItem,usePlacementState,useServerClock,useUsers,useViewpoint,useXRift} from '@xrift/world-components'
import * as THREE from 'three'
import {MAT,VillagerActor,type ActorInput} from './villager/actor'
import {playBlip} from './villager/audio'
import {hash,seedOf} from './villager/brain'
import {loadHuman} from './villager/model'
import {CANNOT_WEAR,HINT_TITLE,LINES,syllables,TALK_HINT,UNWEAR,WEAR,WORN_NAME} from './words'
import {createAbilityInput,type Ability,type AbilityInput} from './henshin/abilities'
import {IDLE_GESTURES,VILLAGER_ABILITIES,type ActPayload} from './henshin/villager'
import {Html} from '@react-three/drei'
import {createPortal} from '@react-three/fiber'
import {WearBridge} from './wear'

export interface ItemProps{position?:[number,number,number];scale?:number}

/** Development only: the lab page can say where 'my' eyes are instead of the camera (dev.tsx). */
type DevHook={eyes?:THREE.Vector3|null;actors?:Map<string,VillagerActor>;wear?:Map<string,WearBridge>;setWear?:Map<string,(who:string|null)=>void>;fire?:Map<string,(ability:string)=>void>;act?:Map<string,(p:ActPayload,from:string)=>void>}
const dev=()=>(globalThis as {__villagerDev?:DevHook}).__villagerDev

const world=new THREE.Vector3(),feetV=new THREE.Vector3()

/** who wears him: a user id, or null. rev only makes every write a change */
interface WearState{who:string|null;rev:number}
const NOBODY:WearState={who:null,rev:0}
/** a wearer who has left the room is let go after this long (by any client that has been here a while) */
const GONE_S=5,SETTLED_S=10

/**
 * 村人A。置いた場所のまわりで立ち、ときどき数歩あるき、近くの人を見て挨拶し、話しかけるとひとこと返す。
 * ふだんのしぐさと歩く先は共有時計と配置IDだけで決まるので、通信なしで全員の画面で同じになる。
 * 話しかけたことだけ useInstanceEvent で送る。
 * 前のござをクリックすると、その人が村人Aになる（wear.ts。誰が着ているかは useInstanceState で共有）。
 */
export function Item({position,scale=1}:ItemProps){
 const {id}=useItem()
 const {baseUrl}=useXRift()
 const preview=usePlacementState().mode==='preview'
 const users=useUsers()
 const clock=useServerClock()
 const now=useRef(clock.now)
 now.current=clock.now
 const usersRef=useRef(users)
 usersRef.current=users
 const [actor,setActor]=useState<VillagerActor|null>(null)
 const actorRef=useRef<VillagerActor|null>(null)
 const group=useRef<THREE.Group>(null)
 const ear=useRef({distance:99})
 const input=useMemo<ActorInput>(()=>({t:0,people:[]}),[])
 const pool=useRef<THREE.Vector3[]>([])
 const myEyes=useMemo(()=>new THREE.Vector3(),[])
 const scene=useThree(s=>s.scene)
 const {getViewpoint}=useViewpoint()
 const localId=users.localUser?.id??null
 const [wear,setWear]=useInstanceState<WearState>(`villager-a:${id}:wear:v1`,NOBODY)
 const wearRef=useRef(wear)
 wearRef.current=wear
 const bridge=useRef<WearBridge|null>(null)
 const seen=useRef({since:-1,goneAt:-1,lastFeet:new THREE.Vector3(),lastYaw:0,had:false})
 const [wearStatus,setWearStatus]=useState('off')
 // what he is saying now: shown where the platform shows the hint for the thing you aim at
 const [line,setLine]=useState<number|null>(null)
 const lineRef=useRef<number|null>(null)

 useEffect(()=>{
  let live=true,made:VillagerActor|null=null
  loadHuman(`${baseUrl}villager_a.glb`).then(src=>{
   if(!live)return
   made=new VillagerActor(src,id,{onBlip:(i,total)=>playBlip(i,total,ear.current.distance)})
   actorRef.current=made
   dev()?.actors?.set(id,made)
   setActor(made)
  }).catch(e=>console.warn('[villager-a] the model could not be loaded',e))
  return()=>{live=false;actorRef.current=null;dev()?.actors?.delete(id);made?.dispose()}
 },[baseUrl,id])

 useEffect(()=>{
  const g=group.current
  if(!actor||!g||preview)return
  const b=new WearBridge(scene,actor,g)
  bridge.current=b
  dev()?.wear?.set(id,b)
  return()=>{b.dispose();bridge.current=null;dev()?.wear?.delete(id)}
 },[actor,scene,preview,id])
 useEffect(()=>{
  const m=dev()?.setWear
  if(!m)return
  m.set(id,who=>setWear(w=>({who,rev:w.rev+1})))
  return()=>{m.delete(id)}
 },[id,setWear])
 // ---- what the wearer makes him do (henshin/villager.ts) ----
 const runAct=useCallback((p:ActPayload,t0:number)=>{
  const a=actorRef.current
  if(!a)return
  if(p.a==='say'&&typeof p.line==='number'&&p.line>=0&&p.line<LINES.length){a.talk(p.line,syllables(LINES[p.line]),t0,null);lineRef.current=p.line;setLine(p.line)}
  else if(p.a==='gesture'&&p.g&&IDLE_GESTURES.concat(['wave','bow']).includes(p.g))a.act(p.g,t0,p.side===1?1:-1)
 },[])
 const emitAct=useInstanceEvent<ActPayload>(`villager-a:${id}:act`,({payload,senderId,timestamp})=>{
  // only the person wearing him can make him do things
  if(!payload||senderId!==wearRef.current.who)return
  runAct(payload,(timestamp||now.current())/1000)
 })
 useEffect(()=>{
  const m=dev()?.act
  if(!m)return
  m.set(id,(p,from)=>{if(from===wearRef.current.who)runAct(p,now.current()/1000)})
  return()=>{m.delete(id)}
 },[id,runAct])
 const idleN=useRef(0)
 const [fired,setFired]=useState<{id:string;seq:number}|null>(null)
 const fire=useCallback((abilityId:string)=>{
  const a=actorRef.current,b=bridge.current
  if(!a||!b||b.status!=='worn'||wearRef.current.who!==localId)return
  if(a.state.gesture)return
  const t=now.current()/1000
  let p:ActPayload
  if(abilityId==='say'){
   let n=Math.floor(hash(seedOf(id),Math.floor(t*10),93)*LINES.length)%LINES.length
   if(n===a.state.line)n=(n+1)%LINES.length
   p={a:'say',line:n}
  }else if(abilityId==='wave')p={a:'gesture',g:'wave',side:-1}
  else if(abilityId==='bow')p={a:'gesture',g:'bow',side:1}
  else p={a:'gesture',g:IDLE_GESTURES[idleN.current++%IDLE_GESTURES.length],side:Math.floor(t)%2?1:-1}
  runAct(p,t)
  emitAct(p)
  setFired(f=>({id:abilityId,seq:(f?.seq??0)+1}))
 },[emitAct,id,localId,runAct])
 const fireRef=useRef(fire)
 fireRef.current=fire
 const abilityInput=useRef<AbilityInput|null>(null)
 const iWear=!!localId&&wear.who===localId&&!preview
 useEffect(()=>{
  if(!iWear)return
  const inp=createAbilityInput(VILLAGER_ABILITIES,abilityId=>fireRef.current(abilityId))
  abilityInput.current=inp
  const m=dev()?.fire
  m?.set(id,abilityId=>fireRef.current(abilityId))
  return()=>{inp.dispose();abilityInput.current=null;m?.delete(id)}
 },[iWear,id])
 const onMat=useCallback(()=>{
  if(!localId)return
  const w=wearRef.current
  if(w.who===localId)setWear({who:null,rev:w.rev+1})
  else if(!w.who)setWear({who:localId,rev:w.rev+1})
 },[localId,setWear])

 /** where somebody's eyes are, in this item's space */
 const eyesOf=useCallback((userId:string):THREE.Vector3|null=>{
  const u=usersRef.current,g=group.current
  const mv=u.getMovement(userId)
  if(!mv||!g)return null
  const p=new THREE.Vector3(mv.position.x,mv.position.y+(u.getAvatarHeight?.(userId)?.eyeHeight??1.35),mv.position.z)
  g.updateWorldMatrix(true,false)
  return g.worldToLocal(p)
 },[])
 const say=useCallback((n:number,at:number,from:THREE.Vector3|null)=>{
  const a=actorRef.current
  if(!a||!(n>=0&&n<LINES.length))return
  a.talk(n,syllables(LINES[n]),at,from)
  lineRef.current=n
  setLine(n)
 },[])
 // the sender does not get its own event back, so it also runs it here
 const emit=useInstanceEvent<{line:number}>(`villager-a:${id}`,({payload,senderId,timestamp})=>{
  if(typeof payload?.line==='number')say(payload.line|0,(timestamp||now.current())/1000,eyesOf(senderId))
 })
 const onTalk=useCallback(()=>{
  const a=actorRef.current
  if(!a||a.state.talking)return
  const t=now.current()
  // a different line each time, never the same twice running
  let n=Math.floor(hash(seedOf(id),Math.floor(t/700),91)*LINES.length)%LINES.length
  if(n===a.state.line)n=(n+1)%LINES.length
  say(n,t/1000,myEyes.clone())
  emit({line:n})
 },[emit,id,myEyes,say])

 useFrame(state=>{
  const a=actorRef.current,g=group.current
  if(!a||!g)return
  const u=usersRef.current
  g.updateWorldMatrix(true,false)
  const eyesOverride=dev()?.eyes
  if(eyesOverride)myEyes.copy(eyesOverride);else state.camera.getWorldPosition(myEyes)
  ear.current.distance=world.copy(a.position).applyMatrix4(g.matrixWorld).distanceTo(myEyes)
  g.worldToLocal(myEyes)
  const people=input.people
  people.length=0
  if(!preview){
   people.push(myEyes)
   let n=0
   for(const user of u.remoteUsers){
    const mv=u.getMovement(user.id)
    if(!mv)continue
    const p=pool.current[n]??(pool.current[n]=new THREE.Vector3())
    n++
    p.set(mv.position.x,mv.position.y+(u.getAvatarHeight?.(user.id)?.eyeHeight??1.35),mv.position.z)
    g.worldToLocal(p)
    people.push(p)
   }
  }
  input.t=now.current()/1000
  a.preview=preview
  // ---- worn? ----
  const t=input.t,wst=wearRef.current,sn=seen.current,b=bridge.current
  if(sn.since<0)sn.since=t
  let wearer=null as null|{userId:string;isLocal:boolean;mv:{position:{x:number;y:number;z:number}};eye:number|null}
  if(wst.who&&!preview){
   const isLocal=wst.who===localId
   const mv=isLocal?u.getLocalMovement?.():u.getMovement(wst.who)
   if(mv){
    const h=isLocal?u.getLocalAvatarHeight?.():u.getAvatarHeight?.(wst.who)
    wearer={userId:wst.who,isLocal,mv,eye:h?.eyeHeight??null}
    sn.goneAt=-1
   }else if(t-sn.since>SETTLED_S){
    // the wearer has left the room: let him go (any client that has been here long enough to know)
    if(sn.goneAt<0)sn.goneAt=t
    else if(t-sn.goneAt>GONE_S){sn.goneAt=-1;setWear(w=>w.who===wst.who?{who:null,rev:w.rev+1}:w)}
   }
  }
  if(wearer&&b){
   feetV.set(wearer.mv.position.x,wearer.mv.position.y,wearer.mv.position.z)
   b.set({userId:wearer.userId,isLocal:wearer.isLocal,feet:feetV,eyeHeight:wearer.eye,firstPerson:wearer.isLocal&&getViewpoint()==='first-person',t})
   if(!a.worn)a.beginWorn()
   a.worn=true
   ear.current.distance=feetV.distanceTo(state.camera.getWorldPosition(world))
   if(wearer.isLocal)abilityInput.current?.pollXR(state.gl.xr.isPresenting?state.gl.xr.getSession():null)
   if(lineRef.current!==null&&!a.speaking){lineRef.current=null;setLine(null)}
   // (drawn by the bridge at render time, only once the avatar has been read)
   if(b.status!=='worn')a.object.visible=false
   sn.lastFeet.copy(feetV);g.worldToLocal(sn.lastFeet);sn.lastYaw=b.measured.heading;sn.had=true
   // what others aim at: a column where he stands
   a.hit.position.set(sn.lastFeet.x,a.rig.info.height/2,sn.lastFeet.z)
   if(b.status!==wearStatus)setWearStatus(b.status)
   return
  }
  b?.set(null)
  if(wearStatus!=='off')setWearStatus('off')
  if(a.worn){
   // nobody wears him any more: he steps out where the wearer stood and goes home
   a.worn=false
   if(sn.had){
    const yaw=sn.lastYaw-Math.atan2(g.matrixWorld.elements[8],g.matrixWorld.elements[10])
    a.placeAt(sn.lastFeet.x,sn.lastFeet.z,yaw,t)
   }else a.placeAt(a.position.x,a.position.z,a.yaw,t)
   sn.had=false
  }
  a.update(input)
  if(lineRef.current!==null&&!a.state.talking){lineRef.current=null;setLine(null)}
 })

 return(
  <group ref={group} position={position} scale={scale}>
   {actor&&<primitive object={actor.object}/>}
   {actor&&!preview&&!wear.who&&(
    <Interactable id={`${id}:talk`} onInteract={onTalk} interactionText={line===null?TALK_HINT:LINES[line]}>
     <primitive object={actor.hit}/>
    </Interactable>
   )}
   {actor&&!preview&&wear.who&&wear.who!==localId&&wearStatus==='worn'&&(
    <Interactable id={`${id}:worn`} onInteract={()=>{}} interactionText={line===null?WORN_NAME:LINES[line]}>
     <primitive object={actor.hit}/>
    </Interactable>
   )}
   {iWear&&wearStatus==='worn'&&<AbilityHint abilities={VILLAGER_ABILITIES} fired={fired} line={line===null?null:LINES[line]}/>}
   <Mat id={id} enabled={!preview&&!!localId&&(!wear.who||wear.who===localId)}
    text={wear.who===localId?(wearStatus==='unreadable'?CANNOT_WEAR+'／'+UNWEAR:UNWEAR):WEAR} onInteract={onMat}/>
  </group>
 )
}

/** The straw mat in front of his place: what people click to become him (and the wearer, to stop). */
function Mat({id,enabled,text,onInteract}:{id:string;enabled:boolean;text:string;onInteract:()=>void}){
 const look=useMemo(()=>({
  straw:new THREE.MeshStandardMaterial({color:'#b89a5e',roughness:0.95}),
  rim:new THREE.MeshStandardMaterial({color:'#7d6232',roughness:0.9}),
 }),[])
 useEffect(()=>()=>{look.straw.dispose();look.rim.dispose()},[look])
 const mat=(
  <group position={[MAT[0],0,MAT[1]]}>
   <mesh position={[0,0.009,0]} material={look.straw} receiveShadow><cylinderGeometry args={[0.34,0.35,0.018,40]}/></mesh>
   {[0.1,0.18,0.26].map(r=><mesh key={r} position={[0,0.0185,0]} rotation={[-Math.PI/2,0,0]} material={look.rim}><ringGeometry args={[r,r+0.012,40]}/></mesh>)}
   <mesh position={[0,0.012,0]} rotation={[Math.PI/2,0,0]} material={look.rim}><torusGeometry args={[0.345,0.014,6,40]}/></mesh>
  </group>
 )
 return <Interactable id={`${id}:mat`} onInteract={onInteract} interactionText={text} enabled={enabled}>{mat}</Interactable>
}

// A strip at the bottom-right of the wearer's screen: what the keys make the body do, and what he just said (the
// wearer cannot aim at their own body to read it). Drawn on the page, not in the room; nobody else sees it.
const hintCss=`.xrift-villager-hint,.xrift-villager-hint *{pointer-events:none!important}
.xrift-villager-hint .vh-bar{position:absolute;right:18px;bottom:18px;display:flex;flex-direction:column;align-items:flex-end;gap:5px;font:600 11px/1.2 "Yu Gothic",system-ui,sans-serif;color:#f3f6f4;user-select:none}
.xrift-villager-hint .vh-keys{display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(28,32,44,.62);border-radius:8px;white-space:nowrap}
.xrift-villager-hint .vh-title{color:#f1dca6}
.xrift-villager-hint kbd{font:700 10px system-ui,sans-serif;border:1px solid #c9d1e080;border-radius:3px;padding:1px 5px;color:#fff;margin-right:3px}
.xrift-villager-hint .vh-key.fired{animation:vh-pop .45s cubic-bezier(.2,1.8,.4,1)}
.xrift-villager-hint .vh-line{padding:6px 10px;background:rgba(250,246,236,.9);color:#3a3226;border-radius:8px;font-size:13px}
@keyframes vh-pop{0%{transform:scale(.6)}60%{transform:scale(1.25)}100%{transform:scale(1)}}
@media(max-width:720px){.xrift-villager-hint .vh-bar{right:10px;bottom:10px}}`
function AbilityHint({abilities,fired,line}:{abilities:Ability[];fired:{id:string;seq:number}|null;line:string|null}){
 const camera=useThree(state=>state.camera)
 const xr=useThree(state=>state.gl.xr)
 if(xr.isPresenting)return null
 return createPortal(<Html position={[0,0,-1]} fullscreen calculatePosition={(_el,_camera,size)=>[size.width/2,size.height/2]} wrapperClass="xrift-villager-hint">
  <style>{hintCss}</style>
  <div className="vh-bar" data-testid="villager-hint" role="note" aria-label="村人Aでできること">
   {line&&<div className="vh-line">{line}</div>}
   <div className="vh-keys">
    <span className="vh-title">{HINT_TITLE}</span>
    {abilities.map(ab=>{const hit=fired?.id===ab.id;return <span key={hit?ab.id+fired!.seq:ab.id} className={hit?'vh-key fired':'vh-key'}><kbd>{ab.keys[0].replace(/^Key/,'')}</kbd>{ab.label}</span>})}
   </div>
  </div>
 </Html>,camera)
}
