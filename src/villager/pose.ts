import type {Pose} from './rig'

/**
 * One-off movements, each written straight onto the pose the actor is building (which starts as standing at ease).
 * ta = seconds since it began. Each fades itself in and out.
 */
export type GestureName='wave'|'bow'|'talk'|'stretch'|'scratch'|'hips'|'sky'|'clasp'|'neck'
export interface Gesture{name:GestureName;t0:number;dur:number;side:1|-1;key:number}
export const GESTURE_DUR:Record<Exclude<GestureName,'talk'>,number>={wave:2.7,bow:2.5,stretch:4.4,scratch:3.2,hips:6.4,sky:4.4,clasp:6.6,neck:3.6}

const clamp01=(x:number)=>Math.min(1,Math.max(0,x))
const ss=(a:number,b:number,x:number)=>{const t=clamp01((x-a)/(b-a));return t*t*(3-2*t)}
/** 0 -> 1 over `rise` seconds, back to 0 over the last `fall` seconds */
const env=(ta:number,dur:number,rise:number,fall:number)=>ss(0,rise,ta)*(1-ss(dur-fall,dur,ta))

interface Arm{o:number;u:number;f:number;r:number;e:number;t:number;wf:number;ws:number}
const ARM_KEYS=['o','u','f','r','e','t','wf','ws'] as const
/**
 * Move one arm towards these numbers by k (side 1 = left). The elbow and the forearm lead and the upper arm follows,
 * so the hand comes up close to the body instead of swinging out at arm's length (and goes down the same way).
 */
function arm(p:Pose,side:1|-1,a:Partial<Arm>,k:number){
 const pre=side>0?'l':'r'
 const lead=1-(1-k)*(1-k),lag=k*k
 for(const key of ARM_KEYS){
  const v=a[key]
  if(v===undefined)continue
  const name=(pre+key) as keyof Pose
  p[name]+=(v-p[name])*(key==='e'||key==='t'||key==='wf'||key==='ws'?lead:lag)
 }
}

/** how wide the mouth is while he speaks: one flap per syllable */
export const SYLLABLE=0.13
export const talkTime=(chars:number)=>0.35+chars*SYLLABLE+0.9

export function applyGesture(p:Pose,g:Gesture,t:number,chars=0){
 const ta=t-g.t0,d=g.dur,s=g.side
 if(ta<0||ta>d)return
 switch(g.name){
  case 'wave':{
   // elbow down, hand up beside the face, palm forward; the forearm rocks from the elbow
   const k=env(ta,d,0.5,0.55)
   const w=Math.sin((ta-0.45)*Math.PI*2*2.3)*ss(0.4,0.7,ta)*(1-ss(d-0.75,d-0.45,ta))
   arm(p,s,{o:0.55,u:-0.55,f:0.5,r:-0.9+0.22*w,e:2.0+0.12*w,t:1.3,wf:0.0,ws:0.14*w},k)
   p.hr+=0.06*s*k;p.sr+=0.025*s*k;p.hp+=-0.04*k
   break
  }
  case 'bow':{
   // from the hips, back straight, hands at the sides
   const k=ss(0,0.55,ta)*(1-ss(d-0.85,d,ta))
   p.pp+=0.3*k;p.sp+=0.3*k;p.hp+=0.12*k;p.pz+=-0.075*k;p.py+=-0.01*k
   arm(p,1,{f:-0.22,o:0.1},k);arm(p,-1,{f:-0.22,o:0.1},k)
   break
  }
  case 'talk':{
   // one hand comes up, palm up, and beats along; the jaw flaps once per syllable while there are any left
   const k=env(ta,d,0.4,0.6)
   const speak=ss(0.3,0.4,ta)*(1-ss(0.35+chars*SYLLABLE,0.45+chars*SYLLABLE,ta))
   const beat=Math.sin(ta*Math.PI*2*1.35)
   arm(p,s,{o:0.3,u:-0.82,f:0.42,r:0.15,e:1.25+0.14*beat,t:0.25,wf:-0.1+0.1*beat,ws:0},k*0.9)
   p.jaw+=0.07*speak*(0.35+0.65*Math.abs(Math.sin((ta-0.35)*Math.PI/SYLLABLE)))
   p.hp+=0.035*beat*speak+0.16*ss(d-0.75,d-0.5,ta)*(1-ss(d-0.4,d-0.1,ta))
   p.hr+=0.03*s*k
   break
  }
  case 'stretch':{
   // hands on the small of the back, leaning back
   const k=env(ta,d,0.9,1.0)
   const reach=ss(1.0,1.9,ta)*(1-ss(d-1.6,d-0.9,ta))
   for(const side of [1,-1] as const)arm(p,side,{o:0.5,u:-0.8,f:-0.45,r:1.3,e:1.7,t:1.6,wf:0.4,ws:0},k)
   p.sp+=-0.05*k-0.12*reach;p.hp+=-0.06*k-0.16*reach;p.pz+=0.03*reach;p.pp+=-0.03*reach
   break
  }
  case 'scratch':{
   // a hand to the back of the head
   const k=env(ta,d,0.6,0.7)
   const w=Math.sin(ta*Math.PI*2*3.1)*ss(0.6,0.9,ta)*(1-ss(d-1.0,d-0.7,ta))
   arm(p,s,{o:0.7,u:0.3,f:0.4,r:-1.7,e:2.3+0.06*w,t:1.5,wf:0.25+0.12*w,ws:0},k)
   p.hp+=0.1*k;p.hr+=-0.06*s*k;p.hy+=-0.1*s*k
   break
  }
  case 'hips':{
   // hands on the hips, a look round
   const k=env(ta,d,0.7,0.8)
   for(const side of [1,-1] as const)arm(p,side,{o:0.62,u:-0.74,f:-0.2,r:0.95,e:1.55,t:1.6,wf:0.5,ws:0},k)
   p.sp+=-0.03*k
   p.hy+=0.45*Math.sin((ta-0.8)*0.9)*ss(0.8,1.6,ta)*k
   break
  }
  case 'sky':{
   // looks up at the sky, a hand shading the eyes
   const k=env(ta,d,0.8,0.9)
   arm(p,s,{o:0.5,u:0.42,f:0.75,r:-0.55,e:2.1,t:1.75,wf:0.1,ws:0},k)
   p.hp+=-0.36*k;p.sp+=-0.06*k;p.hy+=0.2*s*k
   break
  }
  case 'clasp':{
   // hands together in front of him
   const k=env(ta,d,0.8,0.9)
   arm(p,1,{o:0.2,u:-0.9,f:0.35,r:1.15,e:1.6,t:1.3,wf:0.1,ws:0},k)
   arm(p,-1,{o:0.2,u:-0.9,f:0.38,r:1.15,e:1.65,t:1.3,wf:0.1,ws:0},k)
   p.sp+=0.015*k
   break
  }
  case 'neck':{
   // rolls his head from side to side
   const k=env(ta,d,0.5,0.6)
   const a=(ta-0.4)*1.9
   p.hr+=0.3*Math.sin(a)*k;p.hp+=(0.12+0.1*Math.cos(a*2))*k;p.sr+=0.03*Math.sin(a)*k
   break
  }
 }
}
