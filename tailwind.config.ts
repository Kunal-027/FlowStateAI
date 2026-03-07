import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: "hsl(var(--destructive))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      keyframes: {
        "pulse-subtle": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.7" },
        },
        "healing-glow": {
          "0%, 100%": { boxShadow: "0 0 0 0 hsl(var(--accent) / 0.3)" },
          "50%": { boxShadow: "0 0 12px 2px hsl(var(--accent) / 0.5)" },
        },
        "retry-pulse": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.85", transform: "scale(1.02)" },
        },
        "stream-pulse": {
          "0%, 100%": { opacity: "0.4", boxShadow: "0 0 0 0 hsl(var(--accent) / 0.2)" },
          "50%": { opacity: "0.8", boxShadow: "0 0 24px 4px hsl(var(--accent) / 0.15)" },
        },
      },
      animation: {
        "pulse-subtle": "pulse-subtle 1.5s ease-in-out infinite",
        "healing-glow": "healing-glow 1.2s ease-in-out infinite",
        "retry-pulse": "retry-pulse 0.8s ease-in-out infinite",
        "stream-pulse": "stream-pulse 2s ease-in-out infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
