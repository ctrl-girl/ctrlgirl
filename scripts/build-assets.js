// Gera public/css/app.css e copia fontes e ícones para public/vendor.
// O resultado vai para o Git, então a hospedagem não precisa de etapa de build.
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const modules = path.join(ROOT, 'node_modules');
const vendor = path.join(ROOT, 'public', 'vendor');

function copy(from, to) {
  const target = path.join(vendor, to);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(modules, from), target);
}

copy('@fortawesome/fontawesome-free/css/all.min.css', 'fontawesome/css/all.min.css');
for (const font of ['fa-solid-900', 'fa-regular-400', 'fa-brands-400', 'fa-v4compatibility']) {
  copy(`@fortawesome/fontawesome-free/webfonts/${font}.woff2`, `fontawesome/webfonts/${font}.woff2`);
}
copy('@fortawesome/fontawesome-free/LICENSE.txt', 'fontawesome/LICENSE.txt');
copy('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', 'fonts/inter-latin-wght-normal.woff2');
copy('@fontsource-variable/inter/LICENSE', 'fonts/LICENSE-inter.txt');
copy('@fontsource-variable/roboto-serif/files/roboto-serif-latin-wght-normal.woff2', 'fonts/roboto-serif-latin-wght-normal.woff2');
copy('@fontsource-variable/roboto-serif/LICENSE', 'fonts/LICENSE-roboto-serif.txt');

execSync('npx tailwindcss -c tailwind.config.js -i src/styles.css -o public/css/app.css --minify', { cwd: ROOT, stdio: 'inherit' });
