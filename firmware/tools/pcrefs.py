import re,sys
# emit "insn_addr target" for every pc-relative address computation in a capstone listing
for line in open(sys.argv[1]):
    a,_,rest=line.strip().partition(' ')
    pc=int(a,16); base=(pc+4)&~3
    m=re.match(r'adr(?:\.w)? r\d+, #(-?0x[0-9a-f]+|-?\d+)$',rest)
    if m: print(a,'%x'%(base+int(m.group(1),0)),'adr'); continue
    m=re.match(r'(addw|subw) r\d+, pc, #(-?0x[0-9a-f]+|\d+)$',rest)
    if m:
        v=int(m.group(2),0); print(a,'%x'%(base+v if m.group(1)=='addw' else base-v),m.group(1)); continue
    m=re.match(r'ldr(?:\.w)? r\d+, \[pc, #(-?0x[0-9a-f]+|-?\d+)\]$',rest)
    if m: print(a,'%x'%(base+int(m.group(1),0)),'ldr')
