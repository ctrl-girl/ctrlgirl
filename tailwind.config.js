module.exports = {
  content: ['./public/index.html', './public/js/**/*.mjs'],
  theme: {
    extend: {
      colors: {
        brand: {
          purple: '#6B46C1',
          darkPurple: '#5B21B6',
          lightPurple: '#DDD6FE',
          pinkVivid: '#EC4899',
          blue: '#0284C7',
          cardBg: '#F8FAFC',
        },
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        robotoSerif: ['"Roboto Serif"', 'serif'],
      },
      // O menor texto do app é 14 px: sobrescreve o text-xs (12 px) e o text-sm (14 px) do Tailwind.
      fontSize: {
        xs: ['0.875rem', { lineHeight: '1.25rem' }],
        sm: ['0.9375rem', { lineHeight: '1.375rem' }],
      },
    },
  },
};
