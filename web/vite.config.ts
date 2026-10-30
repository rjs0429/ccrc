import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { BUILD_META } from "../broker/src/protocol.ts";

// The build's name, in index.html, from the names of the files it made, which carry their contents' hashes: the page
// and the broker compare it to tell a page of another build.
function buildName(): Plugin {
  return {
    name: "ccrc-build-name",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: (_html, ctx) => {
        const names = Object.keys(ctx.bundle ?? {})
          .filter((n) => n !== "index.html")
          .sort()
          .join("\n");
        return [{ tag: "meta", attrs: { name: BUILD_META, content: createHash("sha256").update(names).digest("hex").slice(0, 16) }, injectTo: "head" }];
      },
    },
  };
}

const COMPRESSIBLE = /\.(js|css|html|svg|json|webmanifest|txt)$/;
const COMPRESS_MIN = 1024;
const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

// Each built file also as .br and .gz, which the broker sends in its place to a browser that takes them.
function precompress(): Plugin {
  let outDir = "";
  return {
    name: "ccrc-precompress",
    apply: "build",
    configResolved: (c) => void (outDir = path.resolve(c.root, c.build.outDir)),
    closeBundle: async () => {
      const files = fs.readdirSync(outDir, { recursive: true, encoding: "utf8" }).filter((f) => COMPRESSIBLE.test(f));
      await Promise.all(
        files.map(async (f) => {
          const file = path.join(outDir, f);
          const data = fs.readFileSync(file);
          if (data.length < COMPRESS_MIN) return;
          const br = await brotli(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
          const gz = await gzip(data, { level: 9 });
          if (br.length < data.length) fs.writeFileSync(`${file}.br`, br);
          if (gz.length < data.length) fs.writeFileSync(`${file}.gz`, gz);
        }),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), buildName(), precompress()],
  build: { chunkSizeWarningLimit: 800 },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8737",
      "/ws": { target: "ws://127.0.0.1:8737", ws: true },
    },
  },
});
