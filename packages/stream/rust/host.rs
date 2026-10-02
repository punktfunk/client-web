//! The console on a canvas: `pf-console-ui`'s whole shell — hosts, library, settings — drawn by
//! Skia's `DirectContext` over the WebGL2 context `pf-glue.js` made current, one `Surface`
//! wrapping the drawing buffer, re-wrapped when the canvas resizes.
//!
//! The page is the shell's host, as Android and Apple are: it pushes the model as
//! `pf_console_ui::bridge` JSON and reads back what the shell raised through
//! `pf_console_event`, one JSON value per call. Apple's C ABI
//! (`clients/apple/native/src/console.rs`) is the model; the push kinds keep its numbers.
//!
//! Single-threaded by construction — the page's `requestAnimationFrame` and every event handler
//! land on the same wasm thread — so the state is a `RefCell` in a `thread_local!`. Events leave
//! only once that borrow is released: a handler that pushes straight back must not find it held.

use pf_client_core::console::{PointerButton, PointerInput, SessionPhase};
use pf_client_core::menu_nav::{MenuNav, MenuSample};
use pf_console_ui::bridge::{
    CreateOptions, EntryJson, Event, Pads, PadsJson, PresetJson, Published,
};
use pf_console_ui::{
    decode_poster_off_thread, Console, ConsoleHandles, HostRow, InputSource, Key, LibraryGame,
    LibraryPhase, PairPhase, Platform, SnapshotStore, Stale, Viewport, WakeStatus,
};
use skia_safe::gpu::{self, DirectContext, SurfaceOrigin};
use skia_safe::{Color, ColorType, Surface};
use std::cell::RefCell;
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// GL_RGBA8 — the sized internal format of a WebGL2 drawing buffer created with `alpha: true`.
/// The UI canvas is the transparent one: video composites underneath it (plan §1 R1).
const GL_RGBA8: u32 = 0x8058;

/// Skia's resource budget. A quarter of the desktop's 160 MB: the page shares one heap with the
/// decoder and the browser, and plan §5.5 makes the wasm ceiling a thing we measure rather than
/// assume. Raise it only against that measurement.
const GPU_CACHE_BYTES: usize = 40 << 20;

/// A frame at most this often once the console is idle, as on Apple.
const IDLE_FRAME: Duration = Duration::from_micros(33_333);

/// Covers decoded per frame. The shell's own decoder runs on a thread a browser page cannot
/// start, so they are decoded here, a few a frame, and a filling shelf does not stutter.
const ART_PER_FRAME: usize = 3;

unsafe extern "C" {
    /// Bring up a WebGL2 context on the UI canvas and make it current; `1` on success. Defined in
    /// `pf-glue.ts`, which is the only place a browser or GL object is named (plan §1 R2).
    fn pf_gl_setup() -> i32;
    /// One thing the shell raised: a bridge event (`{"action": …}`, `{"settings": …}`, …) or
    /// `{"cmd": ConsoleCmd}`. UTF-8, borrowed for the call.
    fn pf_console_event(ptr: *const u8, len: u32);
}

struct App {
    console: Console,
    gpu: DirectContext,
    surface: Option<Surface>,
    size: (i32, i32),
    /// When the last frame was drawn; an idle console draws at most every [`IDLE_FRAME`].
    drawn: Option<Instant>,
    /// The canvas was cleared for a stream and holds nothing of the console.
    cleared: bool,
    store: Arc<SnapshotStore>,
    handles: ConsoleHandles,
    published: Published,
    pads: Pads,
    nav: MenuNav,
    /// Covers waiting to be decoded: the shell publishes the scale once a shelf has drawn.
    art: VecDeque<(String, Vec<u8>)>,
}

thread_local! {
    static APP: RefCell<Option<App>> = const { RefCell::new(None) };
}

/// Run `f` on the console, then hand the page what it raised. `default` when none is up.
fn with_app<T>(default: T, f: impl FnOnce(&mut App) -> T) -> T {
    let (value, out) = APP.with(|a| match a.borrow_mut().as_mut() {
        Some(app) => {
            let value = f(app);
            (value, app.drain())
        }
        None => (default, Vec::new()),
    });
    for json in out {
        // SAFETY: the glue reads `len` bytes at `ptr` and returns before this does.
        unsafe { pf_console_event(json.as_ptr(), json.len() as u32) };
    }
    value
}

/// `len` bytes at `ptr` as UTF-8.
///
/// # Safety
/// `ptr` is null or points to `len` readable bytes for the call.
unsafe fn utf8<'a>(ptr: *const u8, len: u32) -> Option<&'a str> {
    if ptr.is_null() {
        return None;
    }
    // SAFETY: the caller guarantees `len` readable bytes at `ptr`.
    std::str::from_utf8(unsafe { std::slice::from_raw_parts(ptr, len as usize) }).ok()
}

fn json<T: serde::de::DeserializeOwned>(text: &str) -> Option<T> {
    serde_json::from_str(text)
        .inspect_err(|e| println!("punktfunk-web: console: bad JSON from the page: {e}"))
        .ok()
}

/// Bring up GL, Skia and the shell. `options` is the bridge's `CreateOptions` as JSON: the
/// device name and the settings snapshot the page kept. `0` on failure — the page then keeps
/// its own interface rather than a blank canvas.
///
/// # Safety
/// `options` points to `len` readable bytes of UTF-8 for the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pf_start(options: *const u8, len: u32) -> i32 {
    // SAFETY: the caller guarantees `len` readable bytes at `options`.
    let Some(opts) = unsafe { utf8(options, len) }.and_then(json::<CreateOptions>) else {
        return 0;
    };
    match start(opts) {
        Ok(app) => {
            APP.with(|a| *a.borrow_mut() = Some(app));
            1
        }
        Err(e) => {
            println!("punktfunk-web: console start failed: {e:#}");
            0
        }
    }
}

fn start(opts: CreateOptions) -> anyhow::Result<App> {
    // SAFETY: `pf_gl_setup` is the js-library function linked from `pf-glue.ts`; it takes no
    // arguments, touches no wasm memory, and returns a plain int.
    if unsafe { pf_gl_setup() } != 1 {
        anyhow::bail!("no WebGL2 context on the UI canvas");
    }
    let interface = gpu::gl::Interface::new_native()
        .ok_or_else(|| anyhow::anyhow!("Skia: no GL interface (is a context current?)"))?;
    let mut context = gpu::direct_contexts::make_gl(interface, None)
        .ok_or_else(|| anyhow::anyhow!("Skia: DirectContext over WebGL2 failed"))?;
    context.set_resource_cache_limit(GPU_CACHE_BYTES);
    // A packaged Samsung TV page says so at start; the kit then answers with the page's rows,
    // a remote's glyphs, and an exit on Back at the root.
    let platform = if opts.tizen {
        Platform::Tizen
    } else {
        Platform::Web
    };
    let (mut opts, entry, store) = opts.into_console(platform);
    // A Vulkan compute codec: a browser has no device to run it on.
    opts.pyrowave_ok = false;
    opts.gpu_cache_bytes = GPU_CACHE_BYTES;
    let handles = ConsoleHandles::new();
    let console = Console::new(opts, entry, &handles)?;
    let published = Published::new(&console, &store);
    println!("punktfunk-web: console up");
    Ok(App {
        console,
        gpu: context,
        surface: None,
        size: (0, 0),
        drawn: None,
        cleared: false,
        store,
        handles,
        published,
        pads: (None, None, Vec::new()),
        nav: MenuNav::new(),
        art: VecDeque::new(),
    })
}

/// Draw one frame at the canvas's current device-pixel size. Called from `requestAnimationFrame`.
#[unsafe(no_mangle)]
pub extern "C" fn pf_frame(width: i32, height: i32) {
    with_app((), |app| app.draw(width, height));
}

/// One key, as `console.ts` mapped it from `KeyboardEvent.code`. `key` indexes [`KEYS`]; anything
/// else is dropped, which is how the page keeps browser shortcuts working. `1` = the shell used it.
#[unsafe(no_mangle)]
pub extern "C" fn pf_key(key: i32, shift: i32, repeat: i32) -> i32 {
    let Some(&k) = usize::try_from(key).ok().and_then(|i| KEYS.get(i)) else {
        return 0;
    };
    with_app(0, |app| {
        i32::from(app.console.key(k, shift != 0, repeat != 0))
    })
}

/// Typed text while the shell is editing a field.
///
/// # Safety
/// `ptr` points to `len` readable bytes of UTF-8 for the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pf_console_text(ptr: *const u8, len: u32) {
    // SAFETY: the caller guarantees `len` readable bytes at `ptr`.
    let Some(text) = (unsafe { utf8(ptr, len) }) else {
        return;
    };
    with_app((), |app| app.console.text(text));
}

/// A pointer in canvas pixels: kind 0 move, 1 primary down, 2 primary up, 3 secondary down
/// (Back), 4 wheel (`dy` steps, + = up), 5 cancel, 6 primary down from a finger (deferred, so a
/// swipe scrolls). `1` = the shell used it.
#[unsafe(no_mangle)]
pub extern "C" fn pf_console_pointer(kind: u32, x: f32, y: f32, dy: f32) -> i32 {
    let down = |button, touch| PointerInput::Down {
        x,
        y,
        button,
        touch,
    };
    let input = match kind {
        0 => PointerInput::Move { x, y },
        1 => down(PointerButton::Primary, false),
        2 => PointerInput::Up {
            x,
            y,
            button: PointerButton::Primary,
        },
        3 => down(PointerButton::Secondary, false),
        4 => PointerInput::Wheel { x, y, dy },
        5 => PointerInput::Cancel,
        6 => down(PointerButton::Primary, true),
        _ => return 0,
    };
    with_app(0, |app| i32::from(app.console.pointer(input)))
}

/// Every pad the page reads, merged into one sample: bits 0–5 are A, B, X, Y, L1, R1 and bits
/// 6–9 the D-pad's up, down, left, right; the left stick is SDL's range, +y down. Called once a
/// frame, held or not, so a held direction repeats.
#[unsafe(no_mangle)]
pub extern "C" fn pf_console_pad(buttons: u32, lx: i32, ly: i32) {
    let bit = |i: u32| buttons & (1 << i) != 0;
    let sample = MenuSample {
        buttons: [bit(0), bit(1), bit(2), bit(3), bit(4), bit(5)],
        lx: lx.clamp(-32768, 32767) as i16,
        ly: ly.clamp(-32768, 32767) as i16,
        dpad: [bit(6), bit(7), bit(8), bit(9)],
    };
    with_app((), |app| {
        let mut events = Vec::new();
        app.nav.poll(&sample, Instant::now(), &mut events);
        for e in events {
            app.console.menu(e, InputSource::Pad);
        }
    });
}

/// Where the session the shell asked for stands: 0 connecting, 1 streaming, 2 failed, 3 ended
/// (`message` empty = a clean end), 4 reconnecting.
///
/// # Safety
/// `ptr` points to `len` readable bytes of UTF-8 for the call, or is null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pf_console_phase(phase: u32, ptr: *const u8, len: u32) {
    // SAFETY: the caller guarantees `len` readable bytes at `ptr` when it is not null.
    let msg = unsafe { utf8(ptr, len) }.unwrap_or("");
    let phase = match phase {
        0 => SessionPhase::Connecting,
        1 => SessionPhase::Streaming,
        2 => SessionPhase::Failed(msg),
        3 => SessionPhase::Ended((!msg.is_empty()).then_some(msg)),
        4 => SessionPhase::Reconnecting(msg),
        _ => return,
    };
    with_app((), |app| {
        // A pad held across the stream's edges must not fire into the other side.
        if matches!(
            phase,
            SessionPhase::Streaming | SessionPhase::Ended(_) | SessionPhase::Failed(_)
        ) {
            app.nav.reset();
        }
        app.console.session_phase(phase);
    });
}

/// What the shell shows, as bits: 1 it is off screen for a stream, 2 a launch hold keeps it over
/// the stream, 4 a field is being edited, 8 Back at this point would leave it.
#[unsafe(no_mangle)]
pub extern "C" fn pf_console_state() -> u32 {
    APP.with(|a| {
        a.borrow().as_ref().map_or(0, |app| {
            u32::from(app.console.in_stream())
                | u32::from(app.console.holds_launch()) << 1
                | u32::from(app.console.editing()) << 2
                | u32::from(app.console.at_root()) << 3
        })
    })
}

// `pf_console_push` kinds, each with the JSON it takes. The numbers are Apple's.

/// `[HostRow]` — the home carousel.
const PUSH_HOSTS: u32 = 0;
/// `"Idle"`, `"Busy"`, `{"Failed": "why"}` or `{"Paired": {"key": "…"}}`.
const PUSH_PAIR: u32 = 1;
/// `WakeStatus`, or `null` to clear.
const PUSH_WAKE: u32 = 2;
/// A JSON string: a one-shot toast.
const PUSH_NOTICE: u32 = 3;
/// Anything: a library fetch is starting for the shelf on screen.
const PUSH_LIBRARY_BEGIN: u32 = 5;
/// `"Loading"`, `"Empty"`, `"Ready"` or `{"Error": {"title", "body", "can_retry"}}`.
const PUSH_LIBRARY_PHASE: u32 = 6;
/// `[LibraryGame]` — the fetched catalog.
const PUSH_LIBRARY_GAMES: u32 = 7;
/// `[{"app_id", "state"}]` — the host's running games.
const PUSH_LIBRARY_RUNNING: u32 = 9;
/// `0` fresh, `1` waking, `2` offline.
const PUSH_LIBRARY_STALE: u32 = 10;
/// `Settings` changed elsewhere; the shell reads it on its next change. Not a save.
const PUSH_SETTINGS: u32 = 11;
/// `[{id, name, overrides}]` — the preset catalog.
const PUSH_PRESETS: u32 = 12;
/// `KnownHosts` — the records `punktfunk://` links are built from.
const PUSH_KNOWN_HOSTS: u32 = 13;
/// `{"label", "pref", "pads": [PadInfo]}` — the connected controllers.
const PUSH_PADS: u32 = 14;
/// `{}` for Home, `{"library": HostRow}` for a shelf — re-roots before the next frame.
const PUSH_NAVIGATE: u32 = 15;

/// Hand the shell a model update. A bad kind or bad JSON is a logged no-op.
///
/// # Safety
/// `ptr` points to `len` readable bytes of UTF-8 for the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pf_console_push(kind: u32, ptr: *const u8, len: u32) {
    // SAFETY: the caller guarantees `len` readable bytes at `ptr`.
    let Some(text) = (unsafe { utf8(ptr, len) }) else {
        return;
    };
    with_app((), |app| {
        let (console, library) = (&app.handles.console, &app.handles.library);
        let done = match kind {
            PUSH_HOSTS => json::<Vec<HostRow>>(text).map(|v| console.set_hosts(v)),
            PUSH_PAIR => json::<PairPhase>(text).map(|v| console.set_pair(v)),
            PUSH_WAKE => json::<Option<WakeStatus>>(text).map(|v| console.set_wake(v)),
            PUSH_NOTICE => json::<String>(text).map(|v| console.set_notice(v)),
            PUSH_LIBRARY_BEGIN => {
                library.begin_fetch();
                // The fetch clears the shelf's art; covers queued for the last one are stale.
                app.art.clear();
                Some(())
            }
            PUSH_LIBRARY_PHASE => json::<LibraryPhase>(text).map(|v| library.set_phase(v)),
            PUSH_LIBRARY_GAMES => json::<Vec<LibraryGame>>(text).map(|v| library.set_games(v)),
            PUSH_LIBRARY_RUNNING => json::<Vec<pf_client_core::library::RunningGame>>(text)
                .map(|v| library.set_running(&v)),
            PUSH_LIBRARY_STALE => json::<u8>(text).map(|v| {
                library.set_stale(match v {
                    1 => Stale::Waking,
                    2 => Stale::Offline,
                    _ => Stale::No,
                });
            }),
            PUSH_SETTINGS => json(text).map(|v| app.store.set(v)),
            PUSH_PRESETS => json::<Vec<PresetJson>>(text).map(|v| {
                app.store
                    .set_presets(v.into_iter().map(Into::into).collect())
            }),
            PUSH_KNOWN_HOSTS => json(text).map(|v| app.store.set_known_hosts(v)),
            PUSH_PADS => json::<PadsJson>(text).map(|mut v| {
                console.set_other_devices(v.take_others());
                app.pads = v.into_pads();
            }),
            PUSH_NAVIGATE => json::<EntryJson>(text).map(|v| app.console.navigate(v.into_entry())),
            _ => None,
        };
        if done.is_none() {
            println!("punktfunk-web: console push {kind} ignored");
        }
    });
}

/// One title's cover, encoded (JPEG/PNG). Decoded a few a frame once a shelf has said at what
/// scale.
///
/// # Safety
/// `id` points to `id_len` readable bytes of UTF-8 and `bytes` to `len` readable bytes, for the
/// call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pf_console_art(id: *const u8, id_len: u32, bytes: *const u8, len: u32) {
    // SAFETY: the caller guarantees `id_len` readable bytes at `id`.
    let Some(id) = (unsafe { utf8(id, id_len) }) else {
        return;
    };
    if bytes.is_null() || len == 0 {
        return;
    }
    // SAFETY: the caller guarantees `len` readable bytes at `bytes`.
    let bytes = unsafe { std::slice::from_raw_parts(bytes, len as usize) }.to_vec();
    with_app((), |app| app.art.push_back((id.to_string(), bytes)));
}

/// The page's key table, by index. Order is the wire between `console.ts` and here; append only.
const KEYS: [Key; 13] = [
    Key::Left,
    Key::Right,
    Key::Up,
    Key::Down,
    Key::Return,
    Key::Space,
    Key::Escape,
    Key::Backspace,
    Key::PageUp,
    Key::PageDown,
    Key::Tab,
    Key::Y,
    Key::X,
];

impl App {
    fn draw(&mut self, width: i32, height: i32) {
        if width <= 0 || height <= 0 {
            return;
        }
        self.decode_art();
        if self.surface.is_none() || self.size != (width, height) {
            self.surface = self.wrap(width, height);
            self.size = (width, height);
            self.drawn = None;
            self.cleared = false;
        }
        let Some(surface) = self.surface.as_mut() else {
            return;
        };
        // Off screen for a stream: clear once so the picture shows, then leave the canvas be.
        if self.console.in_stream() && !self.console.holds_launch() {
            if !self.cleared {
                surface.canvas().clear(Color::TRANSPARENT);
                self.gpu.flush_and_submit();
                self.cleared = true;
            }
            return;
        }
        self.cleared = false;
        let now = Instant::now();
        if self.console.idle() && self.drawn.is_some_and(|at| now - at < IDLE_FRAME) {
            return;
        }
        let viewport = Viewport::plain(width as u32, height as u32);
        let (label, pref, pads) = &self.pads;
        self.console
            .frame(surface.canvas(), &viewport, label.as_deref(), *pref, pads);
        self.gpu.flush_and_submit();
        self.drawn = Some(now);
    }

    /// A few queued covers, at the scale the shelf asked for. Nothing until a shelf has drawn.
    fn decode_art(&mut self) {
        let Some(k) = self.handles.library.art_scale() else {
            return;
        };
        for _ in 0..ART_PER_FRAME {
            let Some((id, bytes)) = self.art.pop_front() else {
                return;
            };
            if let Some(poster) = decode_poster_off_thread(&bytes, k) {
                self.handles.library.push_decoded(id, poster);
            }
        }
    }

    /// What the shell raised since the last call, as the JSON `pf_console_event` carries.
    fn drain(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        self.published
            .publish(&mut self.console, &self.store, |e: Event| {
                out.push(e.to_json())
            });
        for cmd in self.handles.bus.drain() {
            match serde_json::to_string(&cmd) {
                Ok(c) => out.push(format!("{{\"cmd\":{c}}}")),
                Err(e) => println!("punktfunk-web: console command not sent: {e}"),
            }
        }
        out
    }

    /// A Skia surface over the WebGL2 drawing buffer (framebuffer 0). No MSAA and no stencil: the
    /// console asks for neither, and both cost memory on a page that will also hold decoded video.
    fn wrap(&mut self, width: i32, height: i32) -> Option<Surface> {
        let fb = gpu::gl::FramebufferInfo {
            fboid: 0,
            format: GL_RGBA8,
            protected: gpu::Protected::No,
        };
        let target = gpu::backend_render_targets::make_gl((width, height), None, 0, fb);
        gpu::surfaces::wrap_backend_render_target(
            &mut self.gpu,
            &target,
            SurfaceOrigin::BottomLeft,
            ColorType::RGBA8888,
            None,
            None,
        )
    }
}
