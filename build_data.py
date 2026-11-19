#!/usr/bin/env python3
"""
raw/ 内の時刻表テキスト（Yahoo!路線情報のコピペ等）をパースして data.json を生成する。

使い方:
  1. 初回のみテンプレート作成:  python3 build_data.py --init
  2. raw/*.txt に時刻表を貼り付けて保存
  3. data.json を生成:        python3 build_data.py
"""
import json
import re
import sys
from pathlib import Path

BASE_DIR = Path(__file__).parent
STATIONS_FILE = BASE_DIR / "stations.json"
RAW_DIR = BASE_DIR / "raw"
OUT_FILE = BASE_DIR / "data.json"

# よく使う種別略称の正規化マップ
TYPE_MAP = {
    "各": "各停", "普": "普通", "準": "準急", "急": "急行",
    "快": "快速急行", "快急": "快速急行", "通準": "通勤準急",
    "通急": "通勤急行", "特": "特急", "ロ": "特急"
}

def init_raw_files():
    RAW_DIR.mkdir(exist_ok=True)
    master = json.loads(STATIONS_FILE.read_text(encoding="utf-8"))
    created = 0
    for st in master["stations"]:
        for d in st["directions"]:
            for day in ("weekday", "holiday"):
                p = RAW_DIR / f"{d['id']}_{day}.txt"
                if not p.exists():
                    header = f"# {st['name']} ({d.get('line', st['line'])}) - {d['name']} [{day}]\n# この下にYahoo!路線情報の時刻表（5時〜24時）をそのまま貼り付けてください\n"
                    p.write_text(header, encoding="utf-8")
                    created += 1
    print(f"raw/ に {created} 件のテンプレートファイルを作成しました。")

def parse_timetable_text(text: str) -> dict:
    """
    Yahoo!路線情報の時刻表コピペ形式をパースする。
    例:
      5
      05
      各 新宿
      18
      準 綾瀬
    またはタブ区切り「5\t05 各 新宿\t18 準 綾瀬」等にも対応。
    """
    schedule = {}
    current_hour = None

    # コメント行を除去してトークン化
    lines = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.strip().startswith("#")]

    # パターン1: 「時」の単独行 (例: "5", "05", "23", "5時")
    hour_re = re.compile(r"^(\d{1,2})時?$")
    # パターン2: 分の単独行 (例: "05", "58")
    min_only_re = re.compile(r"^(\d{2})$")
    # パターン3: 1行に「分 種別 行先」が入っている場合 (例: "05 各 新宿", "05:各停:新宿")
    inline_re = re.compile(r"(\d{2})(?:[:\s]+([^\d\s:]+))?(?:[:\s]+([^\d\s:]+))?")

    i = 0
    while i < len(lines):
        line = lines[i]

        # 時間の切り替わり判定（タブ区切りで先頭が「時」のケースも考慮）
        parts = line.split("\t")
        if len(parts) >= 2 and hour_re.match(parts[0].strip()):
            h = int(hour_re.match(parts[0].strip()).group(1))
            if h == 0:
                h = 24
            if 4 <= h <= 24:
                current_hour = str(h)
                schedule.setdefault(current_hour, [])
                for cell in parts[1:]:
                    m_match = inline_re.search(cell.strip())
                    if m_match:
                        m = m_match.group(1)
                        t = TYPE_MAP.get(m_match.group(2) or "", m_match.group(2) or "普通")
                        dest = m_match.group(3) or ""
                        schedule[current_hour].append(f"{m}:{t}:{dest}")
                i += 1
                continue

        # 「時」の単独行
        h_match = hour_re.match(line)
        if h_match and len(line) <= 3:
            val = int(h_match.group(1))
            # 1桁、または直前が時間でない / 0時(24時) / 前回より大きい24以下なら「時」とみなす
            if (len(line.replace("時", "")) == 1 or "時" in line or
                current_hour is None or
                (val == 0 and int(current_hour) >= 23) or
                (4 <= val <= 24 and val == int(current_hour) + 1)):
                current_hour = "24" if val == 0 else str(val)
                schedule.setdefault(current_hour, [])
                i += 1
                continue

        if current_hour is None:
            i += 1
            continue

        # 「分」の単独行（Yahoo!路線情報の縦コピペ形式）
        if min_only_re.match(line):
            m = line
            t_type = "普通"
            dest = ""
            # 次の行が種別・行先なら取り込む
            if i + 1 < len(lines) and not min_only_re.match(lines[i + 1]) and not hour_re.match(lines[i + 1]):
                meta = lines[i + 1].split()
                if len(meta) >= 2:
                    t_type = TYPE_MAP.get(meta[0], meta[0])
                    dest = meta[1]
                elif len(meta) == 1:
                    # 1語だけの場合は種別か行先か簡易判定
                    if meta[0] in TYPE_MAP or meta[0] in TYPE_MAP.values():
                        t_type = TYPE_MAP.get(meta[0], meta[0])
                    else:
                        dest = meta[0]
                i += 1
            schedule[current_hour].append(f"{m}:{t_type}:{dest}")
            i += 1
            continue

        # 1行に「分 種別 行先」が並ぶ形式
        m_match = inline_re.match(line)
        if m_match:
            m = m_match.group(1)
            t = TYPE_MAP.get(m_match.group(2) or "", m_match.group(2) or "普通")
            dest = m_match.group(3) or ""
            schedule[current_hour].append(f"{m}:{t}:{dest}")

        i += 1

    # 空の時間を除去
    return {k: v for k, v in schedule.items() if v}

def build():
    master = json.loads(STATIONS_FILE.read_text(encoding="utf-8"))
    out_stations = []

    for st in master["stations"]:
        st_out = {
            "id": st["id"],
            "name": st["name"],
            "line": st["line"],
            "lat": st["lat"],
            "lon": st["lon"],
            "directions": []
        }
        for d in st["directions"]:
            dir_out = {"name": d["name"], "timetable": {"weekday": {}, "holiday": {}}}
            if "line" in d:
                dir_out["line"] = d["line"]

            for day in ("weekday", "holiday"):
                p = RAW_DIR / f"{d['id']}_{day}.txt"
                if p.exists():
                    parsed = parse_timetable_text(p.read_text(encoding="utf-8"))
                    dir_out["timetable"][day] = parsed
                    count = sum(len(v) for v in parsed.values())
                    if count > 0:
                        print(f"  [OK] {p.name}: {count}本")
            st_out["directions"].append(dir_out)
        out_stations.append(st_out)

    OUT_FILE.write_text(json.dumps({"stations": out_stations}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n-> {OUT_FILE.name} を生成しました。")

if __name__ == "__main__":
    if "--init" in sys.argv:
        init_raw_files()
    else:
        build()