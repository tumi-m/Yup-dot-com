import type { Config } from "tailwindcss";

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
        out: "cubic-bezier(0.22, 1, 0.36, 1)",
        in: "cubic-bezier(0.55, 0, 1, 0.45)",
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
        "rise-word": {
          from: { opacity: "0", transform: "translateY(100%)" },
          to: { opacity: "1", transform: "none" },
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
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 0.3s cubic-bezier(0.22, 1, 0.36, 1)",
        rise: "rise 0.5s cubic-bezier(0.22, 1, 0.36, 1) both",
        "rise-word": "rise-word 0.5s cubic-bezier(0.22, 1, 0.36, 1) both",
        pop: "pop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both",
        fade: "fade 0.5s cubic-bezier(0.22, 1, 0.36, 1) both",
        twinkle: "twinkle 3s ease-in-out infinite",
        "aurora-1": "aurora-1 18s ease-in-out infinite",
        "aurora-2": "aurora-2 22s ease-in-out infinite",
        "aurora-3": "aurora-3 26s ease-in-out infinite",
        "pulse-slow": "pulse-slow 5s ease-in-out infinite",
        float: "float 6s ease-in-out infinite",
        bob: "bob 4.5s ease-in-out infinite",
        wobble: "wobble 3s ease-in-out infinite",
        "spin-slow": "spin 40s linear infinite",
        "spin-slow-reverse": "spin-reverse 40s linear infinite",
        shimmer: "shimmer 1.6s cubic-bezier(0.22, 1, 0.36, 1) 0.2s both",
        skeleton: "skeleton 1.6s linear infinite",
        progress: "progress 1.1s cubic-bezier(0.65, 0, 0.35, 1) infinite",
      },
    },
  },
  plugins: [
    require("tailwindcss-animate"),
    // Touch screens: bigger targets where a finger, not a mouse, is the pointer.
    ({ addVariant }: { addVariant: (name: string, def: string) => void }) => {
      addVariant("pointer-coarse", "@media (pointer: coarse)");
      addVariant("hover-none", "@media (hover: none)");
      // Landscape phones vs. tablets and up: the editor toolbar's two layouts.
      addVariant("short", "@media (max-height: 500px)");
      addVariant("tall", "@media (min-width: 768px) and (min-height: 501px)");
    },
  ],
};

export default config;
