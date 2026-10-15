// Usage: MapData.java <APP1.bin> <fileStartHex> <ramStartHex> <refs.tsv>
// Maps the part of APP1 that the startup code copies into RAM, then defines strings and comments loads of them.
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.mem.*;
import ghidra.program.model.symbol.*;
import ghidra.program.model.data.*;
import java.io.*;
import java.nio.file.*;

public class MapData extends GhidraScript {
    public void run() throws Exception {
        String[] a = getScriptArgs();
        byte[] all = Files.readAllBytes(Paths.get(a[0]));
        int f0 = Integer.parseInt(a[1], 16);
        Address ram = toAddr(Long.parseLong(a[2], 16));
        Memory mem = currentProgram.getMemory();
        if (mem.getBlock(ram) == null) {
            byte[] part = java.util.Arrays.copyOfRange(all, f0, all.length);
            MemoryBlock b = mem.createInitializedBlock("data_ram", ram, new ByteArrayInputStream(part), part.length, monitor, false);
            b.setRead(true); b.setWrite(true); b.setExecute(false);
            println("mapped " + part.length + " bytes at " + ram);
        }
        Listing lst = currentProgram.getListing();
        ReferenceManager rm = currentProgram.getReferenceManager();
        int n = 0;
        for (String line : Files.readAllLines(Paths.get(a[3]))) {
            String[] f = line.split("\t", 3);
            if (f.length < 3) continue;
            Address at = toAddr(Long.parseLong(f[0], 16)), tgt = toAddr(Long.parseLong(f[1], 16));
            try {
                if (lst.getDefinedDataAt(tgt) == null)
                    DataUtilities.createData(currentProgram, tgt, new TerminatedStringDataType(), -1, false, DataUtilities.ClearDataMode.CLEAR_ALL_UNDEFINED_CONFLICT_DATA);
            } catch (Exception e) { }
            if (getInstructionAt(at) == null) continue;
            String txt = f[2].length() > 60 ? f[2].substring(0, 60) + "..." : f[2];
            lst.setComment(at, CodeUnit.EOL_COMMENT, "\"" + txt + "\"");
            rm.addMemoryReference(at, tgt, RefType.DATA, SourceType.USER_DEFINED, 0);
            n++;
        }
        println("RAM string comments " + n);
    }
}
