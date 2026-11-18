import * as THREE from 'three'
import {hash,intentAt,seedOf,type Intent} from './brain'
import {createSkin,type HumanSource,type Skin} from './model'
import {applyGesture,GESTURE_DUR,SYLLABLE,talkTime,type Gesture,type GestureName} from './pose'
import {clonePose,POSE_KEYS,Rig,STAND,type Pose} from './rig'

export interface ActorInput{
 /** shared clock, seconds */
 t:number
 /** eyes of the people around, in the item's space */
 people:THREE.Vector3[]
}
export interface ActorEvents{
 /** one syllable of speech (for the voice) */
 onBlip?:(index:number,total:number)=>void
}

/** he notices people within this, greets them when they come within GREET, and loses interest past FORGET (m) */
const NOTICE=3.4,FORGET=4.0,GREET=2.8
/** the straw mat in front of where he was put (item space) and how far he keeps off it */
export const MAT:[number,number]=[0,0.95]
const MAT_CLEAR=0.62
/** walking: speed (m/s), how far a foot travels on the ground in one step (m), how high it lifts (m) */
const WALK_SPEED=0.78,STEP=0.5,LIFT=0.075
const wrap=(a:number)=>a-Math.PI*2*Math.round(a/(Math.PI*2))
const clamp=(x:number,a:number,b:number)=>Math.min(b,Math.max(a,x))
const ss=(a:number,b:number,x:number)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t)}
const approach=(dt:number,rate:number)=>1-Math.exp(-dt*rate)

export class VillagerActor{
 /** stands on the ground where he is, turned the way he faces (put this in the item's group) */
 readonly object=new THREE.Group()
 readonly mesh:THREE.Mesh
 /** what is clicked: an unseen column round him (the drawn body is bent by the shader, so it cannot be hit) */
 readonly hit:THREE.Mesh
 readonly rig:Rig
 readonly skin:Skin
 readonly pose:Pose=clonePose(STAND)
 readonly position=new THREE.Vector3()
 yaw=0
 intent:Intent|null=null
 /** lab: hold exactly this pose / do nothing by himself */
 poseTest:Pose|null=null
 still=false
 /** shown as the placement preview: he just stands */
 preview=false
 /** somebody wears him (wear.ts poses him; update() is not called meanwhile) */
 worn=false
 readonly state={walk:0,shuffle:0,phase:0,going:false,turning:false,noticed:false,close:false,gesture:'' as GestureName|'',talking:false,
  lookYaw:0,lookPitch:0,nearest:99,blips:0,line:-1}
 private target:Pose=clonePose(STAND)
 private seed:number
 private last=Number.NaN
 private gesture:Gesture|null=null
 private chars=0
 private blip=-1
 private speaker:THREE.Vector3|null=null
 private greetedAt=-1e9
 private idleKey=-1
 private events:ActorEvents

 constructor(src:HumanSource,id:string,events:ActorEvents={}){
  this.seed=seedOf(id)
  this.events=events
  this.skin=createSkin(src)
  this.rig=new Rig(src.info,this.skin)
  this.mesh=new THREE.Mesh(src.geometry,this.skin.material)
  this.mesh.customDepthMaterial=this.skin.depthMaterial
  this.mesh.castShadow=true
  this.mesh.receiveShadow=true
  this.mesh.matrixAutoUpdate=false
  this.mesh.raycast=()=>{}
  const h=src.info.height
  this.hit=new THREE.Mesh(new THREE.CylinderGeometry(0.27,0.24,h,10,1),new THREE.MeshBasicMaterial({transparent:true,opacity:0,depthWrite:false,colorWrite:false}))
  this.hit.position.y=h/2
  this.hit.renderOrder=-1
  this.object.add(this.mesh)
  this.rig.apply(this.pose)
  this.mesh.matrix.copy(this.rig.matrix)
 }

 dispose(){
  this.skin.material.dispose();this.skin.depthMaterial.dispose()
  this.hit.geometry.dispose();(this.hit.material as THREE.Material).dispose()
 }

 /** he says a line of `chars` syllables to whoever is at `from` (item space), starting at shared time `at` */
 talk(line:number,chars:number,at:number,from:THREE.Vector3|null):number{
  const dur=talkTime(chars)
  this.gesture={name:'talk',t0:at,dur,side:hash(this.seed,line,71)<0.5?1:-1,key:line}
  this.chars=chars
  this.blip=-1
  this.speaker=from?from.clone():null
  this.state.line=line
  return dur
 }

 /** the blink at shared time t (the same on every client) */
 blinkAt(t:number){return intentAt(t,this.seed).blink}

 /** put him here (item space), facing yaw, as of shared time t: when nobody wears him any more he starts from
  *  where the wearer stood and walks home from there */
 placeAt(x:number,z:number,yaw:number,t:number){
  this.position.set(x,0,z);this.yaw=yaw;this.last=t;this.gesture=null;this.speaker=null
  this.state.walk=0;this.state.shuffle=0;this.state.going=false;this.state.turning=false
  this.object.matrixAutoUpdate=true;this.object.visible=true
  this.object.position.set(x,0,z);this.object.rotation.set(0,yaw,0)
  this.skin.uniforms.uHideHead.value=0
 }

 /** lab: start a gesture now */
 gestureNow(name:Exclude<GestureName,'talk'>,t:number,side:1|-1=1){
  this.gesture={name,t0:t,dur:GESTURE_DUR[name],side,key:0}
 }

 update(input:ActorInput){
  const t=input.t,st=this.state,still=this.still||this.preview
  let dt=t-this.last
  const snap=!(dt>=0&&dt<1)
  if(snap)dt=0
  dt=Math.min(dt,0.1)
  this.last=t
  const it=this.intent=intentAt(t,this.seed)
  const pos=this.position
  if(this.poseTest){
   // lab: held in one pose, at the spot where the item was put down
   pos.set(0,0,0);this.yaw=0
   this.apply(this.poseTest)
   this.object.position.set(0,0,0);this.object.rotation.y=0
   this.hit.position.set(0,this.rig.info.height/2,0)
   return
  }

  // who is nearest
  let near:THREE.Vector3|null=null,nd=Infinity
  for(const q of input.people){
   const d=Math.hypot(q.x-pos.x,q.z-pos.z)
   if(d<nd){nd=d;near=q}
  }
  st.nearest=nd
  st.noticed=!!near&&nd<(st.noticed?FORGET:NOTICE)

  // what his hands are doing
  let g=this.gesture
  if(g&&(t>g.t0+g.dur||t<g.t0-1)){g=this.gesture=null;this.speaker=null}
  const close=!!near&&nd<(st.close?GREET+0.7:GREET)
  if(close&&!st.close&&!g&&!snap&&!still&&t-this.greetedAt>9){
   // somebody has come up to him: a wave, or a bow
   const n=Math.floor(t/9)
   const name:GestureName=hash(this.seed,n,61)<0.55?'wave':'bow'
   g=this.gesture={name,t0:t+0.25,dur:GESTURE_DUR[name],side:hash(this.seed,n,62)<0.7?-1:1,key:n}
   this.greetedAt=t
  }
  st.close=close
  if(!g&&!still&&it.action!=='none'&&it.ta>=0&&it.ta<it.dur-0.8&&it.key!==this.idleKey&&st.walk<0.05&&!st.going){
   g=this.gesture={name:it.action,t0:t-it.ta,dur:it.dur,side:it.side,key:it.key}
   this.idleKey=it.key
  }
  const talking=g?.name==='talk'
  st.gesture=g?g.name:''
  st.talking=talking
  if(talking&&g){
   // the voice: one blip per syllable
   const i=Math.floor((t-g.t0-0.35)/SYLLABLE)
   if(i>=0&&i<this.chars&&i!==this.blip){this.blip=i;st.blips++;this.events.onBlip?.(i,this.chars)}
  }

  // where he should be, and which way he should face
  const busy=!!g&&(g.name==='talk'||g.name==='bow'||g.name==='wave')
  let gx=still?0:it.goalX,gz=still?0:it.goalZ
  // he does not stand on the mat in front of his place (it is what people click to become him)
  {const mx=gx-MAT[0],mz=gz-MAT[1],md=Math.hypot(mx,mz);if(md<MAT_CLEAR){const k=md>1e-3?MAT_CLEAR/md:0;gx=MAT[0]+(md>1e-3?mx*k:MAT_CLEAR);gz=MAT[1]+mz*k}}
  if(snap){pos.set(gx,0,gz);this.yaw=it.faceYaw;st.walk=0;st.shuffle=0;st.going=false;st.turning=false}
  const dx=gx-pos.x,dz=gz-pos.z,dist=Math.hypot(dx,dz)
  const blocked=!!near&&nd<0.9&&((near.x-pos.x)*dx+(near.z-pos.z)*dz)>0
  st.going=dist>(st.going?0.05:0.18)&&!busy&&!blocked
  let walkTo=0,shuffleTo=0
  if(st.going){
   const err=wrap(Math.atan2(dx,dz)-this.yaw)
   this.yaw+=clamp(err*5,-2.6,2.6)*dt
   // turn on the spot first if it is far off to one side
   if(Math.abs(err)<0.7)walkTo=1;else shuffleTo=1
   st.turning=false
  }else{
   let want=it.faceYaw,start=0.6
   if(talking&&this.speaker){want=Math.atan2(this.speaker.x-pos.x,this.speaker.z-pos.z);start=0.3}
   else if(st.noticed&&near){want=Math.atan2(near.x-pos.x,near.z-pos.z);start=1.0}
   const err=wrap(want-this.yaw)
   if(!st.turning&&Math.abs(err)>start)st.turning=true
   if(st.turning){
    this.yaw+=clamp(err*5,-2.4,2.4)*dt
    shuffleTo=1
    if(Math.abs(err)<0.06)st.turning=false
   }
  }
  st.walk+=(walkTo-st.walk)*approach(dt,walkTo?4:6)
  st.shuffle+=(shuffleTo-st.shuffle)*approach(dt,8)
  if(st.walk<0.002)st.walk=0
  const w=st.walk
  // he slows as he arrives
  const v=WALK_SPEED*w*Math.min(1,dist/0.3+0.2)
  pos.x+=Math.sin(this.yaw)*v*dt;pos.z+=Math.cos(this.yaw)*v*dt
  st.phase+=(0.6*v/(STEP*Math.max(w,0.3))+1.5*st.shuffle*(1-w))*dt
  st.phase-=Math.floor(st.phase)

  // ---- the pose ----
  const p=this.target
  for(const key of POSE_KEYS)p[key]=STAND[key]
  const calm=1-w
  // breathing
  const br=Math.sin(t*1.55+this.seed)
  p.sp+=0.007*br;p.lo+=0.006*br;p.ro+=0.006*br;p.py+=0.0015*br
  // weight on one leg: that hip rides high, the other knee goes slack
  const lean=still?0:it.lean*calm
  p.px+=0.032*lean;p.pr+=-0.045*lean;p.sr+=0.05*lean;p.hr+=-0.012*lean;p.py+=-0.007*Math.abs(lean)
  p.llz+=0.035*Math.max(0,-lean);p.rlz+=0.035*Math.max(0,lean)
  // looking: at whoever is near, else round about
  let wantYaw=still?0:it.gazeYaw*calm,wantPitch=still?0:it.gazePitch*calm
  const who=talking&&this.speaker?this.speaker:st.noticed?near:null
  if(who){
   const rel=wrap(Math.atan2(who.x-pos.x,who.z-pos.z)-this.yaw)
   const eye=this.rig.info.eyes[0][1]
   wantYaw=clamp(rel,-1.2,1.2)
   wantPitch=clamp(Math.atan2(who.y-eye,Math.max(0.3,Math.hypot(who.x-pos.x,who.z-pos.z))),-0.6,0.6)
  }
  st.lookYaw+=(wantYaw-st.lookYaw)*approach(dt,5.5)
  st.lookPitch+=(wantPitch-st.lookPitch)*approach(dt,5.5)
  if(snap){st.lookYaw=wantYaw;st.lookPitch=wantPitch}
  p.hy+=st.lookYaw*0.7;p.sy+=st.lookYaw*0.22;p.pw+=st.lookYaw*0.08
  p.hp+=-st.lookPitch*0.8;p.sp+=-st.lookPitch*0.12
  p.blink=it.blink
  if(g)applyGesture(p,g,t,this.chars)

  // walking: arms swing against the legs, the pelvis turns with the leading leg
  const ph=st.phase*Math.PI*2
  if(w>0){
   const sw=Math.sin(ph)
   p.pw+=0.09*sw*w;p.sy+=-0.16*sw*w;p.pp+=0.035*w;p.sp+=0.03*w
   p.px+=-0.018*Math.cos(ph)*w
   p.py+=(-0.016-0.012*Math.cos(ph*2))*w
   // (the left leg is forward at phase 0, so the left arm is back)
   p.lf+=(-0.3*Math.cos(ph)+0.02)*w;p.rf+=(0.3*Math.cos(ph)+0.02)*w
   p.le+=(0.16-0.14*Math.cos(ph))*w;p.re+=(0.16+0.14*Math.cos(ph))*w
  }

  // smooth everything except the feet, which go where the ground says
  const k=snap?1:approach(dt,14)
  const pose=this.pose
  for(const key of POSE_KEYS)pose[key]+=(p[key]-pose[key])*k
  pose.blink=p.blink
  this.foot('ll',st.phase,w,st.shuffle,p.llz)
  this.foot('rl',st.phase+0.5,w,st.shuffle,p.rlz)
  this.apply(pose)
  this.object.position.set(pos.x,0,pos.z)
  this.object.rotation.y=this.yaw
  this.hit.position.set(pos.x,this.rig.info.height/2,pos.z)
 }

 /** one foot through the step: on the ground going back for 60% of it, then lifted and brought forward */
 private foot(pre:'ll'|'rl',phase:number,w:number,shuffle:number,restZ:number){
  const pose=this.pose
  const f=phase-Math.floor(phase)
  const stride=STEP*w
  let z:number,y=0,pitch=0
  if(f<0.6){
   const s=f/0.6
   z=stride*(0.5-s)
   // heel first, then rolling onto the toes at the end
   pitch=(-0.22*(1-ss(0,0.18,s))+0.3*ss(0.78,1,s))*w
   y=0.012*ss(0.8,1,s)*w
  }else{
   const s=(f-0.6)/0.4
   z=stride*(-0.5+ss(0,1,s))
   y=(LIFT*w+0.04*shuffle*(1-w))*Math.sin(Math.PI*Math.pow(s,0.8))+0.012*(1-s)*w
   pitch=(0.3*(1-ss(0,0.45,s))-0.22*ss(0.6,1,s))*w+0.12*shuffle*(1-w)*Math.sin(Math.PI*s)
  }
  pose[`${pre}z`]=z+restZ*(1-w)
  pose[`${pre}y`]=y
  pose[`${pre}p`]=pitch
  pose[`${pre}x`]=0
 }

 private apply(pose:Pose){
  const rig=this.rig
  rig.apply(pose)
  // a leg cannot be longer than it is: the pelvis sinks until both feet reach the ground
  const over=Math.max(rig.solved.reachL,rig.solved.reachR)
  if(over>0.0005){
   const py=pose.py
   pose.py=py-over*1.08
   rig.apply(pose)
   pose.py=py
  }
  this.mesh.matrix.copy(rig.matrix)
  this.mesh.matrixWorldNeedsUpdate=true
 }
}
