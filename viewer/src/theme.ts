// Light, dark or the system's choice. The choice is remembered; the page, the map and the trains switch together.
export type Pref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const KEY = "sbb-twin-theme"; // also read by the script in index.html, before the first paint
/** One cross-fade for the page, the map and the trains: the same length and the same curve. */
export const SWITCH_MS = 500;
/** MapLibre's paint transitions ease in and out (cubic): the page (styles.css) and the trains use the same curve. */
export const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function readPref(): Pref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}
export function savePref(p: Pref) {
  try {
    localStorage.setItem(KEY, p);
  } catch {
    // storage blocked (private mode): the choice holds until the page is closed
  }
}

const query = (q: string) => (typeof matchMedia === "function" ? matchMedia(q) : undefined);
export const systemTheme = (): Theme => (query("(prefers-color-scheme: dark)")?.matches ? "dark" : "light");
export const resolveTheme = (p: Pref): Theme => (p === "system" ? systemTheme() : p);
export function onSystemThemeChange(cb: () => void) {
  const q = query("(prefers-color-scheme: dark)");
  q?.addEventListener("change", cb);
  return () => q?.removeEventListener("change", cb);
}
/** The theme the page shows now: index.html sets it before the first paint. */
export const shownTheme = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
/** Length of a switch: instant for people who ask for less motion. */
export const switchMs = () => (query("(prefers-reduced-motion: reduce)")?.matches ? 0 : SWITCH_MS);

let done: ReturnType<typeof setTimeout> | undefined;
/** The page's colours. While `theme-switching` is on, every colour cross-fades (styles.css); the rest of the time hovers stay instant. */
export function applyPageTheme(theme: Theme, ms: number) {
  const root = document.documentElement;
  if (root.dataset.theme === theme) return;
  clearTimeout(done);
  if (ms > 0) {
    root.style.setProperty("--theme-ms", `${ms}ms`);
    root.classList.add("theme-switching");
    done = setTimeout(() => root.classList.remove("theme-switching"), ms + 120);
  } else root.classList.remove("theme-switching");
  root.dataset.theme = theme;
}
