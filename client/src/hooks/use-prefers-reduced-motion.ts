import * as React from "react";

/**
 * Tracks the `prefers-reduced-motion` setting.
 *
 * Looping animations are switched off centrally in the token stylesheet, but the
 * recording indicator also drives an inline transform from the live input level.
 * That has to be dropped in JavaScript, which is what this hook is for: with
 * reduced motion the dot is steady and the state is carried by the label alone.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  React.useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return reduced;
}
