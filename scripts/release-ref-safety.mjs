import { spawnSync } from "node:child_process";

function git(args, options = {}) {
	const result = spawnSync("git", args, {
		encoding: "utf8",
		stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
		throw new Error(`git ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
	}
	return result.stdout?.trim() ?? "";
}

export function validateReleaseRefState({ branch, headSha, localMainSha, remoteMainSha, upstream }) {
	if (branch !== "main") {
		throw new Error(`Releases must run from local branch main; current branch is ${branch || "(detached HEAD)"}`);
	}
	if (upstream !== "origin/main") {
		throw new Error(`Local main must track origin/main; current upstream is ${upstream || "(none)"}`);
	}
	if (headSha !== localMainSha) {
		throw new Error(`HEAD ${headSha} is not the local main tip ${localMainSha}`);
	}
	if (headSha !== remoteMainSha) {
		throw new Error(
			`Local main ${headSha} does not match fetched origin/main ${remoteMainSha}. Update and review main before releasing.`,
		);
	}
}

export function assertReleaseRefSafety() {
	const branch = git(["branch", "--show-current"]);
	if (branch !== "main") {
		throw new Error(`Releases must run from local branch main; current branch is ${branch || "(detached HEAD)"}`);
	}
	const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
	if (upstream !== "origin/main") {
		throw new Error(`Local main must track origin/main; current upstream is ${upstream || "(none)"}`);
	}

	console.log("$ git fetch --quiet origin refs/heads/main:refs/remotes/origin/main");
	git(["fetch", "--quiet", "origin", "refs/heads/main:refs/remotes/origin/main"], { inherit: true });
	const state = {
		branch,
		headSha: git(["rev-parse", "HEAD"]),
		localMainSha: git(["rev-parse", "refs/heads/main"]),
		remoteMainSha: git(["rev-parse", "refs/remotes/origin/main"]),
		upstream,
	};
	validateReleaseRefState(state);
	console.log(`  Release source is reviewed origin/main at ${state.headSha}\n`);
	return state;
}
