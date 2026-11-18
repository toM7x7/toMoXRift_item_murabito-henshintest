import {Matrix4,Quaternion,Vector3,type Bone,type Mesh,type Object3D,type Scene,type Skeleton,type SkinnedMesh} from 'three'
import {selectActorRig,type ActorRigSelection} from './pose-lib/adapters/xrift.mjs'
import {authoringRig} from './pose-lib/authoring/rig.mjs'
import type {AuthoringRig} from './pose-lib/authoring/types.d.mts'
import {prepareRig,type PreparedRig} from './pose-lib/vendor/render-pose.mjs'
import type {VillagerActor} from './villager/actor'
import type {Follow} from './villager/rig'

/**
 * Wearing the villager: whoever wears him keeps their own avatar, moved by the platform as always (walking, VR
 * tracking, sitting); every client reads that avatar's bones at render time, hides the avatar's meshes for the
 * length of the render, and draws the villager in the same pose instead. Nothing the platform keeps is changed:
 * the meshes are shown again after every render, and the bones are only read.
 *
 * What this leans on that the SDK does not promise (the pose lab's selectActorRig, also used by 体操ステージ):
 * a remote player's avatar sits under the object marked `remote-player-<id>`, the local avatar is the skeleton
 * outside every such marker, and the skeleton can be read as a humanoid (bone names, else its shape). When the
 * skeleton cannot be read, the avatar is left as it is and the villager is not drawn.
 *
 * Call contract (src/Item.tsx): set(wearer) every frame (null = nobody wears him); dispose() on unmount.
 */
export interface Wearer{
 userId:string;isLocal:boolean
 /** where the platform has the person standing (world) */
 feet:Vector3
 /** the avatar's eye height (useUsers getAvatarHeight), or null to measure it from the skeleton */
 eyeHeight:number|null
 /** the camera is in this avatar's head: the villager's head is folded away (not in mirrors) */
 firstPerson:boolean
}
export type WearStatus='off'|'searching'|'worn'|'unreadable'

/** what authoringRig measures (more than its declared type says) */
type Info=AuthoringRig&{restHeadLocal:Vector3;hands:Record<'left'|'right',{fingerDir:Vector3;palm:Vector3}>}
const RESCAN_S=0.5,RECOLLECT_S=2
const now=()=>performance.now()/1000
const within=(o:Object3D,a:Object3D)=>{for(let n:Object3D|null=o;n;n=n.parent)if(n===a)return true;return false}

interface Found{
 rig:PreparedRig
 related:Skeleton[]
 /** per bone: its rest rotation inverted, times the rest basis (so F = now * this gives the bone's body axes) */
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

const Y=new Vector3(0,1,0),Zv=new Vector3(0,0,1)
const qa=new Quaternion(),qb=new Quaternion(),qHips=new Quaternion(),qChest=new Quaternion(),qHead=new Quaternion(),qFoot=new Quaternion(),qHand=new Quaternion(),qYaw=new Quaternion(),qChestInv=new Quaternion()
const va=new Vector3(),vb=new Vector3(),vc=new Vector3(),hipsW=new Vector3()
const rootM=new Matrix4(),rootInv=new Matrix4(),holderInv=new Matrix4()

export class WearBridge{
 status:WearStatus='off'
 /** what the last search found, for the dev page and the console */
 selection:ActorRigSelection|null=null
 /** dev and checks: the villager's scale and how far the feet missed */
 readonly measured={scale:1,reach:0,heading:0,hidden:0}
 /** dev: leave the avatar shown (to compare it with the villager drawn over it) */
 showAvatar=false
 private wearer:Wearer|null=null
 private found:Found|null=null
 private scannedAt=-Infinity
 private note=''
 private hidden:{o:Object3D;was:boolean}[]=[]
 private follow:Follow
 private mgr:Mgr
 private hook:Hook

 constructor(private scene:Scene,private actor:VillagerActor,private holder:Object3D){
  this.mgr=managerFor(scene)
  this.follow={pelvisQ:new Quaternion(),pelvisOffset:new Vector3(),spineQ:new Quaternion(),headQ:new Quaternion(),arms:[null,null],
   legs:[{ankle:new Vector3(),toe:0},{ankle:new Vector3(),toe:0}],jaw:0,blink:0}
  this.hook={
   before:depth=>{
    if(depth===1){this.restore();if(this.wearer&&this.status==='worn')this.pose()}
    // a mirror (a render inside this one) shows the wearer's face
    else this.actor.skin.uniforms.uHideHead.value=0
   },
   after:depth=>{
    if(depth===1)this.restore()
    else this.actor.skin.uniforms.uHideHead.value=this.wearer?.isLocal&&this.wearer.firstPerson&&this.status==='worn'?1:0
   },
  }
  this.mgr.hooks.add(this.hook)
 }

 /** every frame: who wears him (null: nobody) */
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
  const lost=this.found&&!within(this.found.rig.bones.hips,this.scene)
  if(lost)this.found=null
  if(!this.found&&t-this.scannedAt>RESCAN_S){
   this.scannedAt=t
   this.find(wearer)
  }
  if(this.found&&t-this.found.collectedAt>RECOLLECT_S){
   this.found.meshes=avatarMeshes(this.scene,new Set([this.found.rig.skeleton,...this.found.related]))
   this.found.collectedAt=t
  }
  this.status=this.found?'worn':this.selection?.status==='unsupported'||this.selection?.status==='ambiguous-owner'?'unreadable':'searching'
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
   if(found)console.info(`[villager-a] ${who}: wearing the villager (skeleton read by ${s.roles?.method??'?'})`)
   else if(s.status==='unsupported'||s.status==='ambiguous-owner')console.warn(`[villager-a] ${who}: cannot wear the villager, the skeleton could not be read safely: ${s.diagnosis?.reason}`,s.diagnosis)
   else console.debug(`[villager-a] ${who}: looking for the avatar (${s.status})`)
  }
 }

 /** the body axes of a bone now (columns: its left, up, forward in the world) */
 private axes(bone:Bone,out:Quaternion){
  const f=this.found!
  return out.copy(bone.getWorldQuaternion(qa)).multiply(f.toAxes.get(bone)??qb.identity())
 }

 /** At render time: hide the avatar, read its bones, pose the villager there. */
 private pose(){
  const f=this.found,w=this.wearer
  if(!f||!w)return
  const b=f.rig.bones,info=f.info,actor=this.actor,rig=actor.rig,vi=rig.info
  try{
   // hide what the avatar draws, until this render is over
   if(!this.showAvatar)for(const o of f.meshes){this.hidden.push({o,was:o.visible});o.visible=false}
   this.measured.hidden=f.meshes.length
   // how big the avatar is in the world: its leg is as long as it always is
   const legW=b.leftUpperLeg.getWorldPosition(va).distanceTo(b.leftLowerLeg.getWorldPosition(vb))+vb.distanceTo(b.leftFoot.getWorldPosition(vc))
   const k=legW/Math.max(1e-6,info.legLength)
   const eyeW=w.eyeHeight??((info.hipHeight+info.restHeadLocal.y)*k+0.075*k*info.legLength/0.82)
   const s=Math.max(0.3,Math.min(3,eyeW/vi.eyes[0][1]))
   this.measured.scale=s
   // root: on the feet, turned the way the pelvis faces, at the avatar's size
   this.axes(b.hips,qHips)
   va.set(0,0,1).applyQuaternion(qHips)
   const heading=Math.atan2(va.x,va.z)
   this.measured.heading=heading
   qYaw.setFromAxisAngle(Y,heading)
   rootM.compose(w.feet,qYaw,vc.set(s,s,s))
   rootInv.copy(rootM).invert()
   const fo=this.follow
   // pelvis: its lean, and its drop measured as a share of the avatar's own hip height
   fo.pelvisQ.copy(qYaw).invert().multiply(qHips)
   b.hips.getWorldPosition(hipsW)
   const hipRestW=info.hipHeight*k
   va.copy(hipsW).applyMatrix4(rootInv)
   fo.pelvisOffset.set(va.x,((hipsW.y-w.feet.y)/Math.max(1e-6,hipRestW)-1)*rig.pelvis.y,va.z)
   // spine and head
   this.axes(f.chest,qChest)
   fo.spineQ.copy(qHips).invert().multiply(qChest)
   this.axes(b.head,qHead)
   fo.headQ.copy(qChest).invert().multiply(qHead)
   qChestInv.copy(qChest).invert()
   // arms: directions in the chest's axes
   const sides=['right','left'] as const
   for(let i=0;i<2;i++){
    const side=sides[i],ub=b[side+'UpperArm'],lb=b[side+'LowerArm'],hb=b[side+'Hand'],hand=info.hands[side]
    if(!ub||!lb||!hb){fo.arms[i]=null;continue}
    const arm=fo.arms[i]??(fo.arms[i]={upper:new Vector3(),fore:new Vector3(),fingers:new Vector3(),palm:new Vector3()})
    ub.getWorldPosition(va);lb.getWorldPosition(vb);hb.getWorldPosition(vc)
    arm.upper.subVectors(vb,va).normalize().applyQuaternion(qChestInv)
    arm.fore.subVectors(vc,vb).normalize().applyQuaternion(qChestInv)
    this.axes(hb,qHand)
    arm.fingers.copy(hand.fingerDir).applyQuaternion(qHand).applyQuaternion(qChestInv)
    arm.palm.copy(hand.palm).applyQuaternion(qHand).applyQuaternion(qChestInv)
   }
   // legs: where each ankle is (its height above the floor measured against the avatar's own ankle height)
   const ankleRestW=info.ankleHeight*k
   const rest=[vi.ankleR,vi.ankleL]
   for(let i=0;i<2;i++){
    const side=sides[i],foot=b[side+'Foot'],leg=fo.legs[i]
    foot.getWorldPosition(va)
    const lift=(va.y-w.feet.y-ankleRestW)/s
    va.applyMatrix4(rootInv)
    leg.ankle.set(va.x-rest[i][0],Math.max(-0.05,lift),va.z-rest[i][2])
    this.axes(foot,qFoot)
    vb.copy(Zv).applyQuaternion(qFoot)
    leg.toe=-Math.asin(Math.max(-1,Math.min(1,vb.y)))
   }
   fo.jaw=0
   fo.blink=actor.blinkAt(performance.now()/1000)
   rig.applyFollow(fo)
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
  }catch(error){
   this.restore()
   this.actor.object.visible=false
   console.warn('[villager-a] could not follow the avatar',error)
  }
 }

 private restore(){
  for(const {o,was} of this.hidden)o.visible=was
  this.hidden.length=0
 }

 debug(){
  const f=this.found
  return {status:this.status,wearer:this.wearer?.userId??null,selection:this.selection?.status??null,read:this.selection?.roles?.method??null,
   reason:this.selection?.diagnosis?.reason??null,meshes:f?.meshes.length??0,...this.measured,follow:this.follow}
 }

 dispose(){
  this.restore()
  this.mgr.hooks.delete(this.hook)
  if(!this.mgr.hooks.size)this.mgr.dispose()
  this.actor.skin.uniforms.uHideHead.value=0
 }
}
