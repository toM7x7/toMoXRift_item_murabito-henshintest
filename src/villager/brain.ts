/**
 * What the villager feels like doing, as a pure function of the shared clock (useServerClock) and the placement's
 * seed. Every client works out the same thing, so nothing is sent over the network for the idle behaviour.
 * The actor (actor.ts) turns this into a pose, walks him to where he should be, and smooths it.
 */
export type IdleAction='none'|'stretch'|'scratch'|'hips'|'sky'|'clasp'|'neck'

export interface Intent{
 action:IdleAction
 /** seconds since the action started (negative: not yet) and how long it lasts */
 ta:number;dur:number
 /** one number per action instance, the same on every client */
 key:number
 /** +1 = with the left hand, -1 = with the right */
 side:1|-1
 pick:number
 /** where he should be standing (metres from where the item was put down) and which way he faces there */
 goalX:number;goalZ:number;faceYaw:number
 /** where he looks when nobody is near (rad; yaw + = to his left, pitch + = up) */
 gazeYaw:number;gazePitch:number
 /** which leg carries his weight (-1 right .. 1 left) */
 lean:number
 blink:number
}

/** 0..1, the same for the same integers everywhere */
export function hash(a:number,b:number,c=0):number{
 let x=Math.imul(a|0,374761393)^Math.imul(b|0,668265263)^Math.imul(c|0,1274126177)
 x=Math.imul(x^(x>>>15),2246822519)
 x=Math.imul(x^(x>>>13),3266489917)
 return ((x^(x>>>16))>>>0)/4294967296
}

export function seedOf(id:string):number{
 let s=7
 for(let i=0;i<id.length;i++)s=(Math.imul(s,31)+id.charCodeAt(i))|0
 return s&0xfffff
}

/** length of one 'what next' slot, and how many slots he stays at one spot */
export const EPOCH=8,STAY=3
/** how far from where he was put down he strolls */
export const ROAM=1.3
const GAZE=2.3,BLINK=0.3,LEAN=11

const TABLE:[IdleAction,number][]=[['none',40],['scratch',9],['stretch',8],['hips',13],['sky',9],['clasp',13],['neck',8]]
export const IDLE_DUR:Record<IdleAction,number>={none:0,scratch:3.2,stretch:4.4,hips:6.4,sky:4.4,clasp:6.6,neck:3.6}

const smooth=(x:number)=>x*x*(3-2*x)

export function intentAt(t:number,seed:number):Intent{
 const off=hash(seed,1)
 const k=Math.floor(t/EPOCH+off)
 const t0=(k-off)*EPOCH
 let total=0
 for(const [,w] of TABLE)total+=w
 let r=hash(seed,k,3)*total,action:IdleAction='none'
 for(const [name,w] of TABLE){if(r<w){action=name;break}r-=w}
 const dur=IDLE_DUR[action]
 const start=0.5+hash(seed,k,4)*Math.max(0,EPOCH-dur-1.0)
 // where he stands: a new spot every few slots, and he is at home more often than not
 const s=Math.floor(k/STAY)
 let goalX=0,goalZ=0
 if(hash(seed,s,11)>0.42){
  const a=hash(seed,s,12)*Math.PI*2,d=0.45+hash(seed,s,13)*(ROAM-0.45)
  goalX=Math.sin(a)*d;goalZ=Math.cos(a)*d
 }
 const faceYaw=(hash(seed,s,14)-0.5)*1.5
 // gaze: drifts to a new point every couple of seconds
 const g=t/GAZE+hash(seed,2)
 const gi=Math.floor(g),gf=smooth(Math.min(1,(g-gi)*2.2))
 const gy=(i:number)=>hash(seed,i,21)<0.35?0:(hash(seed,i,22)-0.5)*1.3
 const gp=(i:number)=>(hash(seed,i,23)-0.55)*0.3
 // weight from one leg to the other
 const l=t/LEAN+hash(seed,6)
 const li=Math.floor(l),lf=smooth(Math.min(1,(l-li)*4))
 const lv=(i:number)=>hash(seed,i,41)<0.3?0:(hash(seed,i,42)<0.5?-1:1)*(0.5+0.5*hash(seed,i,43))
 // blinks are quick and irregular
 const b=Math.floor(t/BLINK+hash(seed,5))
 const bt=(t/BLINK+hash(seed,5)-b)*BLINK
 const blink=hash(seed,b,31)<0.085?Math.max(0,1-Math.abs(bt-0.075)/0.075):0
 return {
  action,ta:t-t0-start,dur,key:k,side:hash(seed,k,6)<0.5?1:-1,pick:hash(seed,k,7),
  goalX,goalZ,faceYaw,
  gazeYaw:gy(gi-1)+(gy(gi)-gy(gi-1))*gf,gazePitch:gp(gi-1)+(gp(gi)-gp(gi-1))*gf,
  lean:lv(li-1)+(lv(li)-lv(li-1))*lf,
  blink,
 }
}
