#!/bin/bash
# 村人の素材写真（全身・A ポーズ・緑一色の背景）を Codex に撮らせる。fish-kit / 文鳥の gen_refs.sh と同じやり方。
# Codex には作らせるだけで、保存させない（保存しようとするとシェルが使えずに失敗する）。
# 作った画像は recover_refs.py が Codex の generated_images から refs/ へ写す。
#
# 使い方:
#   bash scripts/humangen/gen_refs.sh front_a front_b front_c      正面の候補を作る
#   FRONT=front_a bash scripts/humangen/gen_refs.sh back side      選んだ正面を見せて、同じ人の後ろと横を作る
# 同時に動かすのは JOBS（省略で 4）まで
CODEX=${CODEX:-$(ls -t "$(cygpath -u "$LOCALAPPDATA")"/OpenAI/Codex/bin/*/codex.exe | head -1)}
ROOT="$(cd "$(dirname "$0")/../.." && (pwd -W 2>/dev/null || pwd))"
OUT="$ROOT/refs"
LOG="$ROOT/scripts/humangen/logs"
mkdir -p "$LOG" "$OUT"
FRONT=${FRONT:-front_a}

PERSON="The model is an ordinary fictional adult Japanese man in his late twenties, average build, about 172 cm tall, with short neat black hair that leaves the ears and the forehead uncovered, clean-shaven, a calm friendly neutral face with the mouth closed and the eyes open. He is dressed as a plain villager: a simple long-sleeved band-collar shirt of undyed off-white linen worn untucked, straight warm-brown cotton trousers, and plain dark-brown leather ankle boots. No hat, no bag, no jewellery, no logos, no patterns."
POSE="He stands perfectly upright and left-right symmetrical in a relaxed A-pose like a body-scan reference: both arms straight and held away from the body about 30 degrees to each side with the elbows straight, the palms turned to face FORWARD (anatomical position), fingers straight and held together, thumbs slightly apart; feet about 25 cm apart and parallel with the toes pointing straight ahead; weight even on both feet; head level, looking straight ahead. Green background is clearly visible between each arm and the torso and between the two legs."
SHOT="Photorealistic full-length studio photograph, 2:3 portrait format, taken with a long telephoto lens from far away at waist height so there is no perspective distortion (nearly orthographic). The whole body is in frame with nothing cropped: the top of the hair is about 6% below the top edge and the soles of the boots about 5% above the bottom edge, the body exactly centred. Uniform flat chroma-key green studio background and floor (#1faa3c) with no gradient, no horizon line, no cast shadow, no reflection, no props, no text. Soft, even, shadowless frontal lighting, razor-sharp detail of skin, hair and cloth weave, natural colours. Unretouched real photograph, not an illustration, not a 3D render."

declare -A P
declare -A REF
for k in front_a front_b front_c front_d; do
  P[$k]="$SHOT $PERSON $POSE FRONT VIEW: he faces the camera squarely; the palms of both hands face the camera."
done
SAME="The attached image is the FRONT view of a man photographed for a body-scan reference. Create a new photograph of EXACTLY the same man in exactly the same pose, clothes, hairstyle, body proportions, lighting, green background, framing and scale (his head top and boot soles at the same heights in the frame as in the attached image, the same image size and 2:3 portrait format), but seen from another direction."
P[back]="$SAME BACK VIEW: the camera is exactly behind him, he faces directly away from it. We see the back of his head and hair, the back of the shirt, the backs of the trousers and the heels of the boots. Because his palms face forward, the camera sees the BACKS of his hands. His arms are held away from the body at the same angle as in the front view and his feet are the same distance apart, so that his outline is the mirror image of the front view. $SHOT $PERSON $POSE"
REF[back]=1
P[side]="$SAME SIDE VIEW: an exact left profile. He faces the LEFT edge of the image, his body exactly perpendicular to the camera, so the camera sees his left ear, his left shoulder and the outer side of his left boot. He stands perfectly straight, not leaning, the head level with the nose pointing to the left edge. The far arm and far leg are hidden exactly behind the near ones. $SHOT $PERSON $POSE"
REF[side]=1
# 顔の拡大（頭の写真だけ細かくしたいとき用）
P[head_front]="The attached image is a full-length FRONT view of a man. Create a close-up studio photograph of the head and shoulders of EXACTLY the same man (same face, same short black hair, same off-white band-collar linen shirt), facing the camera squarely, head level, neutral calm expression, mouth closed, eyes open looking into the lens. Square format; the head is centred, the top of the hair about 8% below the top edge and the collar and the tops of the shoulders in the bottom 20%. Long telephoto lens, no perspective distortion. Uniform flat chroma-key green background (#1faa3c), soft even shadowless frontal lighting, razor-sharp skin and hair detail. Unretouched real photograph."
REF[head_front]=1
P[head_side]="The attached image is a full-length exact LEFT PROFILE view of a man. Create a close-up studio photograph of the head and shoulders of EXACTLY the same man (same face, same short black hair, same off-white band-collar linen shirt) in the same exact left profile: he faces the LEFT edge of the image, the head exactly perpendicular to the camera and level, so the camera sees his left ear; neutral calm expression, mouth closed, eye open looking straight ahead. Square format; the head is centred, the top of the hair about 8% below the top edge and the collar and the top of the shoulder in the bottom 20%. Long telephoto lens, no perspective distortion. Uniform flat chroma-key green background (#1faa3c), soft even shadowless lighting, razor-sharp skin and hair detail. Unretouched real photograph."
REF[head_side]=side

IDS=("$@"); [ ${#IDS[@]} -eq 0 ] && IDS=(front_a front_b front_c)
JOBS=${JOBS:-4}
for k in "${IDS[@]}"; do
  while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do sleep 5; done
  (
    if [ ! -f "$OUT/$k.png" ]; then
      if [ -n "${REF[$k]}" ]; then
        "$CODEX" -c model_reasoning_effort=low -c approval_policy=never exec --skip-git-repo-check -s read-only -C "$ROOT" \
          "Use your image generation tool to create this image, using the attached image as the reference. Do not run any commands or scripts and do not try to save or open the file; just generate it. Prompt: ${P[$k]}" -i "$OUT/$( [ "${REF[$k]}" = 1 ] && echo "$FRONT" || echo "${REF[$k]}" ).png" < /dev/null > "$LOG/ref_${k}.log" 2>&1
      else
        "$CODEX" -c model_reasoning_effort=low -c approval_policy=never exec --skip-git-repo-check -s read-only -C "$ROOT" \
          "Use your image generation tool to create this image. Do not run any commands or scripts and do not try to save or open the file; just generate it. Prompt: ${P[$k]}" < /dev/null > "$LOG/ref_${k}.log" 2>&1
      fi
      echo "$k ref exit=$?"
      python "$ROOT/scripts/humangen/recover_refs.py"
    fi
  ) &
done
wait
ls -la "$OUT"
echo ALLDONE
