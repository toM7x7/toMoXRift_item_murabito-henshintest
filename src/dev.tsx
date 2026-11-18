import {Canvas,useFrame,useThree} from '@react-three/fiber'
import {Physics,RigidBody} from '@react-three/rapier'
import {DevEnvironment,ItemProvider,XRiftProvider,type ItemPlacer,type PlayerMovement,type UsersContextValue} from '@xrift/world-components'
import {useMemo} from 'react'
import {createRoot} from 'react-dom/client'
import * as THREE from 'three'
import {Item} from './Item'
import type {VillagerActor} from './villager/actor'
import type {GestureName} from './villager/pose'
import {clonePose,STAND,type Pose} from './villager/rig'
import type {WearBridge} from './wear'
import {DevVrmAvatar,type DevPerson} from './dev/vrm-avatar'
import {inspectHumanoidRigs,prepareRig,captureBones,restoreBones,type PreparedRig} from './pose-lib/vendor/render-pose.mjs'
import {authoringRig} from './pose-lib/authoring/rig.mjs'
import {applyAuthoredPose} from './pose-lib/authoring/solve.mjs'
import {sampleKeyPose,sampleRoutine,KEY_NAMES} from './dev-motion/taiso'
import mannequinUrl from '../dev-assets/mannequin.glb?url'

// (no query)  walk around him in the official DevEnvironment (click = talk)
// ?lab        a fixed camera, driven from window.__villager (scripts/capture.mjs): the clock can be stopped and
//             stepped, a pose held, a gesture started, people put anywhere
// ?lab&preview  the item as the placement preview shows it
// ?lab&wear   two rigged wooden mannequins stand in for avatars (me and Aさん; dev-assets/mannequin.glb, not
//             shipped) so wearing the villager can be tried: their bones are moved here the way the platform moves
//             an avatar (window.__villager.avatar), and the villager is drawn over whoever wears him
// ?bg=dark    a dark room instead of the bright one
const params=new URLSearchParams(location.search)
const lab=params.has('lab')
const ME:ItemPlacer={id:'user-me',displayName:'me',avatarUrl:null,isLocalUser:true}

type DevHook={eyes:THREE.Vector3|null;actors:Map<string,VillagerActor>;wear:Map<string,WearBridge>;setWear:Map<string,(who:string|null)=>void>}
const hook:DevHook={eyes:null,actors:new Map(),wear:new Map(),setWear:new Map()}
;(globalThis as {__villagerDev?:DevHook}).__villagerDev=hook

function Scenery({solid=false}:{solid?:boolean}){
 const dark=params.get('bg')==='dark'
 const ground=(
  <mesh position={[0,-0.1,0]} receiveShadow>
   <boxGeometry args={[40,0.2,40]}/>
   <meshStandardMaterial color={dark?'#3b3f47':'#8d9a84'} roughness={0.95}/>
  </mesh>
 )
 return(
  <>
   <color attach="background" args={[dark?'#20242c':'#b9cbd9']}/>
   <hemisphereLight args={['#f2f6ff','#77705f',dark?0.5:0.9]}/>
   <directionalLight position={[2.5,5,3]} intensity={dark?1.6:2.1} castShadow shadow-mapSize-width={2048} shadow-mapSize-height={2048} shadow-camera-left={-3} shadow-camera-right={3} shadow-camera-top={3} shadow-camera-bottom={-2} shadow-camera-near={0.5} shadow-camera-far={12} shadow-bias={-0.0003} shadow-normalBias={0.004}/>
   {solid?<RigidBody type="fixed" colliders="cuboid">{ground}</RigidBody>:ground}
  </>
 )
}

// ---------------- lab ----------------

const clock={frozen:false,ms:Date.now(),offset:0}
const nowMs=()=>clock.frozen?clock.ms:Date.now()+clock.offset
const view={p:new THREE.Vector3(0,1.0,3.4),t:new THREE.Vector3(0,0.9,0)}
const mover=(x:number,z:number):PlayerMovement=>({position:{x,y:0,z},direction:{x:0,z:0},horizontalSpeed:0,verticalSpeed:0,rotation:{yaw:0,pitch:0},isGrounded:true,isJumping:false})
/** other people in the room: id -> where they stand */
const others=new Map<string,PlayerMovement>()
/** the local viewpoint the lab reports, and whether the platform would hide my head now (first person) */
const lv={view:'third-person' as 'first-person'|'third-person',headless:false}
const wearLab=lab&&params.has('wear')
/** the mannequins of ?lab&wear: where they stand and how their bones are moved ('idle' = arms down, else a key
 *  of the warm-up routine, or 'routine' to run it) */
const dolls:Record<string,DevPerson&{motion:string}>={
 'user-me':{id:'user-me',position:{x:0.9,y:0,z:1.6},yaw:Math.PI,motion:'idle'},
 'user-a':{id:'user-a',position:{x:-1.0,y:0,z:1.5},yaw:Math.PI,motion:'idle'},
}
const dollMove=(d:DevPerson):PlayerMovement=>({position:d.position,direction:{x:0,z:0},horizontalSpeed:0,verticalSpeed:0,rotation:{yaw:d.yaw,pitch:0},isGrounded:true,isJumping:false})
if(wearLab)others.set('user-a',dollMove(dolls['user-a']))

/** Moves a mannequin's bones every frame the way the platform animates an avatar (kept until the next frame). */
function DollMotion({id}:{id:string}){
 const scene=useThree(s=>s.scene)
 const st=useMemo(()=>({rig:null as PreparedRig|null,snap:null as ReturnType<typeof captureBones>|null,state:{}}),[])
 useFrame(()=>{
  const d=dolls[id]
  if(!st.rig){
   const root=scene.getObjectByName('dev-vrm-'+id)
   if(!root)return
   const rig=inspectHumanoidRigs(root).find(r=>r.supported)
   if(!rig)return
   st.rig=prepareRig(rig)
  }
  if(d.motion==='idle')return
  const info=authoringRig(st.rig)
  const frame=d.motion==='routine'?sampleRoutine(info,nowMs()/1000):sampleKeyPose(info,d.motion)
  frame.weight=1
  applyAuthoredPose(st.rig,frame,{heading:d.yaw+Math.PI,origin:new THREE.Vector3(d.position.x,d.position.y,d.position.z),groundY:d.position.y,state:st.state})
  st.rig.skeleton.update()
 })
 void captureBones;void restoreBones
 return null
}

function LabDriver(){
 const scene=useThree(s=>s.scene)
 useFrame(s=>{
  s.camera.position.copy(view.p)
  s.camera.lookAt(view.t)
  s.camera.updateMatrixWorld()
  s.gl.render(s.scene,s.camera)
 },1)
 useMemo(()=>{
  const actor=()=>[...hook.actors.values()][0]
  const api={
   actor,hook,
   ready:()=>!!actor(),
   freeze(){clock.ms=nowMs();clock.frozen=true},
   resume(){clock.offset=clock.ms-Date.now();clock.frozen=false},
   /** stop the clock at this time (seconds): the idle behaviour is a function of it, so a moment can be revisited */
   setTime(t:number){clock.ms=t*1000;clock.frozen=true},
   advance(dt:number){clock.ms+=dt*1000},
   time:()=>nowMs()/1000,
   view(p:number[],t:number[]){view.p.fromArray(p);view.t.fromArray(t)},
   /** where my eyes are (item space), instead of the camera; null = the camera */
   eyes(p:number[]|null){hook.eyes=p?new THREE.Vector3().fromArray(p):null},
   /** put somebody else in the room (feet), or take them out */
   person(id:string,p:number[]|null){if(p)others.set(id,mover(p[0],p[2]));else others.delete(id)},
   still(on:boolean){const a=actor();if(a)a.still=on},
   /** what the local camera is (the villager's head folds away for the wearer in first person) */
   viewpoint(v:'first-person'|'third-person',headless=false){lv.view=v;lv.headless=headless},
   /** ?lab&wear: who wears the villager (as if they had clicked the mat), or null */
   wear(who:string|null){[...hook.setWear.values()][0]?.(who)},
   bridge:()=>[...hook.wear.values()][0]??null,
   /** ?lab&wear: move a mannequin (feet, yaw: the platform's, 0 = looking along -Z) and pick how it moves */
   avatar(id:string,o:{at?:number[];yaw?:number;motion?:string}){const d=dolls[id];if(!d)return;if(o.at){d.position.x=o.at[0];d.position.y=o.at[1];d.position.z=o.at[2]}if(o.yaw!==undefined)d.yaw=o.yaw;if(o.motion)d.motion=o.motion},
   keys:()=>KEY_NAMES,
   /** where a mannequin's bone is (world) */
   bone(id:string,re:string){const root=scene.getObjectByName('dev-vrm-'+id);let p:number[]|null=null;const r=new RegExp(re,'i');root?.traverse(o=>{if(!p&&(o as THREE.Bone).isBone&&r.test(o.name))p=o.getWorldPosition(new THREE.Vector3()).toArray()});return p},
   /** are the mannequin's meshes shown (outside a render) */
   shown(id:string){const root=scene.getObjectByName('dev-vrm-'+id);let n=0,v=0;root?.traverse(o=>{if((o as THREE.Mesh).isMesh){n++;if(o.visible)v++}});return {meshes:n,visible:v}},
   /** hold a pose: the given numbers over standing at ease ('rest' = as photographed), or null to let him go */
   pose(p:Partial<Pose>|'rest'|null){
    const a=actor()
    if(!a)return
    if(p===null){a.poseTest=null;return}
    const q=clonePose(STAND)
    if(p==='rest'){q.lo=Number.NaN;q.ro=Number.NaN}else Object.assign(q,p)
    a.poseTest=q
   },
   /** 0 = the photos, 1 = the bare shape, 2 = which photo goes where (red = blurred edge, green = front, blue = side) */
   clay(v:number){const a=actor();if(a)a.skin.uniforms.uClay.value=v},
   gesture(name:Exclude<GestureName,'talk'>,side:1|-1=1){actor()?.gestureNow(name,nowMs()/1000,side)},
   /** click something by the end of its Interactable id (':talk') */
   click(end:string){let done=false;scene.traverse(o=>{const d=o.userData as {id?:string;onInteract?:(id:string)=>void;enabled?:boolean};if(!done&&d.id?.endsWith(end)&&d.onInteract&&d.enabled!==false){d.onInteract(d.id);done=true}});return done},
   enabled(end:string){let e:boolean|null=null;scene.traverse(o=>{const d=o.userData as {id?:string;enabled?:boolean};if(e===null&&d.id?.endsWith(end))e=d.enabled!==false});return e},
   text(end:string){let text:string|null=null;scene.traverse(o=>{const d=o.userData as {id?:string;interactionText?:string};if(text===null&&d.id?.endsWith(end))text=d.interactionText??''});return text},
   report(){
    const a=actor()
    if(!a)return null
    const it=a.intent
    return {...a.state,position:a.position.toArray(),yaw:a.yaw,pose:{...a.pose},solved:{...a.rig.solved},action:it?.action,ta:it?.ta,goal:it?[it.goalX,it.goalZ]:null,
     hit:a.hit.position.toArray(),visible:a.object.visible}
   },
   scene,
  }
  ;(window as unknown as {__villager:typeof api}).__villager=api
 },[scene])
 return null
}

function Lab(){
 const users=useMemo<UsersContextValue>(()=>({
  localUser:{id:'user-me',displayName:'me',avatarUrl:null,isGuest:false},
  get remoteUsers(){return [...others.keys()].map(id=>({id,displayName:id,avatarUrl:null,isGuest:false}))},
  getMovement:(id:string)=>others.get(id),
  getLocalMovement:()=>wearLab?dollMove(dolls['user-me']):mover(view.p.x,view.p.z),
  getAvatarHeight:(id:string)=>dolls[id]?.eye?{height:dolls[id].eye!+0.12,eyeHeight:dolls[id].eye!}:undefined,
  getLocalAvatarHeight:()=>({height:(dolls['user-me'].eye??1.5)+0.12,eyeHeight:dolls['user-me'].eye??1.5}),
 }),[])
 const viewpoint=useMemo(()=>({get viewpoint(){return lv.view},getViewpoint:()=>lv.view}),[])
 const serverClock=useMemo(()=>({now:nowMs,uncertainty:10,synced:true,trustworthy:true,timeJumpCount:0,lastTimeJumpMs:0}),[])
 return(
  <XRiftProvider baseUrl="/" usersImplementation={users} serverClockImplementation={serverClock} viewpointImplementation={viewpoint} placementMode={params.has('preview')?'preview':'placed'}>
   <div style={{width:'100vw',height:'100vh'}}>
    <Canvas shadows camera={{fov:32,near:0.05,far:100}} gl={{preserveDrawingBuffer:true}}>
     <Physics>
      <LabDriver/>
      <Scenery solid/>
      <People/>
      {wearLab&&<>
       <DevVrmAvatar person={dolls['user-me']} path={mannequinUrl} remote={false} headless={()=>lv.view==='first-person'&&lv.headless}/>
       <DevVrmAvatar person={dolls['user-a']} path={mannequinUrl} remote/>
       <DollMotion id="user-me"/>
       <DollMotion id="user-a"/>
      </>}
      <ItemProvider id="villager-lab" placedBy={ME}><Item/></ItemProvider>
     </Physics>
    </Canvas>
   </div>
  </XRiftProvider>
 )
}
function People(){
 // the markers follow the map every frame (people are added and moved from the page's console)
 const group=useMemo(()=>new THREE.Group(),[])
 const made=useMemo(()=>new Map<string,THREE.Mesh>(),[])
 useFrame(()=>{
  for(const [id,m] of others){
   if(dolls[id]&&wearLab)continue
   let mesh=made.get(id)
   if(!mesh){
    mesh=new THREE.Mesh(new THREE.CapsuleGeometry(0.17,1.1,6,12),new THREE.MeshStandardMaterial({color:'#5d7fa8',roughness:0.8}))
    mesh.castShadow=true
    made.set(id,mesh);group.add(mesh)
   }
   mesh.position.set(m.position.x,0.72,m.position.z)
  }
  for(const [id,mesh] of made)if(!others.has(id)){group.remove(mesh);made.delete(id)}
 })
 return <primitive object={group}/>
}

function Walk(){
 return(
  <XRiftProvider baseUrl="/">
   <div style={{width:'100vw',height:'100vh'}}>
    <DevEnvironment spawnPosition={[0,0.9,3]} camera={{position:[0,0.9,3],fov:70}}>
     <Scenery solid/>
     <ItemProvider id="villager-dev" placedBy={ME}><Item/></ItemProvider>
     <ItemProvider id="villager-dev-2" placedBy={ME}><Item position={[3,0,-2]}/></ItemProvider>
    </DevEnvironment>
   </div>
  </XRiftProvider>
 )
}

const host=window as unknown as {__villagerRoot?:ReturnType<typeof createRoot>}
host.__villagerRoot??=createRoot(document.getElementById('root')!)
host.__villagerRoot.render(lab?<Lab/>:<Walk/>)
