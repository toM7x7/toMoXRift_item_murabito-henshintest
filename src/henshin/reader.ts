import {Quaternion,Vector3,type Bone,type Mesh,type Object3D,type Scene,type Skeleton,type SkinnedMesh} from 'three'
import {selectActorRig,type ActorRigSelection} from '../pose-lib/adapters/xrift.mjs'
import {authoringRig} from '../pose-lib/authoring/rig.mjs'
import type {AuthoringRig} from '../pose-lib/authoring/types.d.mts'
import {prepareRig,type PreparedRig} from '../pose-lib/vendor/render-pose.mjs'

/**
 * 変身の土台（体に依存しない部分）。
 *
 * Whoever wears a body keeps their own avatar, moved by the platform as always (walking, VR tracking, sitting).
 * Every client finds that avatar's skeleton, and at render time hides the avatar's meshes for the length of the
 * render, reads its bones and hands them to the body (a WornBody), which draws itself in their place. Nothing the
 * platform keeps is changed: the meshes are shown again after every render, and the bones are only read.
 *
 * What this leans on that the SDK does not promise (the pose lab's selectActorRig, also used by 体操ステージ):
 * a remote player's avatar sits under the object marked `remote-player-<id>`, the local avatar is the skeleton
 * outside every such marker, and the skeleton can be read as a humanoid (bone names, else its shape). When the
 * skeleton cannot be read, the avatar is left as it is and the body is not drawn.
 *
 * Call contract: set(wearer) every frame (null = nobody wears it); dispose() on unmount.
 * A body is given: pose(reading, wearer) at render time, nested(true/false) around a render inside the render (a
 * mirror: show the head there), and hide() when there is nothing to draw.
 */
export interface Wearer{
 userId:string;isLocal:boolean
 /** where the platform has the person standing (world) */
 feet:Vector3
 /** the avatar's eye height (useUsers getAvatarHeight), or null to measure it from the skeleton */
 eyeHeight:number|null
 /** the camera is in this avatar's head (the body should leave its head out for this viewer, except in mirrors) */
 firstPerson:boolean
 /** shared clock, seconds */
 t:number
}
export type WearStatus='off'|'searching'|'worn'|'unreadable'
export type Side='right'|'left'

/** What the body can ask about the avatar at render time. Positions and axes are in the world. */
export interface AvatarReading{
 /** world size of the avatar against its own skeleton file (its legs keep their length) */
 k:number
 /** eye height above the feet (m) */
 eye:number
 /** at rest: hip height and ankle height above the floor, leg length and arm length (m, world) */
 hipRest:number;ankleRest:number;legLength:number;armLength:number
 /** the way the pelvis faces (rad about +Y, 0 = +Z) */
 heading:number
 /** world position of a bone by its role (hips, chest, head, leftUpperArm ... rightFoot) */
 pos(role:Role,out:Vector3):Vector3
 /** the body axes of a bone now: a rotation whose columns are its left, up and forward in the world */
 axes(role:Role,out:Quaternion):Quaternion
 /** a hand's finger direction and palm direction (world, unit) */
 hand(side:Side,fingers:Vector3,palm:Vector3):void
}
export type Role='hips'|'chest'|'head'|`${Side}${'UpperArm'|'LowerArm'|'Hand'|'UpperLeg'|'LowerLeg'|'Foot'}`

export interface WornBody{
 /** at render time, the avatar hidden: pose and place yourself where the avatar is (throw if you cannot) */
 pose(r:AvatarReading,w:Wearer):void
 /** a render inside this one (a mirror) begins (true) or ends (false) */
 nested(inside:boolean,w:Wearer|null):void
 /** nothing to draw now */
 hide():void
}

/** what authoringRig measures (more than its declared type says) */
type Info=AuthoringRig&{restHeadLocal:Vector3;hands:Record<Side,{fingerDir:Vector3;palm:Vector3}>}
const RESCAN_S=0.5,RECOLLECT_S=2
const now=()=>performance.now()/1000
const within=(o:Object3D,a:Object3D)=>{for(let n:Object3D|null=o;n;n=n.parent)if(n===a)return true;return false}

interface Found{
 rig:PreparedRig
 related:Skeleton[]
 /** per bone: its rest rotation inverted, times the rest basis (so axes = now * this) */
 toAxes:Map<Bone,Quaternion>
 info:Info
 chest:Bone
 meshes:Object3D[]
 collectedAt:number
}

// One render transaction per scene (a mirror's render inside the main one keeps the same state).
type Hook={before(depth:number):void;after(depth:number):void}
type Mgr={hooks:Set<Hook>;dispose():void}
const managers=new WeakMap<Scene,Mgr>()
function managerFor(scene:Scene):Mgr{
 let m=managers.get(scene)
 if(m)return m
 const hooks=new Set<Hook>(),before=scene.onBeforeRender,after=scene.onAfterRender
 let depth=0
 const onBefore:typeof scene.onBeforeRender=function(this:Scene,...args){depth++;try{before.call(this,...args)}finally{for(const h of hooks)h.before(depth)}}
 const onAfter:typeof scene.onAfterRender=function(this:Scene,...args){try{after.call(this,...args)}finally{for(const h of hooks)h.after(depth);depth=Math.max(0,depth-1)}}
 scene.onBeforeRender=onBefore;scene.onAfterRender=onAfter
 m={hooks,dispose(){if(scene.onBeforeRender===onBefore)scene.onBeforeRender=before;if(scene.onAfterRender===onAfter)scene.onAfterRender=after;managers.delete(scene)}}
 managers.set(scene,m)
 return m
}

/** every mesh drawn by these skeletons, or hung on one of their bones (hair, hats) */
function avatarMeshes(scene:Scene,skeletons:Set<Skeleton>):Object3D[]{
 const bones=new Set<Object3D>()
 for(const s of skeletons)for(const b of s.bones)bones.add(b)
 const out:Object3D[]=[]
 scene.traverse(o=>{
  if(!(o as Mesh).isMesh)return
  if((o as SkinnedMesh).isSkinnedMesh&&skeletons.has((o as SkinnedMesh).skeleton)){out.push(o);return}
  for(let n=o.parent;n;n=n.parent)if(bones.has(n)){out.push(o);return}
 })
 return out
}

const qa=new Quaternion(),qb=new Quaternion(),va=new Vector3(),vb=new Vector3(),vc=new Vector3()

export class AvatarReader{
 status:WearStatus='off'
 /** what the last search found, for the dev page and the console */
 selection:ActorRigSelection|null=null
 /** how many meshes the avatar draws (hidden during each render) */
 hiddenCount=0
 /** dev: leave the avatar shown (to compare it with the body drawn over it) */
 showAvatar=false
 private wearer:Wearer|null=null
 private found:Found|null=null
 private scannedAt=-Infinity
 private note=''
 private hidden:{o:Object3D;was:boolean}[]=[]
 private mgr:Mgr
 private hook:Hook
 private reading:AvatarReading

 /** tag: what the console lines start with, e.g. 'villager-a' */
 constructor(private scene:Scene,private body:WornBody,private tag:string){
  this.mgr=managerFor(scene)
  this.hook={
   before:depth=>{
    if(depth===1){this.restore();if(this.wearer&&this.status==='worn')this.render()}
    else this.body.nested(true,this.wearer)
   },
   after:depth=>{
    if(depth===1)this.restore()
    else this.body.nested(false,this.wearer)
   },
  }
  this.mgr.hooks.add(this.hook)
  const self=this
  this.reading={
   k:1,eye:1.5,hipRest:0.9,ankleRest:0.08,legLength:0.8,armLength:0.6,heading:0,
   pos(role,out){return self.bone(role).getWorldPosition(out)},
   axes(role,out){return self.axes(self.bone(role),out)},
   hand(side,fingers,palm){
    const f=self.found!,h=f.info.hands[side]
    self.axes(f.rig.bones[side+'Hand'],qb)
    fingers.copy(h.fingerDir).applyQuaternion(qb);palm.copy(h.palm).applyQuaternion(qb)
   },
  }
 }

 /** every frame: who wears it (null: nobody) */
 set(wearer:Wearer|null){
  const was=this.wearer
  if(!wearer){
   this.wearer=null
   if(this.status!=='off'){this.status='off';this.found=null;this.selection=null;this.note=''}
   return
  }
  if(!was||was.userId!==wearer.userId){this.found=null;this.selection=null;this.scannedAt=-Infinity;this.note=''}
  this.wearer={...wearer,feet:wearer.feet.clone()}
  const t=now()
  if(this.found&&!within(this.found.rig.bones.hips,this.scene))this.found=null
  if(!this.found&&t-this.scannedAt>RESCAN_S){this.scannedAt=t;this.find(wearer)}
  if(this.found&&t-this.found.collectedAt>RECOLLECT_S){
   this.found.meshes=avatarMeshes(this.scene,new Set([this.found.rig.skeleton,...this.found.related]))
   this.found.collectedAt=t
  }
  this.status=this.found?'worn':this.selection?.status==='unsupported'||this.selection?.status==='ambiguous-owner'?'unreadable':'searching'
  if(this.status!=='worn')this.body.hide()
 }

 private find(w:Wearer){
  const selection=selectActorRig({scene:this.scene,userId:w.userId,isLocal:w.isLocal,feet:w.feet})
  this.selection=selection
  let found:Found|null=null
  if(selection.status==='ready'&&selection.rig){
   try{
    const rig=prepareRig(selection.rig),info=authoringRig(rig) as unknown as Info
    const toAxes=new Map<Bone,Quaternion>()
    for(const [bone,q] of rig.restRotations)toAxes.set(bone,q.clone().invert().multiply(rig.restBasis))
    const chest=info.torso[info.torso.length-1]??rig.bones.hips
    const related=selection.relatedSkeletons
    found={rig,related,toAxes,info,chest,meshes:avatarMeshes(this.scene,new Set([rig.skeleton,...related])),collectedAt:now()}
   }catch(error){this.selection={...selection,status:'unsupported',rig:null,diagnosis:{reason:String(error)}}}
  }
  this.found=found
  const s=this.selection
  const note=s.status+':'+(s.roles?.method??s.diagnosis?.reason??'')
  if(note!==this.note){
   this.note=note
   const who=w.isLocal?'your avatar':`avatar of ${w.userId}`
   if(found)console.info(`[${this.tag}] ${who}: worn (skeleton read by ${s.roles?.method??'?'})`)
   else if(s.status==='unsupported'||s.status==='ambiguous-owner')console.warn(`[${this.tag}] ${who}: cannot be worn, the skeleton could not be read safely: ${s.diagnosis?.reason}`,s.diagnosis)
   else console.debug(`[${this.tag}] ${who}: looking for the avatar (${s.status})`)
  }
 }

 private bone(role:Role):Bone{
  const f=this.found!
  if(role==='chest')return f.chest
  const b=f.rig.bones[role]
  if(!b)throw new Error('no '+role)
  return b
 }
 private axes(bone:Bone,out:Quaternion){
  return out.copy(bone.getWorldQuaternion(qa)).multiply(this.found!.toAxes.get(bone)??qb.identity())
 }

 /** At render time: hide the avatar, measure it, let the body pose itself there. */
 private render(){
  const f=this.found,w=this.wearer
  if(!f||!w)return
  const b=f.rig.bones,info=f.info,r=this.reading
  try{
   if(!this.showAvatar)for(const o of f.meshes){this.hidden.push({o,was:o.visible});o.visible=false}
   this.hiddenCount=f.meshes.length
   // how big the avatar is in the world: its leg is as long as it always is
   const legW=b.leftUpperLeg.getWorldPosition(va).distanceTo(b.leftLowerLeg.getWorldPosition(vb))+vb.distanceTo(b.leftFoot.getWorldPosition(vc))
   const k=legW/Math.max(1e-6,info.legLength)
   r.k=k
   r.eye=w.eyeHeight??((info.hipHeight+info.restHeadLocal.y)*k+0.075*k*info.legLength/0.82)
   r.hipRest=info.hipHeight*k;r.ankleRest=info.ankleHeight*k;r.legLength=legW;r.armLength=info.armLength*k
   this.axes(b.hips,qa)
   va.set(0,0,1).applyQuaternion(qa)
   r.heading=Math.atan2(va.x,va.z)
   this.body.pose(r,w)
  }catch(error){
   this.restore()
   this.body.hide()
   console.warn(`[${this.tag}] could not follow the avatar`,error)
  }
 }

 private restore(){
  for(const {o,was} of this.hidden)o.visible=was
  this.hidden.length=0
 }

 debug(){
  return {status:this.status,wearer:this.wearer?.userId??null,selection:this.selection?.status??null,read:this.selection?.roles?.method??null,
   reason:this.selection?.diagnosis?.reason??null,meshes:this.found?.meshes.length??0,hidden:this.hiddenCount}
 }

 dispose(){
  this.restore()
  this.mgr.hooks.delete(this.hook)
  if(!this.mgr.hooks.size)this.mgr.dispose()
 }
}
