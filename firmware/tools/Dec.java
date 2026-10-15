// Usage: Dec.java <cmd> <addr> ... ; cmd = dec (decompile function containing addr) | xref (functions referencing addr, incl. via literal pools)
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.app.cmd.disassemble.ArmDisassembleCommand;
import ghidra.app.cmd.function.CreateFunctionCmd;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import ghidra.program.model.mem.*;
import java.util.*;

public class Dec extends GhidraScript {
    Function ensureFunc(Address a) throws Exception {
        Function f = getFunctionContaining(a);
        if (f != null) return f;
        if (getInstructionAt(a) == null) {
            ArmDisassembleCommand c = new ArmDisassembleCommand(a, null, true);
            c.applyTo(currentProgram, monitor);
        }
        new CreateFunctionCmd(a).applyTo(currentProgram, monitor);
        return getFunctionAt(a);
    }

    public void run() throws Exception {
        String[] args = getScriptArgs();
        DecompInterface di = new DecompInterface();
        di.openProgram(currentProgram);
        String cmd = args[0];
        for (int i = 1; i < args.length; i++) {
            Address a = toAddr(Long.parseLong(args[i].replace("0x", ""), 16));
            if (cmd.equals("mk")) {
                // force a function entry at a: drop any function whose body covers a, then recreate
                Function old = getFunctionContaining(a);
                if (old != null && !old.getEntryPoint().equals(a)) removeFunction(old);
                Function f = ensureFunc(a);
                if (f == null) { println("NOFUNC " + a); continue; }
                DecompileResults r = di.decompileFunction(f, 120, monitor);
                println("==== " + f.getName() + " @ " + f.getEntryPoint());
                println(r.getDecompiledFunction() == null ? r.getErrorMessage() : r.getDecompiledFunction().getC());
            } else if (cmd.equals("dec")) {
                Function f = ensureFunc(a);
                if (f == null) { println("NOFUNC " + a); continue; }
                DecompileResults r = di.decompileFunction(f, 120, monitor);
                println("==== " + f.getName() + " @ " + f.getEntryPoint());
                println(r.getDecompiledFunction() == null ? r.getErrorMessage() : r.getDecompiledFunction().getC());
            } else if (cmd.equals("xref")) {
                Set<String> seen = new TreeSet<>();
                for (Reference ref : getReferencesTo(a)) {
                    Address from = ref.getFromAddress();
                    Function f = getFunctionContaining(from);
                    seen.add(from + " in " + (f == null ? "?" : f.getName() + "@" + f.getEntryPoint()));
                    // literal pool word: find instructions loading it
                    for (Reference r2 : getReferencesTo(from)) {
                        Function f2 = getFunctionContaining(r2.getFromAddress());
                        seen.add("  via pool " + r2.getFromAddress() + " in " + (f2 == null ? "?" : f2.getName() + "@" + f2.getEntryPoint()));
                    }
                }
                // also raw scan for the 32-bit value
                Memory m = currentProgram.getMemory();
                byte[] pat = new byte[]{(byte)a.getOffset(), (byte)(a.getOffset()>>8), (byte)(a.getOffset()>>16), (byte)(a.getOffset()>>24)};
                Address s = m.getMinAddress();
                while ((s = m.findBytes(s, pat, null, true, monitor)) != null) {
                    seen.add("raw ptr at " + s);
                    s = s.add(1);
                }
                println("==== xref " + a);
                for (String x : seen) println(x);
            }
        }
    }
}
