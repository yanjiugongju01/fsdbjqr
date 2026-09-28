#!/bin/bash
# 初始化 GitHub 仓库并推送 dog-watch 代码
set -e
cd "$(dirname "$0")"

REPO="yanjiugongju01/fsdbjqr"
BRANCH="main"

git init -b $BRANCH
git add -A
git commit -m "feat: dog-watch 飞书机器人最小闭环版"

# 添加远程（如果尚未添加）
if ! git remote | grep -q origin; then
  git remote add origin "https://github.com/${REPO}.git"
fi

echo "=== 代码已提交，等待推送 ==="
echo "请运行 gh auth login 登录后，再运行: git push -u origin $BRANCH"
