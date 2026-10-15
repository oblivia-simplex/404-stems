#!/usr/bin/env node
// Local web UI for exporting SP-404MKII pattern stems.
// Usage: sp404-stems [folder with projects, e.g. an SD card or export folder] [--port N] [--no-open]
import { execFile } from "child_process";
import { startServer } from "./server.js";

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const port = portArg >= 0 ? Number(args[portArg + 1]) : 4040;
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--port");
const root = positional[0] ?? process.cwd();

const server = await startServer({ root, port });
console.log(`🎛  SP-404MKII stem exporter running at ${server.url}`);
console.log(`   Looking for projects under ${root}`);
if (!args.includes("--no-open")) execFile("open", [server.url]);
