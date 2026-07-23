#!/usr/bin/env bash
# Dependency-free test runner for serverclean.sh.
# Sources the script (main is guarded, so nothing executes) and exercises functions.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../../scripts/serverclean.sh"

# shellcheck source=/dev/null
source "$SCRIPT"
set +eu   # the sourced 'set -euo pipefail' must not govern the test runner's own flow

PASS=0; FAIL=0
assert_eq() { # <actual> <expected> <msg>
  if [[ "$1" == "$2" ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1)); echo "FAIL: $3 — got [$1] want [$2]"
  fi
}

# --- human() ---
assert_eq "$(human 0)"          "0B"    "human 0"
assert_eq "$(human 512)"        "512B"  "human 512"
assert_eq "$(human 1536)"       "1.5K"  "human 1536"
assert_eq "$(human 1073741824)" "1.0G"  "human 1GiB"

# --- to_bytes() ---
assert_eq "$(to_bytes 512)"      "512"         "to_bytes 512"
assert_eq "$(to_bytes 1.5G)"     "1610612736"  "to_bytes 1.5G"
assert_eq "$(to_bytes 299.8M)"   "314363084"   "to_bytes 299.8M (journalctl prose unit)"
assert_eq "$(to_bytes 116.2MB)"  "121844531"   "to_bytes 116.2MB (docker unit)"
assert_eq "$(to_bytes kB)"       "0"           "to_bytes no-number -> 0"
assert_eq "$(to_bytes '')"       "0"           "to_bytes empty -> 0"

# --- parse_args() ---
DRY_RUN=0; QUIET=0; JOURNAL_SIZE="200M"
parse_args --dry-run
assert_eq "$DRY_RUN" "1" "parse_args --dry-run sets DRY_RUN"

DRY_RUN=0; QUIET=0; JOURNAL_SIZE="200M"
parse_args -q --journal-size 500M
assert_eq "$QUIET" "1"        "parse_args -q sets QUIET"
assert_eq "$JOURNAL_SIZE" "500M" "parse_args --journal-size SIZE"

DRY_RUN=0; QUIET=0; JOURNAL_SIZE="200M"
parse_args --journal-size=1G
assert_eq "$JOURNAL_SIZE" "1G" "parse_args --journal-size=SIZE"

( parse_args --bogus ) >/dev/null 2>&1
assert_eq "$?" "2" "parse_args unknown flag exits 2"

( parse_args --journal-size ) >/dev/null 2>&1
assert_eq "$?" "2" "parse_args --journal-size missing value exits 2 (usage error)"

( parse_args --help ) >/dev/null 2>&1
assert_eq "$?" "0" "parse_args --help exits 0"

# --- run_step() skip paths (via source seam overrides) ---
# not installed -> skipped, TOTAL_FREED untouched
TOTAL_FREED=0; QUIET=1
run_step "ghost" 0 "definitely_missing_binary_xyz" true true
assert_eq "$TOTAL_FREED" "0" "run_step skips missing tool, no freed change"

# needs root but not root -> skipped, returns 0
is_root() { return 1; }            # override the real is_root
have()    { return 0; }            # pretend the tool exists
TOTAL_FREED=0; QUIET=1
run_step "aptish" 1 "whatever" true true
rc=$?
assert_eq "$rc" "0" "run_step needs-root non-root returns 0"
assert_eq "$TOTAL_FREED" "0" "run_step needs-root non-root frees nothing"

# real run: probe reports 3000 then 1000 -> freed 2000
is_root() { return 0; }
have()    { return 0; }
_seqfile=$(mktemp)
printf '0' > "$_seqfile"
fake_probe() {
  if [[ "$(cat "$_seqfile")" == "0" ]]; then printf '1' > "$_seqfile"; echo 3000; else echo 1000; fi
}
noop_action() { return 0; }
TOTAL_FREED=0; QUIET=1; DRY_RUN=0
run_step "fake" 0 "whatever" fake_probe noop_action
assert_eq "$TOTAL_FREED" "2000" "run_step accumulates freed = before-after"
rm -f "$_seqfile"

# --- docker reclaimable parsing (no jq; docker itself is stubbed) ---
docker() {                          # stub `docker system df --format ...`
  printf 'Images\t2.9GB (9%%)\nContainers\t25MB (1%%)\nLocal Volumes\t81MB (9%%)\nBuild Cache\t51GB (95%%)\n'
}
# expected = to_bytes(2.9GB) + to_bytes(51GB)
_want=$(( $(to_bytes 2.9GB) + $(to_bytes 51GB) ))
assert_eq "$(docker_reclaimable_bytes)" "$_want" "docker_reclaimable = Images + Build Cache only"
unset -f docker

# registry contains the docker row
_has_docker=0; for r in "${CLEANERS[@]}"; do [[ "$r" == docker* ]] && _has_docker=1; done
assert_eq "$_has_docker" "1" "CLEANERS registry has docker row"

# --- dir_bytes() ---
_tmp=$(mktemp -d); head -c 4096 /dev/zero > "$_tmp/f"
_db=$(dir_bytes "$_tmp"); [[ "$_db" -ge 4096 ]] && _dbok=1 || _dbok=0
assert_eq "$_dbok" "1" "dir_bytes returns >= file size"
assert_eq "$(dir_bytes /nonexistent/path/xyz)" "0" "dir_bytes missing path -> 0"
rm -rf "$_tmp"

# --- registry has all package rows, apt is root-gated ---
for want in npm pnpm yarn pip go apt; do
  _hit=0; for r in "${CLEANERS[@]}"; do IFS='|' read -r l nr t p a <<<"$r"; [[ "$t" == "$want" || "$t" == "apt-get" && "$want" == apt ]] && _hit=1; done
  assert_eq "$_hit" "1" "CLEANERS has $want row"
done
# apt row must be needs_root=1
for r in "${CLEANERS[@]}"; do IFS='|' read -r l nr t p a <<<"$r"; [[ "$t" == "apt-get" ]] && assert_eq "$nr" "1" "apt row is root-only"; done

# --- journal prose size extraction ---
_line="Archived and active journals take up 299.8M in the file system."
assert_eq "$(journal_size_str "$_line")" "299.8M" "journal_size_str extracts token"
assert_eq "$(to_bytes "$(journal_size_str "$_line")")" "314363084" "journal size -> bytes"

# registry has root-only journal row using journalctl
for r in "${CLEANERS[@]}"; do IFS='|' read -r l nr t p a <<<"$r"; [[ "$t" == "journalctl" ]] && { assert_eq "$nr" "1" "journal row root-only"; assert_eq "$a" "clean_journal_action" "journal action wired"; }; done

# --- end-to-end smoke (invoke the script as a subprocess) ---
SC="$HERE/../../scripts/serverclean.sh"

# --help exits 0 and mentions usage
_help=$(mktemp)
"$SC" --help >"$_help" 2>&1; assert_eq "$?" "0" "e2e --help exit 0"
grep -q "Usage: serverclean" "$_help" && _u=1 || _u=0
assert_eq "$_u" "1" "e2e --help prints usage"
rm -f "$_help"

# unknown flag exits 2
"$SC" --nope >/dev/null 2>&1; assert_eq "$?" "2" "e2e bad flag exit 2"

# dry-run must NOT mutate. Prove it took the no-op branch: output carries the
# DRY RUN banner and never the execute-mode "total reclaimed" line. (Robust on a
# busy box where whole-disk df sampling drifts by KB between two samples.)
_dry_out=$("$SC" --dry-run 2>&1); assert_eq "$?" "0" "e2e --dry-run exit 0"
if grep -q "DRY RUN" <<<"$_dry_out" && ! grep -q "total reclaimed" <<<"$_dry_out"; then _dryok=1; else _dryok=0; fi
assert_eq "$_dryok" "1" "e2e --dry-run took non-mutating path (no execute-mode output)"

# quiet dry-run emits exactly one summary line
_lines=$("$SC" --dry-run --quiet 2>/dev/null | wc -l | tr -d ' ')
assert_eq "$_lines" "1" "e2e --dry-run --quiet is one line"

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[[ $FAIL -eq 0 ]]
