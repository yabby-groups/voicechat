import { cp, mkdir, rm } from 'node:fs/promises';

const target = new URL('../public/vad/', import.meta.url);
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
const vadDist = new URL('../node_modules/@ricky0123/vad-web/dist/', import.meta.url);
const ortDist = new URL('../node_modules/onnxruntime-web/dist/', import.meta.url);
const ortTarget = new URL('./ort/', target);
await mkdir(ortTarget, { recursive: true });
await cp(new URL('./bundle.min.js', vadDist), new URL('./bundle.min.js', target));
await cp(new URL('./vad.worklet.bundle.min.js', vadDist), new URL('./vad.worklet.bundle.min.js', target));
await cp(new URL('./silero_vad_v5.onnx', vadDist), new URL('./silero_vad_v5.onnx', target));
await cp(ortDist, ortTarget, { recursive: true });
