// `@punktfunk/stream` — the punktfunk browser engine, as a library.
//
// `Engine.create({ videoCanvas })` loads the wasm module and hands back a state machine: reach a
// host, check it, pair, authenticate, stream. Its `EngineState` carries facts, never wording, so
// any interface can sit on it — the web shell and the gamepad console in `apps/web` are two.
// `Host` is the management API through `@punktfunk/host`, reachable from the `ready` state.

export {
  Engine,
  type EngineOptions,
  type EngineState,
  type SessionStats,
  type StreamOptions,
  type TunableOptions,
} from "./engine.ts";
export { DEFAULTS, settings, type Settings } from "./settings.ts";
export type { AudioSnapshot, AudioState } from "./audio.ts";
export { Host, type HostInfo, type HostStatus, type LibraryEntry, VersionSkew } from "./host.ts";
export { hosts, originOf, reach, type KnownHost, type Plane, type Reach } from "./pf-connect.ts";
export type { VideoPlane, UploadStats } from "./video-surface.ts";
