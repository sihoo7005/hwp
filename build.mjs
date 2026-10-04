import { mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
await rm("dist", { recursive: true, force: true });
await mkdir("dist/vendor", { recursive: true });
for (const file of ["style.css", "app.mjs", "advanced-worker.mjs", "editor-core.mjs", "RHWP_THIRD_PARTY_LICENSES.md"]) {
  await copyFile(file, `dist/${file}`);
}
const hash = createHash("sha256");
for (const file of ["app.mjs", "advanced-worker.mjs", "editor-core.mjs", "style.css"]) hash.update(await readFile(file));
const version = hash.digest("hex").slice(0, 12);
await writeFile("dist/index.html", (await readFile("index.html", "utf8"))
  .replace('./app.mjs"', `./app.mjs?v=${version}"`).replace('./style.css"', `./style.css?v=${version}"`));
for (const [source, target] of [
  ["node_modules/cfb/dist/cfb.min.js", "cfb.min.js"],
  ["node_modules/@rhwp/core/rhwp.js", "rhwp.js"],
  ["node_modules/@rhwp/core/rhwp_bg.wasm", "rhwp_bg.wasm"],
]) await copyFile(source, `dist/vendor/${target}`);
const notices = ["본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다."];
for (const name of ["cfb", "pako", "adler-32", "crc-32", "@rhwp/core"]) {
  notices.push(`\n${name}\n${await readFile(`node_modules/${name}/LICENSE`, "utf8")}`);
}
notices.push(`\nrhwp의 컴파일된 의존성 고지\n${await readFile("RHWP_THIRD_PARTY_LICENSES.md", "utf8")}`);
await writeFile("dist/THIRD_PARTY_NOTICES.txt", notices.join("\n"));
console.log("정적 사이트를 dist/에 생성했습니다.");
