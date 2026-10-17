import type { Config } from "tailwindcss";
import { DUR, EASE_IN, EASE_IN_OUT, EASE_OUT, PROGRESS_T, cssEase, cssMs } from "./components/motion/tokens";

// The CSS half of the motion system mirrors components/motion/tokens.ts.
const OUT = cssEase(EASE_OUT);
const IN = cssEase(EASE_IN);
const IN_OUT = cssEase(EASE_IN_OUT);
/** About 10% overshoot: the playful pop of an icon landing. */
const POP = "cubic-bezier(0.34, 1.3, 0.64, 1)";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
      },
      transitionTimingFunction: {
        out: OUT,
        in: IN,
        "in-out": IN_OUT,
      },
      transitionDuration: {
        tap: cssMs(DUR.tap),
        fast: cssMs(DUR.fast),
        base: cssMs(DUR.base),
        slow: cssMs(DUR.slow),
        hero: cssMs(DUR.hero),
        progress: cssMs(PROGRESS_T),
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        // Entrances. CSS rather than JS so server-rendered content paints
        // without waiting for hydration.
        rise: {
          from: { opacity: "0", transform: "translateY(var(--rise, 12px))" },
          to: { opacity: "1", transform: "none" },
        },
        // Transform only, rising out of an overflow mask. It starts with most
        // of each glyph already showing, so the text is painted (and counted
        // for LCP, which ignores text fully clipped at first paint) at once.
        "rise-mask": {
          from: { transform: "translateY(35%)" },
          to: { transform: "none" },
        },
        "rise-soft": {
          from: { transform: "translateY(8px)" },
          to: { transform: "none" },
        },
        pop: {
          from: { opacity: "0", transform: "scale(0.6)" },
          to: { opacity: "1", transform: "none" },
        },
        fade: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        // Ambient loops: transform and opacity only, paused offscreen.
        twinkle: {
          "0%, 100%": { opacity: "0.15" },
          "50%": { opacity: "1" },
        },
        "aurora-1": {
          "0%, 100%": { transform: "translate(0, 0) scale(1)" },
          "50%": { transform: "translate(80px, 60px) scale(1.15)" },
        },
        "aurora-2": {
          "0%, 100%": { transform: "translate(0, 0) scale(1)" },
          "50%": { transform: "translate(-70px, 50px) scale(0.9)" },
        },
        "aurora-3": {
          "0%, 100%": { transform: "translate(0, 0) scale(1)" },
          "50%": { transform: "translate(50px, -60px) scale(1.1)" },
        },
        "pulse-slow": {
          "0%, 100%": { opacity: "0.6" },
          "50%": { opacity: "1" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0) rotate(-2deg)" },
          "50%": { transform: "translateY(-12px) rotate(2deg)" },
        },
        bob: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-8px)" },
        },
        typing: {
          "0%, 100%": { transform: "translateY(0)", opacity: "0.4" },
          "50%": { transform: "translateY(-4px)", opacity: "1" },
        },
        wobble: {
          "0%, 100%": { transform: "rotate(-4deg)" },
          "50%": { transform: "rotate(4deg)" },
        },
        spin: { to: { transform: "rotate(360deg)" } },
        "spin-reverse": { to: { transform: "rotate(-360deg)" } },
        // One sweep across a symmetric gradient, ending where it rests.
        shimmer: {
          from: { backgroundPosition: "100% 0" },
          to: { backgroundPosition: "0% 0" },
        },
        skeleton: {
          from: { backgroundPosition: "100% 0" },
          to: { backgroundPosition: "-100% 0" },
        },
        progress: {
          from: { transform: "translateX(-100%)" },
          to: { transform: "translateX(250%)" },
        },
      },
      animation: {
        "accordion-down": `accordion-down ${cssMs(DUR.base)} ${IN_OUT}`,
        "accordion-up": `accordion-up ${cssMs(DUR.fast)} ${IN}`,
        "fade-in": `fade-in ${cssMs(DUR.base)} ${OUT}`,
        // First-paint entrances. "backwards" hides an element during its delay
        // and leaves no transform behind, so hover transforms still apply.
        rise: `rise ${cssMs(DUR.slow)} ${OUT} backwards`,
        "rise-mask": `rise-mask ${cssMs(DUR.hero)} ${OUT} backwards`,
        "rise-soft": `rise-soft ${cssMs(DUR.slow)} ${OUT} backwards`,
        pop: `pop 0.45s ${POP} backwards`,
        fade: `fade ${cssMs(DUR.slow)} ${OUT} backwards`,
        twinkle: "twinkle 3s ease-in-out infinite",
        "aurora-1": "aurora-1 18s ease-in-out infinite",
        "aurora-2": "aurora-2 22s ease-in-out infinite",
        "aurora-3": "aurora-3 26s ease-in-out infinite",
        "pulse-slow": "pulse-slow 5s ease-in-out infinite",
        float: "float 6s ease-in-out infinite",
        bob: "bob 4.5s ease-in-out infinite",
        typing: "typing 0.9s ease-in-out infinite",
        wobble: "wobble 3s ease-in-out infinite",
        // A working-state glyph: CSS, so it keeps turning while the page is busy.
        glyph: "spin 1.6s linear infinite",
        "spin-slow": "spin 80s linear infinite",
        "spin-slow-reverse": "spin-reverse 80s linear infinite",
        shimmer: `shimmer 1.6s ${OUT} 0.2s backwards`,
        skeleton: "skeleton 1.6s linear infinite",
        progress: `progress 1.1s ${IN_OUT} infinite`,
      },
    },
  },
  plugins: [
    require("tailwindcss-animate"),
    // The same tokens as custom properties, for rules in globals.css.
    ({ addBase }: { addBase: (base: Record<string, Record<string, string>>) => void }) => {
      addBase({
        ":root": {
          "--dur-fast": cssMs(DUR.fast),
          "--dur-base": cssMs(DUR.base),
          "--dur-slow": cssMs(DUR.slow),
          "--ease-out": OUT,
          "--ease-in": IN,
          "--ease-in-out": IN_OUT,
        },
      });
    },
    // Touch screens: bigger targets where a finger, not a mouse, is the pointer.
    ({ addVariant }: { addVariant: (name: string, def: string) => void }) => {
      addVariant("pointer-coarse", "@media (pointer: coarse)");
      addVariant("pointer-fine", "@media (pointer: fine)");
      addVariant("hover-none", "@media (hover: none)");
      // Landscape phones vs. tablets and up: the editor toolbar's two layouts.
      addVariant("short", "@media (max-height: 500px)");
      addVariant("tall", "@media (min-width: 768px) and (min-height: 501px)");
    },
  ],
};

export default config;
