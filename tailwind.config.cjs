/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,js,svelte,ts}', './node_modules/flowbite-svelte/**/*.{html,js,svelte,ts}'],
  theme: {
    extend: {
      colors: { ink: '#17202a', signal: '#f97316', calm: '#0f766e', paper: '#f5f2ea' },
      fontFamily: { sans: ['Inter', 'Noto Sans SC', 'PingFang SC', 'sans-serif'] }
    }
  },
  plugins: []
}
