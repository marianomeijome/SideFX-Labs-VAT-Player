import { build, context } from "esbuild";

const args = new Set(process.argv.slice(2));
const isWatch = args.has("--watch");
const isServe = args.has("--serve");

const buildOptions = {
  entryPoints: {
    "sidefx-player": "src/sidefx-player.ts"
  },
  outdir: "dist",
  bundle: true,
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2018",
  sourcemap: true,
  logLevel: "info"
};

if (isWatch || isServe) {
  const ctx = await context(buildOptions);
  if (isServe) {
    await ctx.serve({ servedir: "public", port: 5173 });
    console.log("Serving on http://localhost:5173");
  }
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await build(buildOptions);
}

