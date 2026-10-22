# Driver fixture completion predicates. Poll spacing is not an assertion clock;
# the canonical suite deadline bounds an incomplete fixture.
driver_read_record(){
  bun -e '
const fs=require("node:fs"),[file,key,value]=process.argv.slice(1);
try{
 let text;try{text=fs.readFileSync(file,"utf8")}catch(e){if(e.code==="ENOENT")process.exit(1);throw e;}
 for(const line of text.slice(0,text.lastIndexOf("\n")+1).split("\n").filter(Boolean)){
  const obj=JSON.parse(line);let found=obj;for(const part of key.split("."))found=found?.[part];
  if(String(found)===value){console.log("OBSERVED_DRIVER_RECORD "+JSON.stringify(obj));process.exit(0);}
 }
 process.exit(1);
}catch(e){console.error("INCOMPLETE driver record: "+String(e));process.exit(2);}
' "$1" "$2" "$3"
}
driver_wait_record(){
  local file="$1" key="$2" value="$3" owner="$4" rc
  while :; do
    driver_read_record "$file" "$key" "$value"; rc=$?
    [ "$rc" != 0 ] || return 0
    [ "$rc" = 1 ] || return "$rc"
    if ! kill -0 "$owner" 2>/dev/null; then
      # Publication may have raced the preceding read; after original exit
      # the shim cannot append another normalized record. Read it once more.
      driver_read_record "$file" "$key" "$value"; rc=$?
      [ "$rc" != 0 ] || return 0
      printf 'INCOMPLETE driver fixture: original shim exited before %s=%s in %s\n' "$key" "$value" "$file" >&2
      return 2
    fi
    sleep 0.02
  done
}
