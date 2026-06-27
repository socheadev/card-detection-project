import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const hlsVendorDir = path.join(projectRoot, "vendor", "hls.js");
const ortVendorDir = path.join(projectRoot, "vendor", "onnxruntime-web");

await mkdir(hlsVendorDir, { recursive: true });
await mkdir(ortVendorDir, { recursive: true });

await cp(
  path.join(projectRoot, "node_modules", "hls.js", "dist", "hls.min.js"),
  path.join(hlsVendorDir, "hls.min.js"),
);

for (const fileName of [
  "ort.min.js",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
]) {
  await cp(
    path.join(projectRoot, "node_modules", "onnxruntime-web", "dist", fileName),
    path.join(ortVendorDir, fileName),
  );
}
