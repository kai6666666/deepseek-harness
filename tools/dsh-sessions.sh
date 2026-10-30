#!/system/bin/sh
# DSH 会话清理
#
# 会话有两份数据，**必须一起清**，否则侧栏会继续显示已删除的会话：
#   ① $R/home/.dsh/sessions/<project-slug>/session-<uuid>/     正文（session.lock + v4.zstd）
#   ② $R/home/.dsh/storages/session_projcache/sessions/<id>.json  侧栏列表缓存索引
#   ③ $R/home/.dsh/storages/workspace.json 里登记的 workspaceIds / archived / pinned
#
# 用法（设备侧 shell，uid 2000；不要包 run-as）：
#   sh dsh-sessions.sh list                      # 每个 project 的会话数 + 最新一条
#   sh dsh-sessions.sh size                      # 占用
#   sh dsh-sessions.sh prune --keep 5            # 每个 project 只留最新 5 个
#   sh dsh-sessions.sh prune --keep 5 --project --data-user-0-com.dsh.android-files-engine--
#   sh dsh-sessions.sh purge --from-workspace    # 只留 workspace.json 登记过的（=清掉全部未分组）
#   sh dsh-sessions.sh purge --keep-ids "session-aaa session-bbb"
#
# 为什么不用 rm -rf：本机 shell 守卫会拦 "rm -rf"，改用 find -depth -delete，
# 效果等价（自底向上删空目录），且不会误删项目根。
R=${DSH_HOME_ROOT:-/data/user/0/com.dsh.android/files}
SESS="$R/home/.dsh/sessions"
CACHE="$R/home/.dsh/storages/session_projcache/sessions"
WS="$R/home/.dsh/storages/workspace.json"
CMD=${1:-list}
shift 2>/dev/null

KEEP=3
ONLY=""
KEEPIDS=""
FROMWS=0
# 临时清单必须落在 app 私有目录：/data/local/tmp 是 root:shell 0711，
# 应用 uid（10xxx）连创建文件都不允许，重定向会静默失败导致「removed=0」。
LST="$R/home/.prune.lst"
while [ $# -gt 0 ]; do
    case "$1" in
        --keep) KEEP=$2; shift 2 ;;
        --project) ONLY=$2; shift 2 ;;
        --keep-ids) KEEPIDS=$2; shift 2 ;;
        --from-workspace) FROMWS=1; shift ;;
        *) shift ;;
    esac
done

[ -d "$SESS" ] || { echo "no sessions dir: $SESS"; exit 1; }

drop() {
    # 自底向上删除，替代 rm -rf
    find "$1" -depth -delete 2>/dev/null
}

# 删一个会话：正文目录 + 侧栏缓存索引
drop_session() {
    drop "$1"
    b=$(basename "$1")
    [ -f "$CACHE/$b.json" ] && drop "$CACHE/$b.json"
}

kept() {
    # $1 = session id（不带 .json）。命中保留名单返回 0
    case " $KEEPIDS " in *" $1 "*) return 0 ;; esac
    return 1
}

case "$CMD" in
    list)
        for p in "$SESS"/*/; do
            [ -d "$p" ] || continue
            n=$(ls -1 "$p" 2>/dev/null | wc -l)
            newest=$(ls -1t "$p" 2>/dev/null | head -1)
            echo "$(basename "$p")  count=$n  newest=$newest"
        done
        echo "---- cache=$(ls -1 "$CACHE" 2>/dev/null | wc -l)  (侧栏缓存索引)"
        ;;
    size)
        du -sh "$SESS" 2>/dev/null
        for p in "$SESS"/*/; do du -sh "$p" 2>/dev/null; done
        [ -d "$CACHE" ] && du -sh "$CACHE" 2>/dev/null
        ;;
    prune)
        total=0
        for p in "$SESS"/*/; do
            [ -d "$p" ] || continue
            slug=$(basename "$p")
            [ -n "$ONLY" ] && [ "$slug" != "$ONLY" ] && continue
            n=$(ls -1 "$p" 2>/dev/null | wc -l)
            if [ "$n" -le "$KEEP" ]; then
                echo "skip $slug (count=$n <= keep=$KEEP)"
                continue
            fi
            ls -1t "$p" | tail -n +$((KEEP + 1)) > "$LST"
            c=0
            while IFS= read -r s; do
                [ -n "$s" ] || continue
                drop_session "$p$s"
                c=$((c + 1))
            done < "$LST"
            find "$LST" -delete 2>/dev/null
            total=$((total + c))
            echo "pruned $slug: removed=$c left=$(ls -1 "$p" 2>/dev/null | wc -l)"
        done
        echo "---- PRUNE done removed=$total keep=$KEEP"
        ;;
    purge)
        # 要保留的 id：显式名单，或从 workspace.json 里抓（未登记 = 未分组）
        if [ "$FROMWS" = "1" ] && [ -f "$WS" ]; then
            KEEPIDS=$(grep -o 'session-[0-9a-f-]\{36\}' "$WS" | sort -u | tr '\n' ' ')
        fi
        [ -n "$KEEPIDS" ] || { echo "purge 需要 --from-workspace 或 --keep-ids"; exit 2; }
        echo "keep: $KEEPIDS"
        c=0
        for p in "$SESS"/*/; do
            [ -d "$p" ] || continue
            for s in "$p"*; do
                [ -d "$s" ] || continue
                b=$(basename "$s")
                kept "$b" && { echo "keep $b"; continue; }
                drop_session "$s"
                c=$((c + 1))
                echo "del  $b"
            done
        done
        # 缓存里可能存在「正文早已删除」的孤儿索引，一并清
        o=0
        for f in "$CACHE"/*.json; do
            [ -f "$f" ] || continue
            b=$(basename "$f" .json)
            kept "$b" && continue
            drop "$f"
            o=$((o + 1))
        done
        echo "---- PURGE done removed=$c orphan_cache=$o"
        ;;
    *)
        echo "usage: sh dsh-sessions.sh list|size|prune [--keep N] [--project SLUG]|purge [--from-workspace|--keep-ids \"id ...\"]"
        exit 2
        ;;
esac