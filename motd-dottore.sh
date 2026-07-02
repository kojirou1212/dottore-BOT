#!/bin/bash
# /etc/update-motd.d/01-dottore
# SSH ログイン時に表示されるカスタムバナー

# ─── カラー定義 ───────────────────────────────────────────────
R='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'
CYAN='\033[36m'
BLUE='\033[34m'
WHITE='\033[37m'
GRAY='\033[90m'
YELLOW='\033[33m'
RED='\033[31m'
GREEN='\033[32m'

# ─── システム情報の取得 ───────────────────────────────────────
HOST=$(hostname)
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$IP" ] && IP="不明"

UPTIME=$(uptime -p 2>/dev/null | sed 's/^up //' || echo "不明")

# CPU温度（vcgencmd が使えればそちらを優先）
if command -v vcgencmd &>/dev/null; then
  CPU_TEMP=$(vcgencmd measure_temp 2>/dev/null | grep -oP '[0-9.]+')
elif [ -f /sys/class/thermal/thermal_zone0/temp ]; then
  CPU_TEMP=$(awk '{printf "%.1f", $1/1000}' /sys/class/thermal/thermal_zone0/temp)
else
  CPU_TEMP="N/A"
fi

# 温度に応じて色を変える
TEMP_COLOR="$GREEN"
if [ "$CPU_TEMP" != "N/A" ]; then
  if (( $(echo "$CPU_TEMP >= 75" | bc -l 2>/dev/null) )); then
    TEMP_COLOR="$RED"
  elif (( $(echo "$CPU_TEMP >= 60" | bc -l 2>/dev/null) )); then
    TEMP_COLOR="$YELLOW"
  fi
fi

MEM_USED=$(free -m 2>/dev/null | awk 'NR==2{print $3}')
MEM_TOTAL=$(free -m 2>/dev/null | awk 'NR==2{print $2}')
MEM_PCT=$(free 2>/dev/null | awk 'NR==2{printf "%.0f", $3/$2*100}')
[ -z "$MEM_USED" ] && MEM_USED="?" && MEM_TOTAL="?" && MEM_PCT="?"

DISK_USED=$(df -h / 2>/dev/null | awk 'NR==2{print $3}')
DISK_TOTAL=$(df -h / 2>/dev/null | awk 'NR==2{print $2}')
DISK_PCT=$(df / 2>/dev/null | awk 'NR==2{print $5}')
[ -z "$DISK_USED" ] && DISK_USED="?" && DISK_TOTAL="?" && DISK_PCT="?"

NOW=$(date '+%Y/%m/%d  %H:%M:%S')

# ─── 描画関数 ─────────────────────────────────────────────────
W=52  # ボックス内側幅

# ボックスの罫線
top_border()    { printf "${BLUE}╔$(printf '═%.0s' $(seq 1 $W))╗${R}\n"; }
mid_border()    { printf "${BLUE}╠$(printf '═%.0s' $(seq 1 $W))╣${R}\n"; }
bottom_border() { printf "${BLUE}╚$(printf '═%.0s' $(seq 1 $W))╝${R}\n"; }
blank_row()     { printf "${BLUE}║${R}$(printf ' %.0s' $(seq 1 $W))${BLUE}║${R}\n"; }

# 中央寄せ行
center_row() {
  local text="$1"
  local color="$2"
  local len=${#text}
  local left=$(( (W - len) / 2 ))
  local right=$(( W - len - left ))
  [ $left -lt 0 ] && left=0
  [ $right -lt 0 ] && right=0
  printf "${BLUE}║${R}%${left}s${color}%s${R}%${right}s${BLUE}║${R}\n" "" "$text" ""
}

# ラベル＋値の行
info_row() {
  local label="$1"
  local value_plain="$2"   # パディング計算用（エスケープなし）
  local value_color="$3"   # 実際の表示（ANSIカラーあり）
  local inner="  $label  $value_plain"
  local len=${#inner}
  local pad=$(( W - len ))
  [ $pad -lt 0 ] && pad=0
  printf "${BLUE}║${R}  ${GRAY}%s${R}  %s%${pad}s${BLUE}║${R}\n" "$label" "$value_color" ""
}

# ─── バナー出力（13行） ───────────────────────────────────────
echo
top_border                                                                        # 1
center_row "◆  D O T T O R E  ◆"               "${BOLD}${CYAN}"                 # 2
center_row "Sistema di ricerca avviato"          "${DIM}${WHITE}"                # 3
mid_border                                                                        # 4
info_row   "HOST     :" "$HOST"                  "${BOLD}${WHITE}${HOST}${R}"    # 5
info_row   "IP       :" "$IP"                    "${GREEN}${IP}${R}"             # 6
info_row   "UPTIME   :" "$UPTIME"               "${WHITE}${UPTIME}${R}"          # 7
info_row   "CPU TEMP :" "${CPU_TEMP}°C"          "${TEMP_COLOR}${CPU_TEMP}°C${R}"# 8
info_row   "MEMORY   :" "${MEM_USED}MB/${MEM_TOTAL}MB (${MEM_PCT}%)" \
                         "${WHITE}${MEM_USED}MB${R}${GRAY}/${R}${WHITE}${MEM_TOTAL}MB ${R}${DIM}(${MEM_PCT}%)${R}"  # 9
info_row   "DISK     :" "${DISK_USED}/${DISK_TOTAL} (${DISK_PCT})" \
                         "${WHITE}${DISK_USED}${R}${GRAY}/${R}${WHITE}${DISK_TOTAL} ${R}${DIM}(${DISK_PCT})${R}"   # 10
info_row   "DATE     :" "$NOW"                   "${DIM}${NOW}${R}"              # 11
bottom_border                                                                     # 12
echo                                                                              # 13
