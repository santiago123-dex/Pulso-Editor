// Copia de compilación con identificador y recursos propios; nunca comparte datos de la app instalada.
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const source = resolve(".");
const root = await mkdtemp(join(source, ".pulso-perf-isolated-"));
for (const name of ["src", "public", "scripts"]) await cp(join(source, name), join(root, name), { recursive: true });
for (const name of ["index.html", "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts"]) await cp(join(source, name), join(root, name));
await mkdir(join(root, "src-tauri"));
for (const name of ["src", "icons", "capabilities", "gen", "build.rs", "Cargo.toml", "Cargo.lock", "tauri.conf.json"]) await cp(join(source, "src-tauri", name), join(root, "src-tauri", name), { recursive: true });
const configPath = join(root, "src-tauri", "tauri.conf.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
config.identifier = `dev.pulso.perftest${Date.now()}`;
await writeFile(configPath, JSON.stringify(config, null, 2));
const libPath = join(root, "src-tauri", "src", "lib.rs");
const lib = await readFile(libPath, "utf8");
if (!lib.includes('const SECRET_SERVICE: &str = "pulso-editor";')) throw new Error("No se encontró el almacén de credenciales que se debe aislar.");
await writeFile(libPath, lib.replace('const SECRET_SERVICE: &str = "pulso-editor";', `const SECRET_SERVICE: &str = "${config.identifier}";`));
const githubPath = join(root, "src", "github.ts");
const github = await readFile(githubPath, "utf8");
if (!github.includes("export async function autoConnect(): Promise<string | null> {")) throw new Error("No se encontró la conexión automática que se debe desactivar.");
await writeFile(githubPath, github.replace("export async function autoConnect(): Promise<string | null> {", "export async function autoConnect(): Promise<string | null> { return null;"));
try { await symlink(join(source, "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir"); }
catch (error) {
  if (error.code !== "EPERM") throw error;
  // En entornos sin permiso para enlaces se usa una copia: los scripts de build no alteran la instalación compartida.
  await cp(join(source, "node_modules"), join(root, "node_modules"), { recursive: true });
}
console.log(root);
