# Annotated x64 disassembly of IL2CPP methods (needs Il2CppDumper output: dump.cs + script.json, and capstone + pefile).
# Usage: il2cpp_dis.py <GameAssembly.dll> <il2cppdumper out dir> <Class> <rva|methodName> [...]   (env RETS=n: stop after n rets)
import sys, json, re, pefile, capstone, pickle, os
dll, out, cls = sys.argv[1], sys.argv[2], sys.argv[3]
cache = os.path.join(out, "_names.pkl")
if os.path.exists(cache):
    names, fields, statics = pickle.load(open(cache, "rb"))
else:
    sj = json.load(open(os.path.join(out, "script.json"), encoding="utf-8"))
    names = {m["Address"]: m["Name"] for m in sj["ScriptMethod"]}
    statics = {m["Address"]: m["Name"] for m in sj.get("ScriptMetadata", [])}
    statics.update({m["Address"]: "MI:" + m["Name"] for m in sj.get("ScriptMetadataMethod", [])})
    # fields per class: offset -> name (including inherited, by walking ': Base')
    src = open(os.path.join(out, "dump.cs"), encoding="utf-8").read().split("\n")
    fields, bases, cur = {}, {}, None
    for l in src:
        m = re.match(r"^(?:public|internal|private)?[\w ]*class (\S+?)(?: : (\S+?))?(?:,| //|$)", l)
        if m: cur = m.group(1); bases[cur] = m.group(2); fields[cur] = {}; continue
        m = re.match(r"\s+(?:\[.*\] )?(?:public|private|protected|internal)[\w<>\[\], .]* (\w+); // (0x[0-9A-F]+)", l)
        if m and cur: fields[cur][int(m.group(2), 16)] = m.group(1)
    fields = {"_bases": bases, **fields}
    pickle.dump((names, fields, statics), open(cache, "wb"))
bases = fields["_bases"]
def field_map(c):
    fm = {}
    chain = []
    while c: chain.append(c); c = bases.get(c)
    for c in reversed(chain): fm.update(fields.get(c, {}))
    return fm
fm = field_map(cls)
pe = pefile.PE(dll, fast_load=True); base = pe.OPTIONAL_HEADER.ImageBase
img = pe.get_memory_mapped_image()
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64); md.detail = False
by_name = {v: k for k, v in names.items()}
for target in sys.argv[4:]:
    rva = int(target, 16) if target.startswith("0x") else by_name.get(f"{cls}$${target}")
    print(f"\n##### {names.get(rva, '?')} @ {hex(rva)}")
    code = img[rva:rva + 0x1200]
    seen_ret = 0
    for ins in md.disasm(code, rva):
        txt = f"{ins.mnemonic} {ins.op_str}"
        note = []
        for mm in re.finditer(r"\[r(?:cx|dx|bx|di|si|ax|8|9|10|11|12|13|14|15)\w* \+ (0x[0-9a-f]+)\]", txt):
            off = int(mm.group(1), 16)
            if off in fm: note.append(fm[off])
        mm = re.search(r"\[rip \+ (0x[0-9a-f]+)\]", txt)
        if mm:
            a = ins.address + ins.size + int(mm.group(1), 16)
            if a in statics: note.append(statics[a])
            elif a in names: note.append(names[a])
            elif ins.mnemonic in ("movss", "mulss", "addss", "subss", "divss", "comiss", "maxss", "minss"):
                try:
                    off = pe.get_offset_from_rva(a); import struct as _s
                    note.append(f"const {_s.unpack_from('<f', pe.__data__, off)[0]:g}")
                except Exception: pass
        if ins.mnemonic in ("call", "jmp") and ins.op_str.startswith("0x"):
            a = int(ins.op_str, 16)
            if a in names: note.append(names[a])
        print(f"  {ins.address:08x}  {txt:50} {'; ' + ', '.join(note) if note else ''}")
        if ins.mnemonic == "ret" or (ins.mnemonic == "jmp" and seen_ret): 
            seen_ret += 1
            if seen_ret >= int(os.environ.get("RETS", "1")): break
        if ins.mnemonic == "int3": break
