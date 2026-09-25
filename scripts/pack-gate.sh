#!/usr/bin/env bash
# Install @punktfunk/stream from its packed tarball into an empty Vite project, type-check a
# consumer and build it. Proves the package, not the workspace, carries the lazy wasm and the
# asset reference that finds it. Run after `npm run build`.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

tarball="$(npm pack --silent --pack-destination "$work" -w @punktfunk/stream)"
cp "$root/.npmrc" "$work/"
cd "$work"
echo '{ "private": true, "type": "module" }' > package.json
npm install --silent --no-audit --no-fund "./$tarball" vite typescript

cat > main.ts <<'TS'
import { Engine, type EngineState } from "@punktfunk/stream";

const videoCanvas = document.createElement("canvas");
const engine = await Engine.create({ videoCanvas });
engine.onState((s: EngineState) => console.log(s.kind));
TS
cat > index.html <<'HTML'
<!doctype html>
<script type="module" src="./main.ts"></script>
HTML
cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["main.ts"]
}
JSON

npx tsc -p .
npx vite build --logLevel warn
wasm="$(find dist -name '*.wasm' | head -1)"
[ -n "$wasm" ] || { echo "pack gate: the build emitted no .wasm" >&2; exit 1; }
echo "pack gate: $tarball builds in a fresh consumer, $(wc -c < "$wasm") bytes of wasm"
