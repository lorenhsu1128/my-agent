import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Discord-inspired dark palette
        bg: {
          primary: '#313338',
          secondary: '#2b2d31',
          tertiary: '#1e1f22',
          accent: '#404249',
          floating: '#111214',
        },
        text: {
          primary: '#f2f3f5',
          secondary: '#b5bac1',
          muted: '#80848e',
          link: '#00a8fc',
        },
        brand: {
          DEFAULT: '#5865f2',
          hover: '#4752c4',
        },
        status: {
          online: '#23a55a',
          idle: '#f0b232',
          dnd: '#f23f43',
          offline: '#80848e',
        },
        divider: '#3f4147',
      },
      fontFamily: {
        sans: [
          'gg sans',
          '"Noto Sans"',
          '"Helvetica Neue"',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
        mono: ['"JetBrains Mono"', 'Consolas', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config
