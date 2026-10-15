# SP-404 Stems

A local web app for exporting stems from patterns and pattern chains. Each stem is a group of pads you choose (by default, one stem per bank).

```bash
npm run stems -- "/path/to/projects"   # an SD card, or a folder of exported projects
```

It opens `http://127.0.0.1:4040/` in your browser:

- Click or drag across pads to put them in the selected stem; right-click a pad (or its ▶) to hear it.
- Pick a pattern or chain to preview the full mix or any single stem.
- **Export stems** writes one 32-bit float WAV per stem (plus the full mix if ticked) to `~/Music/SP404 Stems/<project>/<pattern>/`. The stems always sum exactly to the mix.

Playback follows the pad settings: start/end, volume, velocity, pan, gate, loop, reverse, pitch, mute groups and same-pad retriggers. Time-stretching (BPM sync) and envelopes aren't applied yet. Format notes: [docs/sp404mk2-project-format.md](docs/sp404mk2-project-format.md).

## License

Copyright (C) 2026 Olivia Lucca Fraser

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.