// Copia la app web a www/ (carpeta que Capacitor mete dentro del APK / app iOS).
import { cpSync, rmSync, mkdirSync } from "node:fs";

const FILES = ["index.html", "config.js", "manifest.webmanifest", "sw.js", "icons"];
rmSync("www", { recursive: true, force: true });
mkdirSync("www");
for (const f of FILES) cpSync(f, `www/${f}`, { recursive: true });
console.log("www/ listo:", FILES.join(", "));
