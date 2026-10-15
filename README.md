# SP-404 Stems

An app for exporting stems from patterns and pattern chains. Each stem is a group of pads you choose (by default, one stem per bank). It runs as a desktop app or in your browser:

```bash
npm run app                            # desktop app (Electron); opens the SD card if it's mounted
npm run app:build                      # build "SP-404 Stems.app" into release/
npm run stems -- "/path/to/projects"   # or: browser UI at http://127.0.0.1:4040/ for an SD card or folder of exports
```

- Click or drag across pads to put them in the selected stem; right-click a pad (or its ▶) to hear it.
- Pick a pattern or chain to preview the full mix or any single stem.
- **Export stems** writes one 32-bit float WAV per stem (plus the full mix if ticked) to `~/Music/SP404 Stems/<project>/<pattern>/`. The stems always sum exactly to the mix.

- **Copy from SP-404…** copies a project straight out of the SP-404MKII's internal storage over USB, so you don't need to export it to an SD card first. Copies go to `~/Music/SP-404MKII Projects/P<slot>_<NAME>/`, laid out exactly like an SD-card export, and open in the app like any other project. A copy is the project as it is on the unit right now, so it can differ from an older SD export of the same project. Nothing on the unit is changed. From the command line: `npm run device -- list` and `npm run device -- pull <slot|all> [folder]`.

- **Make a new project from this chain** (or pattern) copies only the pads it plays into a new project folder next to the original, one bank per stem, and rewrites the patterns to match. The original project isn't touched. A stem with more than 16 pads spills into the next bank, with a warning suggesting you split it.

Playback follows the pad settings: start/end, volume, velocity, pan, gate, loop (toggling when gate is off), reverse, pitch and speed (VINYL or independent), the envelope, mute groups (with release), same-pitch retriggers, the project/bank tempo, and MK2 or SX pattern continuation. A transport bar shows the beat, bar and position in the pattern or chain, and pads light up as they play. BPM-synced pads are time-stretched to the project tempo (with a WSOLA stretcher, not the device's own algorithm), and effects aren't applied: stems are dry. Format notes: [docs/sp404mk2-project-format.md](docs/sp404mk2-project-format.md).

Run the tests with `npm test` (unit tests for the file formats, renderer, time-stretch, refactor tool, USB protocol and server, using synthetic projects and a simulated SP-404), and `npm run typecheck`.

## License

Copyright (C) 2026 Olivia Lucca Fraser

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.