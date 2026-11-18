// Dev only: stand a local VRM in for a host avatar so the real pose bridge can find and pose it.
// ?vrm=<absolute path>   the local user's avatar     ?vrm2=<absolute path>   the remote user's avatar
// Files are read through Vite's /@fs/ in the dev server only (never copied into public/ or dist).
import {useEffect,useMemo,useRef} from 'react'
import {useFrame} from '@react-three/fiber'
import {Group,Object3D,Quaternion,Vector3,type Bone,type SkinnedMesh} from 'three'
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js'

export interface DevPerson{id:string;position:{x:number;y:number;z:number};yaw:number;/** the way the body faces when that is not where its owner looks (third person: it turns to where it walks) */bodyYaw?:number;/** set from the avatar once it is loaded: the height of its eyes */eye?:number}
// a path on disk goes through /@fs/; anything else (a ?url import, http) is used as it is
const fsUrl=(p:string)=>/^[A-Za-z]:[\\/]/.test(p)?'/@fs/'+p.replace(/\\/g,'/').replace(/^\/+/,''):p

/** Arms hang from the T-pose (the host's idle), head follows a slow look-around. */
function idle(bones:Record<string,Bone|undefined>,t:number){
 const rotate=(bone:Bone|undefined,axis:Vector3,angle:number)=>{if(!bone?.parent)return;const target=new Quaternion().setFromAxisAngle(axis,angle).multiply(bone.getWorldQuaternion(new Quaternion())),parent=bone.parent.getWorldQuaternion(new Quaternion());bone.quaternion.copy(parent.invert().multiply(target));bone.updateWorldMatrix(false,true)}
 for(const arm of [bones.leftUpperArm,bones.rightUpperArm]){
  const child=arm?.children.find(c=>(c as Bone).isBone);if(!arm||!child)continue
  const dir=child.getWorldPosition(new Vector3()).sub(arm.getWorldPosition(new Vector3())).normalize()
  const axis=new Vector3().crossVectors(dir,new Vector3(0,-1,0));if(axis.lengthSq()<1e-6)continue
  rotate(arm,axis.normalize(),1.2)
 }
 rotate(bones.head,new Vector3(0,1,0),Math.sin(t*.6)*.08)
}

/** headless: true while the camera sits in this avatar's head (the platform hides the head from its owner's first-person view). */
export function DevVrmAvatar({person,path,remote,headless}:{person:DevPerson;path:string;remote:boolean;headless?:()=>boolean}){
 const holder=useRef<Group>(null)
 const state=useMemo(()=>({flip:0,root:null as Object3D|null,bones:{} as Record<string,Bone|undefined>,neutral:[] as {b:Bone;q:Quaternion;p:Vector3}[]}),[])
 useEffect(()=>{
  let live=true
  new GLTFLoader().loadAsync(fsUrl(path)).then(gltf=>{
   if(!live||!holder.current)return
   const root=gltf.scene;root.name='dev-vrm-'+person.id
   // VRM 1.0 faces +Z, VRM 0.x faces -Z (= XRift yaw 0).
   state.flip=(gltf.parser.json as {extensions?:Record<string,unknown>}).extensions?.VRMC_vrm?Math.PI:0
   root.traverse(o=>{o.frustumCulled=false;if((o as SkinnedMesh).isSkinnedMesh)o.castShadow=true})
   // Raw VRM0 bone names (Character1_*, J_Bip_*) are what the pose bridge reads, as in XRift.
   const find=(re:RegExp)=>{let f:Bone|undefined;root.traverse(o=>{if(!f&&(o as Bone).isBone&&re.test(o.name))f=o as Bone});return f}
   // Also Blender (upper_armL after GLTFLoader drops the dot) and Unreal (upperarm_l) names.
   state.bones={hips:find(/hips$/i),leftUpperArm:find(/(left_?arm|leftupperarm|L_UpperArm|upper_?armL|upperarm_l)$/i),rightUpperArm:find(/(right_?arm|rightupperarm|R_UpperArm|upper_?armR|upperarm_r)$/i),head:find(/head$/i)}
   root.traverse(o=>{if((o as Bone).isBone)state.neutral.push({b:o as Bone,q:o.quaternion.clone(),p:o.position.clone()})})
   holder.current.add(root);state.root=root
   // the eyes sit a little above the head joint (the platform reads the avatar's own eye height)
   if(state.bones.head){root.updateWorldMatrix(true,true);person.eye=state.bones.head.getWorldPosition(new Vector3()).y-person.position.y+.07}
   if(remote){
    // Host convention the bridge reads for remote players: Interactable userData id remote-player-<id>.
    const marker=new Object3D();marker.userData={id:'remote-player-'+person.id,onInteract(){}};root.add(marker)
   }
  }).catch(e=>console.warn('[dev-vrm]',path,e))
  return()=>{live=false;if(state.root)holder.current?.remove(state.root);state.root=null;state.neutral=[]}
 },[path,person.id,remote,state])
 useFrame(({clock})=>{
  const g=holder.current;if(!g)return
  // VRM0 faces -Z, which is XRift yaw 0.
  g.position.set(person.position.x,person.position.y,person.position.z);g.rotation.set(0,(person.bodyYaw??person.yaw)+state.flip,0);g.updateWorldMatrix(true,false)
  if(!state.root||!state.bones.hips)return
  for(const n of state.neutral){n.b.quaternion.copy(n.q);n.b.position.copy(n.p)}
  state.root.updateWorldMatrix(true,true)
  idle(state.bones,clock.elapsedTime)
  state.bones.head?.scale.setScalar(headless?.()?1e-4:1)
  state.root.traverse(o=>{const m=o as SkinnedMesh;if(m.isSkinnedMesh)m.skeleton.update()})
 })
 return <group ref={holder}/>
}
