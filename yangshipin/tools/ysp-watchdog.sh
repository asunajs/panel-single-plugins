#!/bin/bash
# 央视频插件卡死取证看门狗（独立于面板与插件运行）
#
# 判据：最后一条 `[start] [yangshipin]` 晚于最后一条「结束标志」，
# 且 start 与最后一条 yangshipin 日志各自都已静默超过 STALL_SEC 秒。
# 命中就 sample 面板进程线程栈，同一轮只抓一次。

set -u
P="/Users/catlair/Library/Application Support/plugin-panel"
LOG="$P/logs/stdout.log"
OUT="$P/watchdog/stacks"
MARK="$P/watchdog/.last-sampled"
STALL_SEC=${STALL_SEC:-90}

[ -f "$LOG" ] || exit 0

START_LINE=$(grep -n "\[start\] \[yangshipin\]" "$LOG" | tail -1 | cut -d: -f1)
[ -z "$START_LINE" ] && exit 0

# 结束的三种写法：预算/手动停止、正常跑完的汇总行、执行失败
# 四种收尾形态：停止 / 正常汇总 / 执行失败 / 兜底检查（今天已完成）
END_LINE=$(grep -nE "任务 .每日任务. 已停止|每日任务：[0-9]+ 新完成|任务 .每日任务. 执行失败|兜底检查：" "$LOG" \
           | tail -1 | cut -d: -f1)
if [ -n "$END_LINE" ] && [ "$END_LINE" -gt "$START_LINE" ]; then exit 0; fi

if [ -f "$MARK" ] && [ "$(cat "$MARK" 2>/dev/null)" = "$START_LINE" ]; then exit 0; fi

epoch_of() {  # 把日志某行的时间戳转成 epoch
    sed -n "${1}p" "$LOG" | awk '{print $1" "$2}' | cut -d. -f1 \
      | xargs -I{} date -j -f "%Y-%m-%d %H:%M:%S" "{}" +%s 2>/dev/null
}

START_EPOCH=$(epoch_of "$START_LINE")
LAST_LINE=$(grep -n "\[yangshipin\]" "$LOG" | tail -1 | cut -d: -f1)
LAST_EPOCH=$(epoch_of "$LAST_LINE")
NOW=$(date +%s)
[ -z "$START_EPOCH" ] && exit 0
[ -z "$LAST_EPOCH" ] && exit 0

[ $((NOW - START_EPOCH)) -lt "$STALL_SEC" ] && exit 0
[ $((NOW - LAST_EPOCH)) -lt "$STALL_SEC" ] && exit 0

PID=$(pgrep -f "plugin-panel/bin/plugin-panel" | head -1)
[ -z "$PID" ] && exit 0

STAMP=$(date +%Y%m%d-%H%M%S)
{
  echo "=== 卡死现场 $STAMP ==="
  echo "面板 pid=$PID"
  echo "start 行=$START_LINE（已 $((NOW - START_EPOCH))s）  最后日志行=$LAST_LINE（已静默 $((NOW - LAST_EPOCH))s）"
  echo "--- 最后 5 条 yangshipin 日志 ---"
  grep "\[yangshipin\]" "$LOG" | tail -5
} > "$OUT/stall-$STAMP.txt"
sample "$PID" 2 -file "$OUT/stall-$STAMP.stack" >/dev/null 2>&1
echo "$START_LINE" > "$MARK"
