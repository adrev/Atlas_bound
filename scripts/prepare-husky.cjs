const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.env.NODE_ENV === 'production' || process.env.HUSKY === '0') {
  process.exit(0);
}

const root = path.resolve(__dirname, '..');
if (!fs.existsSync(path.join(root, '.git'))) {
  process.exit(0);
}

const huskyBin =
  process.platform === 'win32'
    ? path.join(root, 'node_modules', '.bin', 'husky.cmd')
    : path.join(root, 'node_modules', '.bin', 'husky');

if (!fs.existsSync(huskyBin)) {
  process.exit(0);
}

const result = spawnSync(huskyBin, { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(result.status ?? 1);
