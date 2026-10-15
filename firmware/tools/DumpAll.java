// Usage: DumpAll.java <outdir> [names.tsv]
// Applies known names (addr<TAB>name<TAB>comment), then decompiles every function into
// <outdir>/<0xNNNN0000 region>/<addr>_<name>.c plus an index.tsv.
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import ghidra.program.model.address.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;

public class DumpAll extends GhidraScript {
    public void run() throws Exception {
        String[] args = getScriptArgs();
        File out = new File(args[0]);
        out.mkdirs();
        if (args.length > 1) {
            for (String line : Files.readAllLines(Paths.get(args[1]))) {
                if (line.isBlank() || line.startsWith("#")) continue;
                String[] f = line.split("\t");
                Address a = toAddr(Long.parseLong(f[0].replace("0x", ""), 16));
                Function fn = getFunctionAt(a);
                if (fn == null) fn = createFunction(a, null);
                if (fn == null) continue;
                fn.setName(f[1], SourceType.USER_DEFINED);
                if (f.length > 2) fn.setComment(f[2]);
            }
        }
        DecompInterface di = new DecompInterface();
        DecompileOptions opt = new DecompileOptions();
        opt.setEOLCommentIncluded(true);
        opt.setPRECommentIncluded(true);
        di.setOptions(opt);
        di.toggleCCode(true);
        di.openProgram(currentProgram);
        PrintWriter idx = new PrintWriter(new File(out, "index.tsv"));
        idx.println("address\tname\tsize\tfile");
        int n = 0;
        for (Function fn : currentProgram.getFunctionManager().getFunctions(true)) {
            if (monitor.isCancelled()) break;
            long ea = fn.getEntryPoint().getOffset();
            String region = String.format("%08x", ea & 0xffff0000L);
            File dir = new File(out, region);
            dir.mkdirs();
            String fname = String.format("%08x_%s.c", ea, fn.getName());
            DecompileResults r = di.decompileFunction(fn, 60, monitor);
            String body = r.getDecompiledFunction() == null ? "/* decompile failed: " + r.getErrorMessage() + " */\n" : r.getDecompiledFunction().getC();
            try (PrintWriter w = new PrintWriter(new File(dir, fname))) {
                w.printf("// %s @ 0x%08x (%d bytes)%n", fn.getName(), ea, fn.getBody().getNumAddresses());
                if (fn.getComment() != null) w.println("// " + fn.getComment());
                w.print(body);
            }
            idx.printf("0x%08x\t%s\t%d\t%s/%s%n", ea, fn.getName(), fn.getBody().getNumAddresses(), region, fname);
            if (++n % 500 == 0) println("dumped " + n);
        }
        idx.close();
        println("done " + n);
    }
}
