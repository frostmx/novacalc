# List methods (with RVA) of exact class names from Il2CppDumper dump.cs.
# Usage: il2cpp_class.py <dump.cs> <Class[,Class...]> [method regex filter]
import re, sys
lines = open(sys.argv[1], encoding="utf-8").read().split("\n")
flt = re.compile(sys.argv[3]) if len(sys.argv) > 3 else None
for name in sys.argv[2].split(","):
    for i, l in enumerate(lines):
        if re.match(r"^(public|internal|private)?[\w ]*class " + re.escape(name) + r"( :|$| //)", l):
            print("=====", l.strip()[:150])
            j = i + 2
            while lines[j] != "}":
                s = lines[j].strip()
                if "(" in s and not s.startswith("//") and (not flt or flt.search(s)):
                    rva = re.search(r"RVA: (0x[0-9A-F]+)", lines[j-1])
                    print("  ", rva.group(1) if rva else "-", s[:130])
                elif flt is None or (s.endswith(";") and flt.search(s)):
                    if s.endswith(";") and "//" in s: print("   field", s[:130])
                j += 1
            break
    else:
        print("NOT FOUND", name)
