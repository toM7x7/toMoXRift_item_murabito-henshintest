import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react'
import {createPortal,useFrame,useThree} from '@react-three/fiber'
import {Html} from '@react-three/drei'
import {Interactable,useInstanceEvent,useInstanceState,useItem,usePlacementState,useServerClock,useUsers,useViewpoint,useXRift} from '@xrift/world-components'
import * as THREE from 'three'
import {BeastActor,type ActorInput} from './beast/actor'
import {playSound} from './beast/audio'
import {loadBeast} from './beast/model'
import type {Mode} from './beast/motions'
import {isLive,registerPlacement,subscribePlacements} from './placements.mjs'
import {ABILITY,CANNOT_WEAR,HINT_TITLE,UNWEAR,WEAR,WORDS} from './words'
import {createAbilityInput,type Ability,type AbilityInput} from './henshin/abilities'
import {WearBridge,type BeastDrive} from './wear'
import type {MotionName} from './beast/motions'

export interface ItemProps{position?:[number,number,number];scale?:number}

/** the form everyone sees, and when it was asked for (shared clock, ms). Only this is sent between players. */
interface Form{m:Mode;at:number}
const START:Form={m:'gorilla',at:0}

/** Development only: the lab page can say where 'my' eyes are instead of the camera (dev.tsx). */
type DevHook={eyes?:THREE.Vector3|null;actors?:Map<string,BeastActor>;wear?:Map<string,WearBridge>;setWear?:Map<string,(who:string|null)=>void>;act?:Map<string,(p:{a:string},from:string)=>void>}
const dev=()=>(globalThis as {__gorillaRoboDev?:DevHook}).__gorillaRoboDev

const world=new THREE.Vector3(),tmp=new THREE.Vector3(),feetV=new THREE.Vector3()

/** who has gone into it: a user id, or null. rev only makes every write a change */
interface WearState{who:string|null;rev:number}
const NOBODY:WearState={who:null,rev:0}
/** a wearer who has left the room is let go after this long (by any client that has been here a while) */
const GONE_S=5,SETTLED_S=10
/** the stand you go into it from (item space): outside the circle it walks in */
const STAND_AT:[number,number]=[0,2.15]
/**
 * What the wearer can do: Z transforms, X does the form's display (drumming / a salute). In VR, B and Y (A is the
 * platform's jump, the trigger and grip are grab and use; waving a hand is shown by the hand itself).
 * C and V are taken by the platform's own shortcuts in production (2026-11-19).
 */
const ABILITIES:Ability[]=[
 {id:'transform',label:ABILITY.transform,keys:['KeyZ'],xr:{hand:'right',button:5,name:'B'}},
 {id:'act',label:'',keys:['KeyX'],xr:{hand:'left',button:5,name:'Y'}},
]
/** what is sent to the room when the wearer starts the form's display */
interface ActPayload{a:MotionName}

/**
 * 1人1体まで。同じ人が2体目以降を置いても、そのコピーは何も出さない（placements.mjs）。
 * 本体に「1個だけ」の設定がないので、アイテム側で守る。
 */
export function Item(props:ItemProps){
 const {id,placedBy}=useItem()
 const preview=usePlacementState().mode==='preview'
 const placer=placedBy?.id??null
 useLayoutEffect(()=>registerPlacement(id,preview,placer),[id,preview,placer])
 const live=useSyncExternalStore(subscribePlacements,()=>isLive(id),()=>true)
 return live?<Beast {...props}/>:null
}

function Beast({position,scale=1}:ItemProps){
 const {id}=useItem()
 const {baseUrl}=useXRift()
 const preview=usePlacementState().mode==='preview'
 const users=useUsers()
 const clock=useServerClock()
 const now=useRef(clock.now)
 now.current=clock.now
 const usersRef=useRef(users)
 usersRef.current=users
 const [form,setForm]=useInstanceState<Form>(`gorilla-robo:${id}`,START)
 const formRef=useRef(form)
 formRef.current=form
 const [actor,setActor]=useState<BeastActor|null>(null)
 const actorRef=useRef<BeastActor|null>(null)
 const group=useRef<THREE.Group>(null)
 const ear=useRef(99)
 const input=useMemo<ActorInput>(()=>({t:0,mode:'gorilla',since:0,people:[]}),[])
 const pool=useRef<THREE.Vector3[]>([])
 const myEyes=useMemo(()=>new THREE.Vector3(),[])
 const scene=useThree(s=>s.scene)
 const {getViewpoint}=useViewpoint()
 const localId=users.localUser?.id??null
 const [wear,setWear]=useInstanceState<WearState>(`gorilla-robo:${id}:wear:v1`,NOBODY)
 const wearRef=useRef(wear)
 wearRef.current=wear
 const bridge=useRef<WearBridge|null>(null)
 const seen=useRef({since:-1,goneAt:-1,lastFeet:new THREE.Vector3(),lastYaw:0,had:false})
 const [wearStatus,setWearStatus]=useState('off')
 const shot=useRef<{name:MotionName;t0:number}|null>(null)
 const [fired,setFired]=useState<{id:string;seq:number}|null>(null)

 useEffect(()=>{
  let live=true,made:BeastActor|null=null
  loadBeast(`${baseUrl}gorilla_robo.glb`).then(src=>{
   if(!live)return
   made=new BeastActor(src,id,{onSound:(name,gain)=>playSound(name,gain,ear.current)})
   actorRef.current=made
   dev()?.actors?.set(id,made)
   setActor(made)
  }).catch(e=>console.warn('[gorilla-robo] the model could not be loaded',e))
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
 const onStand=useCallback(()=>{
  if(!localId)return
  const w=wearRef.current
  if(w.who===localId)setWear({who:null,rev:w.rev+1})
  else if(!w.who)setWear({who:localId,rev:w.rev+1})
 },[localId,setWear])
 // ---- what the wearer makes it do ----
 const emitAct=useInstanceEvent<ActPayload>(`gorilla-robo:${id}:act`,({payload,senderId,timestamp})=>{
  // only the person inside it can make it do things
  if(!payload||senderId!==wearRef.current.who)return
  if(payload.a==='gBeat'||payload.a==='rSalute')shot.current={name:payload.a,t0:(timestamp||now.current())/1000}
 })
 useEffect(()=>{
  const m=dev()?.act
  if(!m)return
  m.set(id,(p,from)=>{if(from===wearRef.current.who&&(p.a==='gBeat'||p.a==='rSalute'))shot.current={name:p.a as MotionName,t0:now.current()/1000}})
  return()=>{m.delete(id)}
 },[id])
 const fire=useCallback((ability:string)=>{
  const b=bridge.current
  if(!b||b.status!=='worn'||wearRef.current.who!==localId)return
  const f=formRef.current,t=now.current()
  if(BeastActor.busy(t/1000,f.m,f.at/1000))return
  const sh=shot.current
  if(sh&&t/1000-sh.t0<(sh.name==='gBeat'?4.3:2.9))return
  if(ability==='transform'){setForm({m:f.m==='gorilla'?'robot':'gorilla',at:t})}
  else{
   const p:ActPayload={a:f.m==='gorilla'?'gBeat':'rSalute'}
   shot.current={name:p.a,t0:t/1000}
   emitAct(p)
  }
  setFired(x=>({id:ability,seq:(x?.seq??0)+1}))
 },[emitAct,localId,setForm])
 const fireRef=useRef(fire)
 fireRef.current=fire
 const abilityInput=useRef<AbilityInput|null>(null)
 const iWear=!!localId&&wear.who===localId&&!preview
 useEffect(()=>{
  if(!iWear)return
  const inp=createAbilityInput(ABILITIES,a=>fireRef.current(a))
  abilityInput.current=inp
  return()=>{inp.dispose();abilityInput.current=null}
 },[iWear])

 // a click changes the form for everybody; while it is changing, clicks do nothing
 const onTransform=useCallback(()=>{
  const f=formRef.current,t=now.current()
  if(BeastActor.busy(t/1000,f.m,f.at/1000))return
  setForm({m:f.m==='gorilla'?'robot':'gorilla',at:t})
 },[setForm])

 useFrame(state=>{
  const a=actorRef.current,g=group.current
  if(!a||!g)return
  const u=usersRef.current
  g.updateWorldMatrix(true,false)
  // eyes of the people around, in this item's space
  const eyesOverride=dev()?.eyes
  if(eyesOverride)myEyes.copy(eyesOverride);else{state.camera.getWorldPosition(myEyes);g.worldToLocal(myEyes)}
  ear.current=a.centre(tmp).applyMatrix4(g.matrixWorld).distanceTo(state.camera.getWorldPosition(world))
  const people=input.people
  people.length=0
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
  const f=formRef.current
  input.t=now.current()/1000
  input.mode=f.m==='robot'?'robot':'gorilla'
  input.since=(Number.isFinite(f.at)?f.at:0)/1000
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
    if(sn.goneAt<0)sn.goneAt=t
    else if(t-sn.goneAt>GONE_S){sn.goneAt=-1;setWear(w=>w.who===wst.who?{who:null,rev:w.rev+1}:w)}
   }
  }
  if(wearer&&b){
   feetV.set(wearer.mv.position.x,wearer.mv.position.y,wearer.mv.position.z)
   const drive:BeastDrive={mode:input.mode,since:input.since,shot:shot.current}
   b.set({userId:wearer.userId,isLocal:wearer.isLocal,feet:feetV,eyeHeight:wearer.eye,firstPerson:wearer.isLocal&&getViewpoint()==='first-person',t},drive)
   ear.current=feetV.distanceTo(state.camera.getWorldPosition(world))
   if(wearer.isLocal)abilityInput.current?.pollXR(state.gl.xr.isPresenting?state.gl.xr.getSession():null)
   if(b.status!=='worn')a.object.visible=false
   sn.lastFeet.copy(feetV);g.worldToLocal(sn.lastFeet);sn.lastYaw=b.measured.heading;sn.had=true
   if(b.status!==wearStatus)setWearStatus(b.status)
   return
  }
  b?.set(null)
  if(wearStatus!=='off')setWearStatus('off')
  if(sn.had){
   // nobody is inside any more: it steps out where the wearer stood and goes on as itself
   const yaw=sn.lastYaw-Math.atan2(g.matrixWorld.elements[8],g.matrixWorld.elements[10])
   a.placeAt(sn.lastFeet.x,sn.lastFeet.z,yaw,t)
   sn.had=false;shot.current=null
  }
  a.update(input)
 })

 const worn=!!wear.who
 return(
  <group ref={group} position={position} scale={scale}>
   {actor&&(preview||worn?<primitive object={actor.object}/>:(
    <Interactable id={`${id}:transform`} onInteract={onTransform} interactionText={form.m==='robot'?WORDS.toGorilla:WORDS.toRobot}>
     <primitive object={actor.object}/>
    </Interactable>
   ))}
   {!preview&&<WearStand id={id} enabled={!!localId&&(!wear.who||wear.who===localId)}
    text={wear.who===localId?(wearStatus==='unreadable'?CANNOT_WEAR+'／'+UNWEAR:UNWEAR):WEAR} lit={worn} onInteract={onStand}/>}
   {iWear&&wearStatus==='worn'&&<AbilityHint title={HINT_TITLE[form.m==='robot'?'robot':'gorilla']}
    abilities={ABILITIES.map(x=>x.id==='act'?{...x,label:form.m==='robot'?ABILITY.salute:ABILITY.beat}:x)} fired={fired}/>}
  </group>
 )
}

/** The stand in front of it: a low steel plinth with an amber ring; you go into it (and out of it) from here. */
function WearStand({id,enabled,text,lit,onInteract}:{id:string;enabled:boolean;text:string;lit:boolean;onInteract:()=>void}){
 const look=useMemo(()=>({
  steel:new THREE.MeshStandardMaterial({color:'#5d6168',roughness:0.45,metalness:0.8}),
  ring:new THREE.MeshStandardMaterial({color:'#2a1a08',emissive:new THREE.Color(1.0,0.5,0.06),emissiveIntensity:0.6,roughness:0.5}),
 }),[])
 useEffect(()=>()=>{look.steel.dispose();look.ring.dispose()},[look])
 look.ring.emissive.setRGB(lit?0.08:1.0,lit?0.85:0.5,lit?1.0:0.06)
 look.ring.emissiveIntensity=lit?1.4:0.6
 return(
  <Interactable id={`${id}:stand`} onInteract={onInteract} interactionText={text} enabled={enabled}>
   <group position={[STAND_AT[0],0,STAND_AT[1]]}>
    <mesh position={[0,0.04,0]} material={look.steel} castShadow receiveShadow><cylinderGeometry args={[0.36,0.42,0.08,32]}/></mesh>
    <mesh position={[0,0.082,0]} rotation={[-Math.PI/2,0,0]} material={look.ring}><ringGeometry args={[0.2,0.27,40]}/></mesh>
   </group>
  </Interactable>
 )
}

// A strip at the bottom-right of the wearer's screen: what the keys do in this form. Drawn on the page, not in the
// room; nobody else sees it, and not in VR.
const hintCss=`.xrift-gorilla-hint,.xrift-gorilla-hint *{pointer-events:none!important}
.xrift-gorilla-hint .gh-bar{position:absolute;right:18px;bottom:18px;display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(28,32,44,.62);border-radius:8px;font:600 11px/1.2 "Yu Gothic",system-ui,sans-serif;color:#f3f6f4;user-select:none;white-space:nowrap}
.xrift-gorilla-hint .gh-title{color:#ffc56b}
.xrift-gorilla-hint kbd{font:700 10px system-ui,sans-serif;border:1px solid #c9d1e080;border-radius:3px;padding:1px 5px;color:#fff;margin-right:3px}
.xrift-gorilla-hint .gh-key.fired{animation:gh-pop .45s cubic-bezier(.2,1.8,.4,1)}
@keyframes gh-pop{0%{transform:scale(.6)}60%{transform:scale(1.25)}100%{transform:scale(1)}}
@media(max-width:720px){.xrift-gorilla-hint .gh-bar{right:10px;bottom:10px}}`
function AbilityHint({title,abilities,fired}:{title:string;abilities:Ability[];fired:{id:string;seq:number}|null}){
 const camera=useThree(state=>state.camera)
 const xr=useThree(state=>state.gl.xr)
 if(xr.isPresenting)return null
 return createPortal(<Html position={[0,0,-1]} fullscreen calculatePosition={(_el,_camera,size)=>[size.width/2,size.height/2]} wrapperClass="xrift-gorilla-hint">
  <style>{hintCss}</style>
  <div className="gh-bar" data-testid="gorilla-hint" role="note" aria-label="ゴリラロボでできること">
   <span className="gh-title">{title}</span>
   {abilities.map(ab=>{const hit=fired?.id===ab.id;return <span key={hit?ab.id+fired!.seq:ab.id} className={hit?'gh-key fired':'gh-key'}><kbd>{ab.keys[0].replace(/^Key/,'')}</kbd>{ab.label}</span>})}
  </div>
 </Html>,camera)
}
