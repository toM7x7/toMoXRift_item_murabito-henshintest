/**
 * The skeleton: a pose (a flat list of numbers) -> one matrix per part, in body space
 * (the beast stands at the origin facing +Z, +X is its left, the ground is y = 0).
 *
 * Nothing here is an animation clip. The body is placed by the pelvis and three spine angles, the limbs by where
 * the wrists and ankles should be (two-bone IK), and the parts that transform by how far each group has gone
 * from its gorilla place (g) to its robot place (r). Both places come from the model file (making/scripts/build.py).
 */
import * as THREE from 'three'

export interface RigPart{name:string;parent:string|null;g:number[];r:number[]}
export interface RigData{parts:RigPart[];dims:Record<string,number>}

/** Angles are radians. 'pitch' is positive when the top leans forward (nose down); 'yaw' when it turns to its left. */
export const CH=[
 // pelvis (hip centre) in body space, and its turn
 'px','py','pz','pyaw','ppitch','proll',
 // abdomen on the pelvis, chest on the abdomen
 'ayaw','apitch','aroll','cyaw','cpitch','croll',
 // the head in use (the gorilla's, or the robot's once the heads have swapped), and the gorilla's jaw
 'hyaw','hpitch','hroll','jaw',
 // wrists: where they should be, and which way the elbows point
 'hlx','hly','hlz','hrx','hry','hrz','elx','ely','elz','erx','ery','erz',
 // forearm twist, wrist bend (towards the palm), wrist tilt, finger curl
 'twl','twr','wfl','wfr','wdl','wdr','fgl','fgr',
 // ankles: where they should be, which way the knees point, and how the feet sit
 'flx','fly','flz','frx','fry','frz','klx','kly','klz','krx','kry','krz',
 'fyl','fyr','fpl','fpr','fol','for',
 // how far each group of transforming parts has gone, 0 = gorilla, 1 = robot
 'fHead','fPec','fSad','fCap','fShell','fThigh','fToe',
 // lights: gorilla eyes / chest lamps, visor, mouth; hue 0 = amber, 1 = cyan
 'eye','visor','mouth','hue',
] as const
export type Ch=typeof CH[number]
export type Pose=Record<Ch,number>

export const newPose=():Pose=>{const p={} as Pose;for(const k of CH)p[k]=0;return p}
export function copyPose(out:Pose,a:Pose){for(const k of CH)out[k]=a[k];return out}
export function mixPose(out:Pose,a:Pose,b:Pose,w:number){for(const k of CH)out[k]=a[k]+(b[k]-a[k])*w;return out}

const GROUP:Record<string,Ch>={ghead:'fHead',rhead:'fHead',pecL:'fPec',pecR:'fPec',saddleL:'fSad',saddleR:'fSad',capL:'fCap',capR:'fCap',
 shellL:'fShell',shellR:'fShell',tshellL:'fThigh',tshellR:'fThigh',toeL:'fToe',toeR:'fToe'}
/** on the way from one place to the other the heads swing out round the chest instead of going through it */
const VIA:Record<string,[number,number,number]>={rhead:[0,0.07,-0.13],ghead:[0,0.02,0.1]}

interface Part{name:string;gp:THREE.Vector3;gq:THREE.Quaternion;rp:THREE.Vector3;rq:THREE.Quaternion;m:THREE.Matrix4;group:Ch|null;via:THREE.Vector3|null}

const v0=new THREE.Vector3(),v1=new THREE.Vector3(),v2=new THREE.Vector3(),v3=new THREE.Vector3()
const X=new THREE.Vector3(),Y=new THREE.Vector3(),Z=new THREE.Vector3(),S=new THREE.Vector3(),E=new THREE.Vector3(),W=new THREE.Vector3(),DIR=new THREE.Vector3(),POLE=new THREE.Vector3()
const q0=new THREE.Quaternion(),q1=new THREE.Quaternion(),eu=new THREE.Euler(),ONE=new THREE.Vector3(1,1,1),m0=new THREE.Matrix4(),m1=new THREE.Matrix4()

export class Rig{
 readonly parts=new Map<string,Part>()
 readonly dims:Record<string,number>
 /** shoulder in the chest's frame and hip in the pelvis's frame (left side; mirror x for the right) */
 readonly shoulder=new THREE.Vector3()
 readonly hip=new THREE.Vector3()
 readonly upperArm:number;readonly forearm:number;readonly thigh:number;readonly shin:number

 constructor(data:RigData){
  this.dims=data.dims
  for(const d of data.parts){
   const via=VIA[d.name]
   this.parts.set(d.name,{name:d.name,gp:new THREE.Vector3().fromArray(d.g),gq:new THREE.Quaternion().fromArray(d.g,3),rp:new THREE.Vector3().fromArray(d.r),rq:new THREE.Quaternion().fromArray(d.r,3),
    m:new THREE.Matrix4(),group:GROUP[d.name]??null,via:via?new THREE.Vector3(...via):null})
  }
  this.shoulder.copy(this.part('upperArmL').gp)
  this.hip.copy(this.part('thighL').gp)
  this.upperArm=-this.part('forearmL').gp.y;this.forearm=-this.part('handL').gp.y
  this.thigh=-this.part('shinL').gp.y;this.shin=-this.part('footL').gp.y
 }

 part(name:string):Part{const p=this.parts.get(name);if(!p)throw new Error('gorilla-robo: the model has no part '+name);return p}
 matrix(name:string){return this.part(name).m}

 /** the part's own place in its parent, part-way between the gorilla's and the robot's */
 private local(p:Part,pose:Pose,out:THREE.Matrix4){
  const f=p.group?pose[p.group]:0
  v0.lerpVectors(p.gp,p.rp,f)
  if(p.via&&f>0&&f<1)v0.addScaledVector(p.via,Math.sin(Math.PI*f))
  q0.slerpQuaternions(p.gq,p.rq,f)
  return out.compose(v0,q0,ONE)
 }
 private child(name:string,parent:THREE.Matrix4,pose:Pose,rx=0,ry=0,rz=0){
  const p=this.part(name)
  this.local(p,pose,m0)
  if(rx||ry||rz)m0.multiply(m1.makeRotationFromEuler(eu.set(rx,ry,rz,'YXZ')))
  p.m.multiplyMatrices(parent,m0)
  return p.m
 }

 /** pelvis, abdomen and chest only (what a motion needs to place the hands relative to the chest) */
 spine(pose:Pose){
  const pelvis=this.part('pelvis')
  pelvis.m.compose(v0.set(pose.px,pose.py,pose.pz),q0.setFromEuler(eu.set(pose.ppitch,pose.pyaw,pose.proll,'YXZ')),ONE)
  const abdomen=this.child('abdomen',pelvis.m,pose,pose.apitch,pose.ayaw,pose.aroll)
  return this.child('chest',abdomen,pose,pose.cpitch,pose.cyaw,pose.croll)
 }
 /** a point given in the chest's frame (x is mirrored for the right side by the caller), in body space */
 chestPoint(pose:Pose,x:number,y:number,z:number,out:THREE.Vector3){return out.set(x,y,z).applyMatrix4(this.spine(pose))}

 solve(pose:Pose){
  const chest=this.spine(pose),pelvis=this.part('pelvis').m
  // the two heads: the look goes to whichever is the head at the moment
  const f=pose.fHead
  this.child('ghead',chest,pose,pose.hpitch*(1-f),pose.hyaw*(1-f),pose.hroll*(1-f))
  this.child('jaw',this.part('ghead').m,pose,pose.jaw)
  this.child('rhead',chest,pose,pose.hpitch*f,pose.hyaw*f,pose.hroll*f)
  for(const n of ['pecL','pecR','saddleL','saddleR'])this.child(n,chest,pose)
  this.arm('L',1,chest,pose)
  this.arm('R',-1,chest,pose)
  this.leg('L',1,pelvis,pose)
  this.leg('R',-1,pelvis,pose)
 }

 private arm(sd:'L'|'R',s:number,chest:THREE.Matrix4,pose:Pose){
  const l=sd==='L',l1=this.upperArm,l2=this.forearm
  S.set(this.shoulder.x*s,this.shoulder.y,this.shoulder.z).applyMatrix4(chest)
  W.set(l?pose.hlx:pose.hrx,l?pose.hly:pose.hry,l?pose.hlz:pose.hrz)
  POLE.set(l?pose.elx:pose.erx,l?pose.ely:pose.ery,l?pose.elz:pose.erz)
  bend(S,W,POLE,l1,l2,v3.set(0,0,-1))
  X.crossVectors(DIR,POLE)
  const upper=this.part('upperArm'+sd),fore=this.part('forearm'+sd),hand=this.part('hand'+sd)
  Y.subVectors(S,E).divideScalar(l1);Z.crossVectors(X,Y)
  upper.m.makeBasis(X,Y,Z).setPosition(S)
  Y.subVectors(E,W).divideScalar(l2);Z.crossVectors(X,Y)
  fore.m.makeBasis(X,Y,Z).setPosition(E)
  const tw=l?pose.twl:pose.twr
  if(tw)fore.m.multiply(m1.makeRotationY(tw))
  this.child('cap'+sd,upper.m,pose)
  this.child('shell'+sd,fore.m,pose)
  this.child('hand'+sd,fore.m,pose,l?pose.wfl:pose.wfr,0,l?pose.wdl:pose.wdr)
  this.child('fingers'+sd,hand.m,pose,l?pose.fgl:pose.fgr)
 }

 private leg(sd:'L'|'R',s:number,pelvis:THREE.Matrix4,pose:Pose){
  const l=sd==='L',l1=this.thigh,l2=this.shin
  S.set(this.hip.x*s,this.hip.y,this.hip.z).applyMatrix4(pelvis)
  W.set(l?pose.flx:pose.frx,l?pose.fly:pose.fry,l?pose.flz:pose.frz)
  POLE.set(l?pose.klx:pose.krx,l?pose.kly:pose.kry,l?pose.klz:pose.krz)
  bend(S,W,POLE,l1,l2,v3.set(0,0,1))
  X.crossVectors(POLE,DIR)
  const thigh=this.part('thigh'+sd),shin=this.part('shin'+sd),foot=this.part('foot'+sd)
  Y.subVectors(S,E).divideScalar(l1);Z.crossVectors(X,Y)
  thigh.m.makeBasis(X,Y,Z).setPosition(S)
  Y.subVectors(E,W).divideScalar(l2);Z.crossVectors(X,Y)
  shin.m.makeBasis(X,Y,Z).setPosition(E)
  foot.m.compose(W,q1.setFromEuler(eu.set(l?pose.fpl:pose.fpr,l?pose.fyl:pose.fyr,l?pose.fol:pose.for,'YXZ')),ONE)
  this.child('tshell'+sd,thigh.m,pose)
  this.child('toe'+sd,foot.m,pose)
 }
}

/**
 * Two bones from S to W (W is pulled in if it is out of reach). Leaves the middle joint in E, the unit vector S->W in DIR
 * and the unit vector towards the side the joint sticks out in POLE (perpendicular to DIR).
 */
function bend(s:THREE.Vector3,w:THREE.Vector3,pole:THREE.Vector3,l1:number,l2:number,fallback:THREE.Vector3){
 DIR.subVectors(w,s)
 let d=DIR.length()
 const max=l1+l2-0.002,min=Math.abs(l1-l2)+0.002
 if(d<1e-6){DIR.set(0,-1,0);d=min}else DIR.divideScalar(d)
 if(d>max||d<min){d=Math.min(max,Math.max(min,d));w.copy(s).addScaledVector(DIR,d)}
 pole.addScaledVector(DIR,-pole.dot(DIR))
 if(pole.lengthSq()<1e-8){pole.copy(fallback).addScaledVector(DIR,-fallback.dot(DIR));if(pole.lengthSq()<1e-8)pole.set(1,0,0).addScaledVector(DIR,-DIR.x)}
 pole.normalize()
 const a=(l1*l1-l2*l2+d*d)/(2*d),h=Math.sqrt(Math.max(0,l1*l1-a*a))
 E.copy(s).addScaledVector(DIR,a).addScaledVector(pole,h)
}
