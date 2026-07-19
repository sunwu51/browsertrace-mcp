import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "src");
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(source, dist, { recursive: true });
await build({
  entryPoints: [join(source, "webm-remux.js")],
  outfile: join(dist, "webm-remux.js"),
  bundle: true,
  platform: "browser",
  alias: { ebml: join(root, "node_modules", "ebml", "lib", "ebml.esm.js") },
  format: "iife",
  target: "chrome120"
});

console.log(`Built unpacked extension at ${dist}`);
