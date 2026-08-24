#!/usr/bin/env bash
#
# Move loose mcpi session JSONL files into the current per-project session layout.
#
# By default, the source is mcpi's config directory and the destination is the
# XDG state directory's sessions tree. MCPI_CODING_AGENT_DIR remains a single-root
# override, so both locations are under that directory when it is set.
#
# Legacy migration is explicit: to migrate the old ~/.pi/agent layout, pass
#   --source "$HOME/.pi/agent"
# mcpi never reads that legacy path as a runtime fallback.
#
# Usage: ./migrate-sessions.sh [--dry-run] [--source <dir>] [--destination <dir>]
#

set -euo pipefail

if [[ -n "${MCPI_CODING_AGENT_DIR:-}" ]]; then
	config_root="$MCPI_CODING_AGENT_DIR"
	state_root="$MCPI_CODING_AGENT_DIR"
elif [[ "$OSTYPE" == msys* || "$OSTYPE" == cygwin* ]]; then
	config_home="${APPDATA:-$HOME/AppData/Roaming}"
	state_home="${LOCALAPPDATA:-$HOME/AppData/Local}"
	config_root="$config_home/mcpi"
	state_root="$state_home/mcpi"
else
	config_root="${XDG_CONFIG_HOME:-$HOME/.config}/mcpi"
	state_root="${XDG_STATE_HOME:-$HOME/.local/state}/mcpi"
fi

source_dir="$config_root"
destination_dir="$state_root/sessions"
dry_run=false

usage() {
	cat <<EOF
Usage: ./migrate-sessions.sh [--dry-run] [--source <dir>] [--destination <dir>]

Moves loose *.jsonl files from:
  $source_dir
to mcpi's per-project session directories under:
  $destination_dir

Legacy ~/.pi/agent migration is opt-in:
  ./migrate-sessions.sh --source "\$HOME/.pi/agent"
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--dry-run)
			dry_run=true
			shift
			;;
		--source)
			[[ $# -ge 2 ]] || {
				echo "Error: --source requires a directory" >&2
				exit 2
			}
			source_dir="$2"
			shift 2
			;;
		--destination)
			[[ $# -ge 2 ]] || {
				echo "Error: --destination requires a directory" >&2
				exit 2
			}
			destination_dir="$2"
			shift 2
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			echo "Error: unknown argument: $1" >&2
			usage >&2
			exit 2
			;;
	esac
done

if [[ "$dry_run" == true ]]; then
	echo "Dry run mode - no files will be moved"
	echo
fi

shopt -s nullglob
files=("$source_dir"/*.jsonl)
shopt -u nullglob

if [[ ${#files[@]} -eq 0 ]]; then
	echo "No loose session files found in $source_dir"
	exit 0
fi

echo "Found ${#files[@]} session file(s) to migrate"
echo

migrated=0
failed=0

for file in "${files[@]}"; do
	filename=$(basename "$file")

	if ! first_line=$(head -1 "$file" 2>/dev/null); then
		echo "SKIP: $filename - cannot read file"
		((failed += 1))
		continue
	fi

	if ! cwd=$(printf "%s\n" "$first_line" | jq -r '.cwd // empty' 2>/dev/null); then
		echo "SKIP: $filename - invalid JSON"
		((failed += 1))
		continue
	fi

	if [[ -z "$cwd" ]]; then
		echo "SKIP: $filename - no cwd in session header"
		((failed += 1))
		continue
	fi

	encoded=$(printf "%s\n" "$cwd" | sed 's|^[/\\]||; s|[/:\\]|-|g')
	encoded="--${encoded}--"
	target_dir="$destination_dir/$encoded"
	target_file="$target_dir/$filename"

	if [[ -e "$target_file" ]]; then
		echo "SKIP: $filename - target already exists"
		((failed += 1))
		continue
	fi

	echo "MIGRATE: $filename"
	echo "    cwd: $cwd"
	echo "    to:  $target_dir/"

	if [[ "$dry_run" == false ]]; then
		mkdir -p "$target_dir"
		mv "$file" "$target_file"
	fi

	((migrated += 1))
	echo
done

echo "---"
echo "Migrated: $migrated"
echo "Skipped:  $failed"

if [[ "$dry_run" == true && $migrated -gt 0 ]]; then
	echo
	echo "Run without --dry-run to perform the migration"
fi
