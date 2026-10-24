import { useEffect, useState } from "react";

/** Reactive media-query hook; initial value is computed synchronously so the
 *  first render already picks the right layout (no desktop/mobile flash).
 *  A window resize listener backs up the media change event because some
 *  embedded webviews resize without dispatching MediaQueryList changes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    window.addEventListener("resize", update);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, [query]);
  return matches;
}
