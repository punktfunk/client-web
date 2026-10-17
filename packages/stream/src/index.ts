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
  type HostTarget,
  type HudLine,
  type SessionStats,
  type StreamOptions,
  type TunableOptions,
} from "./engine.ts";
export { DEFAULTS, settings, type Settings, type StatsTier } from "./settings.ts";
export type { AudioSnapshot, AudioState } from "./audio.ts";
export { Host, type HostAction, type HostInfo, type HostStatus, type LibraryEntry, VersionSkew } from "./host.ts";
export { type GameEnd, gameEndNotice, gameEndOf, gameGone } from "./game-end.ts";
export { captureLog, pageLog } from "./logs.ts";
export {
  CONSOLE_PUSH,
  CONSOLE_STATE,
  type ConsoleAction,
  type ConsoleCmd,
  type ConsoleEvent,
  type ConsoleGame,
  type ConsoleHostRow,
} from "./console-bridge.ts";
export { bootstrap, bootstrapUrl, hosts, originOf, reach, reachTarget, type Bootstrap, type KnownHost, type Plane, type Reach } from "./pf-connect.ts";
export { deviceName, exitApp, packaged, remoteKey, tizen, tizenInfo } from "./platform.ts";
export { tunnelFetch, type TunnelFetch } from "./tunnel.ts";
export { tvBack } from "./input.ts";
export { type LinkError, linkFor, type PageLink, parseLink } from "./links.ts";
export type { VideoPlane, UploadStats } from "./video-surface.ts";
