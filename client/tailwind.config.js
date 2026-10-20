/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'], mono: ['JetBrains Mono', 'Consolas', 'monospace'] },
      colors: {
        brand: { 50: '#EEF4FF', 100: '#DCE7FE', 500: '#3B6FF6', 600: '#2457E6', 700: '#1C45BE' },
        pbi: '#F2C811',
      },
    },
  },
  plugins: [],
};
