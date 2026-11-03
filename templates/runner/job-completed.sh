#!/bin/bash
# runner の job 終了フック（ACTIONS_RUNNER_HOOK_JOB_COMPLETED）。job の作業ディレクトリの中身を消す。
# root 所有で /usr/local/libexec/dle/ に置く。保証するのは「スクリプトの中身を job が書き換えられない」ことだけ。
# runner の .env に同名の行を書けばフックの指定は差し替えられる（dle runner status が .env の変更を検知する）。
#
# 消すのは、解決後のパスが <actions-runners>/<名前>/_work/<リポジトリ>/<リポジトリ> の形のときだけ。
# 条件を満たさなければ、何も消さずに警告だけ出して 0 で終わる。
# Why not 終了コード 1: フックの失敗がそのまま job の失敗（赤）になりうる。
# Why not 環境変数での差し替え: フックの環境は Worker 経由で、job の env: や $GITHUB_ENV が届きうる。
#   actions-runners の場所は第 1 引数でだけ上書きできる（runner は引数を渡さないので、テストだけが使う）。

# runner は `bash -e <path>` で呼ぶ。-e のままだと、掃除の一部の失敗でフックが失敗し、job が赤になりうる。
# 失敗は警告にとどめ、次の掃除（_temp）も続けて、必ず 0 で終わる。
set +e
set -u
export PATH=/usr/bin:/bin
cd / || exit 0
warn() { echo "dle job-completed: $*" >&2; }

HOME_DIR=$(getent passwd "$(id -un)" | cut -d: -f6)
ROOT=${1:-$HOME_DIR/actions-runners}
root_real=$(realpath -e -- "$ROOT" 2>/dev/null) || { warn "actions-runners が見つからない: 何も消さない"; exit 0; }

# 絶対パスで、.. とシンボリックリンクを含まない（解決後と一致する）ものだけ
check_dir() { # $1=パス $2=期待する階層（workspace | temp）。通れば解決後のパスを標準出力に出す
	local p=$1 kind=$2 real rel name w a b extra
	[ -n "$p" ] || return 1
	real=$(realpath -e -- "$p" 2>/dev/null) || return 1
	[ "$p" = "$real" ] || return 1
	case $real in "$root_real"/*) ;; *) return 1 ;; esac
	rel=${real#"$root_real"/}
	IFS=/ read -r name w a b extra <<<"$rel"
	[[ $name =~ ^[a-z0-9][a-z0-9-]*$ ]] || return 1
	[ "$w" = "_work" ] || return 1
	if [ "$kind" = workspace ]; then
		[ -n "$a" ] && [ -n "$b" ] && [ -z "$extra" ] || return 1
		case $a in _*) return 1 ;; esac
	else
		[ "$a" = "_temp" ] && [ -z "$b" ] || return 1
	fi
	printf '%s\n' "$real"
}

clean() {
	# job が chmod 000 のサブディレクトリを作っても消せるように、先に所有者の権限を戻す（シンボリックリンクは辿らない）
	chmod -R u+rwX -- "$1" 2>/dev/null
	find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf --one-file-system -- {} + 2>/dev/null
}

if ws=$(check_dir "${GITHUB_WORKSPACE:-}" workspace); then
	clean "$ws" || warn "作業ディレクトリの一部を消せなかった"
else
	warn "GITHUB_WORKSPACE が想定の場所でないので、何も消さない"
fi
if tmp=$(check_dir "${RUNNER_TEMP:-}" temp); then
	clean "$tmp" || warn "_temp の一部を消せなかった"
else
	warn "RUNNER_TEMP が想定の場所でないので、何も消さない"
fi
exit 0
