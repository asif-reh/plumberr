#!/usr/bin/env sh
# Railway/Docker entrypoint for the Plumberr OpenClaw Gateway.
set -eu
: "${OPENCLAW_STATE_DIR:=/data/.openclaw}"
: "${OPENCLAW_WORKSPACE_DIR:=/data/workspace}"
export OPENCLAW_STATE_DIR OPENCLAW_WORKSPACE_DIR
mkdir -p "$OPENCLAW_STATE_DIR" "$OPENCLAW_WORKSPACE_DIR/oncall"
cp /app/workspace/AGENTS.md "$OPENCLAW_WORKSPACE_DIR/oncall/AGENTS.md"
# Plugins (idempotent). Local plugins must be installed from a packed tarball:
# a pnpm-linked directory fails OpenClaw's dependency-boundary safety scan.
[ -d "$OPENCLAW_STATE_DIR/extensions/cerebras" ] || openclaw plugins install @openclaw/cerebras-provider
openclaw plugins install --force --accept-capabilities /app/plugins/plumberr-tools.tgz
openclaw plugins install --force --accept-capabilities /app/plugins/plumberr-hooks.tgz
: "${OPENCLAW_CEREBRAS_BASE_URL:=https://api.cerebras.ai/v1}"; export OPENCLAW_CEREBRAS_BASE_URL
# Render config (JSON5 → JSON; ${VARS} stay literal and are resolved by OpenClaw at runtime)
node /app/render-config.mjs /app/openclaw.json5 "$OPENCLAW_STATE_DIR/openclaw.json"
openclaw config validate
# Railway private networking is IPv6; OpenClaw "lan" binds IPv4 only. Run the gateway on loopback and
# expose it on [::]:$PUBLIC_PORT through a tiny dual-stack TCP forwarder.
PUBLIC_PORT="${OPENCLAW_GATEWAY_PORT:-8080}"
INNER_PORT=18789
node -e 'const n=require("net");const[p,i]=process.argv.slice(1).map(Number);n.createServer(s=>{const t=Date.now();let up=0;const c=n.connect(i,"127.0.0.1",()=>console.log("[fwd] upstream connected"));console.log("[fwd] conn from "+s.remoteAddress);c.on("data",d=>{if(!up)console.log("[fwd] first response bytes after "+(Date.now()-t)+"ms: "+d.toString("latin1").split("\r\n")[0]);up+=d.length});s.pipe(c).pipe(s);s.on("close",()=>console.log("[fwd] client closed after "+(Date.now()-t)+"ms, upstream bytes "+up));s.on("error",e=>{console.log("[fwd] client "+e.code);c.destroy()});c.on("error",e=>{console.log("[fwd] upstream "+e.code);s.destroy()})}).listen(p,"::",()=>console.log("[fwd] [::]:"+p+" -> 127.0.0.1:"+i))' "$PUBLIC_PORT" "$INNER_PORT" &
# Self-probe (diagnostics): listening sockets + local HTTP check, logged a few times after boot.
( for n in $(seq 1 40); do sleep 15; node -e '
const fs=require("fs");const L=[];for(const f of ["/proc/net/tcp","/proc/net/tcp6"]){try{for(const l of fs.readFileSync(f,"utf8").split("\n").slice(1)){const c=l.trim().split(/\s+/);if(c[3]==="0A"){const[h,p]=c[1].split(":");L.push(f.slice(-4)+" "+h+":"+parseInt(p,16))}}}catch{}}
console.log("[probe] listen "+L.join(", "));const t=Date.now();
fetch("http://127.0.0.1:18789/healthz",{signal:AbortSignal.timeout(10000)}).then(r=>console.log("[probe] healthz "+r.status+" "+(Date.now()-t)+"ms")).catch(e=>console.log("[probe] healthz ERR "+(e.cause?.code||e.name)+" "+(Date.now()-t)+"ms"));
const rd=f=>{try{return fs.readFileSync(f,"utf8").trim().replace(/\n/g,",")}catch{return "?"}};const m="cgroup max="+rd("/sys/fs/cgroup/memory.max")+" cur="+rd("/sys/fs/cgroup/memory.current")+" peak="+rd("/sys/fs/cgroup/memory.peak")+" events="+rd("/sys/fs/cgroup/memory.events")+" cpu.max="+rd("/sys/fs/cgroup/cpu.max");console.log("[probe] "+m)'; done ) &
exec env -u OPENCLAW_GATEWAY_PORT openclaw gateway --port "$INNER_PORT" --bind loopback
