import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "src");
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(source, dist, { recursive: true });
console.log(`Built unpacked extension at ${dist}`);
