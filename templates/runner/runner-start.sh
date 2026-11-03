#!/bin/bash
# dle-runner@.service の ExecStart。runner を起動してよいか確認してから run.sh に exec する。
# root 所有で /usr/local/libexec/dle/ に置く（job に書き換えさせない）。
#
# 終了コード（systemd の Restart=always・RestartPreventExitStatus=71 と組む）:
#   71  起動してはいけない（public・登録なし・書式違反）。再試行されない
#   72  WSL interop が有効。再試行される（無効化されれば自動で起動する）
#   75  判定できない（ネットワーク失敗・429・403・301・5xx）。再試行される
#   それ以外の失敗（想定外・構文エラー・127）も 71 以外なので、再試行される
# Why not ExecCondition: systemd 自身の exec 失敗（200 番台）が「条件を満たさない」扱いで再試行されない。
# Why not GitHub の API: 認証なしは 60 回/時間/IP で、3 runner が 60 秒おきに確認すると超える。Web ページは
#   private が 404、public が 200（認証なし）で、別のレート制限になる。git ls-remote はネットワーク失敗と
#   「private で認証を求められた失敗」を区別できず、失敗時に起動してしまう向きになるので使わない。
#
# テスト用の差し替え: DLE_CURL（curl の場所）・DLE_RUNNERS_ROOT（actions-runners の場所）・
#   DLE_INTEROP_FILE（binfmt の WSLInterop）。PATH 経由の差し替えは使わない（PATH は固定する）。
#   ユニットの UnsetEnvironment= で、manager の環境からは引き継がない。

set -u
export PATH=/usr/bin:/bin
cd / || exit 74

CURL=${DLE_CURL:-/usr/bin/curl}
INTEROP=${DLE_INTEROP_FILE:-/proc/sys/fs/binfmt_misc/WSLInterop}
HOME_DIR=$(getent passwd "$(id -un)" | cut -d: -f6)
[ -n "$HOME_DIR" ] || exit 74
ROOT=${DLE_RUNNERS_ROOT:-$HOME_DIR/actions-runners}

# 引数は runner のディレクトリ名 1 個だけ（%i に ../x を渡されても、他の .runner を読まない）
[ "$#" -eq 1 ] || exit 71
name=$1
[[ $name =~ ^[a-z0-9][a-z0-9-]*$ ]] || exit 71
dir=$ROOT/$name
runner_file=$dir/.runner
[ -f "$runner_file" ] && [ ! -L "$runner_file" ] || exit 71
size=$(stat -c %s "$runner_file") || exit 74
[ "$size" -le 65536 ] || exit 71

# 登録先。.runner は job が書き換えられるが、書式（https://github.com/<owner>/<repo>）に合うものだけ使う
url=$(sed -n 's/.*"gitHubUrl"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$runner_file" | head -1)
re='^https://github\.com/([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9._-]{1,100})$'
[[ $url =~ $re ]] || exit 71
owner=${BASH_REMATCH[1]}
repo=${BASH_REMATCH[2]}
[ "$repo" != "." ] && [ "$repo" != ".." ] || exit 71

# WSL interop が有効なら起動しない（Windows の実行ファイルが job から起動できる状態）。無効化されれば自動で起動する
if [ "$(head -n1 "$INTEROP" 2>/dev/null)" = "enabled" ]; then
	echo "WSL interop が有効なので起動しない（README の手順で無効化する）" >&2
	exit 72
fi

code=$("$CURL" --silent --max-time 10 --connect-timeout 5 --output /dev/null --write-out '%{http_code}' \
	"https://github.com/$owner/$repo")
rc=$?
[ "$rc" -eq 0 ] || exit 75
case $code in
404) cd "$dir" || exit 75; exec "$dir/run.sh" ;;
200) exit 71 ;;
*) exit 75 ;;
esac
