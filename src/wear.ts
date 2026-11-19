import {Euler,Matrix4,Quaternion,Vector3,type Object3D,type Scene} from 'three'
import {AvatarReader,type AvatarReading,type WearStatus,type Wearer,type WornBody} from './henshin/reader'
import type {VillagerActor} from './villager/actor'
import {applyGesture,ARM_WEIGHT} from './villager/pose'
import {POSE_KEYS,STAND,type Follow,type Pose} from './villager/rig'

export type {Wearer,WearStatus}

/**
 * Wearing the villager: the body half of 変身 (the avatar half is henshin/reader.ts).
 * The villager is drawn where the avatar is, in the avatar's pose: pelvis, spine and head by the turns between body
 * axes, the arms by the directions of their bones in the chest's axes, the legs by where the ankles are. A gesture
 * the wearer asked for is laid on top.
 */
/**
 * How big the worn villager is. Everyone else (and the wearer in third person) sees him at his own size; only the
 * wearer's own first-person view matches him to the avatar's eyes, because the platform puts the camera there.
 */
export const SIZE:'item'|'avatar'='item'

const Y=new Vector3(0,1,0),Zv=new Vector3(0,0,1)
const qb=new Quaternion(),qHips=new Quaternion(),qChest=new Quaternion(),qHead=new Quaternion(),qFoot=new Quaternion(),qYaw=new Quaternion(),qChestInv=new Quaternion()
const va=new Vector3(),vb=new Vector3(),vc=new Vector3(),hipsW=new Vector3()
const GP={...STAND} as Pose,eu=new Euler()
const rootM=new Matrix4(),rootInv=new Matrix4(),holderInv=new Matrix4()
const SIDES=['right','left'] as const

class VillagerBody implements WornBody{
 readonly measured={scale:1,reach:0,heading:0,gesture:''}
 readonly follow:Follow
 constructor(private actor:VillagerActor,private holder:Object3D){
  this.follow={pelvisQ:new Quaternion(),pelvisOffset:new Vector3(),spineQ:new Quaternion(),headQ:new Quaternion(),arms:[null,null],
   legs:[{ankle:new Vector3(),toe:0},{ankle:new Vector3(),toe:0}],jaw:0,blink:0}
 }
 hide(){this.actor.object.visible=false}
 nested(inside:boolean,w:Wearer|null){
  // a mirror shows the wearer's face
  this.actor.skin.uniforms.uHideHead.value=!inside&&w?.isLocal&&w.firstPerson?1:0
 }
 pose(r:AvatarReading,w:Wearer){
  const actor=this.actor,rig=actor.rig,vi=rig.info,fo=this.follow
  this.holder.getWorldScale(vc)
  const own=w.isLocal&&w.firstPerson||SIZE==='avatar'
  const s=own?Math.max(0.3,Math.min(3,r.eye/vi.eyes[0][1])):vc.x
  this.measured.scale=s
  // root: on the feet, turned the way the pelvis faces
  this.measured.heading=r.heading
  qYaw.setFromAxisAngle(Y,r.heading)
  rootM.compose(w.feet,qYaw,vc.set(s,s,s))
  rootInv.copy(rootM).invert()
  // pelvis: its lean, and its drop measured as a share of the avatar's own hip height
  r.axes('hips',qHips)
  fo.pelvisQ.copy(qYaw).invert().multiply(qHips)
  r.pos('hips',hipsW)
  va.copy(hipsW).applyMatrix4(rootInv)
  fo.pelvisOffset.set(va.x,((hipsW.y-w.feet.y)/Math.max(1e-6,r.hipRest)-1)*rig.pelvis.y,va.z)
  // spine and head
  r.axes('chest',qChest)
  fo.spineQ.copy(qHips).invert().multiply(qChest)
  r.axes('head',qHead)
  fo.headQ.copy(qChest).invert().multiply(qHead)
  qChestInv.copy(qChest).invert()
  // arms: directions in the chest's axes
  for(let i=0;i<2;i++){
   const side=SIDES[i]
   const arm=fo.arms[i]??(fo.arms[i]={upper:new Vector3(),fore:new Vector3(),fingers:new Vector3(),palm:new Vector3()})
   r.pos(`${side}UpperArm`,va);r.pos(`${side}LowerArm`,vb);r.pos(`${side}Hand`,vc)
   arm.upper.subVectors(vb,va).normalize().applyQuaternion(qChestInv)
   arm.fore.subVectors(vc,vb).normalize().applyQuaternion(qChestInv)
   r.hand(side,arm.fingers,arm.palm)
   arm.fingers.applyQuaternion(qChestInv);arm.palm.applyQuaternion(qChestInv)
  }
  // legs: where each ankle is (its height above the floor measured against the avatar's own ankle height)
  const rest=[vi.ankleR,vi.ankleL]
  for(let i=0;i<2;i++){
   const side=SIDES[i],leg=fo.legs[i]
   r.pos(`${side}Foot`,va)
   const lift=(va.y-w.feet.y-r.ankleRest)/s
   va.applyMatrix4(rootInv)
   leg.ankle.set(va.x-rest[i][0],Math.max(-0.05,lift),va.z-rest[i][2])
   r.axes(`${side}Foot`,qFoot)
   vb.copy(Zv).applyQuaternion(qFoot)
   leg.toe=-Math.asin(Math.max(-1,Math.min(1,vb.y)))
  }
  fo.jaw=0
  fo.blink=actor.blinkAt(w.t)
  // a gesture the wearer asked for, laid over the avatar's own pose: the body by what it changes from standing,
  // the arms it uses blended over the avatar's arms
  const cur=actor.wornTick(w.t)
  if(cur){
   for(const key of POSE_KEYS)GP[key]=STAND[key]
   applyGesture(GP,cur.g,w.t,cur.chars)
   const D=(key:keyof Pose)=>GP[key]-STAND[key]
   fo.pelvisQ.multiply(qb.setFromEuler(eu.set(D('pp'),D('pw'),-D('pr'),'YXZ')))
   fo.pelvisOffset.x+=D('px');fo.pelvisOffset.y+=D('py');fo.pelvisOffset.z+=D('pz')
   fo.spineQ.multiply(qb.setFromEuler(eu.set(D('sp'),D('sy'),-D('sr'),'YXZ')))
   fo.headQ.multiply(qb.setFromEuler(eu.set(D('hp'),D('hy'),-D('hr'),'YXZ')))
   fo.jaw=Math.max(0,D('jaw'))
   this.measured.gesture=cur.g.name
  }else this.measured.gesture=''
  rig.applyFollow(fo)
  if(cur){rig.blendArm(0,GP,ARM_WEIGHT.r);rig.blendArm(1,GP,ARM_WEIGHT.l)}
  this.measured.reach=Math.max(rig.solved.reachL,rig.solved.reachR)
  actor.skin.uniforms.uHideHead.value=w.isLocal&&w.firstPerson?1:0
  // place him (the scene's matrices were updated before this render started)
  const obj=actor.object
  this.holder.updateWorldMatrix(true,false)
  holderInv.copy(this.holder.matrixWorld).invert()
  obj.matrixAutoUpdate=false
  obj.matrix.multiplyMatrices(holderInv,rootM)
  actor.mesh.matrix.copy(rig.matrix)
  obj.visible=true
  obj.updateMatrixWorld(true)
 }
}

/** The villager, worn: what Item.tsx holds (status, debug and the dev switches in one place). */
export class WearBridge{
 private body:VillagerBody
 private reader:AvatarReader
 constructor(scene:Scene,private actor:VillagerActor,holder:Object3D){
  this.body=new VillagerBody(actor,holder)
  this.reader=new AvatarReader(scene,this.body,'villager-a')
 }
 get status(){return this.reader.status}
 get measured(){return this.body.measured}
 get showAvatar(){return this.reader.showAvatar}
 set showAvatar(v:boolean){this.reader.showAvatar=v}
 set(w:Wearer|null){this.reader.set(w)}
 debug(){return {...this.reader.debug(),...this.body.measured,follow:this.body.follow}}
 dispose(){this.reader.dispose();this.actor.skin.uniforms.uHideHead.value=0}
}
