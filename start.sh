#!/usr/bin/env bash
#
# 股票秘书 — 一键启动脚本
# Usage:
#   ./start.sh          # 生产模式（后端托管前端，http://127.0.0.1:3000）
#   ./start.sh dev      # 开发模式（后端 + Vite HMR，http://localhost:5173）
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

# ---- 颜色 ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

log_info()  { echo -e "${GREEN}[INFO]${NC}  $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()  { echo -e "${CYAN}━━━ $1 ━━━${NC}"; }

# ---- 1. 检查 Node.js 版本 ----
log_step "检查 Node.js"
if ! command -v node &>/dev/null; then
  log_error "未找到 node，请先安装 Node.js >= 18"
  exit 1
fi
NODE_VER=$(node -v | sed 's/v//;s/\..*//')
if [ "$NODE_VER" -lt 18 ]; then
  log_error "Node.js 版本过低：$(node -v)，需要 >= 18"
  exit 1
fi
log_info "Node.js $(node -v)"

# ---- 2. 安装依赖 ----
log_step "检查前端依赖"
if [ ! -d node_modules ]; then
  log_info "未检测到 node_modules，正在安装依赖..."
  npm install
  log_info "依赖安装完成"
else
  log_info "依赖已就绪"
fi

# ---- 3. 模式选择 ----
MODE="${1:-prod}"

if [ "$MODE" = "dev" ]; then
  # ========== 开发模式 ==========
  log_step "启动开发模式"

  # 构建前端（开发模式不需要先构建，Vite 会处理）
  log_info "正在启动后端服务（:3000）和 Vite 开发服务器（:5173）..."
  log_info ""
  log_info "  后端 API + 行情调度 → http://127.0.0.1:3000"
  log_info "  前端热更新        → http://localhost:5173  （/api 自动代理到 :3000）"
  log_info "  按 ${CYAN}Ctrl+C${NC} 同时停止两个服务"
  log_info ""

  # 用 trap 清理后台进程
  cleanup() {
    log_info "正在停止服务..."
    kill 0 2>/dev/null || true
    wait 2>/dev/null || true
  }
  trap cleanup EXIT INT TERM

  # 后台启动后端
  node server/index.js &
  BACKEND_PID=$!

  # 前台启动 Vite（保留 stdout/stderr 直出）
  npx vite --host
  # Vite 退出后 trap 会自动清理后端进程

else
  # ========== 生产模式 ==========
  log_step "启动生产模式"

  # 构建前端（dist/ 不存在，或 web/ 源码比构建产物新时重建）
  NEED_BUILD=0
  if [ ! -d dist ] || [ ! -f dist/index.html ]; then
    NEED_BUILD=1
  else
    # web/ 下任一源文件比 dist/index.html 新 → 需要重建
    if [ -n "$(find web -type f -newer dist/index.html 2>/dev/null | head -n 1)" ]; then
      NEED_BUILD=1
    fi
  fi

  if [ "$NEED_BUILD" = "1" ]; then
    log_info "正在构建前端（首次或源码有更新）..."
    npm run build
    log_info "构建完成"
  else
    log_info "前端构建产物已就绪（dist/）"
  fi

  echo ""
  log_info "服务地址：${CYAN}http://127.0.0.1:3000${NC}"
  log_info "行情调度每 20 秒自动运行（非交易时段降频至 300 秒）"
  log_info "按 ${CYAN}Ctrl+C${NC} 停止服务"
  echo ""

  npm start
fi
