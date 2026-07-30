#!/usr/bin/env bash
# Lightweight, self-contained test of entrypoint.sh's M8-E3 (task_2541)
# tier-detection-before-memory-check reordering and its two branches.
#
# WHY NOT A FULL bats/image-build TEST: entrypoint.sh's later sections need a
# real container/micro-VM runtime (network namespaces, virtiofs mounts, an
# actual /dev/vsock character device -- `mknod` for one needs privileges this
# sandbox doesn't have, confirmed empirically while writing this test) and a
# built magpie-reviewer image. None of that is available here, and this repo
# has no bats harness set up (checked: no *.bats files, no `bats` binary on
# PATH).
#
# WHAT THIS DOES INSTEAD: runs the REAL entrypoint.sh source (not a
# reimplementation) up through the memory-ceiling check only -- truncated
# right before the M4-E confinement assertions, which need real network/
# vsock state this harness can't provide -- with exactly three literal
# lines made override-able for the test:
#   - `[ -c /dev/vsock ]`            -> driven by MAGPIE_TEST_FORCE_MICROVM
#   - `/proc/meminfo` reads          -> driven by MAGPIE_TEST_MEMINFO
#   - `/sys/fs/cgroup/memory.max`    -> driven by MAGPIE_TEST_CGROUP_MEM_MAX
# reads
# (each override falls back to the real path when its test var is unset, so
# this also documents that the production script is unchanged outside these
# exact five lines). Every other line -- the tier-detection ordering, the
# crun-tier cgroup check, the micro-VM RAM-ceiling check's validation and
# arithmetic -- runs unmodified, character-for-character.
#
# Run directly: bash docker/reviewer/entrypoint-tier-memory.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRYPOINT="${SCRIPT_DIR}/entrypoint.sh"

MAGPIE_TEST_WORKDIR="$(mktemp -d)"
trap 'rm -rf "${MAGPIE_TEST_WORKDIR}"' EXIT

EXCERPT="${MAGPIE_TEST_WORKDIR}/entrypoint-excerpt.sh"

truncate_marker="# M4-E: fail-closed startup confinement assertions. PLAN.md milestone 4's"
truncate_line="$(grep -nF -- "${truncate_marker}" "${ENTRYPOINT}" | head -n1 | cut -d: -f1)"
if [ -z "${truncate_line}" ]; then
  echo "FAIL: could not find the M4-E section marker in entrypoint.sh -- has it moved? Update truncate_marker above." >&2
  exit 1
fi
# The marker line is the SECOND line of a two-line "# ---" / "# M4-E: ..."
# banner; keep everything strictly before the banner.
keep_lines=$(( truncate_line - 2 ))
head -n "${keep_lines}" "${ENTRYPOINT}" > "${EXCERPT}"

# replace_line SEARCH_LITERAL REPLACEMENT_LINE
#
# Finds the (single, exact) line containing SEARCH_LITERAL as a fixed
# substring and overwrites that whole line with REPLACEMENT_LINE. Uses awk
# (not sed) for the actual rewrite so REPLACEMENT_LINE's `$`/`"`/`&` content
# never has to survive a second round of shell-metacharacter escaping.
replace_line() {
  local literal="$1" replacement="$2" lineno matches
  matches="$(grep -cF -- "${literal}" "${EXCERPT}")"
  if [ "${matches}" != "1" ]; then
    echo "FAIL: expected exactly 1 line containing '${literal}' in the excerpt, found ${matches} -- entrypoint.sh's text has drifted from what this test expects. Aborting (not a false pass)." >&2
    exit 1
  fi
  lineno="$(grep -nF -- "${literal}" "${EXCERPT}" | cut -d: -f1)"
  awk -v n="${lineno}" -v rep="${replacement}" 'NR==n { print rep; next } { print }' "${EXCERPT}" > "${EXCERPT}.tmp"
  mv "${EXCERPT}.tmp" "${EXCERPT}"
}

replace_line \
  'if [ -c /dev/vsock ]; then' \
  "if [ -n \"\${MAGPIE_TEST_FORCE_MICROVM:-}\" ]; then"

replace_line \
  'if [ -r /proc/meminfo ]; then' \
  "if [ -r \"\${MAGPIE_TEST_MEMINFO:-/proc/meminfo}\" ]; then"

replace_line \
  "magpie_mem_total_kib=\"\$(awk '/^MemTotal:/ { print \$2 }' /proc/meminfo)\"" \
  "magpie_mem_total_kib=\"\$(awk '/^MemTotal:/ { print \$2 }' \"\${MAGPIE_TEST_MEMINFO:-/proc/meminfo}\")\""

replace_line \
  'if [ -r /sys/fs/cgroup/memory.max ]; then' \
  "if [ -r \"\${MAGPIE_TEST_CGROUP_MEM_MAX:-/sys/fs/cgroup/memory.max}\" ]; then"

replace_line \
  "magpie_memory_max_raw=\"\$(cat /sys/fs/cgroup/memory.max 2>/dev/null || true)\"" \
  "magpie_memory_max_raw=\"\$(cat \"\${MAGPIE_TEST_CGROUP_MEM_MAX:-/sys/fs/cgroup/memory.max}\" 2>/dev/null || true)\""

# Belt-and-suspenders: the excerpt must still be syntactically valid bash and
# must still contain each test hook, proving the substitutions landed rather
# than silently no-op'ing.
bash -n "${EXCERPT}"
for marker in MAGPIE_TEST_FORCE_MICROVM MAGPIE_TEST_MEMINFO MAGPIE_TEST_CGROUP_MEM_MAX MAGPIE_MICROVM_RAM_MIB; do
  grep -q -- "${marker}" "${EXCERPT}" || {
    echo "FAIL: expected marker '${marker}' not found in the generated excerpt." >&2
    exit 1
  }
done

{
  echo 'echo "MAGPIE_TEST_REACHED_END"'
  echo 'exit 0'
} >> "${EXCERPT}"

pass_count=0
fail_count=0

# run_case NAME EXPECTED_EXIT ENV_ASSIGNMENTS...
#
# ENV_ASSIGNMENTS is a single string of space-separated VAR=value pairs,
# applied ONLY to the excerpt subprocess (env -i gives it a clean
# environment plus PATH, so no ambient host env can leak in and mask a
# fail-closed bug as a pass).
run_case() {
  local name="$1" expected_exit="$2" env_assignments="$3"
  local out rc
  set +e
  out="$(env -i PATH="${PATH}" bash -c "${env_assignments} bash \"\$1\"" -- "${EXCERPT}" 2>&1)"
  rc=$?
  set -e
  if [ "${rc}" = "${expected_exit}" ]; then
    echo "PASS: ${name} (exit ${rc})"
    pass_count=$((pass_count + 1))
  else
    echo "FAIL: ${name} -- expected exit ${expected_exit}, got ${rc}. Output:"
    printf '%s\n' "${out}" | awk '{ print "    " $0 }'
    fail_count=$((fail_count + 1))
  fi
}

# --- Fixtures ------------------------------------------------------------
CGROUP_ENFORCED="${MAGPIE_TEST_WORKDIR}/memory.max.enforced"
printf '536870912' > "${CGROUP_ENFORCED}"   # 512 MiB, a finite byte count

CGROUP_UNENFORCED="${MAGPIE_TEST_WORKDIR}/memory.max.unenforced"
printf 'max' > "${CGROUP_UNENFORCED}"

MEMINFO_IN_BOUND="${MAGPIE_TEST_WORKDIR}/meminfo.in-bound"
printf 'MemTotal:        1000000 kB\nMemFree:          500000 kB\n' > "${MEMINFO_IN_BOUND}"

MEMINFO_OVER_BOUND="${MAGPIE_TEST_WORKDIR}/meminfo.over-bound"
printf 'MemTotal:        8000000 kB\nMemFree:         4000000 kB\n' > "${MEMINFO_OVER_BOUND}"

COMMON_ENV='OPENROUTER_API_KEY=sk-magpie-test OPENAI_BASE_URL=http://127.0.0.1:4000/v1'

# --- crun tier (MAGPIE_TEST_FORCE_MICROVM unset -> [ -c /dev/vsock ] false) ---

run_case "crun tier, enforced cgroup ceiling -> passes" 0 \
  "${COMMON_ENV} MAGPIE_TEST_CGROUP_MEM_MAX=${CGROUP_ENFORCED}"

run_case "crun tier, unenforced ceiling + require_memory_limit default(true) -> fails closed" 1 \
  "${COMMON_ENV} MAGPIE_TEST_CGROUP_MEM_MAX=${CGROUP_UNENFORCED}"

run_case "crun tier, unenforced ceiling + require_memory_limit=false -> warns and continues" 0 \
  "${COMMON_ENV} MAGPIE_REQUIRE_MEMORY_LIMIT=false MAGPIE_TEST_CGROUP_MEM_MAX=${CGROUP_UNENFORCED}"

# --- micro-VM tier (MAGPIE_TEST_FORCE_MICROVM=1) --------------------------

run_case "microvm tier, MemTotal within ram-mib bound -> passes" 0 \
  "${COMMON_ENV} MAGPIE_TEST_FORCE_MICROVM=1 MAGPIE_MICROVM_RAM_MIB=1024 MAGPIE_TEST_MEMINFO=${MEMINFO_IN_BOUND}"

run_case "microvm tier, MemTotal far exceeds ram-mib bound -> fails closed (ceiling not enforced)" 1 \
  "${COMMON_ENV} MAGPIE_TEST_FORCE_MICROVM=1 MAGPIE_MICROVM_RAM_MIB=1024 MAGPIE_TEST_MEMINFO=${MEMINFO_OVER_BOUND}"

run_case "microvm tier, MAGPIE_MICROVM_RAM_MIB unset -> fails closed" 1 \
  "${COMMON_ENV} MAGPIE_TEST_FORCE_MICROVM=1 MAGPIE_TEST_MEMINFO=${MEMINFO_IN_BOUND}"

run_case "microvm tier, MAGPIE_MICROVM_RAM_MIB non-numeric -> fails closed" 1 \
  "${COMMON_ENV} MAGPIE_TEST_FORCE_MICROVM=1 MAGPIE_MICROVM_RAM_MIB=abc MAGPIE_TEST_MEMINFO=${MEMINFO_IN_BOUND}"

run_case "microvm tier, MAGPIE_MICROVM_RAM_MIB=0 -> fails closed" 1 \
  "${COMMON_ENV} MAGPIE_TEST_FORCE_MICROVM=1 MAGPIE_MICROVM_RAM_MIB=0 MAGPIE_TEST_MEMINFO=${MEMINFO_IN_BOUND}"

# The CORE regression case for task_2541: under the micro-VM tier, an
# UNENFORCED-looking cgroup fixture must be completely ignored -- proving
# the crun-only cgroup branch is genuinely skipped (not just coincidentally
# passing), i.e. that the reordering fix actually took effect.
run_case "microvm tier ignores an unenforced cgroup fixture entirely (proves the crun branch is skipped)" 0 \
  "${COMMON_ENV} MAGPIE_TEST_FORCE_MICROVM=1 MAGPIE_MICROVM_RAM_MIB=1024 MAGPIE_TEST_MEMINFO=${MEMINFO_IN_BOUND} MAGPIE_TEST_CGROUP_MEM_MAX=${CGROUP_UNENFORCED} MAGPIE_REQUIRE_MEMORY_LIMIT=true"

echo
echo "${pass_count} passed, ${fail_count} failed"
[ "${fail_count}" -eq 0 ]
