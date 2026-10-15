#!/usr/bin/env node
// Copy projects out of an SP-404MKII connected over USB.
// Usage: sp404-device list
//        sp404-device pull <slot 1-16 | all> [destination folder]
import * as path from "path";
import { Sp404Device, findSerialPort, openSerialTransport } from "./sp404/remote/device.js";
import { listProjects, downloadProject } from "./sp404/remote/projects.js";
import { DEFAULT_DEVICE_DIR } from "./server.js";

async function main() {
  const [cmd = "list", which, destArg] = process.argv.slice(2);
  const port = await findSerialPort();
  if (!port) throw new Error("No SP-404MKII found. Connect it with a USB cable and turn it on.");
  const dev = new Sp404Device(await openSerialTransport(port.path));
  try {
    await dev.connect();
    const projects = await listProjects(dev);
    if (cmd === "list") {
      for (const p of projects) console.log(`${String(p.slot).padStart(2)}  ${p.name || "(unnamed)"}`);
      return;
    }
    if (cmd !== "pull" || !which) throw new Error("Usage: sp404-device list | pull <slot|all> [destination]");
    const dest = path.resolve(destArg ?? DEFAULT_DEVICE_DIR);
    const slots = which === "all" ? projects.map((p) => p.slot) : [Number(which)];
    for (const slot of slots) {
      const started = Date.now();
      let last = 0;
      const out = await downloadProject(dev, slot, dest, (p) => {
        if (Date.now() - last < 250 && p.bytes < p.totalBytes) return;
        last = Date.now();
        process.stdout.write(`\r  P${slot}: ${(p.bytes / 1e6).toFixed(1)} / ${(p.totalBytes / 1e6).toFixed(1)} MB, ${p.filesDone}/${p.files} files   `);
      });
      process.stdout.write(`\n  saved ${out} in ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
    }
  } finally {
    await dev.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
