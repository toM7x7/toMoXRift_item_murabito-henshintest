import {Euler,Matrix4,Quaternion,Vector3,type Object3D,type Scene} from 'three'
import {AvatarReader,type AvatarReading,type WearStatus,type Wearer,type WornBody} from './henshin/reader'
import type {BeastActor} from './beast/actor'
import {rStand,type Mode,type MotionName} from './beast/motions'
import {newPose,type Pose} from './beast/rig'

export type {Wearer,WearStatus}

/**
 * Wearing the gorilla-robot: the body half of 変身 (the avatar half is henshin/reader.ts).
 *
 * The gorilla is not given the wearer's bones: a gorilla walking on two legs with its back straight looks wrong.
 * It keeps its own motions and the wearer drives them: how fast they move (knuckle walk, faster than its natural
 * pace by quicker steps), where they look (its head), standing still (it sits after a while), their hands raised
 * (it rears up on its hind legs and reaches for them). The robot is shaped like a person, so it takes the wearer's
 * pose from their bones: pelvis, spine and head by the turns between body axes, the wrists and ankles where the
 * wearer's are (scaled to its own limbs), the elbows and knees pointing the same way.
 *
 * Sizes: everyone sees it at its own size (gorilla 1.4 m, robot 2.1 m). Only the wearer's own first-person view
 * matches the robot to the avatar's eyes, because the platform puts the camera there; the gorilla is left at its
 * size there (its head is lower and further forward than any eyes the camera could be in) and its heads are left out.
 */
export interface BeastDrive{mode:Mode;since:number;shot:{name:MotionName;t0:number}|null}

const Y=new Vector3(0,1,0),Zv=new Vector3(0,0,1)
const qHips=new Quaternion(),qChest=new Quaternion(),qHead=new Quaternion(),qYaw=new Quaternion(),qYawInv=new Quaternion(),qFoot=new Quaternion(),qRel=new Quaternion(),qChestInv=new Quaternion()
const va=new Vector3(),vb=new Vector3(),vc=new Vector3(),vd=new Vector3(),hipsW=new Vector3(),eu=new Euler()
const rootM=new Matrix4(),holderInv=new Matrix4()
const SIDES=[['left',1],['right',-1]] as const
/** the robot's eye height and hip height (m) at its own size, from rStand */
const ROBOT_EYE=1.86,ROBOT_HIP=0.937
const wrap=(a:number)=>Math.atan2(Math.sin(a),Math.cos(a))

class BeastBody implements WornBody{
 readonly measured={scale:1,heading:0,speed:0,reach:0,motion:'' as string,gazeYaw:0,gazePitch:0}
 /** what Item.tsx says (form and the action asked for) */
 drive:BeastDrive={mode:'gorilla',since:-99,shot:null}
 readonly follow=newPose()
 private yaw=0;private lastT=NaN;private last=new Vector3();private speed=0;private reach=0
 private handL=new Vector3();private handR=new Vector3()
 constructor(private actor:BeastActor,private holder:Object3D){}
 hide(){this.actor.object.visible=false}
 nested(inside:boolean,w:Wearer|null){this.actor.setHeadsHidden(!inside&&!!w?.isLocal&&w.firstPerson)}
 pose(r:AvatarReading,w:Wearer){
  const a=this.actor,rig=a.rig,d=this.drive,gorilla=d.mode==='gorilla'
  this.holder.getWorldScale(vc)
  const own=w.isLocal&&w.firstPerson&&!gorilla
  const s=own?Math.max(0.3,Math.min(3,r.eye/ROBOT_EYE)):vc.x
  this.measured.scale=s
  // how fast the wearer goes over the ground, and which way the body should face
  // (a frame may be drawn more than once: only a new moment moves things on)
  const first=!Number.isFinite(this.lastT)
  const dt=first?0:Math.max(0,Math.min(0.2,w.t-this.lastT))
  if(first){this.speed=0;this.yaw=r.heading;this.last.copy(w.feet);this.lastT=w.t}
  else if(dt>0){
   const dx=w.feet.x-this.last.x,dz=w.feet.z-this.last.z,v=Math.hypot(dx,dz)/dt
   this.speed+=(v-this.speed)*Math.min(1,dt*8)
   // the gorilla turns to where it goes (an animal does not walk sideways); otherwise to where the wearer faces
   const want=gorilla&&this.speed>0.4&&v>0.05?Math.atan2(dx,dz):r.heading
   this.yaw+=wrap(want-this.yaw)*Math.min(1,dt*(gorilla?6:12))
   this.last.copy(w.feet);this.lastT=w.t
  }
  if(!gorilla)this.yaw=r.heading
  this.measured.heading=this.yaw;this.measured.speed=this.speed
  qYaw.setFromAxisAngle(Y,this.yaw);qYawInv.copy(qYaw).invert()
  rootM.compose(w.feet,qYaw,vc.set(s,s,s))
  // where the wearer looks, against the body
  r.axes('head',qHead)
  va.copy(Zv).applyQuaternion(qHead)
  const gy=Math.max(-1.2,Math.min(1.2,wrap(Math.atan2(va.x,va.z)-this.yaw))),gp=Math.max(-0.6,Math.min(0.5,-Math.asin(Math.max(-1,Math.min(1,va.y)))))
  this.measured.gazeYaw=gy;this.measured.gazePitch=gp
  r.axes('hips',qHips);r.axes('chest',qChest)
  // gorilla: the wearer's hands raised above their eyes -> up on its hind legs, reaching for them
  let reachWant=0
  if(gorilla){
   r.pos('chest',vd);qChestInv.copy(qChest).invert()
   const armK=(rig.upperArm+rig.forearm)/Math.max(0.1,r.armLength)
   for(const [side] of SIDES){
    r.pos(`${side}Hand`,va)
    if(va.y-w.feet.y>r.eye-0.05)reachWant=1
    const out=side==='left'?this.handL:this.handR
    out.subVectors(va,vd).applyQuaternion(qChestInv).multiplyScalar(armK)
   }
  }
  this.reach+=(reachWant-this.reach)*Math.min(1,dt*4)
  this.measured.reach=this.reach
  // robot: the wearer's pose
  if(!gorilla)this.robotFollow(r,w,s)
  const shown=a.drive({t:w.t,mode:d.mode,since:d.since,speed:this.speed/s,lift:0,gazeYaw:gy,gazePitch:gp,shot:d.shot,
   reach:this.reach,handL:this.handL,handR:this.handR,follow:gorilla?null:this.follow})
  this.measured.motion=shown
  a.setHeadsHidden(w.isLocal&&w.firstPerson)
  if(w.isLocal&&w.firstPerson){
   // the wearer's camera is where their avatar's eyes are: move the body back so that its (hidden) head is under
   // the camera, and looking down shows its shoulders and arms instead of its back
   va.setFromMatrixPosition(a.rig.matrix(gorilla||d.since>w.t-1?'ghead':'rhead'))
   vb.set(va.x*s,0,va.z*s).applyQuaternion(qYaw)
   vc.copy(w.feet).sub(vb)
   rootM.setPosition(vc.x,w.feet.y,vc.z)
  }
  // place it (the scene's matrices were updated before this render started)
  const obj=a.object
  this.holder.updateWorldMatrix(true,false)
  holderInv.copy(this.holder.matrixWorld).invert()
  obj.matrixAutoUpdate=false
  obj.matrix.multiplyMatrices(holderInv,rootM)
  obj.visible=true
  obj.updateMatrixWorld(true)
 }

 /** the robot's pose from the wearer's bones, in its body space (feet at the origin, facing +Z, its own size) */
 private robotFollow(r:AvatarReading,w:Wearer,s:number){
  const p=this.follow,rig=this.actor.rig
  rStand(p)
  // pelvis: where it is over the feet, how far it has dropped (as a share of the hip height), its lean
  r.pos('hips',hipsW)
  va.subVectors(hipsW,w.feet).applyQuaternion(qYawInv).divideScalar(s)
  p.px=va.x;p.pz=va.z
  p.py=ROBOT_HIP*(hipsW.y-w.feet.y)/Math.max(0.1,r.hipRest)
  eu.setFromQuaternion(qRel.copy(qYawInv).multiply(qHips),'YXZ')
  p.ppitch=eu.x;p.pyaw=eu.y;p.proll=eu.z
  // spine: shared between abdomen and chest
  eu.setFromQuaternion(qRel.copy(qHips).invert().multiply(qChest),'YXZ')
  p.apitch=p.cpitch=eu.x/2;p.ayaw=p.cyaw=eu.y/2;p.aroll=p.croll=eu.z/2
  // head
  eu.setFromQuaternion(qRel.copy(qChest).invert().multiply(qHead),'YXZ')
  p.hpitch=eu.x;p.hyaw=eu.y;p.hroll=eu.z
  // arms: the wrist where the wearer's is from their shoulder, scaled to its arm; the elbow pointing the same way
  const chest=rig.spine(p)
  const armK=(rig.upperArm+rig.forearm)/Math.max(0.1,r.armLength)
  for(const [side,sx] of SIDES){
   const L=side==='left'
   r.pos(`${side}UpperArm`,va);r.pos(`${side}LowerArm`,vb);r.pos(`${side}Hand`,vc)
   vd.set(rig.shoulder.x*sx,rig.shoulder.y,rig.shoulder.z).applyMatrix4(chest)
   const wx=vc.x-va.x,wy=vc.y-va.y,wz=vc.z-va.z
   hipsW.set(wx,wy,wz).applyQuaternion(qYawInv).multiplyScalar(armK).add(vd)
   // pole: from the middle of shoulder-wrist to the elbow
   vb.sub(va.addScaledVector(vc.sub(va),0.5)).applyQuaternion(qYawInv)
   if(L){p.hlx=hipsW.x;p.hly=hipsW.y;p.hlz=hipsW.z;p.elx=vb.x;p.ely=vb.y;p.elz=vb.z}
   else{p.hrx=hipsW.x;p.hry=hipsW.y;p.hrz=hipsW.z;p.erx=vb.x;p.ery=vb.y;p.erz=vb.z}
  }
  // legs: the ankle where the wearer's is from their hip, scaled to its leg; the knee pointing the same way
  const pelvis=rig.part('pelvis').m
  const legK=(rig.thigh+rig.shin)/Math.max(0.1,r.legLength)
  for(const [side,sx] of SIDES){
   const L=side==='left'
   r.pos(`${side}UpperLeg`,va);r.pos(`${side}LowerLeg`,vb);r.pos(`${side}Foot`,vc)
   vd.set(rig.hip.x*sx,rig.hip.y,rig.hip.z).applyMatrix4(pelvis)
   hipsW.set(vc.x-va.x,vc.y-va.y,vc.z-va.z).applyQuaternion(qYawInv).multiplyScalar(legK).add(vd)
   hipsW.y=Math.max(0.11,hipsW.y)
   vb.sub(va.addScaledVector(vc.sub(va),0.5)).applyQuaternion(qYawInv)
   r.axes(`${side}Foot`,qFoot)
   va.copy(Zv).applyQuaternion(qFoot)
   const toe=-Math.asin(Math.max(-1,Math.min(1,va.y)))
   if(L){p.flx=hipsW.x;p.fly=hipsW.y;p.flz=hipsW.z;p.klx=vb.x;p.kly=vb.y;p.klz=vb.z;p.fpl=toe}
   else{p.frx=hipsW.x;p.fry=hipsW.y;p.frz=hipsW.z;p.krx=vb.x;p.kry=vb.y;p.krz=vb.z;p.fpr=toe}
  }
 }
}

/** The gorilla-robot, worn: what Item.tsx holds. */
export class WearBridge{
 private body:BeastBody
 private reader:AvatarReader
 constructor(scene:Scene,private actor:BeastActor,holder:Object3D){
  this.body=new BeastBody(actor,holder)
  this.reader=new AvatarReader(scene,this.body,'gorilla-robo')
 }
 get status(){return this.reader.status}
 get measured(){return this.body.measured}
 get showAvatar(){return this.reader.showAvatar}
 set showAvatar(v:boolean){this.reader.showAvatar=v}
 /** every frame: who wears it, and what form and action Item.tsx has for it */
 set(w:Wearer|null,drive?:BeastDrive){if(drive)this.body.drive=drive;this.reader.set(w)}
 debug(){return {...this.reader.debug(),...this.body.measured}}
 dispose(){this.reader.dispose();this.actor.setHeadsHidden(false)}
}
