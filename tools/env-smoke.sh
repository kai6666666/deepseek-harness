#!/system/bin/sh
P=/data/user/0/com.dsh.android/files/termux/usr
export PREFIX=$P
export HOME=/data/user/0/com.dsh.android/files/termux/home
export TMPDIR=$P/tmp
export PATH=$P/bin:$PATH
export LD_LIBRARY_PATH=$P/lib
T=$TMPDIR/envtest
rm -rf "$T"; mkdir -p "$T"

echo "=== python ==="
printf 'print("py-ok", 1+1)\n' > "$T/a.py"
python3 "$T/a.py"

echo "=== rust ==="
printf 'fn main(){println!("rust-ok");}\n' > "$T/a.rs"
rustc -o "$T/a_rs" "$T/a.rs" && "$T/a_rs"

echo "=== go ==="
cat > "$T/a.go" <<'GO'
package main

import "fmt"

func main() { fmt.Println("go-ok") }
GO
(cd "$T" && GOFLAGS=-mod=mod go run a.go)

echo "=== java ==="
cat > "$T/H.java" <<'JAVA'
public class H {
    public static void main(String[] a) { System.out.println("java-ok " + System.getProperty("java.version")); }
}
JAVA
javac -d "$T" "$T/H.java" && java -cp "$T" H

echo "=== node ==="
node -e 'console.log("node-ok", process.version)'

echo "=== ssh ==="
ssh -V 2>&1 | head -1
