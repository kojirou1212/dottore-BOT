#!/bin/bash
# /etc/update-motd.d/01-dottore
# $'...' 記法で ESC 文字を正しく展開する

# ─── カラー ──────────────────────────────────────────────────
R=$'\e[0m';  B=$'\e[1m';  D=$'\e[2m'
CY=$'\e[36m'; BL=$'\e[34m'; WT=$'\e[37m'
GR=$'\e[90m'; YL=$'\e[33m'; RD=$'\e[31m'; GN=$'\e[32m'

# ─── システム情報 ─────────────────────────────────────────────
HOST=$(hostname)
IP=$(hostname -I 2>/dev/null | awk '{print $1}'); [[ -z $IP ]] && IP="—"
UPTIME=$(uptime -p 2>/dev/null \
  | sed 's/^up //; s/ weeks\?/w/g; s/ days\?/d/g; s/ hours\?/h/g; s/ minutes\?/m/g; s/,//g')

# CPU温度
if command -v vcgencmd &>/dev/null; then
  TEMP=$(vcgencmd measure_temp 2>/dev/null | grep -oP '[0-9.]+')
elif [[ -f /sys/class/thermal/thermal_zone0/temp ]]; then
  TEMP=$(awk '{printf "%.1f", $1/1000}' /sys/class/thermal/thermal_zone0/temp)
else
  TEMP="N/A"
fi
# 85°C を 100% として割合を計算
if [[ $TEMP != "N/A" ]]; then
  TEMP_P=$(awk "BEGIN{printf \"%.0f\", ${TEMP%.*}*100/85}")
else
  TEMP_P=0
fi
TEMP_C=$GN
(( TEMP_P >= 88 )) && TEMP_C=$RD || (( TEMP_P >= 70 )) && TEMP_C=$YL

# メモリ
MEM_U=$(free -m 2>/dev/null | awk 'NR==2{print $3}')
MEM_T=$(free -m 2>/dev/null | awk 'NR==2{print $2}')
MEM_P=$(free 2>/dev/null | awk 'NR==2{printf "%.0f", $3/$2*100}')
MEM_C=$GN; (( MEM_P >= 80 )) && MEM_C=$RD || (( MEM_P >= 60 )) && MEM_C=$YL

# ディスク
DSK_U=$(df -h / 2>/dev/null | awk 'NR==2{print $3}')
DSK_T=$(df -h / 2>/dev/null | awk 'NR==2{print $2}')
DSK_P=$(df / 2>/dev/null | awk 'NR==2{print $5}' | tr -d '%')
DSK_C=$GN; (( DSK_P >= 80 )) && DSK_C=$RD || (( DSK_P >= 60 )) && DSK_C=$YL

NOW=$(date '+%Y/%m/%d  %H:%M')
LAST=$(last -F 2>/dev/null | awk '!/reboot|wtmp|^$/{print $5,$6,$7,$8; exit}')

W=62  # ボックス内側幅（ASCIIアート60文字に合わせる）

# ─── 描画ヘルパー ─────────────────────────────────────────────
TB() { printf "${BL}╔$(printf '═%.0s' $(seq 1 $W))╗${R}\n"; }
MB() { printf "${BL}╠$(printf '═%.0s' $(seq 1 $W))╣${R}\n"; }
BB() { printf "${BL}╚$(printf '═%.0s' $(seq 1 $W))╝${R}\n"; }

# 中央寄せ（キリル文字など多バイト文字対応: wc -m で文字数カウント）
ctr() {
  local txt="$1" col="${2:-}"
  local len; len=$(printf '%s' "$txt" | wc -m)
  local l=$(( (W - len) / 2 ))
  local r=$(( W - len - l ))
  [[ $l -lt 0 ]] && l=0; [[ $r -lt 0 ]] && r=0
  printf "${BL}║${R}%${l}s${col}%s${R}%${r}s${BL}║${R}\n" "" "$txt" ""
}

# プログレスバー（BAR と BAR_PLAIN にセット）
# 塗り:col色の█  空き:グレーの░（ASCII括弧で幅計算を正確に保つ）
mkbar() {
  local pct=$1 col=$2 w=26 filled="" empty="" i
  local f=$(( pct * w / 100 ))
  [[ $f -lt 0 ]] && f=0; [[ $f -gt $w ]] && f=$w
  local e=$(( w - f ))
  for ((i=0;i<f;i++)); do filled+="█"; done
  for ((i=0;i<e;i++)); do empty+="░"; done
  BAR="${GR}[${col}${B}${filled}${R}${GR}${empty}]${R}"
  BAR_PLAIN="[${filled}${empty}]"  # 幅 = w+2（ASCII only, ${#} = 実文字数）
}

# ラベル＋バー行
brow() {
  local label="$1" val="$2" val_c="$3" pct="${4:-0}" bar_c="$5"
  mkbar "$pct" "$bar_c"
  local visible="  $label  $val  ${BAR_PLAIN}  ${pct}%"
  local pad=$(( W - ${#visible} ))
  [[ $pad -lt 0 ]] && pad=0
  printf "${BL}║${R}  ${GR}%s${R}  ${val_c}%s${R}  %s  ${D}%s%%${R}%${pad}s${BL}║${R}\n" \
    "$label" "$val" "$BAR" "$pct" ""
}

# 2カラム行
trow() {
  local k1="$1" v1="$2" c1="$3" k2="$4" v2="$5" c2="$6"
  local lp="  $k1  $v1"
  local rp="$k2  $v2  "
  local gap=$(( W - ${#lp} - ${#rp} ))
  [[ $gap -lt 1 ]] && gap=1
  printf "${BL}║${R}  ${GR}%s${R}  ${c1}%s${R}%${gap}s${GR}%s${R}  ${c2}%s${R}  ${BL}║${R}\n" \
    "$k1" "$v1" "" "$k2" "$v2"
}

# ─── 出力 ─────────────────────────────────────────────────────
echo
TB
ctr "██████╗  ██████╗ ████████╗████████╗ ██████╗ ██████╗ ███████╗" "${B}${CY}"
ctr "██╔══██╗██╔═══██╗╚══██╔══╝╚══██╔══╝██╔═══██╗██╔══██╗██╔════╝" "${B}${CY}"
ctr "██║  ██║██║   ██║   ██║      ██║   ██║   ██║██████╔╝█████╗  " "${B}${CY}"
ctr "██║  ██║██║   ██║   ██║      ██║   ██║   ██║██╔══██╗██╔══╝  " "${B}${CY}"
ctr "██████╔╝╚██████╔╝   ██║      ██║   ╚██████╔╝██║  ██║███████╗" "${B}${CY}"
ctr "╚═════╝  ╚═════╝    ╚═╝      ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚══════╝" "${B}${CY}"
ctr "Sistema  di  ricerca  avviato"  "${D}${WT}"
MB
trow "HOST"   "$HOST"   "${B}${WT}" "IP"     "$IP"   "${GN}"
trow "UPTIME" "$UPTIME" "${WT}"     "DATE"   "$NOW"  "${D}${WT}"
MB
brow "CPU " "${TEMP}°C"              "$TEMP_C" "$TEMP_P" "$TEMP_C"
brow "MEM " "${MEM_U}MB / ${MEM_T}MB" "$MEM_C" "$MEM_P"  "$MEM_C"
brow "DISK" "${DSK_U} / ${DSK_T}"   "$DSK_C"  "$DSK_P"  "$DSK_C"
MB
if [[ -n $LAST ]]; then
  ctr "Last login : $LAST" "${GR}"
else
  ctr "─── benvenuto nel sistema ───" "${GR}"
fi
BB
echo
