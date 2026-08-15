/**
 * 构建辅助：把 src/client.js 复制到 lib/client.js。
 * client 半边是 window.__ModuleLoader__ 闭包格式（CommonJS），tsc 无法产出，
 * 源码手写于 src/client.js，构建时原样复制进产物目录。
 */
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("lib", { recursive: true });
copyFileSync("src/client.js", "lib/client.js");
console.log("client.js copied to lib/");
