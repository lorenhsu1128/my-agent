/**
 * 最小 binding 驗證：require .node 並列出 exports。
 * 不載入模型，只看 N-API 表面。
 */
import {createRequire} from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const addonPath = path.resolve(
    "llama/localBuilds/win-x64-cuda-release-spiritbuun_buun-llama-cpp_aecbbd5/Release/llama-addon.node"
);

console.log("[load] addon path: " + addonPath);
console.log("[load] requiring...");

const addon = require(addonPath);

console.log("[load] exports keys: " + Object.keys(addon).slice(0, 30).join(", "));
console.log("[load] AddonContext: " + (typeof addon.AddonContext));
console.log("[load] systemInfo: " + (typeof addon.systemInfo));
console.log("[load] OK ✓");
