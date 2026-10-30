#!/bin/bash
# Finder may start with a minimal PATH; also check standard Homebrew locations.
cd -- "$(dirname -- "$0")" || exit 1
ibkr_node="$(command -v node || true)"
for candidate in "$ibkr_node" /opt/homebrew/bin/node /usr/local/bin/node /opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@24/bin/node; do
  if [ -x "$candidate" ] && "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
    "$candidate" scripts/install-discord-mac.mjs
    ibkr_result=$?
    if [ "$ibkr_result" -eq 0 ]; then
      echo "安装完成。请在看板的 Discord 设置中查看同步状态。"
    else
      echo "安装未完成，请按上方提示处理后重新双击 Install.command。"
    fi
    read -r -p "按回车关闭窗口…" ibkr_reply
    exit "$ibkr_result"
  fi
done
echo "请先从 https://nodejs.org/ 安装 Node.js 24 或更新版本，再重新双击 Install.command。"
read -r -p "按回车关闭窗口…" ibkr_reply
exit 1
