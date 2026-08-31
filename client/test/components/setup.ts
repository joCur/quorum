import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

/**
 * jsdom stubs for the browser APIs the app reads but jsdom does not implement.
 *
 * Each one is stubbed at its narrowest useful shape. A stub that quietly returns something
 * plausible for an API a component actually depends on would turn a real bug into a green test,
 * so `matchMedia` reports "no match" (the honest default: no reduced motion, light scheme) and
 * tests that care set it themselves.
 */

/**
 * The Vite-injected version constant. The `define` replacement only reaches the modules the Node
 * suite transforms; in jsdom the identifier is looked up on the global at run time, so a component
 * importing `@/env` would otherwise fail on the import alone.
 */
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = "0.0.0-test";

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

// Radix positions its overlays with a ResizeObserver, which jsdom has no layout engine for.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

// Radix guards dismissable layers with pointer-capture APIs that jsdom leaves unimplemented.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

// Node's own experimental `localStorage` global shadows jsdom's here and arrives without the
// Storage methods, so anything that remembers a preference would throw on read. A plain in-memory
// store restores the API a browser actually offers.
if (typeof window.localStorage?.getItem !== "function") {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, String(value)),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
