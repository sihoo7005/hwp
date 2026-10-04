import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
await mkdir("dist/vendor", { recursive: true });
for (const file of ["index.html", "style.css", "app.mjs", "worker.js", "hwp.mjs", "viewer.mjs"]) {
  await copyFile(file, `dist/${file}`);
}
for (const [source, target] of [
  ["node_modules/cfb/dist/cfb.min.js", "cfb.min.js"],
  ["node_modules/pako/dist/pako.min.js", "pako.min.js"],
]) await copyFile(source, `dist/vendor/${target}`);
const notices = ["본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다."];
for (const name of ["cfb", "pako", "adler-32", "crc-32"]) {
  notices.push(`\n${name}\n${await readFile(`node_modules/${name}/LICENSE`, "utf8")}`);
}
await writeFile("dist/THIRD_PARTY_NOTICES.txt", notices.join("\n"));
console.log("정적 사이트를 dist/에 생성했습니다.");
