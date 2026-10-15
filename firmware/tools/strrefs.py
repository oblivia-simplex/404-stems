# Usage: python3 -I strrefs.py <APP1.bin> <app1.lst> <pcrefs.txt> <strings.txt> <outdir>
# strings.txt: "hexoffset text" lines (e.g. from `strings -t x`). Writes:
#   prologues.txt      push {...lr} addresses (function candidates for Annotate.java)
#   strtargets.tsv     insn -> flash string (PC-relative adr/addw/ldr)
#   ramstrtargets.tsv  insn -> string in the block copied to RAM (file [0x1f0000, end) at file offset + 0x7ffde540),
#                      reached through movw/movt pairs or literal-pool words
import re, struct, sys
binf, lstf, pcf, strf, out = sys.argv[1:]
d = open(binf, 'rb').read()
B, R, F0 = 0x67FA4000, 0x7ffde540, 0x1f0000
ok = lambda t, n: len(t) >= n and re.fullmatch(r'[ -~]+', t)
strs = {}
for l in open(strf, encoding='latin1'):
    off, _, t = l.rstrip('\n').strip().partition(' ')
    try: strs[int(off, 16)] = t
    except ValueError: pass
with open(f'{out}/prologues.txt', 'w') as o:
    for l in open(lstf):
        if re.match(r'^[0-9a-f]+ (push|push\.w|stmdb sp!, |stmdb\.w sp!, )\{.*lr\}', l): o.write(l.split()[0] + '\n')
flash = open(f'{out}/strtargets.tsv', 'w'); ram = open(f'{out}/ramstrtargets.tsv', 'w')
for l in open(pcf):
    a, t, k = l.split(); off = int(t, 16) - B
    if off in strs and ok(strs[off], 3): flash.write(f"{a}\t{t}\t{strs[off]}\n")
    if k == 'ldr' and 0 <= off < len(d) - 3:
        so = struct.unpack_from('<I', d, off)[0] - R
        if F0 <= so < len(d) and so in strs and ok(strs[so], 2): ram.write(f"{a}\t{so + R:x}\t{strs[so]}\n")
lo = {}
for l in open(lstf):
    m = re.match(r'^([0-9a-f]+) movw (r\d+), #(0x[0-9a-f]+|\d+)$', l.strip())
    if m: lo[m.group(2)] = (m.group(1), int(m.group(3), 0)); continue
    m = re.match(r'^([0-9a-f]+) movt (r\d+), #(0x[0-9a-f]+|\d+)$', l.strip())
    if m and m.group(2) in lo:
        a, v = lo.pop(m.group(2)); v |= int(m.group(3), 0) << 16; so = v - R
        if F0 <= so < len(d) and so in strs and ok(strs[so], 2): ram.write(f"{a}\t{v:x}\t{strs[so]}\n")
