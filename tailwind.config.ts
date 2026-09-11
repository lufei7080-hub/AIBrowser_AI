/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(220 13% 91%)",
        "border-subtle": "hsl(220 13% 94%)",
        input: "hsl(220 13% 91%)",
        ring: "hsl(222 47% 11%)",
        background: "hsl(0 0% 100%)",
        foreground: "hsl(222 47% 11%)",
        primary: {
          DEFAULT: "hsl(222 47% 11%)",
          foreground: "hsl(210 40% 98%)",
        },
        secondary: {
          DEFAULT: "hsl(210 40% 96%)",
          foreground: "hsl(222 47% 11%)",
        },
        muted: {
          DEFAULT: "hsl(210 40% 96%)",
          foreground: "hsl(215 16% 47%)",
        },
        accent: {
          DEFAULT: "hsl(210 40% 96%)",
          foreground: "hsl(222 47% 11%)",
        },
        card: {
          DEFAULT: "hsl(0 0% 100%)",
          foreground: "hsl(222 47% 11%)",
        },
        "surface-muted": "hsl(210 40% 97%)",
        success: "hsl(142 71% 45%)",
        warning: "hsl(38 92% 50%)",
        destructive: "hsl(0 84% 60%)",
        // 代码/终端深色面：token 化，杜绝硬编码 slate/#0b1220
        code: {
          bg: "hsl(222 47% 8%)",
          border: "hsl(222 40% 16%)",
          text: "hsl(210 40% 90%)",
          muted: "hsl(215 20% 55%)",
          subtle: "hsl(215 20% 38%)",
          hover: "hsl(222 40% 22%)",
        },
      },
      boxShadow: {
        panel: "0 1px 2px rgba(15, 23, 42, 0.06), 0 8px 24px rgba(15, 23, 42, 0.04)",
      },
      fontFamily: {
        sans: ["Inter", "Segoe UI", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
