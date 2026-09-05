// The web-native interface: DOM, pointer, touch and a text field.
//
// The alternative to `console.ts`, which is the gamepad shell every punktfunk client shares. That
// one is built for a D-pad across a room and cannot offer a text field at all; this one is built
// for the thing actually holding the browser — a mouse, a trackpad, a phone. Same `Screen`
// values, same `Actions`, no state of its own beyond what is on screen.
//
// Everything is built with `textContent`, never `innerHTML`: host names and error strings come
// from the network and from the user.

import type { LibraryEntry } from "@punktfunk/stream";
import type { Actions, Screen, SessionStats, Ui } from "./types.ts";

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export class WebShell implements Ui {
  private readonly root: HTMLElement;
  private actions!: Actions;
  /** The last screen rendered, so `render` can skip rebuilding an unchanged one — a stats tick
   *  arrives every second and must not steal focus from the field someone is typing in. */
  private last: Screen["kind"] | null = null;
  private overlayTimer = 0;

  constructor(container: HTMLElement) {
    this.root = el("div", "pf-shell");
    container.append(this.root);
  }

  mount(actions: Actions): void {
    this.actions = actions;
  }

  render(screen: Screen): void {
    // Streaming redraws often; the others are rebuilt only when the screen actually changes.
    if (screen.kind === "streaming" && this.last === "streaming") {
      this.updateStats(screen.stats);
      return;
    }
    // The library redraws as art arrives, and rebuilding it would drop the scroll position.
    if (screen.kind === "library" && this.last === "library") {
      this.root.replaceChildren();
      this.root.dataset["screen"] = screen.kind;
      this.library(screen);
      return;
    }
    this.last = screen.kind;
    this.root.replaceChildren();
    this.root.dataset["screen"] = screen.kind;

    switch (screen.kind) {
      case "picker":
        this.picker(screen);
        break;
      case "accept":
        this.accept(screen);
        break;
      case "connecting":
        this.root.append(this.card("Connecting", [el("p", "sub", screen.origin), this.spinner()]));
        break;
      case "pair":
        this.pair(screen);
        break;
      case "library":
        this.library(screen);
        break;
      case "streaming":
        this.streaming(screen.stats);
        break;
      case "error":
        this.error(screen);
        break;
    }
  }

  // The library. A grid of what the host offers, which is the screen a browser could not draw
  // at all until it could authenticate to the management API.
  private library(screen: Screen & { kind: "library" }): void {
    const head = el("header", "bar");
    head.append(el("h1", undefined, screen.host ?? screen.origin.replace(/^https:\/\//, "")));
    const stream = el("button", "primary small", "Stream the desktop");
    stream.addEventListener("click", () => this.actions.play());
    const leave = el("button", "ghost small", "Disconnect");
    leave.addEventListener("click", () => this.actions.disconnect());
    head.append(stream, leave);
    this.root.append(head);

    if (screen.error) this.root.append(this.errorLine(screen.error));
    if (screen.busy && !screen.entries.length) {
      this.root.append(this.spinner());
      return;
    }
    if (!screen.entries.length) {
      this.root.append(
        el("p", "sub empty", "This host's library is empty, or nothing has been added to it yet."),
      );
      return;
    }

    const grid = el("div", "grid");
    for (const entry of screen.entries) grid.append(this.tile(entry, screen.art.get(entry.id)));
    this.root.append(grid);
  }

  private tile(entry: LibraryEntry, art: string | undefined): HTMLElement {
    const tile = el("button", "tile");
    tile.setAttribute("aria-label", entry.title);
    const cover = el("div", "cover");
    if (art) {
      const img = el("img");
      img.src = art;
      img.alt = "";
      img.loading = "lazy";
      cover.append(img);
    } else {
      // No art is the common case on a fresh host; an initial reads better than a broken image.
      cover.append(el("span", "initial", entry.title.slice(0, 1).toUpperCase()));
    }
    tile.append(cover, el("span", "title", entry.title));
    tile.addEventListener("click", () => this.actions.play(entry));
    return tile;
  }

  private card(title: string, body: Node[]): HTMLElement {
    const card = el("section", "card");
    card.append(el("h1", undefined, title), ...body);
    return card;
  }

  private spinner(): HTMLElement {
    const s = el("div", "spinner");
    s.setAttribute("role", "status");
    s.setAttribute("aria-label", "Working");
    return s;
  }

  private picker(screen: Screen & { kind: "picker" }): void {
    const field = el("input", "addr");
    field.type = "text";
    field.placeholder = "192.168.1.25";
    field.autocomplete = "off";
    field.spellcheck = false;
    field.setAttribute("aria-label", "Host address");
    field.disabled = !!screen.busy;

    const go = el("button", "primary", screen.busy ? "Connecting…" : "Connect");
    go.disabled = !!screen.busy;
    const submit = () => this.actions.connect(field.value);
    go.addEventListener("click", submit);
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });

    const body: Node[] = [
      el("p", "sub", "The address of a machine running punktfunk on your network."),
      field,
    ];
    if (screen.error) body.push(this.errorLine(screen.error));
    body.push(go);

    if (screen.hosts.length) {
      const list = el("div", "known");
      list.append(el("p", "label", "Known hosts"));
      for (const host of screen.hosts) {
        const row = el("div", "row");
        const open = el("button", "ghost");
        open.append(
          el("span", "name", host.name ?? host.origin.replace(/^https:\/\//, "")),
          el("span", "meta", host.fingerprint ? "paired" : "not paired"),
        );
        open.addEventListener("click", () => this.actions.connect(host.origin));
        const drop = el("button", "icon", "✕");
        drop.title = `Forget ${host.origin}`;
        drop.setAttribute("aria-label", `Forget ${host.origin}`);
        drop.addEventListener("click", () => this.actions.forget(host.origin));
        row.append(open, drop);
        list.append(row);
      }
      body.push(list);
    }

    this.root.append(this.card("Connect to a host", body));
    if (!screen.busy) field.focus();
  }

  private accept(screen: Screen & { kind: "accept" }): void {
    const link = el("a", "link", screen.url);
    link.href = screen.url;
    link.target = "_blank";
    link.rel = "noopener";

    const retry = el("button", "primary", "I have accepted it");
    retry.addEventListener("click", () => this.actions.retry());
    const back = el("button", "ghost", "Back");
    back.addEventListener("click", () => this.actions.back());

    this.root.append(
      this.card("Accept this host's certificate", [
        el(
          "p",
          "sub",
          "A punktfunk host signs its own certificate, so your browser will not talk to it " +
            "until you say so once. Open this, accept the warning, then come back.",
        ),
        link,
        el("div", "actions"),
        retry,
        back,
      ]),
    );
  }

  private pair(screen: Screen & { kind: "pair" }): void {
    const pin = el("input", "pin");
    pin.type = "text";
    pin.inputMode = "numeric";
    pin.maxLength = 8;
    pin.autocomplete = "off";
    pin.setAttribute("aria-label", "Pairing PIN");
    pin.disabled = !!screen.busy;

    const go = el("button", "primary", screen.busy ? "Pairing…" : "Pair");
    go.disabled = !!screen.busy;
    const submit = () => {
      const value = pin.value.trim();
      if (value) this.actions.pair(value);
    };
    go.addEventListener("click", submit);
    pin.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });

    const back = el("button", "ghost", "Back");
    back.addEventListener("click", () => this.actions.back());

    const body: Node[] = [el("p", "sub", screen.message), pin];
    if (screen.error) body.push(this.errorLine(screen.error));
    body.push(go, back);
    this.root.append(this.card("Pair with this host", body));
    if (!screen.busy) pin.focus();
  }

  private error(screen: Screen & { kind: "error" }): void {
    const back = el("button", "primary", "Back");
    back.addEventListener("click", () => this.actions.back());
    this.root.append(this.card(screen.head, [el("p", "sub", screen.text), back]));
  }

  private errorLine(text: string): HTMLElement {
    const line = el("p", "err", text);
    line.setAttribute("role", "alert");
    return line;
  }

  // The streaming overlay. Out of the way by default — this is the screen someone came for — and
  // brought back by a pointer, a key or a tap, then hidden again.
  private streaming(stats: SessionStats): void {
    const bar = el("div", "hud");
    bar.append(
      el("span", "dot"),
      el("span", "host", stats.origin.replace(/^https:\/\//, "")),
      el("span", "stat", ""),
    );
    const leave = el("button", "ghost small", "Disconnect");
    leave.addEventListener("click", () => this.actions.disconnect());
    const full = el("button", "ghost small", "Fullscreen");
    full.addEventListener("click", () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
    });
    bar.append(full, leave);
    this.root.append(bar);
    this.updateStats(stats);

    const wake = () => this.wakeOverlay();
    for (const type of ["pointermove", "pointerdown", "keydown"] as const) {
      window.addEventListener(type, wake, { passive: true });
    }
    this.wakeOverlay();
  }

  private updateStats(stats: SessionStats): void {
    const line = this.root.querySelector(".stat");
    if (!line) return;
    const parts = [
      stats.width ? `${stats.width}×${stats.height}` : "",
      stats.fps ? `${stats.fps} fps` : "",
      stats.backend ?? "",
      stats.dropped ? `${stats.dropped} dropped` : "",
    ].filter(Boolean);
    line.textContent = parts.join(" · ");
  }

  private wakeOverlay(): void {
    const hud = this.root.querySelector(".hud");
    if (!hud) return;
    hud.classList.remove("idle");
    clearTimeout(this.overlayTimer);
    this.overlayTimer = window.setTimeout(() => hud.classList.add("idle"), 2600);
  }

  destroy(): void {
    clearTimeout(this.overlayTimer);
    this.root.remove();
  }
}
