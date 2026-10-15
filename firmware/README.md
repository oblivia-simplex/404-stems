# Firmware reference

`names.tsv` lists the SP-404MKII v5.52 `SP404MKII_APP1.bin` functions we have identified (address, our name, notes).

`decompiled/` (gitignored, local only) holds a Ghidra decompile of every function, one file per function, with these
names applied. It's Roland's code, so it is never committed. Regenerate it with Ghidra's headless analyzer and
`DumpAll.java` (see the session notes) against an APP1 image you've extracted from Roland's update package yourself.
