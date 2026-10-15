# Firmware tools

Scripts that rebuild `../decompiled/` (local only) from an `SP404MKII_APP1.bin` you extract from Roland's v5.52
update yourself. Our own code; no Roland data. Steps:

1. `python3 -I listing.py SP404MKII_APP1.bin 67FA4000 app1.lst` (capstone, Thumb/M-class), then
   `python3 -I pcrefs.py app1.lst > pcrefs.txt` and `strings -t x -n 2 SP404MKII_APP1.bin > app1.strings`.
2. `python3 -I strrefs.py SP404MKII_APP1.bin app1.lst pcrefs.txt app1.strings <work>`.
3. Import the binary into a Ghidra project (ARM Cortex, little endian, base 0x67FA4000, auto-analysis on), then run
   headless with `-postScript`:
   `Annotate.java <work>/prologues.txt <work>/strtargets.tsv` (adds about 4,000 functions and flash string comments),
   `MapData.java SP404MKII_APP1.bin 1f0000 801ce540 <work>/ramstrtargets.tsv` (maps the RAM-copied data block),
   `DumpAll.java <repo>/firmware/decompiled <repo>/firmware/names.tsv` (applies our names, one .c per function).
4. `python3 -I tables.py <work> <repo>/firmware/decompiled` for strings_by_function.tsv and callgraph.tsv.

`Dec.java dec|xref <addr>` decompiles one function or lists references, for quick looks.
