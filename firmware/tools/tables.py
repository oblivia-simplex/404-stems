# Usage: python3 -I tables.py <scratchpad/study> <repo/firmware/decompiled>
# Writes strings_by_function.tsv (function -> strings it loads, flash and RAM-copied) and callgraph.tsv.
import sys, bisect, re, os, collections
S, D = sys.argv[1:]
rows = [l.rstrip('\n').split('\t') for l in open(f'{D}/index.tsv')][1:]
ents = sorted((int(r[0], 16), r[1], int(r[2]), r[3]) for r in rows)
starts = [e[0] for e in ents]
by = collections.defaultdict(list)
for fn in ('strtargets.tsv', 'ramstrtargets.tsv'):
    for l in open(f'{S}/{fn}'):
        a, t, s = l.rstrip('\n').split('\t', 2)
        i = bisect.bisect_right(starts, int(a, 16)) - 1
        if i >= 0: by[ents[i]].append(s)
with open(f'{D}/strings_by_function.tsv', 'w') as o:
    o.write("address\tname\tstrings (in order of use)\n")
    for e in sorted(by):
        seen = []
        for x in by[e]:
            if x not in seen: seen.append(x)
        o.write(f"0x{e[0]:08x}\t{e[1]}\t" + " | ".join(seen) + "\n")
names = set(e[1] for e in ents)
call = re.compile(r'\b(FUN_[0-9a-f]{8}|[a-z][a-z0-9_]+)\s*\(')
with open(f'{D}/callgraph.tsv', 'w') as o:
    o.write("caller_addr\tcaller\tcallee\tcount\n")
    for e in ents:
        p = f'{D}/{e[3]}'
        if not os.path.exists(p): continue
        body = open(p, errors='replace').read().split('{', 1)[-1]
        c = collections.Counter(m.group(1) for m in call.finditer(body) if m.group(1) in names and m.group(1) != e[1])
        for n, k in sorted(c.items()): o.write(f"0x{e[0]:08x}\t{e[1]}\t{n}\t{k}\n")
print(len(by), "functions with strings")
