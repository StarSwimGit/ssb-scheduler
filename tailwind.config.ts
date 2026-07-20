import type { Config } from "tailwindcss";

// Race-day palette. Includes back-compat aliases for old token names
// so existing pages (checkout, order, admin, product-detail) keep working
// while wearing the new dark theme.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // New tokens
        deep: "#050f1a",
        deep2: "#071726",
        panel: "#081b2c",
        panel2: "#0b2438",
        lane: "#0a2237",
        cyan: {
          DEFAULT: "#29b6e8",
          bright: "#38d6f0",
          soft: "#7fe9f7",
          ice: "#cfeef8"
        },
        text: {
          hi: "#eef8ff",
          body: "#cddced",
          mute: "#a9c2d6",
          dim: "#7f9cb4",
          faint: "#5c7086"
        },
        edge: "rgba(125,220,250,.14)",
        edgeStrong: "rgba(125,220,250,.28)",

        // Back-compat aliases → point old names at the new dark palette
        navy: "#eef8ff",   // used for headings; make it bright on dark
        ink: "#cddced",    // body copy
        aqua: {
          DEFAULT: "#38d6f0",
          dark: "#29b6e8",
          pale: "rgba(56,214,240,.14)"
        },
        foam: "rgba(255,255,255,.03)",
        buoy: "#ff8a70",
        line: "rgba(125,220,250,.18)"
      },
      fontFamily: {
        display: ["Anton", "Impact", "sans-serif"],
        sans: ["'Barlow Semi Condensed'", "system-ui", "sans-serif"],
        head: ["Archivo", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "monospace"]
      },
      boxShadow: {
        cta: "0 16px 38px -12px rgba(41,182,232,.75)",
        card: "0 26px 50px -26px rgba(41,182,232,.55)",
        hero: "0 40px 90px -35px rgba(6,22,38,.75)",
        soft: "0 2px 16px rgba(0,0,0,.35)",
        lift: "0 12px 28px rgba(0,0,0,.4)"
      }
    }
  },
  plugins: []
};
export default config;
