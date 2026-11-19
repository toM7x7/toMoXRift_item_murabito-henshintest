import * as THREE from 'three'
import type {HumanInfo,Skin,V3} from './model'

/**
 * A pose is a flat set of numbers, so two poses can be mixed number by number.
 *
 * pelvis   px py pz = how far it is moved from standing (m; x = to the person's left, y = up, z = forward)
 *          pp pw pr = lean forward, turn to the left, lean to the left (rad; the top goes left, the left hip down)
 * spine    sp sy sr = bend forward, turn to the left, bend to the left (spread from the hips to the ribs)
 * head     hp hy hr = nod down, turn to the left, tilt to the left
 * jaw      0 = shut .. about 0.12 = open         blink  0 = open .. 1 = shut
 * arms     (l* = left, r* = right; the numbers mean the same on both sides)
 *          o u f = where the upper arm points: out to the side, up, forward (any length)
 *          r     = the whole arm turned inward about the upper arm
 *          e     = elbow fold (0 = straight)
 *          t     = forearm twist: 0 = palm forward (as photographed), about 1.4 = palm to the thigh
 *          wf ws = wrist: bent to the palm side, bent to the thumb side
 * legs     (ll* = left, rl* = right) x y z = the ankle moved from where it stands at rest (same axes as the
 *          pelvis; the feet stay where they are told while the pelvis moves), p = toes down
 */
export const POSE_KEYS=[
 'px','py','pz','pp','pw','pr','sp','sy','sr','hp','hy','hr','jaw','blink',
 'lo','lu','lf','lr','le','lt','lwf','lws',
 'ro','ru','rf','rr','re','rt','rwf','rws',
 'llx','lly','llz','llp','rlx','rly','rlz','rlp',
] as const
export type PoseKey=typeof POSE_KEYS[number]
export type Pose=Record<PoseKey,number>

/** standing at ease: arms hanging, palms to the thighs */
export const STAND:Pose={
 px:0,py:0,pz:0,pp:0,pw:0,pr:0,sp:0,sy:0,sr:0,hp:0,hy:0,hr:0,jaw:0,blink:0,
 lo:0.13,lu:-1,lf:0.02,lr:0.25,le:0.2,lt:1.15,lwf:0.12,lws:0,
 ro:0.13,ru:-1,rf:0.02,rr:0.25,re:0.2,rt:1.15,rwf:0.12,rws:0,
 llx:0,lly:0,llz:0,llp:0,rlx:0,rly:0,rlz:0,rlp:0,
}
/** as photographed (arms out, palms forward) */
export const REST:Pose={...STAND,lo:Number.NaN,ro:Number.NaN}

export const clonePose=(p:Pose):Pose=>({...p})
export function mixPose(out:Pose,a:Pose,b:Pose,k:number):Pose{
 for(const key of POSE_KEYS)out[key]=a[key]+(b[key]-a[key])*k
 return out
}
/** out += (p - base) * k: lay a gesture, written as a change from standing, on top of whatever out is */
export function addPose(out:Pose,p:Pose,base:Pose,k:number):Pose{
 for(const key of POSE_KEYS)out[key]+=(p[key]-base[key])*k
 return out
}

const X=new THREE.Vector3(1,0,0),Z=new THREE.Vector3(0,0,1)

/** one arm to follow: directions in the chest's axes (unit vectors) */
export interface FollowArm{upper:THREE.Vector3;fore:THREE.Vector3;fingers:THREE.Vector3;palm:THREE.Vector3}
export interface Follow{
 /** the pelvis' turn against the root, and how far it is from where it stands at rest (m, this body's size) */
 pelvisQ:THREE.Quaternion;pelvisOffset:THREE.Vector3
 spineQ:THREE.Quaternion;headQ:THREE.Quaternion
 /** [right, left]; null keeps that arm hanging */
 arms:[FollowArm|null,FollowArm|null]
 /** [right, left]: the ankle moved from where it stands at rest (root space, m), toes down (rad) */
 legs:[{ankle:THREE.Vector3;toe:number},{ankle:THREE.Vector3;toe:number}]
 jaw:number;blink:number
}
const FOLLOW_POSE:Pose={} as Pose
const smoothstep=(e0:number,e1:number,x:number)=>{const t=Math.max(0,Math.min(1,(x-e0)/(e1-e0)));return t*t*(3-2*t)}
/** the part of v square to axis, normalized (zero if there is none) */
function perp(out:THREE.Vector3,v:THREE.Vector3,axis:THREE.Vector3){
 out.copy(v).addScaledVector(axis,-v.dot(axis))
 const l=out.length()
 return l>1e-6?out.multiplyScalar(1/l):out.set(0,0,0)
}
/** rotation whose columns are (y×z, y, z) for y = dir and z = ref made square to it */
function frame(m:THREE.Matrix4,dir:THREE.Vector3,ref:THREE.Vector3){
 fy.copy(dir).normalize()
 fz.copy(ref).addScaledVector(fy,-ref.dot(fy))
 if(fz.lengthSq()<1e-8){fz.set(0,0,1).addScaledVector(fy,-fy.z);if(fz.lengthSq()<1e-8)fz.set(1,0,0).addScaledVector(fy,-fy.x)}
 fz.normalize()
 fx.crossVectors(fy,fz)
 return m.makeBasis(fx,fy,fz)
}
function fromRV(v:THREE.Vector3,out:THREE.Quaternion){const a=v.length();return a<1e-7?out.identity():out.setFromAxisAngle(tmpA.copy(v).multiplyScalar(1/a),a)}
const tmpA=new THREE.Vector3(),bs=new THREE.Vector3(),bw=new THREE.Vector3(),bb=new THREE.Vector2(),qa1=new THREE.Quaternion(),qa2=new THREE.Quaternion()
const fx=new THREE.Vector3(),fy=new THREE.Vector3(),fz=new THREE.Vector3(),fb=new THREE.Vector3(),palmR=new THREE.Vector3(),fingV=new THREE.Vector3(),palmV=new THREE.Vector3()
const n1=new THREE.Vector3(),n2=new THREE.Vector3(),tmpV=new THREE.Vector3()
const m1=new THREE.Matrix4(),m2=new THREE.Matrix4()
const qE=new THREE.Quaternion(),qS=new THREE.Quaternion(),qSE=new THREE.Quaternion(),qR=new THREE.Quaternion(),qM=new THREE.Quaternion(),qT=new THREE.Quaternion()
const q1=new THREE.Quaternion(),q2=new THREE.Quaternion(),q3=new THREE.Quaternion()
const e1=new THREE.Euler()
const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),d=new THREE.Vector3()

/** quaternion -> rotation vector (axis * angle) */
function toRV(q:THREE.Quaternion,out:THREE.Vector3){
 let w=q.w,x=q.x,y=q.y,z=q.z
 if(w<0){w=-w;x=-x;y=-y;z=-z}
 const s=Math.hypot(x,y,z)
 if(s<1e-7)return out.set(0,0,0)
 const k=2*Math.atan2(s,w)/s
 return out.set(x*k,y*k,z*k)
}

export class Rig{
 readonly info:HumanInfo
 private u:Skin['uniforms']
 /** middle of the pelvis: what the pelvis' own lean and turn go about */
 readonly pelvis:THREE.Vector3
 private arms:{u0:THREE.Vector3;f0:THREE.Vector3;flex:THREE.Vector3;sx:number;bend0:number;fing:THREE.Vector3}[]
 private legs:{hip:THREE.Vector3;ankle:THREE.Vector3;r0:THREE.Vector3;l1:number;l2:number}[]
 /** the body mesh's own matrix (the pelvis' move, lean and turn) */
 readonly matrix=new THREE.Matrix4()
 private rot=new THREE.Quaternion()
 /** read back for checks: knee folds and how far each ankle is from where it was asked to be */
 readonly solved={kneeL:0,kneeR:0,reachL:0,reachR:0}

 constructor(info:HumanInfo,skin:Skin){
  this.info=info
  this.u=skin.uniforms
  const v=(p:V3)=>new THREE.Vector3(p[0],p[1],p[2])
  this.pelvis=new THREE.Vector3(0,(info.hipL[1]+info.hipR[1])/2+0.03,(info.hipL[2]+info.hipR[2])/2)
  this.arms=[info.armR,info.armL].map((arm,i)=>{
   const u0=v(arm.elbow).sub(v(arm.shoulder)).normalize()
   const f0=v(arm.wrist).sub(v(arm.elbow)).normalize()
   return {u0,f0,flex:f0.clone().cross(Z).normalize(),sx:i?1:-1,bend0:Math.acos(Math.min(1,u0.dot(f0))),fing:v(arm.tip).sub(v(arm.wrist)).normalize()}
  })
  this.legs=[[info.hipR,info.kneeR,info.ankleR],[info.hipL,info.kneeL,info.ankleL]].map(([h,k,an])=>{
   const hip=v(h),knee=v(k),ankle=v(an)
   return {hip,ankle,r0:ankle.clone().sub(hip).normalize(),l1:knee.distanceTo(hip),l2:ankle.distanceTo(knee)}
  })
 }

 /** write the pose into the shader's uniforms and this.matrix */
 apply(p:Pose){
  const u=this.u
  // pelvis
  this.rot.setFromEuler(e1.set(p.pp,p.pw,-p.pr,'YXZ'))
  a.copy(this.pelvis).applyQuaternion(this.rot)
  b.set(p.px,p.py,p.pz).add(this.pelvis).sub(a)
  this.matrix.compose(b,this.rot,c.set(1,1,1))
  // spine and head
  toRV(q1.setFromEuler(e1.set(p.sp,p.sy,-p.sr,'YXZ')),u.uSpineRV.value)
  toRV(q1.setFromEuler(e1.set(p.hp,p.hy,-p.hr,'YXZ')),u.uHeadRV.value)
  u.uJawOpen.value=p.jaw
  u.uBlink.value=p.blink
  // arms
  this.arm(0,p.ro,p.ru,p.rf,p.rr,p.re,p.rt,p.rwf,p.rws)
  this.arm(1,p.lo,p.lu,p.lf,p.lr,p.le,p.lt,p.lwf,p.lws)
  // legs: the ankles stay where the pose puts them on the ground while the pelvis moves
  q3.copy(this.rot).invert()
  this.solved.reachR=this.leg(0,p.rlx,p.rly,p.rlz,p.rlp,p)
  this.solved.reachL=this.leg(1,p.llx,p.lly,p.llz,p.llp,p)
 }

 /**
  * Follow another body (the avatar of whoever wears him, wear.ts) instead of a Pose. Every direction is in this
  * body's own axes (+X its left, +Y up, +Z forward): the pelvis' turn against the root, the spine's against the
  * pelvis, the head's against the chest; the arms' directions in the chest's axes; the ankles in the root's space.
  */
 applyFollow(f:Follow){
  const u=this.u
  this.rot.copy(f.pelvisQ)
  a.copy(this.pelvis).applyQuaternion(this.rot)
  b.copy(f.pelvisOffset).add(this.pelvis).sub(a)
  this.matrix.compose(b,this.rot,c.set(1,1,1))
  toRV(f.spineQ,u.uSpineRV.value)
  toRV(f.headQ,u.uHeadRV.value)
  u.uJawOpen.value=f.jaw
  u.uBlink.value=f.blink
  for(let i=0;i<2;i++){const arm=f.arms[i];if(arm)this.followArm(i,arm);else this.arm(i,STAND[i?'lo':'ro'],STAND[i?'lu':'ru'],STAND[i?'lf':'rf'],STAND[i?'lr':'rr'],STAND[i?'le':'re'],STAND[i?'lt':'rt'],STAND[i?'lwf':'rwf'],0)}
  q3.copy(this.rot).invert()
  const p=FOLLOW_POSE
  p.px=f.pelvisOffset.x;p.py=f.pelvisOffset.y;p.pz=f.pelvisOffset.z
  for(let i=0;i<2;i++){
   const l=f.legs[i]
   const reach=this.leg(i,l.ankle.x,l.ankle.y,l.ankle.z,l.toe,p)
   if(i)this.solved.reachL=reach;else this.solved.reachR=reach
  }
 }

 /** After applyFollow: turn arm i (0 right, 1 left) toward what Pose p asks of it, by k (a gesture over a worn body). */
 blendArm(i:number,p:Pose,k:number){
  if(k<=0)return
  const u=this.u
  bs.copy(u.uShoulderRV.value[i]);bw.copy(u.uWristRV.value[i]);bb.copy(u.uArmBend.value[i])
  if(i)this.arm(1,p.lo,p.lu,p.lf,p.lr,p.le,p.lt,p.lwf,p.lws);else this.arm(0,p.ro,p.ru,p.rf,p.rr,p.re,p.rt,p.rwf,p.rws)
  const kk=Math.min(1,k)
  toRV(fromRV(bs,qa1).slerp(fromRV(u.uShoulderRV.value[i],qa2),kk),u.uShoulderRV.value[i])
  toRV(fromRV(bw,qa1).slerp(fromRV(u.uWristRV.value[i],qa2),kk),u.uWristRV.value[i])
  u.uArmBend.value[i].set(bb.x+(u.uArmBend.value[i].x-bb.x)*kk,bb.y+(u.uArmBend.value[i].y-bb.y)*kk)
 }

 /** One arm from the directions of its upper arm, forearm, fingers and palm (chest axes). */
 private followArm(i:number,t:FollowArm){
  const u=this.u,arm=this.arms[i]
  const bend=Math.acos(Math.max(-1,Math.min(1,t.upper.dot(t.fore))))
  // the photographed arm is already a little bent; the elbow only folds forward from there
  const theta=Math.max(0,bend-arm.bend0)
  qE.setFromAxisAngle(arm.flex,theta)
  fb.copy(arm.f0).applyQuaternion(qE)
  palmR.copy(Z).applyQuaternion(qE)
  // Turn the arm so that its upper arm lies along the target's and the plane of the elbow matches the target's.
  // With a nearly straight arm that plane is undefined: then the arm only swings (no roll of the shoulder), and the
  // turn of the palm is left to the forearm's twist and the wrist, as a real arm does it.
  const w=smoothstep(0.12,0.45,bend)
  qS.setFromUnitVectors(arm.u0,t.upper)
  if(w>0){
   frame(m1,arm.u0,perp(n1,fb,arm.u0));frame(m2,t.upper,perp(n2,t.fore,t.upper))
   qR.setFromRotationMatrix(m2.multiply(m1.transpose()))
   qS.slerp(qR,w)
  }
  toRV(qS,u.uShoulderRV.value[i])
  // what is left for the hand: R_twist * R_wrist = (S E)^-1 * R * (S E), R turning the hand as the arm leaves it
  // onto the target hand
  qSE.copy(qS).multiply(qE)
  fingV.copy(arm.fing).applyQuaternion(qE).applyQuaternion(qS)
  palmV.copy(Z).applyQuaternion(qE).applyQuaternion(qS)
  frame(m1,fingV,palmV);frame(m2,t.fingers,t.palm)
  qR.setFromRotationMatrix(m2.multiply(m1.transpose()))
  qM.copy(qSE).invert().multiply(qR).multiply(qSE)
  // twist about the forearm (spread along it by the skin's weights), the rest at the wrist
  const ax=arm.f0
  let tw=2*Math.atan2(qM.x*ax.x+qM.y*ax.y+qM.z*ax.z,qM.w)
  tw=Math.atan2(Math.sin(tw),Math.cos(tw))
  tw=Math.max(-1.9,Math.min(1.9,tw))
  qT.setFromAxisAngle(ax,tw)
  toRV(qT.invert().multiply(qM),u.uWristRV.value[i])
  u.uArmBend.value[i].set(theta,tw)
 }

 private arm(i:number,o:number,up:number,f:number,roll:number,elbow:number,twist:number,wf:number,ws:number){
  const u=this.u,arm=this.arms[i]
  if(Number.isNaN(o)){
   // as photographed
   u.uShoulderRV.value[i].set(0,0,0);u.uArmBend.value[i].set(0,0);u.uWristRV.value[i].set(0,0,0)
   return
  }
  a.set(arm.sx*o,up,f).normalize()
  q1.setFromUnitVectors(arm.u0,a)
  q2.setFromAxisAngle(a,arm.sx*roll)
  toRV(q2.multiply(q1),u.uShoulderRV.value[i])
  u.uArmBend.value[i].set(elbow,arm.sx*twist)
  u.uWristRV.value[i].copy(arm.flex).multiplyScalar(wf).addScaledVector(Z,-arm.sx*ws)
 }

 private leg(i:number,x:number,y:number,z:number,pitch:number,p:Pose):number{
  const u=this.u,leg=this.legs[i]
  // where the ankle has to be, seen from the pelvis as it is leaning now
  a.copy(leg.ankle).add(b.set(x,y,z))
  a.sub(c.set(p.px,p.py,p.pz).add(this.pelvis)).applyQuaternion(q3).add(this.pelvis)
  d.copy(a).sub(leg.hip)
  const want=d.length()
  const {l1,l2}=leg
  const D=Math.min(Math.max(want,Math.abs(l1-l2)+0.02),l1+l2-0.0005)
  const knee=Math.PI-Math.acos(Math.min(1,Math.max(-1,(l1*l1+l2*l2-D*D)/(2*l1*l2))))
  const lift=Math.acos(Math.min(1,Math.max(-1,(l1*l1+D*D-l2*l2)/(2*l1*D))))
  d.normalize()
  q1.setFromUnitVectors(leg.r0,d)
  q2.setFromAxisAngle(X,-lift)
  q1.multiply(q2)
  toRV(q1,u.uHipRV.value[i])
  // the foot stays flat on the ground (plus the pose's own toe-down)
  c.set(0,0,1).applyAxisAngle(X,knee).applyQuaternion(q1).applyQuaternion(this.rot)
  const ankle=Math.asin(Math.min(1,Math.max(-1,c.y)))+pitch
  u.uLegBend.value[i].set(knee,ankle)
  if(i)this.solved.kneeL=knee;else this.solved.kneeR=knee
  return want-D
 }
}
