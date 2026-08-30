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

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
