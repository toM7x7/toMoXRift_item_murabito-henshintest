/**
 * Every motion is a function of time that writes a pose (rig.ts). There are no animation clips.
 *
 * The gorilla moves like an animal: it never quite stops, the weight rolls from limb to limb, and big moves are
 * followed by a settle. The robot moves like a machine: one joint group at a time, quick to start, dead still once
 * it gets there, with holds in between.
 *
 * Body space: the beast stands at the origin facing +Z, +X is its left, y = 0 is the ground. Lengths in metres.
 */
import * as THREE from 'three'
import type {Pose,Rig} from './rig'
import {copyPose,mixPose,newPose} from './rig'

export type Mode='gorilla'|'robot'
export type MotionName='gIdle'|'gWalk'|'gSit'|'gBeat'|'rIdle'|'rWalk'|'rScan'|'rSalute'|'rGuard'|'rPower'|'rWave'|'toRobot'|'toGorilla'
export type SitAct='none'|'belly'|'head'|'yawn'
export type SoundName='beat'|'thump'|'pad'|'clank'|'stomp'|'servo'|'lock'|'hoot'|'power'|'grunt'

export interface Ctx{
 rig:Rig
 /** shared clock, seconds (for things that just keep going, like breathing) */
 t:number
 /** seconds into this motion */
 ta:number
 /** +1 or -1: which hand does it */
 side:number
 /** where to look, relative to where the body faces */
 gazeYaw:number;gazePitch:number
 /** walking: where in the stride (0..1), how long the stride is (0..1) and how much the limbs lift (0..1) */
 phase:number;stride:number;step:number
 /** sitting: what it is doing with its hands, and how far into that (seconds) */
 sit:SitAct;sitT:number
}

const rad=(d:number)=>d*Math.PI/180
const c01=(x:number)=>x<0?0:x>1?1:x
/** soft start and stop */
const ease=(x:number)=>{x=c01(x);return x*x*(3-2*x)}
const stage=(u:number,a:number,b:number)=>ease((u-a)/(b-a))
/** a machine's move: quick, with a small overshoot that settles */
const mech=(u:number,a:number,b:number)=>{const x=c01((u-a)/(b-a)),k=x-1;return 1+2.2*k*k*k+1.2*k*k}
/** falls: slow at first, fastest at the end */
const fall=(u:number,a:number,b:number)=>{const x=c01((u-a)/(b-a));return x*x}
/** 0 -> 1 -> 0 between a and b */
const hump=(t:number,a:number,b:number)=>{const x=(t-a)/(b-a);return x>0&&x<1?Math.sin(Math.PI*x):0}
/** a knock at t0 that dies away */
const knock=(t:number,t0:number,decay:number,hz:number)=>t>t0?Math.exp(-(t-t0)/decay)*Math.cos((t-t0)*hz*2*Math.PI):0
const frac=(x:number)=>x-Math.floor(x)
const TAU=Math.PI*2

const tmp=new THREE.Vector3()

// x is given for the left side and mirrored for the right
function hand(p:Pose,s:number,x:number,y:number,z:number){if(s>0){p.hlx=x;p.hly=y;p.hlz=z}else{p.hrx=-x;p.hry=y;p.hrz=z}}
function elbow(p:Pose,s:number,x:number,y:number,z:number){if(s>0){p.elx=x;p.ely=y;p.elz=z}else{p.erx=-x;p.ery=y;p.erz=z}}
function foot(p:Pose,s:number,x:number,y:number,z:number){if(s>0){p.flx=x;p.fly=y;p.flz=z}else{p.frx=-x;p.fry=y;p.frz=z}}
function knee(p:Pose,s:number,x:number,y:number,z:number){if(s>0){p.klx=x;p.kly=y;p.klz=z}else{p.krx=-x;p.kry=y;p.krz=z}}
/** forearm twist, wrist bend, wrist tilt, finger curl */
function wrist(p:Pose,s:number,tw:number,wf:number,wd:number,fg:number){if(s>0){p.twl=tw;p.wfl=wf;p.wdl=wd;p.fgl=fg}else{p.twr=-tw;p.wfr=wf;p.wdr=-wd;p.fgr=fg}}
/** how a foot sits: toes out, toes down, rolled */
function sole(p:Pose,s:number,yaw:number,pitch:number,roll=0){if(s>0){p.fyl=yaw;p.fpl=pitch;p.fol=roll}else{p.fyr=-yaw;p.fpr=pitch;p.for=-roll}}
/** a hand placed relative to the chest (x for the left side), using the spine already written into p */
function chestHand(c:Ctx,p:Pose,s:number,x:number,y:number,z:number){
 c.rig.chestPoint(p,x*s,y,z,tmp)
 if(s>0){p.hlx=tmp.x;p.hly=tmp.y;p.hlz=tmp.z}else{p.hrx=tmp.x;p.hry=tmp.y;p.hrz=tmp.z}
}
function forms(p:Pose,f:number){p.fHead=p.fPec=p.fSad=p.fCap=p.fShell=p.fThigh=p.fToe=f}

const FIST=1.75,OPEN=0.3
/**
 * Forearm twist. At 0 the back of the hand faces into the bend of the elbow (knuckle walking, fists hanging at the sides);
 * at PALM_IN the palm does (a hand on its own chest, belly or head). Half-way the thumb is uppermost.
 */
const PALM_IN=2.9
/** the ankle's height over the ground for a rigid foot tipped onto its toes (pitch > 0) or its heel (pitch < 0), plus lift */
const ankleY=(pitch:number,lift=0)=>ANKLE*Math.cos(pitch)+(pitch>0?0.215:0.13)*Math.abs(Math.sin(pitch))+lift
/** wrist height when the knuckles are on the ground */
const KNUCKLE=0.186,ANKLE=0.11

// ---------------------------------------------------------------- gorilla

/** on all fours, weight on the knuckles */
export function gStand(p:Pose){
 forms(p,0)
 p.eye=1;p.visor=0;p.mouth=0;p.hue=0
 p.px=0;p.py=0.78;p.pz=-0.3;p.pyaw=0;p.ppitch=rad(62);p.proll=0
 p.ayaw=0;p.apitch=rad(8);p.aroll=0;p.cyaw=0;p.cpitch=rad(8);p.croll=0
 p.hyaw=0;p.hpitch=0;p.hroll=0;p.jaw=0
 for(const s of [1,-1]){
  hand(p,s,0.38,KNUCKLE,0.42);elbow(p,s,0.45,0.1,-1);wrist(p,s,0,0,0,FIST)
  foot(p,s,0.21,ANKLE,-0.3);knee(p,s,0.5,0,1);sole(p,s,0.3,0)
 }
}

/**
 * The gorilla's head is set on the chest for walking on all fours. When the body comes upright the head has to
 * nod forward by as much, or it would stare at the sky. `down` is how far below level the face should point.
 */
function gHead(p:Pose,down=rad(15)){p.hpitch=down-(p.ppitch+p.apitch+p.cpitch-rad(63))}

/** breathing, a slow shift of weight, and the eyes going where it looks */
function alive(p:Pose,c:Ctx,amount=1){
 const b=Math.sin(c.t*TAU*0.31)
 p.cpitch-=rad(1.1)*b*amount
 p.py+=0.004*b*amount
 p.px+=0.012*Math.sin(c.t*TAU*0.07+1.3)*amount
 p.hyaw+=c.gazeYaw
 p.hpitch+=c.gazePitch
}

export function gIdle(p:Pose,c:Ctx){
 gStand(p)
 alive(p,c)
 // the head follows; past a point the shoulders come round a little too
 p.croll-=c.gazeYaw*0.12
}

/**
 * Knuckle walk. A diagonal-sequence gait like the great apes use: left hind, right fore, right hind, left fore.
 * The arm is a stiff strut while it carries weight (the shoulder rides up over it), the hind legs stay bent
 * and the feet come down heel first.
 */
export function gWalk(p:Pose,c:Ctx){
 gStand(p)
 const ph=c.phase,w=c.stride,sw=c.step,L=0.9
 for(const s of [1,-1]){
  // hind
  let u=frac(ph-(s>0?0:0.5)),duty=0.66,A=L*duty*w
  if(u<duty){
   u/=duty
   const strike=u<0.14?1-u/0.14:0,off=u>0.72?(u-0.72)/0.28:0
   const pitch=(-0.2*strike+0.45*off*off)*sw
   foot(p,s,0.2,ankleY(pitch),-0.28+A*(0.5-u))
   sole(p,s,0.3,pitch)
  }else{
   u=(u-duty)/(1-duty)
   const pitch=(0.45*(1-u)*(1-u)-0.2*u*u)*sw
   foot(p,s,0.2,ankleY(pitch,0.07*Math.sin(Math.PI*u)*sw),-0.28+A*(-0.5+ease(u)))
   sole(p,s,0.3,pitch)
  }
  // fore
  u=frac(ph-(s>0?0.58:0.08));duty=0.62;A=L*duty*w
  if(u<duty){
   u/=duty
   hand(p,s,0.37,KNUCKLE,0.42+A*(0.5-u))
   wrist(p,s,0,0,0,FIST)
  }else{
   u=(u-duty)/(1-duty)
   const lift=Math.sin(Math.PI*u)
   hand(p,s,0.37-0.03*lift,KNUCKLE+0.13*Math.pow(lift,0.8)*sw,0.42+A*(-0.5+ease(u)))
   // the hand hangs loose while it swings and stiffens just before it lands
   wrist(p,s,0,0.7*Math.sin(Math.PI*Math.min(1,u*1.25))*sw,0,FIST-0.45*lift*sw)
  }
 }
 // the hips sink a little as each hind foot takes the weight, and swing with the hind legs
 p.py+=(-0.012*Math.cos(2*TAU*(ph-0.12)))*sw
 p.px+=0.02*Math.cos(TAU*(ph-0.33))*sw
 p.pyaw=-0.07*Math.cos(TAU*ph)*w
 p.proll=0.035*Math.sin(TAU*(ph-0.08))*sw
 p.ppitch+=rad(1.5)*Math.sin(2*TAU*ph)*sw
 // the shoulder over the arm that carries the weight rides high; the chest swings the other way from the hips
 const rock=Math.cos(TAU*(ph-0.89))
 p.ayaw=0.035*rock*sw;p.cyaw=0.05*rock*sw
 p.croll=-(0.05*Math.cos(TAU*(ph-0.08))*w-p.pyaw)*0.5
 p.aroll=p.croll*0.6
 // the head stays level and nods a little
 p.hyaw=c.gazeYaw-0.5*(p.pyaw)
 p.hroll=-0.06*rock*sw
 p.hpitch=c.gazePitch+rad(2)*Math.cos(2*TAU*(ph-0.2))*sw
}

/** sitting on its rump, knees up and apart, hands over the knees */
function gSeat(p:Pose,c:Ctx){
 gStand(p)
 p.py=0.21;p.pz=-0.14;p.ppitch=rad(-14);p.apitch=rad(14);p.cpitch=rad(14)
 for(const s of [1,-1]){
  foot(p,s,0.31,ANKLE,0.3);knee(p,s,1,0.75,0.5);sole(p,s,0.55,0)
  hand(p,s,0.47,0.57,0.04);elbow(p,s,1,-0.3,-0.55);wrist(p,s,0,0.85,0,0.7)
 }
 gHead(p,rad(8))
}

export function gSit(p:Pose,c:Ctx){
 gSeat(p,c)
 alive(p,c,1.4)
 const s=c.side,t=c.sitT
 if(c.sit==='belly'){
  // one hand comes over and scratches the belly; it watches its hand
  const k=ease(t/0.7)*(1-ease((t-3.0)/0.6)),scr=Math.sin(t*TAU*4.2)
  if(k>0){
   c.rig.chestPoint(p,s*0.2,-0.14+0.035*scr,0.29,tmp)
   mixHand(p,s,tmp,k)
   elbowMix(p,s,1,-0.5,0.1,k)
   wristMix(p,s,PALM_IN,0.45,0,0.8+0.35*scr,k)
   p.hpitch+=0.5*k;p.hyaw=p.hyaw*(1-k)+s*0.15*k
   p.cpitch+=rad(4)*k
  }
 }else if(c.sit==='head'){
  // elbow high, fingers working at the top of its head
  const k=ease(t/0.8)*(1-ease((t-3.0)/0.7)),scr=Math.sin(t*TAU*4.6)
  if(k>0){
   c.rig.chestPoint(p,s*(0.25+0.02*scr),0.8,0.2+0.02*scr,tmp)
   mixHand(p,s,tmp,k)
   elbowMix(p,s,1,0.7,0.1,k)
   wristMix(p,s,PALM_IN,0.75,0,0.7+0.4*scr,k)
   p.hroll+=s*-0.22*k;p.hpitch+=0.12*k;p.hyaw*=1-0.7*k
  }
 }else if(c.sit==='yawn'){
  // a wide yawn: the head tips back, the mouth opens all the way, then a shake of the head
  const open=ease(t/0.9)*(1-ease((t-2.0)/0.7))
  p.jaw=0.85*open
  p.mouth=open
  p.eye=1-0.75*open
  p.hpitch-=0.45*open;p.hyaw*=1-open
  p.cpitch-=rad(6)*open;p.apitch-=rad(3)*open
  p.hyaw+=0.2*knock(t,2.75,0.25,3.4)
 }
}

const hm=new THREE.Vector3()
function mixHand(p:Pose,s:number,to:THREE.Vector3,k:number){
 if(s>0){p.hlx+=(to.x-p.hlx)*k;p.hly+=(to.y-p.hly)*k;p.hlz+=(to.z-p.hlz)*k}else{p.hrx+=(to.x-p.hrx)*k;p.hry+=(to.y-p.hry)*k;p.hrz+=(to.z-p.hrz)*k}
}
function elbowMix(p:Pose,s:number,x:number,y:number,z:number,k:number){
 if(s>0){p.elx+=(x-p.elx)*k;p.ely+=(y-p.ely)*k;p.elz+=(z-p.elz)*k}else{p.erx+=(-x-p.erx)*k;p.ery+=(y-p.ery)*k;p.erz+=(z-p.erz)*k}
}
function wristMix(p:Pose,s:number,tw:number,wf:number,wd:number,fg:number,k:number){
 if(s>0){p.twl+=(tw-p.twl)*k;p.wfl+=(wf-p.wfl)*k;p.wdl+=(wd-p.wdl)*k;p.fgl+=(fg-p.fgl)*k}
 else{p.twr+=(-tw-p.twr)*k;p.wfr+=(wf-p.wfr)*k;p.wdr+=(-wd-p.wdr)*k;p.fgr+=(fg-p.fgr)*k}
}

/** up on its hind legs, chest out, hands open in front of the chest */
export function gRise(p:Pose,c:Ctx){
 gStand(p)
 p.py=0.8;p.pz=-0.03;p.ppitch=rad(-3);p.apitch=rad(-4);p.cpitch=rad(-8)
 for(const s of [1,-1]){
  foot(p,s,0.26,ANKLE,-0.03);knee(p,s,0.7,0,1);sole(p,s,0.45,0)
  chestHand(c,p,s,0.44,0.2,0.46);elbow(p,s,1,-0.3,-0.25);wrist(p,s,PALM_IN,0.2,0,OPEN)
 }
 gHead(p,rad(-14))
}
/**
 * Worn, the wearer's hands up: rises onto its hind legs (by k) and its hands go where the wearer's are, given in the
 * chest's frame (metres, +X its left). null leaves that hand where gRise has it.
 */
export function gReach(p:Pose,c:Ctx,k:number,left:THREE.Vector3|null,right:THREE.Vector3|null){
 gStand(A)
 gRise(B,c)
 for(const [s,h] of [[1,left],[-1,right]] as const){
  if(!h)continue
  c.rig.chestPoint(B,h.x,h.y,h.z,hm)
  mixHand(B,s,hm,1)
  elbowMix(B,s,1,-0.6,-0.4,1)
  wristMix(B,s,PALM_IN*0.6,0.2,0,OPEN,1)
 }
 mixPose(p,A,B,k)
 p.hyaw+=c.gazeYaw;p.hpitch+=c.gazePitch*(1-0.5*k)
}
export const BEAT={dur:4.3,up:0.9,first:1.0,rate:8,count:14,drop:2.85,land:3.3}

/**
 * The chest-beating display: three hoots, up on the hind legs, open cupped hands drumming on the chest in turn
 * (about 8 beats a second), then down onto the knuckles with a thump.
 */
export function gBeat(p:Pose,c:Ctx){
 const t=c.ta
 gStand(A)
 gRise(B,c)
 const up=ease(t/BEAT.up),down=fall(t,BEAT.drop,BEAT.land)
 mixPose(p,A,B,up*(1-down))
 // hooting first, lips pushed forward
 p.jaw=0.13*(hump(t,0.1,0.32)+hump(t,0.36,0.58)+hump(t,0.62,0.84))
 const beating=ease((t-BEAT.up)/0.12)*(1-ease((t-(BEAT.first+BEAT.count/BEAT.rate))/0.12))
 if(beating>0&&down<1){
  for(const s of [1,-1]){
   // each hand strikes four times a second, half a beat apart
   const ph=(t-BEAT.first)*BEAT.rate/2+(s>0?0.5:0)
   const k=Math.pow(0.5+0.5*Math.cos(TAU*ph),2.4)*beating
   c.rig.chestPoint(p,s*0.3,0.27,0.29,hm)
   mixHand(p,s,hm,k)
   wristMix(p,s,PALM_IN,0.3,0,OPEN+0.15,k)
  }
  const d=(t-BEAT.first)*BEAT.rate
  p.py+=0.005*Math.cos(TAU*d)*beating
  p.cyaw+=0.035*Math.sin(TAU*d/2)*beating
  p.hyaw+=0.07*Math.sin(TAU*d/2+1)*beating
  p.jaw+=0.3*ease((t-1.5)/0.3)*beating
  p.mouth=p.jaw
 }
 // landing: the arms take the weight, the body sinks and comes back, the head shakes it off
 p.py-=0.045*knock(t,BEAT.land,0.16,2.2)*(t>BEAT.land?1:0)
 p.ppitch+=rad(4)*knock(t,BEAT.land,0.18,2.2)*(t>BEAT.land?1:0)
 p.hyaw+=0.16*knock(t,BEAT.land+0.25,0.22,3.6)
 p.hyaw+=c.gazeYaw*(1-up*(1-down));p.hpitch+=c.gazePitch*(1-up*(1-down))
}
const A=newPose(),B=newPose(),C=newPose(),D=newPose()

// ---------------------------------------------------------------- robot

/** upright, feet apart, arms a little out from the body, fists closed */
export function rStand(p:Pose){
 forms(p,1)
 p.eye=0.7;p.visor=1;p.mouth=0;p.hue=1
 p.px=0;p.py=0.937;p.pz=0;p.pyaw=0;p.ppitch=0;p.proll=0
 p.ayaw=0;p.apitch=0;p.aroll=0;p.cyaw=0;p.cpitch=0;p.croll=0
 p.hyaw=0;p.hpitch=0;p.hroll=0;p.jaw=0
 for(const s of [1,-1]){
  hand(p,s,0.6,0.83,0.08);elbow(p,s,1,0,-0.75);wrist(p,s,R_TWIST,0,0,FIST)
  foot(p,s,0.2,ANKLE,0);knee(p,s,0.18,0,1);sole(p,s,0.16,0)
 }
}
const R_TWIST=0

/** holds still; every so often it re-sets its weight or its arms in one short move */
export function rIdle(p:Pose,c:Ctx){
 rStand(p)
 // a new stance every 3.4 s, reached in 0.35 s and then held
 const k=Math.floor(c.t/3.4),u=(c.t/3.4-k)*3.4
 const h=(n:number)=>{const x=Math.sin(n*127.1+311.7)*43758.5453;return x-Math.floor(x)}
 const a0=h(k-1)*2-1,a1=h(k)*2-1,m=mech(u,0,0.35),lean=a0+(a1-a0)*m
 p.px=0.022*lean;p.proll=-0.012*lean;p.croll=0.018*lean
 const b0=h(k+40.5)*2-1,b1=h(k+41.5)*2-1,arm=b0+(b1-b0)*mech(u,0.5,0.8)
 for(const s of [1,-1]){
  hand(p,s,0.57+0.02*arm*s,0.84+0.012*arm,0.07+0.03*arm*s)
 }
 p.visor=0.92+0.08*Math.sin(c.t*TAU*0.45)
 p.hyaw=c.gazeYaw;p.hpitch=c.gazePitch
 p.cyaw=c.gazeYaw*0.18
}

/** a heavy march: flat-footed, the body dropping onto each step, arms swinging against the legs */
export function rWalk(p:Pose,c:Ctx){
 rStand(p)
 const ph=c.phase,w=c.stride,sw=c.step,L=1.0,duty=0.6
 let dip=0
 for(const s of [1,-1]){
  let u=frac(ph-(s>0?0:0.5))
  const A=L*duty*w
  if(u<duty){
   dip+=Math.exp(-u/0.09)
   u/=duty
   const strike=u<0.16?1-u/0.16:0,off=u>0.7?(u-0.7)/0.3:0
   const pitch=(-0.24*strike+0.42*off*off)*sw
   foot(p,s,0.19,ankleY(pitch),A*(0.5-u))
   sole(p,s,0.16,pitch)
  }else{
   u=(u-duty)/(1-duty)
   const pitch=(0.42*(1-u)*(1-u)-0.24*u*u)*sw
   foot(p,s,0.19,ankleY(pitch,0.1*Math.sin(Math.PI*u)*sw),A*(-0.5+ease(u)))
   sole(p,s,0.16,pitch)
  }
  // the arm on the side of the leading foot goes back
  const sw2=Math.cos(TAU*ph)*s
  hand(p,s,0.55,0.87+0.03*Math.abs(sw2)*w,0.08-0.2*sw2*w)
 }
 p.py=0.925-0.012*w+0.012*Math.cos(2*TAU*(ph-0.3))*sw-0.016*dip*sw
 p.px=0.032*Math.cos(TAU*(ph-0.3))*sw
 p.proll=-0.03*Math.cos(TAU*(ph-0.3))*sw
 p.pyaw=-0.09*Math.cos(TAU*ph)*w
 const twist=0.07*Math.cos(TAU*ph)*w
 p.ayaw=twist;p.cyaw=twist
 p.ppitch=rad(3)*w
 p.hyaw=c.gazeYaw-(p.pyaw+2*twist);p.hpitch=c.gazePitch
}

export const SCAN={dur:4.2}
/** looks for something: the body turns one way, holds, then the other, with a hand up to shade the visor */
export function rScan(p:Pose,c:Ctx){
 rStand(p)
 const t=c.ta,s=c.side
 const up=mech(t,0.1,0.55)*(1-mech(t,3.4,3.9))
 const turn=mech(t,0.5,0.95)-2*mech(t,1.8,2.35)+mech(t,3.2,3.7)
 p.cyaw=0.22*turn*s;p.ayaw=0.14*turn*s
 p.hyaw=0.55*turn*s
 p.hpitch=-0.05*up
 chestMix(c,p,s,0.29,0.7,0.24,up)
 elbowMix(p,s,1,0.2,0.1,up)
 wristMix(p,s,PALM_IN,0.1,0,0.2,up)
 // the visor sweeps while it looks
 p.visor=1+0.5*up*Math.abs(Math.sin(t*TAU*1.6))
}
function chestMix(c:Ctx,p:Pose,s:number,x:number,y:number,z:number,k:number){
 c.rig.chestPoint(p,x*s,y,z,hm)
 mixHand(p,s,hm,k)
}

export const SALUTE={dur:2.9,hit:0.62}
/** a fist to the chest crest: the robot's answer to the gorilla's drumming. One clean strike, held. */
export function rSalute(p:Pose,c:Ctx){
 rStand(p)
 const t=c.ta,s=c.side
 const back=mech(t,0.05,0.4),strike=fall(t,0.44,SALUTE.hit),ret=mech(t,2.2,2.75)
 const k=(back*0.35+strike*0.65)*(1-ret)
 // wind up outwards, then in
 chestMix(c,p,s,0.25+0.3*back*(1-strike),0.24,0.36+0.12*back*(1-strike),k)
 elbowMix(p,s,1,-0.45,-0.15,k)
 wristMix(p,s,PALM_IN,0.15,0,FIST,k)
 const hit=knock(t,SALUTE.hit,0.09,5)
 p.cpitch=-rad(1.6)*hit
 p.py-=0.006*hit
 p.eye=0.7+1.6*Math.exp(-Math.max(0,t-SALUTE.hit)/0.35)*(t>SALUTE.hit?1:0)
 p.hpitch=c.gazePitch*(1-k)+0.16*mech(t,0.95,1.2)*(1-mech(t,1.75,2.0))
 p.hyaw=c.gazeYaw*(1-k*0.6)
}

export const GUARD={dur:3.6}
/** both forearms up in front, shields forward, weight low */
export function rGuard(p:Pose,c:Ctx){
 rStand(p)
 const t=c.ta
 const k=mech(t,0.1,0.5)*(1-mech(t,2.9,3.4))
 p.py-=0.075*k;p.ppitch=rad(7)*k;p.cpitch=rad(4)*k
 for(const s of [1,-1]){
  knee(p,s,0.18+0.3*k,0,1)
  chestMix(c,p,s,0.15,0.44,0.36,k)
  elbowMix(p,s,0.75,-1,0.1,k)
  wristMix(p,s,GUARD_TWIST,0,0,FIST,k)
 }
 // a shove forward half-way through, as if taking a blow
 const shove=knock(t,1.5,0.14,3)
 p.pz=0.02*k-0.025*shove;p.cpitch+=rad(2.5)*shove
 p.hpitch=0.1*k;p.hyaw=c.gazeYaw*(1-k)
}
const GUARD_TWIST=PALM_IN

export const POWER={dur:3.8,roar:1.15}
/** charges up: knees bent, arms flexed out to the sides, and the gorilla face on the chest roars */
export function rPower(p:Pose,c:Ctx){
 rStand(p)
 const t=c.ta
 const k=mech(t,0.1,0.55)*(1-mech(t,3.0,3.6))
 const roar=ease((t-POWER.roar)/0.25)*(1-ease((t-2.75)/0.4))
 const shake=Math.sin(t*TAU*17)*roar
 p.py-=0.1*k-0.004*shake;p.ppitch=rad(4)*k;p.cpitch=-rad(9)*k*(0.6+0.4*roar)
 for(const s of [1,-1]){
  foot(p,s,0.2,ANKLE,0);knee(p,s,0.18+0.45*k,0,1)
  chestMix(c,p,s,0.56,0.5-0.05*roar,0.1,k)
  elbowMix(p,s,1,-0.6,-0.25,k)
  wristMix(p,s,PALM_IN,0.35,0,FIST,k)
 }
 p.jaw=0.8*roar;p.mouth=1.6*roar
 p.eye=0.7+2.2*roar;p.visor=1+1.2*roar
 p.hpitch=-0.22*roar;p.hyaw=c.gazeYaw*(1-k)
 p.cyaw=0.012*shake
}

export const WAVE={dur:3.0}
/** an open hand raised to whoever is there */
export function rWave(p:Pose,c:Ctx){
 rStand(p)
 const t=c.ta,s=c.side
 const k=mech(t,0.1,0.5)*(1-mech(t,2.35,2.85))
 const wv=Math.sin((t-0.5)*TAU*1.5)*ease((t-0.5)/0.2)*(1-ease((t-2.2)/0.2))
 chestMix(c,p,s,0.56+0.07*wv,0.62,0.18,k)
 elbowMix(p,s,1,-0.7,-0.1,k)
 wristMix(p,s,PALM_IN*0.5,0,0.3*wv,0.12,k)
 p.hyaw=c.gazeYaw;p.hpitch=c.gazePitch-0.04*k
 p.croll=-0.03*k*s
}

// ---------------------------------------------------------------- transforming

export const TO_ROBOT=3.6,TO_GORILLA=3.3

/** the robot's arms held out from the body while things move round them */
function rOpen(p:Pose){
 rStand(p)
 for(const s of [1,-1]){hand(p,s,0.7,0.9,0.1);elbow(p,s,1,0.1,-0.5)}
}
/** up on straightening legs with the arms hanging: half-way between the two */
function half(p:Pose,c:Ctx){
 gStand(p)
 p.py=0.86;p.pz=-0.02;p.ppitch=rad(4);p.apitch=rad(2);p.cpitch=rad(-2)
 for(const s of [1,-1]){
  foot(p,s,0.21,ANKLE,-0.01);knee(p,s,0.4,0,1);sole(p,s,0.22,0)
  chestHand(c,p,s,0.5,-0.36,0.2);elbow(p,s,1,0,-0.6);wrist(p,s,0.4,0,0,1.0)
 }
 gHead(p,rad(-6))
}

/**
 * Gorilla -> robot. It rears up and straightens, then the parts go one group at a time, each with its own start and stop:
 * heel spurs, thigh fur to the skirts, chest plates apart, the heads swap (the gorilla's goes down onto the chest as the
 * helmet comes up out of the hump), the silver back opens into wings, shoulder fur lifts, forearm fur turns into shields.
 */
export function toRobot(p:Pose,c:Ctx){
 const u=c.ta/TO_ROBOT
 gStand(A);half(B,c);rOpen(C);rStand(D)
 mixPose(p,A,B,ease(u/0.2))
 mixPose(p,p,C,stage(u,0.16,0.42))
 mixPose(p,p,D,mech(u,0.86,0.97))
 p.fToe=mech(u,0.2,0.34)
 p.fThigh=mech(u,0.27,0.43)
 p.fPec=mech(u,0.38,0.5)
 p.fHead=stage(u,0.44,0.68)
 p.fSad=mech(u,0.6,0.78)
 p.fCap=mech(u,0.66,0.8)
 p.fShell=mech(u,0.72,0.86)
 // each group knocks the body a little as it locks
 let j=0
 for(const t0 of [0.34,0.43,0.5,0.68,0.78,0.8,0.86])j+=knock(u,t0,0.012,9)
 p.py+=0.006*j;p.cpitch+=rad(0.8)*j
 // the gorilla's head keeps looking ahead as the body comes upright, and lets go as it swings down onto the chest
 gHead(p,rad(15)*(1-ease(u/0.3)));p.hpitch*=1-p.fHead
 p.hyaw=0
 // the light leaves the gorilla's eyes for the visor
 p.hue=stage(u,0.5,0.7)
 p.eye=1-0.7*stage(u,0.44,0.56)+0.4*stage(u,0.66,0.8)
 p.visor=stage(u,0.67,0.7)*(1+2.2*Math.exp(-Math.max(0,u-0.7)/0.05))
 // last, the arms snap out and down
 const flex=hump(u,0.84,0.97)
 p.cpitch-=rad(5)*flex
 p.mouth=0
}

/**
 * Robot -> gorilla, in the opposite order: shields, shoulders and wings fold back, the heads swap, the chest closes,
 * then it tips forward and drops onto its knuckles, and shakes itself.
 */
export function toGorilla(p:Pose,c:Ctx){
 const u=c.ta/TO_GORILLA
 rStand(A);rOpen(B);half(C,c);gStand(D)
 mixPose(p,A,B,mech(u,0.0,0.1))
 mixPose(p,p,C,stage(u,0.5,0.7))
 mixPose(p,p,D,fall(u,0.68,0.83))
 p.fShell=1-mech(u,0.04,0.18)
 p.fCap=1-mech(u,0.1,0.24)
 p.fSad=1-mech(u,0.14,0.32)
 p.fHead=1-stage(u,0.26,0.5)
 p.fPec=1-mech(u,0.44,0.56)
 p.fThigh=1-mech(u,0.5,0.64)
 p.fToe=1-mech(u,0.56,0.68)
 let j=0
 for(const t0 of [0.18,0.24,0.32,0.5,0.56,0.64])j+=knock(u,t0,0.012,9)
 p.py+=0.006*j
 p.hue=1-stage(u,0.3,0.5)
 p.visor=1-stage(u,0.26,0.3)
 p.eye=0.7-0.4*stage(u,0.26,0.36)+0.7*stage(u,0.46,0.56)
 // down onto the knuckles, then a shake from the shoulders to the head
 const land=0.83
 p.py-=0.05*knock(u,land,0.045,0.72)*(u>land?1:0)
 p.ppitch+=rad(4)*knock(u,land,0.05,0.72)*(u>land?1:0)
 const shake=hump(u,0.87,0.99)*Math.sin((u-0.87)*TO_GORILLA*TAU*5.5)
 gHead(p,rad(15)*fall(u,0.68,0.83));p.hpitch*=1-p.fHead
 p.cyaw+=0.06*shake;p.hroll=0.2*shake;p.hyaw=0.1*shake
 p.mouth=0;p.jaw=0.18*hump(u,0.86,0.96)
}

export const MOTIONS:Record<MotionName,(p:Pose,c:Ctx)=>void>={gIdle,gWalk,gSit,gBeat,rIdle,rWalk,rScan,rSalute,rGuard,rPower,rWave,toRobot,toGorilla}
/** how long the timed ones last */
export const DURATION:Partial<Record<MotionName,number>>={gBeat:BEAT.dur,rScan:SCAN.dur,rSalute:SALUTE.dur,rGuard:GUARD.dur,rPower:POWER.dur,rWave:WAVE.dur,toRobot:TO_ROBOT,toGorilla:TO_GORILLA}

/** sounds: [seconds into the motion, what, how loud] */
export const SOUNDS:Partial<Record<MotionName,[number,SoundName,number][]>>={
 gBeat:[[0.12,'hoot',0.7],[0.38,'hoot',0.8],[0.64,'hoot',0.9],
  ...Array.from({length:BEAT.count},(_,i)=>[BEAT.first+i/BEAT.rate,'beat',0.75+0.25*Math.min(1,i/5)] as [number,SoundName,number]),
  [BEAT.land,'thump',1],[BEAT.land+0.3,'grunt',0.7]],
 rScan:[[0.1,'servo',0.5],[0.5,'servo',0.4],[1.8,'servo',0.5],[3.2,'servo',0.4]],
 rSalute:[[0.05,'servo',0.5],[SALUTE.hit,'clank',1]],
 rGuard:[[0.1,'servo',0.7],[0.5,'lock',0.8],[1.5,'clank',0.6],[2.9,'servo',0.5]],
 rPower:[[0.1,'servo',0.7],[POWER.roar,'power',1],[3.0,'servo',0.5]],
 rWave:[[0.1,'servo',0.4]],
 toRobot:[[0,'grunt',0.6],[0.2*TO_ROBOT,'servo',0.8],[0.34*TO_ROBOT,'lock',0.6],[0.43*TO_ROBOT,'lock',0.7],[0.38*TO_ROBOT,'servo',0.7],[0.5*TO_ROBOT,'lock',0.8],
  [0.44*TO_ROBOT,'servo',1],[0.68*TO_ROBOT,'lock',1],[0.6*TO_ROBOT,'servo',0.8],[0.78*TO_ROBOT,'lock',0.8],[0.8*TO_ROBOT,'lock',0.7],[0.86*TO_ROBOT,'lock',0.9],[0.7*TO_ROBOT,'power',0.6],[0.95*TO_ROBOT,'stomp',0.7]],
 toGorilla:[[0.04*TO_GORILLA,'servo',0.8],[0.18*TO_GORILLA,'lock',0.7],[0.24*TO_GORILLA,'lock',0.7],[0.14*TO_GORILLA,'servo',0.7],[0.32*TO_GORILLA,'lock',0.8],
  [0.26*TO_GORILLA,'servo',1],[0.5*TO_GORILLA,'lock',1],[0.56*TO_GORILLA,'lock',0.7],[0.64*TO_GORILLA,'lock',0.6],[0.83*TO_GORILLA,'thump',1],[0.9*TO_GORILLA,'grunt',0.9]],
}

export {copyPose,mixPose,newPose}
