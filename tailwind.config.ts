import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#FDFBF7",
        ink: "#1C1C1C",
        gold: "#b28b4b"
      },
      fontFamily: {
        serif: ["Georgia", "Times New Roman", "ui-serif", "serif"]
      }
    }
  },
  plugins: []
} satisfies Config;
