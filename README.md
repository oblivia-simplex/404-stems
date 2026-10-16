# SP-404 Stems

Export stems from Roland SP-404MKII patterns and pattern chains, and copy projects off the unit over USB.

A stem is a group of pads you choose (by default, one stem per bank). The app reads projects from an SD card, a folder of exported projects, or straight from the SP-404MKII over USB, and renders each stem as its own WAV.

## Running it

```bash
npm install
npm run app                            # desktop app (Electron); opens the SD card if it's mounted
npm run stems -- "/path/to/projects"   # or the same UI in your browser, at http://127.0.0.1:4040/
npm run app:build                      # build "SP-404 Stems.app" into release/
```

Requires Node.js 18+. Developed and tested on macOS.

## What it does

- **Group pads into stems.** Click or drag across pads to put them in the selected stem; right-click a pad (or its ▶) to hear it.
- **Preview.** Pick a pattern or chain to hear the full mix or any single stem. A transport bar shows the beat, bar and position in the pattern or chain, and pads light up as they play.
- **Export stems.** Writes one 32-bit float WAV per stem (plus the full mix if ticked) to `~/Music/SP404 Stems/<project>/<pattern>/`. The stems always sum exactly to the mix.
- **Copy from SP-404…** copies a project straight out of the unit's internal storage over USB, so you don't need to export it to an SD card first. Copies go to `~/Music/SP-404MKII Projects/P<slot>_<NAME>/`, laid out exactly like an SD-card export. A copy is the project as it is on the unit right now, so it can differ from an older SD export of the same project. Nothing on the unit is changed. Close Roland's SP-404MKII app first: only one program can use the connection at a time.
- **Make a new project from this chain** (or pattern) copies only the pads it plays into a new project folder next to the original, one bank per stem, and rewrites the patterns to match. The original project isn't touched. A stem with more than 16 pads spills into the next bank, with a warning suggesting you split it.

From the command line:

```bash
npm run device -- list                       # projects on a connected SP-404MKII
npm run device -- pull <slot|all> [folder]   # copy them to your computer
```

## How faithful the rendering is

Playback follows the pad settings: start/end, volume, velocity, pan, gate, loop (toggling when gate is off), reverse, pitch and speed (VINYL or independent), the envelope, mute groups (with release), same-pitch retriggers, time signatures, the project/bank tempo, and MK2 or SX pattern continuation.

Not reproduced exactly:
- BPM-synced and non-VINYL pads are time-stretched with a WSOLA stretcher, not the unit's own algorithms, which run on a DSP whose code isn't readable.
- Effects aren't applied: stems are dry.

The file formats and the USB protocol are documented in [docs/sp404mk2-project-format.md](docs/sp404mk2-project-format.md).

## Development

```bash
npm test          # unit tests: file formats, renderer, time-stretch, refactor tool, USB protocol, server
npm run typecheck
```

The tests build synthetic projects (`test/support/fixtures.ts`) and talk to a simulated SP-404MKII (`test/support/fakeSp404.ts`), so they don't need the hardware.

## Building packages

```bash
make mac     # .dmg and .zip for Apple silicon and Intel (needs macOS)
make win     # Windows portable .exe and .zip, x64 and arm64 (needs Docker)
make linux   # .deb packages for Debian and Ubuntu, amd64 and arm64 (needs Docker)
make dist    # runs the tests, then builds all three
```

Packages land in `release/` and are unsigned. Windows and Linux build inside electron-builder's official Docker image, so they can be made from any machine with Docker; `make clean-docker` removes its cached volumes.

## Disclaimer

Not affiliated with or endorsed by Roland. The project format and USB protocol were worked out by reverse engineering and may be incomplete. The app only reads from the SD card and the unit; the one exception is "Make a new project", which writes a new folder next to the original and never overwrites an existing one. Keep backups of your projects anyway.

## License

Copyright (C) 2026 Olivia Lucca Fraser

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.
