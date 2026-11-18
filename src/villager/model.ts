import * as THREE from 'three'
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js'

/**
 * The photo person: loads public/<file>.glb (making/scripts/humangen/humangen.py) and gives it a material whose
 * vertex shader bends the body at its joints (no bones, no clips; the fish-kit way) and whose fragment shader lays
 * the front, back and side photos onto it.
 * Model space: +Z the way the person faces, +Y up, +X the person's left, metres, origin on the floor between the ankles.
 */
export type V3=[number,number,number]
export interface ArmInfo{shoulder:V3;elbow:V3;wrist:V3;tip:V3}
export interface HumanInfo{
 id:string;name:string;height:number
 neck:V3;spine:V3
 armR:ArmInfo;armL:ArmInfo
 hipR:V3;hipL:V3;kneeR:V3;kneeL:V3;ankleR:V3;ankleL:V3
 toeZ:number;heelZ:number
 eyes:[number,number][];eyeR:[number,number];lid:V3
 mouth:[number,number];mouthHalf:number;jaw:V3;chin:number;crown:number
 neckY:[number,number]
 /** atlas uv = (a, b) * (su, sv) + (u0, v0); front / back / headFront from model (x, y), side / headSide from (z, y) */
 tex:{front:number[];back:number[];side:number[];headFront:number[]|null;headSide:number[]|null}
}
export interface HumanSource{geometry:THREE.BufferGeometry;map:THREE.Texture;info:HumanInfo}

const cache=new Map<string,Promise<HumanSource>>()

export function loadHuman(url:string):Promise<HumanSource>{
 let p=cache.get(url)
 if(!p){
  p=new GLTFLoader().loadAsync(url).then(gltf=>{
   let mesh:THREE.Mesh|null=null
   gltf.scene.traverse(o=>{if(!mesh&&(o as THREE.Mesh).isMesh)mesh=o as THREE.Mesh})
   if(!mesh)throw new Error('villager: no mesh in '+url)
   const m=mesh as THREE.Mesh
   const info=m.userData.human as HumanInfo|undefined
   const map=(m.material as THREE.MeshStandardMaterial).map
   if(!info||!map)throw new Error('villager: the model has no human data')
   map.anisotropy=4
   const g=m.geometry
   // the arms reach well outside the resting shape
   g.boundingSphere=new THREE.Sphere(new THREE.Vector3(0,info.height*0.55,0),info.height*0.85)
   g.boundingBox=new THREE.Box3(new THREE.Vector3(-1,-0.2,-1),new THREE.Vector3(1,info.height+0.6,1))
   return {geometry:g,map,info}
  })
  cache.set(url,p)
  p.catch(()=>cache.delete(url))
 }
 return p
}

// _w0 = (spine, head, arm, elbow)   _w1 = (forearm twist, hand, leg, which leg: 1 = left)   _w2 = (knee, foot, side photo, jaw)
// Arrays of two: [0] = the person's right (-X), [1] = the left (+X).
const VERT_HEAD=/* glsl */`
uniform vec3 uNeck, uSpine, uJawP, uHeadRV, uSpineRV;
uniform float uJawOpen, uHideHead;
uniform vec3 uShoulder[2], uElbow[2], uWrist[2], uElbowAxis[2], uForearmAxis[2], uShoulderRV[2], uWristRV[2];
uniform vec2 uArmBend[2];
uniform vec3 uHip[2], uKnee[2], uAnkle[2], uHipRV[2];
uniform vec2 uLegBend[2];
attribute vec4 _w0;
attribute vec4 _w1;
attribute vec4 _w2;
mat3 vRot(vec3 rv) {
  float a = length(rv);
  if (a < 1e-5) return mat3(1.0);
  vec3 k = rv / a; float c = cos(a), s = sin(a), t = 1.0 - c;
  return mat3(
    t * k.x * k.x + c, t * k.x * k.y + s * k.z, t * k.x * k.z - s * k.y,
    t * k.x * k.y - s * k.z, t * k.y * k.y + c, t * k.y * k.z + s * k.x,
    t * k.x * k.z + s * k.y, t * k.y * k.z - s * k.x, t * k.z * k.z + c);
}
// Every joint turns what hangs from it by its angle times the vertex's weight, so skin near a joint bends smoothly.
// Innermost joints first: each pivot is where the joint is in the resting shape.
void vDeform(inout vec3 p, inout vec3 n) {
  mat3 R;
  if (_w2.w > 0.0 && uJawOpen != 0.0) { R = vRot(vec3(uJawOpen * _w2.w, 0.0, 0.0)); p = uJawP + R * (p - uJawP); n = R * n; }
  if (_w0.y > 0.0) { R = vRot(uHeadRV * _w0.y); p = uNeck + R * (p - uNeck); n = R * n; }

  if (_w0.z > 0.0) {
    int s = position.x > 0.0 ? 1 : 0;
    if (_w1.y > 0.0) { R = vRot(uWristRV[s] * _w1.y); p = uWrist[s] + R * (p - uWrist[s]); n = R * n; }
    if (_w1.x > 0.0) { R = vRot(uForearmAxis[s] * (uArmBend[s].y * _w1.x)); p = uElbow[s] + R * (p - uElbow[s]); n = R * n; }
    if (_w0.w > 0.0) { R = vRot(uElbowAxis[s] * (uArmBend[s].x * _w0.w)); p = uElbow[s] + R * (p - uElbow[s]); n = R * n; }
    R = vRot(uShoulderRV[s] * _w0.z); p = uShoulder[s] + R * (p - uShoulder[s]); n = R * n;
  }
  if (_w0.x > 0.0) { R = vRot(uSpineRV * _w0.x); p = uSpine + R * (p - uSpine); n = R * n; }
  if (_w1.z > 0.0) {
    int s = _w1.w > 0.5 ? 1 : 0;
    if (_w2.y > 0.0) { R = vRot(vec3(uLegBend[s].y * _w2.y, 0.0, 0.0)); p = uAnkle[s] + R * (p - uAnkle[s]); n = R * n; }
    if (_w2.x > 0.0) { R = vRot(vec3(uLegBend[s].x * _w2.x, 0.0, 0.0)); p = uKnee[s] + R * (p - uKnee[s]); n = R * n; }
    float wl = _w1.z * _w1.w, wr = _w1.z * (1.0 - _w1.w);
    if (wr > 0.0) { R = vRot(uHipRV[0] * wr); p = uHip[0] + R * (p - uHip[0]); n = R * n; }
    if (wl > 0.0) { R = vRot(uHipRV[1] * wl); p = uHip[1] + R * (p - uHip[1]); n = R * n; }
  }
}
`
const VERT_VARY=/* glsl */`
varying vec3 vRest;
varying vec3 vRestN;
varying vec3 vPart;
`
const VERT_BODY=/* glsl */`
vec3 hp = position;
vec3 hn = normal;
vRest = position;
vRestN = normal;
vPart = vec3(_w0.y, _w2.z, _w2.w);
vDeform(hp, hn);
vec3 objectNormal = hn;
`
const FRAG_HEAD=/* glsl */`
uniform vec4 uTexFront, uTexBack, uTexSide, uTexHeadF, uTexHeadS;
uniform vec4 uEyes;
uniform vec2 uEyeR, uNeckY, uHeadTex;
uniform vec3 uLid, uMouthIn, uMouth;
uniform float uBlink, uJawOpen, uClay, uHideHead;
varying vec3 vRest;
varying vec3 vRestN;
varying vec3 vPart;
`
// Three photos are laid on: the front one on what faces forward, the back one on what faces backward, and the side
// one on the sides of the head and of the legs. Skin that is edge-on to the front and back photos would repeat one
// line of them across itself as stripes: there the photos are read from a coarser mip (a blurred photo).
const FRAG_MAP=/* glsl */`
// (worn, seen by the wearer in first person: the head is left out; the camera is in it)
if (uHideHead > 0.5 && vPart.x > 0.35) discard;
vec3 hN = normalize(vRestN);
vec2 hUvF = vRest.xy * uTexFront.xy + uTexFront.zw;
vec2 hUvB = vRest.xy * uTexBack.xy + uTexBack.zw;
float hFront = smoothstep(-0.14, 0.14, hN.z);
float hEdge = 1.0 - smoothstep(0.22, 0.62, abs(hN.z));
vec3 hColF = texture2D( map, hUvF ).rgb;
vec3 hColB = texture2D( map, hUvB ).rgb;
// the head, from the close-up (finer than the full-length photo)
float hHead = smoothstep(uNeckY.x, uNeckY.y, vRest.y);
if (uHeadTex.x > 0.5) hColF = mix(hColF, texture2D( map, vRest.xy * uTexHeadF.xy + uTexHeadF.zw ).rgb, hHead);
vec3 hCol = mix(hColB, hColF, hFront);
if (hEdge > 0.0) {
  vec3 hSoft = mix(textureLod( map, hUvB, 3.4 ).rgb, textureLod( map, hUvF, 3.4 ).rgb, hFront);
  hCol = mix(hCol, hSoft, hEdge);
}
// the side photo
// (where the skin is turned half-way, the side photo is trusted a little sooner than the front one: the front
// photo's pixels are already being stretched there)
float hWF = pow(abs(hN.z), 3.0), hWS = 1.7 * pow(abs(hN.x), 3.0);
float hSide = vPart.y * smoothstep(0.12, 0.88, hWS / max(hWF + hWS, 1e-4));
if (hSide > 0.0) {
  vec3 hColS = texture2D( map, vRest.zy * uTexSide.xy + uTexSide.zw ).rgb;
  if (uHeadTex.y > 0.5) hColS = mix(hColS, texture2D( map, vRest.zy * uTexHeadS.xy + uTexHeadS.zw ).rgb, hHead);
  hCol = mix(hCol, hColS, hSide);
}
vec4 sampledDiffuseColor = vec4(hCol, 1.0);
diffuseColor *= sampledDiffuseColor;
// (lab: the bare shape, without the photos)
if (uClay > 0.5) {
  if (uClay < 1.5) diffuseColor.rgb = vec3(0.78);
  else if (uClay < 2.5) diffuseColor.rgb = vec3(hEdge, hFront, hSide);
  else if (uClay < 3.5) diffuseColor.rgb = hN * 0.5 + 0.5;
  else if (uClay < 4.5) diffuseColor.rgb = hColF;
  else diffuseColor.rgb = texture2D( map, vRest.zy * (uHeadTex.y > 0.5 ? uTexHeadS.xy : uTexSide.xy) + (uHeadTex.y > 0.5 ? uTexHeadS.zw : uTexSide.zw) ).rgb;
}
if (vPart.x > 0.5 && hN.z > 0.3) {
  // the strip that stretches between the lips when the jaw drops is the inside of the mouth
  // the opening grows with the jaw: a dark oval between the lips
  vec2 hM = (vRest.xy - vec2(uMouth.x, uMouth.y - 0.002 - 0.025 * uJawOpen)) / vec2(uMouth.z * 0.62, 0.0012 + 0.05 * uJawOpen);
  float gap = (1.0 - smoothstep(0.55, 1.0, dot(hM, hM))) * smoothstep(0.012, 0.04, uJawOpen);
  diffuseColor.rgb = mix(diffuseColor.rgb, uMouthIn, gap * 0.9);
  // eyelids: the upper one comes down
  for (int i = 0; i < 2; i++) {
    vec2 e = (vRest.xy - (i == 0 ? uEyes.xy : uEyes.zw)) / uEyeR;
    float er = length(e * vec2(0.92, 1.0));
    if (er < 1.5 && uBlink > 0.001) {
      float edge = mix(1.3, -0.95, uBlink);
      float lid = smoothstep(edge - 0.12, edge + 0.12, e.y) * (1.0 - smoothstep(1.0, 1.3, er));
      float lash = (1.0 - smoothstep(0.0, 0.3, abs(e.y - edge))) * (1.0 - smoothstep(0.85, 1.15, er));
      diffuseColor.rgb = mix(diffuseColor.rgb, uLid * (0.82 + 0.18 * smoothstep(-1.0, 1.0, e.y)), lid);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.03, 0.025), lash * 0.75 * smoothstep(0.1, 0.5, uBlink));
    }
  }
}
`

export interface Skin{
 material:THREE.MeshStandardMaterial
 depthMaterial:THREE.MeshDepthMaterial
 uniforms:ReturnType<typeof makeUniforms>
}

const v3=(a:number[])=>new THREE.Vector3(a[0],a[1],a[2])
const v4=(a:number[]|null)=>a?new THREE.Vector4(a[0],a[1],a[2],a[3]):new THREE.Vector4()

function makeUniforms(i:HumanInfo){
 const arms=[i.armR,i.armL]
 const z=new THREE.Vector3(0,0,1)
 const forearm=arms.map(a=>v3(a.wrist).sub(v3(a.elbow)).normalize())
 return {
  uNeck:{value:v3(i.neck)},uSpine:{value:v3(i.spine)},uJawP:{value:v3(i.jaw)},
  uHeadRV:{value:new THREE.Vector3()},uSpineRV:{value:new THREE.Vector3()},uJawOpen:{value:0},
  uShoulder:{value:arms.map(a=>v3(a.shoulder))},uElbow:{value:arms.map(a=>v3(a.elbow))},uWrist:{value:arms.map(a=>v3(a.wrist))},
  // the elbow folds the forearm forward (the photo has the palms facing forward), the forearm twists about itself
  uElbowAxis:{value:forearm.map(f=>f.clone().cross(z).normalize())},uForearmAxis:{value:forearm},
  uShoulderRV:{value:[new THREE.Vector3(),new THREE.Vector3()]},uWristRV:{value:[new THREE.Vector3(),new THREE.Vector3()]},
  uArmBend:{value:[new THREE.Vector2(),new THREE.Vector2()]},
  uHip:{value:[v3(i.hipR),v3(i.hipL)]},uKnee:{value:[v3(i.kneeR),v3(i.kneeL)]},uAnkle:{value:[v3(i.ankleR),v3(i.ankleL)]},
  uHipRV:{value:[new THREE.Vector3(),new THREE.Vector3()]},uLegBend:{value:[new THREE.Vector2(),new THREE.Vector2()]},
  uTexFront:{value:v4(i.tex.front)},uTexBack:{value:v4(i.tex.back)},uTexSide:{value:v4(i.tex.side)},
  uTexHeadF:{value:v4(i.tex.headFront)},uTexHeadS:{value:v4(i.tex.headSide)},
  uHeadTex:{value:new THREE.Vector2(i.tex.headFront?1:0,i.tex.headSide?1:0)},
  // the close-up takes over from under the jaw upward
  uNeckY:{value:new THREE.Vector2(i.neckY[0]+0.012,i.neckY[1]+0.004)},
  uEyes:{value:new THREE.Vector4(i.eyes[0][0],i.eyes[0][1],i.eyes[1][0],i.eyes[1][1])},uEyeR:{value:new THREE.Vector2(i.eyeR[0],i.eyeR[1])},
  uLid:{value:new THREE.Color(i.lid[0],i.lid[1],i.lid[2])},uMouthIn:{value:new THREE.Color(0.1,0.025,0.025)},uMouth:{value:new THREE.Vector3(i.mouth[0],i.mouth[1],i.mouthHalf)},
  uBlink:{value:0},uClay:{value:0},uHideHead:{value:0},
 }
}

export function createSkin(src:HumanSource):Skin{
 const u=makeUniforms(src.info)
 const material=new THREE.MeshStandardMaterial({map:src.map,roughness:0.92,metalness:0,side:THREE.FrontSide})
 material.onBeforeCompile=sh=>{
  Object.assign(sh.uniforms,u)
  sh.vertexShader=sh.vertexShader
   .replace('#include <common>','#include <common>\n'+VERT_HEAD+VERT_VARY)
   .replace('#include <beginnormal_vertex>',VERT_BODY)
   .replace('#include <begin_vertex>','vec3 transformed = hp;')
  sh.fragmentShader=sh.fragmentShader
   .replace('#include <common>','#include <common>\n'+FRAG_HEAD)
   .replace('#include <map_fragment>',FRAG_MAP)
 }
 material.customProgramCacheKey=()=>'villager-skin-9'
 // shadows are cast by the bent body, not the resting one
 const depthMaterial=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking})
 depthMaterial.onBeforeCompile=sh=>{
  Object.assign(sh.uniforms,u)
  sh.vertexShader=sh.vertexShader
   .replace('#include <common>','#include <common>\n'+VERT_HEAD)
   .replace('#include <begin_vertex>','vec3 hp = position; vec3 hn = vec3(0.0, 0.0, 1.0); vDeform(hp, hn); vec3 transformed = hp;')
 }
 depthMaterial.customProgramCacheKey=()=>'villager-depth-2'
 return {material,depthMaterial,uniforms:u}
}
