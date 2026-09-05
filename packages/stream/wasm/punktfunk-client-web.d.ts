// The shape of what `build.sh` puts beside this file: emscripten's `MODULARIZE` + `EXPORT_ES6`
// output, a default-exported factory. Generated code has no types of its own; this is the one
// line that gives it some.
import type { PunktfunkModule } from "../src/emscripten.ts";
export default function PunktfunkWeb(moduleArg?: object): Promise<PunktfunkModule>;
