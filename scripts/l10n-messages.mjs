// The page's messages: the pinned monorepo's `l10n/` crate, found through Cargo's checkout, copied
// where Paraglide reads them.
//
//   node scripts/l10n-messages.mjs
//
// Copies `messages/{common,client,browser,host}/<locale>.json` for the source language and every
// shipped one into `apps/web/l10n/<part>/` (git-ignored), and writes the same locale list into
// `apps/web/project.inlang/settings.json`. The shipped list has one source: `locales.json`. A
// language the monorepo has not shipped is a draft and is not copied.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stream = join(root, "packages", "stream");
const web = join(root, "apps", "web");
const PARTS = ["common", "client", "browser", "host"];

function cargo(...args) {
  const run = spawnSync("cargo", args, { cwd: stream, encoding: "utf8", maxBuffer: 1 << 28 });
  if (run.status !== 0) {
    throw new Error(`cargo ${args[0]} failed${run.error ? `: ${run.error.message}` : `\n${run.stderr}`}`);
  }
  return run.stdout;
}

/** `pf-l10n`'s directory in the checkout the stream package's lock resolves. */
function l10nDir() {
  const metadata = () => JSON.parse(cargo("metadata", "--manifest-path", join(stream, "Cargo.toml"), "--format-version", "1", "--offline"));
  let meta;
  try {
    meta = metadata();
  } catch {
    // The checkout is not in Cargo's cache yet.
    cargo("fetch", "--manifest-path", join(stream, "Cargo.toml"), "--locked");
    meta = metadata();
  }
  const pkg = meta.packages.find((p) => p.name === "pf-l10n");
  if (!pkg) throw new Error("pf-l10n is not in packages/stream's dependency graph");
  return dirname(pkg.manifest_path);
}

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const crate = l10nDir();
const { source, shipped } = read(join(crate, "locales.json"));
const locales = [...new Set([source, ...shipped])];

rmSync(join(web, "l10n"), { recursive: true, force: true });
for (const part of PARTS) {
  mkdirSync(join(web, "l10n", part), { recursive: true });
  for (const locale of locales) {
    try {
      copyFileSync(join(crate, "messages", part, `${locale}.json`), join(web, "l10n", part, `${locale}.json`));
    } catch (e) {
      // A part may lack a shipped language; it reads the source's text. The source itself may not be absent.
      if (e.code !== "ENOENT" || locale === source) throw e;
    }
  }
}

// Only the two lines that follow the monorepo; the rest of the file is hand-written.
const settingsPath = join(web, "project.inlang", "settings.json");
const settings = readFileSync(settingsPath, "utf8")
  .replace(/"baseLocale": "[^"]*"/, `"baseLocale": ${JSON.stringify(source)}`)
  .replace(/"locales": \[[^\]]*\]/, `"locales": ${JSON.stringify(locales).replaceAll(",", ", ")}`);
writeFileSync(settingsPath, settings);
console.log(`l10n: ${locales.join(", ")} from ${crate}`);
