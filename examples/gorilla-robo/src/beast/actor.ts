/**
 * One beast: turns what the brain wants (brain.ts) into a pose every frame (motions.ts -> rig.ts) and draws it.
 * It walks to where the scene says, turns to face people, plays the scene's action, and transforms when the
 * shared form changes. Changes of motion are cross-faded so nothing snaps.
 */
import * as THREE from 'three'
import {glanceAt,intentAt,sceneAt,seedOf,type Intent} from './brain'
import {makeMaterial,type BeastSource,type Lights} from './model'
import {DURATION,MOTIONS,SOUNDS,TO_GORILLA,TO_ROBOT,copyPose,gReach,mixPose,newPose,type Ctx,type Mode,type MotionName,type SitAct,type SoundName} from './motions'
import {Rig,type Pose} from './rig'

export interface ActorInput{
 /** shared clock, seconds */
 t:number
 /** the form it should be in, and when that was asked for (shared clock, seconds) */
 mode:Mode;since:number
 /** eyes of the people around, in the item's space */
 people:THREE.Vector3[]
}
/** Development only: hold one motion at one moment (the lab page and scripts/capture.mjs). */
export interface ActorTest{motion:MotionName;ta?:number;phase?:number;stride?:number;step?:number;sit?:SitAct;sitT?:number;side?:number;gazeYaw?:number;gazePitch?:number;set?:Partial<Pose>}
export interface ActorHooks{onSound?:(name:SoundName,gain:number)=>void}

/**
 * Worn (wear.ts): somebody's avatar drives it. It stands at the root of its object (the body places the object);
 * the gorilla walks, sits and looks by what the wearer does, the robot takes the pose read from the wearer's bones.
 */
export interface DriveInput{
 t:number;mode:Mode;since:number
 /** walking speed over the ground (m/s, this body's size) and how high off the ground it is (m) */
 speed:number;lift:number
 /** where the wearer looks, against the way the body faces */
 gazeYaw:number;gazePitch:number
 /** something the wearer asked for (drumming, a salute), started at shared time t0 */
 shot:{name:MotionName;t0:number}|null
 /** gorilla: how far up on its hind legs to reach for the wearer's hands (0..1), and where they are (chest frame) */
 reach:number;handL:THREE.Vector3|null;handR:THREE.Vector3|null
 /** robot: the pose read from the wearer's bones */
 follow:Pose|null
}
/** standing still this long, the worn gorilla sits down */
const SIT_AFTER=6
const REACH=newPose()

const wrap=(a:number)=>{a=(a+Math.PI)%(Math.PI*2);return (a<0?a+Math.PI*2:a)-Math.PI}
const clamp=(x:number,a:number,b:number)=>x<a?a:x>b?b:x
const ease=(x:number)=>{x=clamp(x,0,1);return x*x*(3-2*x)}
const frac=(x:number)=>x-Math.floor(x)

const AMBER=new THREE.Color(1.0,0.5,0.06),CYAN=new THREE.Color(0.08,0.85,1.0),EMBER=new THREE.Color(1.0,0.3,0.05)
/** stride length (m) and time (s) of one full cycle */
const GAIT={gorilla:{L:0.9,T:1.12,turn:1.9},robot:{L:1.0,T:1.35,turn:1.5}}
/** when each limb comes down in the stride, and what it sounds like */
const FOOTFALLS:Record<Mode,[number,SoundName,number][]>={
 gorilla:[[0,'pad',1],[0.5,'pad',1],[0.08,'pad',0.6],[0.58,'pad',0.6]],
 robot:[[0,'stomp',1],[0.5,'stomp',1]],
}

export class BeastActor{
 /** add this to the scene (item space) */
 readonly object=new THREE.Group()
 readonly rig:Rig
 readonly pose=newPose()
 /** where it stands in the item's space, and which way it faces */
 x=0;z=0;yaw=0
 motion:MotionName='gIdle'
 mode:Mode='gorilla'
 intent:Intent|null=null
 test:ActorTest|null=null

 private readonly body=new THREE.Group()
 private readonly meshes:[THREE.Mesh,THREE.Matrix4][]=[]
 private readonly material:THREE.MeshStandardMaterial
 private readonly lights:Lights
 private readonly seed:number
 private readonly from=newPose()
 private readonly target=newPose()
 private readonly ctx:Ctx
 private started=false
 private last=0
 private fade=1;private fadeDur=0.4
 private prevTa=0
 private walking=false;private turning=false
 private phase=0;private stride=0
 private shot:{name:MotionName;t0:number;mode:Mode}|null=null
 private doneScene=NaN
 private gazeYaw=0;private gazePitch=0;private heldYaw=0;private heldPitch=0;private heldAt=-9

 constructor(src:BeastSource,id:string,private readonly hooks:ActorHooks={}){
  this.rig=new Rig(src.rig)
  this.seed=seedOf(id)
  const {material,lights}=makeMaterial()
  this.material=material;this.lights=lights
  for(const part of src.rig.parts){
   const geometry=src.geometries.get(part.name)
   if(!geometry)continue
   const mesh=new THREE.Mesh(geometry,material)
   mesh.name=part.name
   mesh.matrixAutoUpdate=false
   mesh.castShadow=true;mesh.receiveShadow=true
   this.body.add(mesh)
   this.meshes.push([mesh,this.rig.matrix(part.name)])
  }
  this.object.add(this.body)
  this.ctx={rig:this.rig,t:0,ta:0,side:1,gazeYaw:0,gazePitch:0,phase:0,stride:0,step:0,sit:'none',sitT:0}
 }

 dispose(){this.material.dispose()}

 /** true while it is changing form (clicks are ignored meanwhile) */
 static busy(t:number,mode:Mode,since:number){const d=t-since;return d>=0&&d<(mode==='robot'?TO_ROBOT:TO_GORILLA)+0.35}

 update(inp:ActorInput){
  const t=inp.t,c=this.ctx
  let dt=t-this.last
  const jumped=!this.started||dt<0||dt>1.5
  dt=jumped?0:Math.min(dt,0.1)
  this.last=t
  this.mode=inp.mode
  const g=inp.mode==='gorilla'
  // the nearest person
  let near:THREE.Vector3|null=null,nearD=Infinity
  for(const p of inp.people){const d=Math.hypot(p.x-this.x,p.z-this.z);if(d<nearD){nearD=d;near=p}}
  const keen=nearD<3.6
  // what the scene asks for (decided once per scene and form)
  const k=sceneAt(t,this.seed)
  if(!this.intent||this.intent.scene!==k||jumped||this.intentMode!==inp.mode){this.intent=intentAt(t,this.seed,inp.mode,keen);this.intentMode=inp.mode}
  const it=this.intent
  if(jumped){
   // just arrived (or the clock jumped): be where the scene says, with nothing in progress
   this.x=it.x;this.z=it.z;this.yaw=it.face
   this.shot=null;this.walking=this.turning=false;this.stride=0;this.doneScene=NaN
  }
  c.t=t;c.side=it.side;c.sit='none';c.sitT=0;c.stride=0;c.step=0;c.phase=this.phase
  let name:MotionName,ta=0
  const since=t-inp.since,changing=since>=0&&since<(g?TO_GORILLA:TO_ROBOT)
  const test=this.test
  if(test){
   name=test.motion;ta=test.ta??0
   this.x=this.z=this.yaw=0
   c.phase=test.phase??0;c.stride=test.stride??1;c.step=test.step??1;c.sit=test.sit??'none';c.sitT=test.sitT??0;c.side=test.side??1
  }else if(changing){
   name=g?'toGorilla':'toRobot';ta=since
   this.shot=null;this.walking=this.turning=false;this.stride=0
  }else{
   const dx=it.x-this.x,dz=it.z-this.z,d=Math.hypot(dx,dz)
   if(this.shot&&(this.shot.mode!==inp.mode||t-this.shot.t0>=(DURATION[this.shot.name]??0)))this.shot=null
   if(!this.shot){
    if(!this.walking&&d>0.22)this.walking=true
    if(this.walking&&d<0.05)this.walking=false
   }
   const seated=g&&it.sit&&!this.walking&&!this.shot
   const face=keen&&near?Math.atan2(near.x-this.x,near.z-this.z):it.face
   const err=wrap(face-this.yaw)
   if(this.walking||this.shot||seated)this.turning=false
   else if(Math.abs(err)>0.45)this.turning=true
   else if(Math.abs(err)<0.06)this.turning=false
   // the scene's action is due, and there is still time to do all of it
   const due=!!it.action&&this.doneScene!==it.scene&&!seated&&t>=it.start&&t<=it.end-(DURATION[it.action]??0)-0.1
   // it has to get up before it goes anywhere
   const rising=this.motion==='gSit'&&!seated||(this.motion==='gIdle'&&this.fromSit&&this.fade<this.fadeDur)
   if(this.shot){name=this.shot.name;ta=t-this.shot.t0}
   else if(rising)name='gIdle'
   else if(this.walking||(this.turning&&!due)){
    name=g?'gWalk':'rWalk'
    const gait=GAIT[inp.mode]
    const e=this.walking?wrap(Math.atan2(dx,dz)-this.yaw):err
    this.yaw=wrap(this.yaw+clamp(e*4,-gait.turn,gait.turn)*dt)
    const want=this.walking?clamp(1-Math.abs(e)/0.9,0,1)*Math.min(1,d/0.4+0.12):0
    this.stride+=(want-this.stride)*Math.min(1,dt*5)
    const move=Math.min(this.stride*gait.L/gait.T*dt,d)
    this.x+=Math.sin(this.yaw)*move;this.z+=Math.cos(this.yaw)*move
    const before=this.phase
    this.phase=frac(this.phase+dt/gait.T)
    for(const [at,sound,gain] of FOOTFALLS[inp.mode])if(crossed(before,this.phase,at))this.hooks.onSound?.(sound,gain*(0.5+0.5*this.stride))
    c.phase=this.phase;c.stride=this.stride;c.step=1
   }else if(due&&it.action){
    this.shot={name:it.action,t0:t,mode:inp.mode};this.doneScene=it.scene;this.turning=false
    name=it.action;ta=0
   }else if(seated){
    name='gSit'
    const s=t-it.sitAt
    if(it.sitAct!=='none'&&s>=0&&s<3.8&&this.fade>=this.fadeDur){c.sit=it.sitAct;c.sitT=s}
   }else name=g?'gIdle':'rIdle'
   if(!this.walking&&!this.turning)this.stride=0
  }
  // where to look: at whoever is near, otherwise wherever the eyes wander
  let gy=0,gp=0
  if(test){gy=test.gazeYaw??0;gp=test.gazePitch??0;this.gazeYaw=gy;this.gazePitch=gp}
  else{
   if(near&&nearD<5){
    const eye=g?(name==='gSit'?0.95:1.05):1.86
    gy=clamp(wrap(Math.atan2(near.x-this.x,near.z-this.z)-this.yaw),-1.2,1.2)
    gp=clamp(Math.atan2(eye-near.y,Math.max(0.3,nearD)),-0.55,0.45)
   }else [gy,gp]=glanceAt(t,this.seed,inp.mode)
   if(g){
    // an animal's eyes drift across
    const r=Math.min(1,dt*4.5)
    this.gazeYaw+=(gy-this.gazeYaw)*r;this.gazePitch+=(gp-this.gazePitch)*r
   }else{
    // a machine picks a bearing, snaps to it and holds
    if((Math.abs(gy-this.heldYaw)>0.14||Math.abs(gp-this.heldPitch)>0.1)&&t-this.heldAt>0.55){this.heldYaw=gy;this.heldPitch=gp;this.heldAt=t}
    const r=Math.min(1,dt*13)
    this.gazeYaw+=(this.heldYaw-this.gazeYaw)*r;this.gazePitch+=(this.heldPitch-this.gazePitch)*r
   }
   if(jumped){this.gazeYaw=gy;this.gazePitch=gp;this.heldYaw=gy;this.heldPitch=gp}
  }
  c.gazeYaw=this.gazeYaw;c.gazePitch=this.gazePitch
  // the pose, cross-faded from wherever the last motion left it
  if(name!==this.motion){
   copyPose(this.from,this.pose)
   this.fromSit=this.motion==='gSit'
   this.fadeDur=this.motion==='gSit'||name==='gSit'?1.0:name==='toRobot'||name==='toGorilla'?0.3:name==='gWalk'||name==='rWalk'?0.35:0.45
   this.fade=0
   this.motion=name
   this.prevTa=ta-1e-3
  }
  c.ta=ta
  MOTIONS[name](this.target,c)
  if(test?.set)Object.assign(this.target,test.set)
  this.fade+=dt
  if(jumped||test){this.fade=this.fadeDur;copyPose(this.pose,this.target)}
  else mixPose(this.pose,this.from,this.target,ease(this.fade/this.fadeDur))
  // sounds on the way past
  const sounds=SOUNDS[name]
  if(sounds&&!test&&!jumped)for(const [at,sound,gain] of sounds)if(this.prevTa<at&&ta>=at&&ta-at<0.25)this.hooks.onSound?.(sound,gain)
  this.prevTa=ta
  this.started=true
  this.draw()
 }
 private intentMode:Mode='gorilla'
 private fromSit=false

 /** worn: one frame (instead of update). Returns the motion it shows. */
 drive(d:DriveInput):MotionName{
  const t=d.t,c=this.ctx
  let dt=t-this.last
  const jumped=!this.started||dt<0||dt>1.5
  dt=jumped?0:Math.min(dt,0.1)
  this.last=t
  this.mode=d.mode
  this.x=this.z=this.yaw=0
  const g=d.mode==='gorilla'
  c.t=t;c.side=1;c.sit='none';c.sitT=0;c.stride=0;c.step=0;c.phase=this.phase
  c.gazeYaw=d.gazeYaw;c.gazePitch=d.gazePitch
  const since=t-d.since,changing=since>=0&&since<(g?TO_GORILLA:TO_ROBOT)
  let name:MotionName,ta=0
  const moving=d.speed>0.12
  if(moving||!g)this.stillFor=0;else this.stillFor+=dt
  if(changing){name=g?'toGorilla':'toRobot';ta=since;this.stride=0}
  else if(d.shot&&t>=d.shot.t0&&t-d.shot.t0<(DURATION[d.shot.name]??0)){name=d.shot.name;ta=t-d.shot.t0}
  else if(g&&(moving||this.stride>0.05)){
   name='gWalk'
   const gait=GAIT.gorilla,natural=gait.L/gait.T
   // up to its natural pace the stride lengthens; past it the legs go faster
   const want=Math.min(1,d.speed/natural)
   this.stride+=(want-this.stride)*Math.min(1,dt*6)
   const rate=Math.max(d.speed,natural*this.stride)/gait.L
   const before=this.phase
   this.phase=frac(this.phase+dt*rate)
   for(const [at,sound,gain] of FOOTFALLS.gorilla)if(crossed(before,this.phase,at))this.hooks.onSound?.(sound,gain*(0.5+0.5*this.stride))
   c.phase=this.phase;c.stride=this.stride;c.step=1
  }else if(g&&this.stillFor>SIT_AFTER)name='gSit'
  else name=g?'gIdle':'rIdle'
  if(name!=='gWalk')this.stride=0
  if(name!==this.motion){
   copyPose(this.from,this.pose)
   this.fadeDur=this.motion==='gSit'||name==='gSit'?0.8:name==='toRobot'||name==='toGorilla'?0.3:0.3
   this.fade=0
   this.motion=name
   this.prevTa=ta-1e-3
  }
  c.ta=ta
  MOTIONS[name](this.target,c)
  // the robot: the wearer's own pose, unless it is in the middle of something
  if(!g&&d.follow&&name==='rIdle')copyPose(this.target,d.follow)
  // the gorilla reaching up for the wearer's hands
  if(g&&d.reach>0&&(name==='gIdle'||name==='gWalk'||name==='gSit')){
   gReach(REACH,c,1,d.handL,d.handR)
   mixPose(this.target,this.target,REACH,d.reach)
  }
  this.fade+=dt
  if(jumped){this.fade=this.fadeDur;copyPose(this.pose,this.target)}
  else mixPose(this.pose,this.from,this.target,ease(this.fade/this.fadeDur))
  const sounds=SOUNDS[name]
  if(sounds&&!jumped)for(const [at,sound,gain] of sounds)if(this.prevTa<at&&ta>=at&&ta-at<0.25)this.hooks.onSound?.(sound,gain)
  this.prevTa=ta
  this.started=true
  this.lift=d.lift
  this.draw()
  return name
 }
 private stillFor=0
 private lift=0
 /** worn and seen by the wearer in first person: leave the heads out */
 setHeadsHidden(hidden:boolean){for(const [mesh] of this.meshes)if(mesh.name==='ghead'||mesh.name==='jaw'||mesh.name==='rhead')mesh.visible=!hidden}
 /** back to itself, standing where the wearer stood (item space), as of shared time t */
 placeAt(x:number,z:number,yaw:number,t:number){
  this.x=x;this.z=z;this.yaw=yaw;this.last=t;this.lift=0;this.stillFor=0
  this.walking=this.turning=false;this.stride=0;this.shot=null;this.intent=null
  this.object.matrixAutoUpdate=true;this.object.matrix.identity();this.object.position.set(0,0,0);this.object.rotation.set(0,0,0);this.object.scale.setScalar(1)
  this.object.visible=true
  this.setHeadsHidden(false)
 }

 private draw(){
  const p=this.pose
  this.rig.solve(p)
  for(const [mesh,m] of this.meshes){mesh.matrix.copy(m);mesh.matrixWorldNeedsUpdate=true}
  this.body.position.set(this.x,this.lift,this.z)
  this.body.rotation.y=this.yaw
  const L=this.lights
  L.eye.copy(AMBER).lerp(CYAN,p.hue).multiplyScalar(1.5*Math.max(0,p.eye))
  L.visor.copy(CYAN).multiplyScalar(2.4*Math.max(0,p.visor))
  L.mouth.copy(EMBER).lerp(CYAN,p.hue*0.8).multiplyScalar(1.8*Math.max(0,p.mouth))
 }

 /** the middle of the body, in the item's space (for sounds and for where to aim a camera) */
 centre(out:THREE.Vector3){
  const p=this.pose,c=Math.cos(this.yaw),s=Math.sin(this.yaw)
  return out.set(this.x+p.px*c+p.pz*s,p.py+0.2,this.z-p.px*s+p.pz*c)
 }
}

/** did the stride pass this point between two frames? (the phase wraps at 1) */
function crossed(a:number,b:number,at:number){return a<=b?a<at&&b>=at:a<at||b>=at}
