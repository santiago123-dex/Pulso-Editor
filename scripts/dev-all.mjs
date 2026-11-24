import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const cliOnly = process.argv.includes('--cli-only');
const isWin = process.platform === 'win32';

function run(cmd, args) {
  const res = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWin,
  });
  return res.status ?? 1;
}

console.log('→ Compilando Pulso CLI (`pulso`)...');
const buildCode = run('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'pulso']);
if (buildCode !== 0) {
  process.exit(buildCode);
}

const binName = isWin ? 'pulso.exe' : 'pulso';
const builtBin = join(root, 'src-tauri', 'target', 'debug', binName);

if (isWin && process.env.LOCALAPPDATA) {
  const installDir = join(process.env.LOCALAPPDATA, 'Pulso Editor');
  const installedBin = join(installDir, binName);
  if (existsSync(installDir) && existsSync(builtBin)) {
    try {
      copyFileSync(builtBin, installedBin);
      console.log(`✓ Comando global \`pulso\` actualizado en ${installedBin}`);
    } catch (err) {
      console.warn(
        `⚠ No se pudo sobrescribir ${installedBin} (cierra cualquier sesión abierta de \`pulso\` e intenta de nuevo): ${err.message}`,
      );
    }
  }
}

if (cliOnly) {
  process.exit(0);
}

console.log('→ Iniciando Pulso Editor (`tauri dev`)...');
process.exit(run('npx', ['tauri', 'dev']));
