// Bash の harness-config と同じ字句的なパス契約。参照時にディレクトリは作らない。
import path from "node:path";

export interface WorktreeLocation {
	repoRoot: string;
	home: string;
	project: string;
	worktreeRoot?: unknown;
}

export function withinDirectory(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function resolveWorktreeRoot({ repoRoot, home, project, worktreeRoot }: WorktreeLocation): string {
	const main = path.resolve(repoRoot);
	if (worktreeRoot != null && typeof worktreeRoot !== "string") {
		throw new Error("worktreeRoot は文字列/null/未指定で指定してください");
	}
	if (typeof worktreeRoot === "string" && worktreeRoot !== "") {
		if (/^[~$]/.test(worktreeRoot)) {
			throw new Error(
				"worktreeRoot: 先頭の ~ や $ の展開は行わないため、展開済みの絶対パスまたは通常の相対パスを指定してください",
			);
		}
		return path.resolve(main, worktreeRoot);
	}
	if (!project) throw new Error("worktreeRoot: 登録名を特定できないため DLE_PROJECT に登録名を指定してください");
	if (!/^[A-Za-z0-9._-]+$/.test(project) || project === "." || project === "..") {
		throw new Error(
			"worktreeRoot: 登録名は [A-Za-z0-9._-]+（. と .. を除く）で指定してください。適切な明示 root も利用できます",
		);
	}
	const h = path.resolve(main, home);
	const candidate = path.resolve(`${h}-worktrees`, project);
	if (withinDirectory(main, candidate) || withinDirectory(h, candidate)) {
		throw new Error("worktreeRoot: 既定候補が main/DLE_HOME 配下になるため、適切な明示絶対 root を指定してください");
	}
	return candidate;
}
