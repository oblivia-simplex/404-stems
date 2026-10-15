// Usage: Annotate.java <prologues.txt> <strtargets.tsv>
// 1) Creates functions at push {...lr} prologues that no existing function covers.
// 2) Defines strings at PC-relative string targets and adds an EOL comment with the text at each load.
import ghidra.app.script.GhidraScript;
import ghidra.app.cmd.disassemble.ArmDisassembleCommand;
import ghidra.app.cmd.function.CreateFunctionCmd;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import ghidra.program.model.data.*;
import java.nio.file.*;
import java.util.*;

public class Annotate extends GhidraScript {
    public void run() throws Exception {
        String[] args = getScriptArgs();
        Listing lst = currentProgram.getListing();
        int made = 0, skipped = 0;
        for (String line : Files.readAllLines(Paths.get(args[0]))) {
            if (line.isBlank()) continue;
            Address a = toAddr(Long.parseLong(line.trim(), 16));
            if (getFunctionContaining(a) != null) { skipped++; continue; }
            Data d = lst.getDefinedDataContaining(a);
            if (d != null) { skipped++; continue; }
            if (getInstructionAt(a) == null) {
                ArmDisassembleCommand c = new ArmDisassembleCommand(a, null, true);
                c.applyTo(currentProgram, monitor);
            }
            if (getInstructionAt(a) == null) { skipped++; continue; }
            if (new CreateFunctionCmd(a).applyTo(currentProgram, monitor)) made++;
            if (made % 500 == 0) println("functions made " + made);
        }
        println("functions made " + made + ", skipped " + skipped);
        int cm = 0;
        ReferenceManager rm = currentProgram.getReferenceManager();
        for (String line : Files.readAllLines(Paths.get(args[1]))) {
            String[] f = line.split("\t", 3);
            if (f.length < 3) continue;
            Address at = toAddr(Long.parseLong(f[0], 16));
            Address tgt = toAddr(Long.parseLong(f[1], 16));
            try {
                if (lst.getDefinedDataAt(tgt) == null && lst.getInstructionContaining(tgt) == null)
                    DataUtilities.createData(currentProgram, tgt, new TerminatedStringDataType(), -1, false, DataUtilities.ClearDataMode.CLEAR_ALL_UNDEFINED_CONFLICT_DATA);
            } catch (Exception e) { }
            Instruction ins = getInstructionAt(at);
            if (ins == null) continue;
            String txt = f[2].length() > 60 ? f[2].substring(0, 60) + "..." : f[2];
            lst.setComment(at, CodeUnit.EOL_COMMENT, "\"" + txt + "\"");
            rm.addMemoryReference(at, tgt, RefType.DATA, SourceType.USER_DEFINED, 0);
            cm++;
        }
        println("string comments " + cm);
    }
}
