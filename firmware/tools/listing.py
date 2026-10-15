import capstone,sys
d=open(sys.argv[1],'rb').read(); base=int(sys.argv[2],16)
md=capstone.Cs(capstone.CS_ARCH_ARM,capstone.CS_MODE_THUMB|capstone.CS_MODE_MCLASS)
md.skipdata=True
out=open(sys.argv[3],'w')
for i in md.disasm_lite(d,base):
    out.write('%08x %s %s\n'%(i[0],i[2],i[3]))
