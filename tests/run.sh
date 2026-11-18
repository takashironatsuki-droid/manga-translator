#!/bin/bash
# 启动两个本地测试服务器，依次运行指定的检查脚本，跑完后关掉服务器。
# 用法：bash run.sh tap.js appmode.js e2e.js ext.js
# 需要：Node.js、Playwright（npm i playwright）、Chrome（路径可用环境变量 CHROME 指定）
cd "$(dirname "$0")"
(cd site && exec python3 -m http.server 8801 >/dev/null 2>&1) & S1=$!
(cd img && exec python3 -m http.server 8802 >/dev/null 2>&1) & S2=$!
sleep 1.2
RC=0
for t in "$@"; do
  timeout ${TMO:-300} node $t 2>&1 | tail -${TAILN:-200}
  [ ${PIPESTATUS[0]} -ne 0 ] && RC=1
done
kill $S1 $S2 2>/dev/null
exit $RC
