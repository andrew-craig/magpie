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
  # Surfaced so the task_4c37 PATH cases below can assert on the value the
  # excerpt actually ended up with. Bracketed so an EMPTY PATH is
  # distinguishable from an absent line.
  echo 'echo "MAGPIE_TEST_PATH=[${PATH:-}]"'
  # Same idea for the M8-E7 (task_80a4) findings-path cases below.
  # shellcheck disable=SC2016  # literal: expands when the GENERATED excerpt runs, not here
  echo 'echo "MAGPIE_TEST_FINDINGS_PATH=[${MAGPIE_FINDINGS_PATH:-}]"'
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

# run_case_no_path NAME EXPECTED_SUBSTRING ENV_ASSIGNMENTS
#
# Like run_case, but runs the excerpt with PATH genuinely ABSENT from the
# environment -- `env -i` with no PATH= assignment, invoking bash by absolute
# path. That is the exact condition a micro-VM guest boots in (task_4c37: a
# bare exported rootfs carries no OCI config, and the launcher's env vec
# starts empty), and it is the one thing run_case CANNOT reproduce, since it
# deliberately injects PATH so the fixtures can find coreutils.
#
# NOTE: the excerpt still runs fine without PATH because `bash` resolves bare
# command names via its own compiled-in fallback -- which is precisely the
# phenomenon that kept this bug hidden until the M8-E2/E3 fixes cleared the
# earlier blockers (that fallback is internal to bash and is NOT exported to
# the processes it starts, e.g. setpriv's execvp of `pi`).
#
# Asserts on stdout rather than just the exit code.
run_case_no_path() {
  local name="$1" expected_substring="$2" env_assignments="$3"
  local out rc
  set +e
  out="$(env -i /bin/bash -c "${env_assignments} /bin/bash \"\$1\"" -- "${EXCERPT}" 2>&1)"
  rc=$?
  set -e
  if [ "${rc}" = "0" ] && printf '%s' "${out}" | grep -qF -- "${expected_substring}"; then
    echo "PASS: ${name}"
    pass_count=$((pass_count + 1))
  else
    echo "FAIL: ${name} -- expected exit 0 and output containing '${expected_substring}', got exit ${rc}. Output:"
    printf '%s\n' "${out}" | awk '{ print "    " $0 }'
    fail_count=$((fail_count + 1))
  fi
}

# run_case_no_path_refute NAME FORBIDDEN_SUBSTRING ENV_ASSIGNMENTS
#
# The negative counterpart of run_case_no_path. Deliberately asserts ABSENCE
# rather than an exact expected PATH: with PATH absent from the environment,
# bash assigns its own COMPILED-IN default to the shell variable (see
# entrypoint.sh's task_4c37 comment), and that value varies by bash build --
# so pinning it would make this test a hostage to the base image's bash.
# The property that actually matters is that the crun tier did NOT get the
# micro-VM branch's manufactured PATH.
run_case_no_path_refute() {
  local name="$1" forbidden_substring="$2" env_assignments="$3"
  local out rc
  set +e
  out="$(env -i /bin/bash -c "${env_assignments} /bin/bash \"\$1\"" -- "${EXCERPT}" 2>&1)"
  rc=$?
  set -e
  if [ "${rc}" = "0" ] && ! printf '%s' "${out}" | grep -qF -- "${forbidden_substring}"; then
    echo "PASS: ${name}"
    pass_count=$((pass_count + 1))
  else
    echo "FAIL: ${name} -- expected exit 0 and output NOT containing '${forbidden_substring}', got exit ${rc}. Output:"
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

# --- task_4c37 (M8-E4): PATH in a guest that boots without one -------------
#
# The regression pair for the `setpriv: failed to execute pi: No such file or
# directory` blocker found during the 2026-07-31 live micro-VM run. The
# micro-VM tier must MANUFACTURE a PATH containing /usr/local/bin (where the
# Dockerfile symlinks `pi`); the crun tier must be left exactly as it was,
# inheriting whatever the image's OCI config gave it -- including nothing.

run_case_no_path "microvm tier, PATH absent -> manufactures one containing /usr/local/bin (task_4c37)" \
  "MAGPIE_TEST_PATH=[/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin]" \
  "${COMMON_ENV} MAGPIE_TEST_FORCE_MICROVM=1 MAGPIE_MICROVM_RAM_MIB=1024 MAGPIE_TEST_MEMINFO=${MEMINFO_IN_BOUND}"

# The crun-tier guard: same PATH-absent environment, but WITHOUT the micro-VM
# signal the script must NOT apply the micro-VM branch's PATH -- proving the
# fix is genuinely tier-scoped and the crun path is untouched byte for byte.
run_case_no_path_refute "crun tier, PATH absent -> does NOT get the micro-VM PATH (proves the fix is micro-VM-only)" \
  "MAGPIE_TEST_PATH=[/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin]" \
  "${COMMON_ENV} MAGPIE_TEST_CGROUP_MEM_MAX=${CGROUP_ENFORCED}"

# --- task_80a4 (M8-E7): MAGPIE_FINDINGS_PATH in a bare-rootfs guest --------
#
# Same defect class as the PATH pair above: the Dockerfile's
# `ENV MAGPIE_FINDINGS_PATH=/out/findings.json` reaches the process only
# because `podman run` applies the image's OCI config, and a micro-VM guest has
# none. Left unset, the report_findings extension silently wrote
# ./magpie-findings.json under the READ-ONLY /work mount and every micro-VM
# review failed as "pi did not call report_findings" despite Pi calling it.
#
# The expected value is read out of the DOCKERFILE rather than hardcoded here,
# so this test also pins that the script's re-declaration and the image's ENV
# cannot drift apart (there is no single source of truth available to a bare
# rootfs at runtime, so the duplication is deliberate and needs pinning).
dockerfile_findings_path="$(grep -E '^ENV MAGPIE_FINDINGS_PATH=' "${SCRIPT_DIR}/Dockerfile" | head -n1 | cut -d= -f2-)"
if [ -z "${dockerfile_findings_path}" ]; then
  echo "FAIL: could not read ENV MAGPIE_FINDINGS_PATH from Dockerfile -- has it moved?" >&2
  exit 1
fi

run_case_no_path "microvm tier -> re-declares MAGPIE_FINDINGS_PATH matching the Dockerfile ENV (task_80a4)" \
  "MAGPIE_TEST_FINDINGS_PATH=[${dockerfile_findings_path}]" \
  "${COMMON_ENV} MAGPIE_TEST_FORCE_MICROVM=1 MAGPIE_MICROVM_RAM_MIB=1024 MAGPIE_TEST_MEMINFO=${MEMINFO_IN_BOUND}"

# Crun tier: must NOT manufacture it -- there it legitimately comes from the
# image config, and this harness runs with no image config at all, so the
# correct observed value is EMPTY. Proves the fix is tier-scoped.
run_case_no_path "crun tier -> does NOT manufacture MAGPIE_FINDINGS_PATH (image config supplies it there)" \
  "MAGPIE_TEST_FINDINGS_PATH=[]" \
  "${COMMON_ENV} MAGPIE_TEST_CGROUP_MEM_MAX=${CGROUP_ENFORCED}"

# --- task_a749 (M8-E5): the guest privilege-drop uid/gid -------------------
#
# WHY A SECOND EXCERPT: the excerpt above is truncated at the M4-E confinement
# banner, which sits ~400 lines ABOVE the privilege-drop block -- so the
# setpriv block is simply unreachable from it, and extending the truncation
# point is not an option (everything in between needs real network/vsock/
# virtiofs state this harness cannot provide). Rather than reimplement the
# block (the one thing this file's header rules out), slice it out of the REAL
# entrypoint.sh by marker and run it standalone.
#
# NOTHING IN THE SLICED BLOCK IS REWRITTEN -- not even the final `exec`. The
# two external commands it invokes (`chown`, `setpriv`) are instead shadowed by
# stubs placed FIRST on PATH, so the real `chown -R "${UID}:${GID}"` and the
# real `exec setpriv --reuid=... --regid=... pi` lines execute character-for-
# character and simply report what they were called with. That also means a
# stub is what `exec` replaces the shell with, so the stub's own output is the
# proof the block reached the drop.
DROP_EXCERPT="${MAGPIE_TEST_WORKDIR}/entrypoint-drop-excerpt.sh"
# shellcheck disable=SC2016  # a fixed grep needle matching entrypoint.sh's literal source text, not an expansion
drop_start_marker='case "${MAGPIE_MICROVM_REVIEWER_UID:-}" in'
drop_end_marker='exec setpriv --reuid='
drop_start_line="$(grep -nF -- "${drop_start_marker}" "${ENTRYPOINT}" | head -n1 | cut -d: -f1)"
drop_end_line="$(grep -nF -- "${drop_end_marker}" "${ENTRYPOINT}" | head -n1 | cut -d: -f1)"
if [ -z "${drop_start_line}" ] || [ -z "${drop_end_line}" ]; then
  echo "FAIL: could not locate the M8-E5 privilege-drop block in entrypoint.sh -- has it moved? Update drop_start_marker/drop_end_marker above." >&2
  exit 1
fi
# One line back for the `if [ "${MAGPIE_IS_MICROVM}" = "1" ]; then` that opens
# the block; one line forward for its closing `fi`.
{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  # shellcheck disable=SC2016  # deliberately literal: these are lines WRITTEN INTO the generated excerpt, to expand when IT runs
  echo ': "${MAGPIE_IS_MICROVM:=0}"'
  # shellcheck disable=SC2016
  echo 'mkdir -p "$HOME/.pi"'
  sed -n "$(( drop_start_line - 1 )),$(( drop_end_line + 1 ))p" "${ENTRYPOINT}"
  # Only reachable when the block was SKIPPED (crun tier) -- the micro-VM path
  # always ends in the `exec` above.
  echo 'echo "MAGPIE_TEST_DROP_SKIPPED"'
  echo 'exit 0'
} > "${DROP_EXCERPT}"

DROP_STUB_BIN="${MAGPIE_TEST_WORKDIR}/dropstubs"
mkdir -p "${DROP_STUB_BIN}"
printf '#!/usr/bin/env bash\necho "STUB_CHOWN $*"\nexit 0\n' > "${DROP_STUB_BIN}/chown"
printf '#!/usr/bin/env bash\necho "STUB_SETPRIV $*"\nexit 0\n' > "${DROP_STUB_BIN}/setpriv"
chmod +x "${DROP_STUB_BIN}/chown" "${DROP_STUB_BIN}/setpriv"

# run_drop_case NAME EXPECTED_EXIT EXPECTED_SUBSTRING ENV_ASSIGNMENTS
#
# EXPECTED_SUBSTRING is asserted on combined stdout+stderr; pass "" to skip
# the substring check and assert only the exit status.
run_drop_case() {
  local name="$1" expected_exit="$2" expected_substring="$3" env_assignments="$4"
  local out rc
  set +e
  out="$(env -i PATH="${DROP_STUB_BIN}:${PATH}" HOME="${MAGPIE_TEST_WORKDIR}/drophome" \
    bash -c "${env_assignments} bash \"\$1\"" -- "${DROP_EXCERPT}" 2>&1)"
  rc=$?
  set -e
  if [ "${rc}" = "${expected_exit}" ] && { [ -z "${expected_substring}" ] || printf '%s' "${out}" | grep -qF -- "${expected_substring}"; }; then
    echo "PASS: ${name}"
    pass_count=$((pass_count + 1))
  else
    echo "FAIL: ${name} -- expected exit ${expected_exit}${expected_substring:+ and output containing \'${expected_substring}\'}, got exit ${rc}. Output:"
    printf '%s\n' "${out}" | awk '{ print "    " $0 }'
    fail_count=$((fail_count + 1))
  fi
}

# The positive case, and the whole point of task_a749: the uid/gid the
# orchestrator supplies is what BOTH the chown and the setpriv drop use. The
# live bug was that these were hardcoded to 10001 while `/out` was owned by the
# host uid, so Pi could never write findings.json.
run_drop_case "microvm tier, valid reviewer uid/gid -> drops to exactly those ids" 0 \
  "STUB_SETPRIV --reuid=993 --regid=988 --clear-groups --no-new-privs pi" \
  "MAGPIE_IS_MICROVM=1 MAGPIE_MICROVM_REVIEWER_UID=993 MAGPIE_MICROVM_REVIEWER_GID=988"

run_drop_case "microvm tier, chown targets the SAME uid/gid as the drop" 0 \
  "STUB_CHOWN -R 993:988" \
  "MAGPIE_IS_MICROVM=1 MAGPIE_MICROVM_REVIEWER_UID=993 MAGPIE_MICROVM_REVIEWER_GID=988"

# Fail-closed cases. Each must abort BEFORE Pi -- never silently fall back to
# the baked-in 10001 account, which is known-broken for the /out virtiofs.
run_drop_case "microvm tier, reviewer uid unset -> fails closed" 1 \
  "MAGPIE_MICROVM_REVIEWER_UID is unset or non-numeric" \
  "MAGPIE_IS_MICROVM=1 MAGPIE_MICROVM_REVIEWER_GID=988"

run_drop_case "microvm tier, reviewer uid non-numeric -> fails closed" 1 \
  "MAGPIE_MICROVM_REVIEWER_UID is unset or non-numeric" \
  "MAGPIE_IS_MICROVM=1 MAGPIE_MICROVM_REVIEWER_UID=magpie MAGPIE_MICROVM_REVIEWER_GID=988"

run_drop_case "microvm tier, reviewer gid unset -> fails closed" 1 \
  "MAGPIE_MICROVM_REVIEWER_GID is unset or non-numeric" \
  "MAGPIE_IS_MICROVM=1 MAGPIE_MICROVM_REVIEWER_UID=993"

run_drop_case "microvm tier, reviewer gid non-numeric -> fails closed" 1 \
  "MAGPIE_MICROVM_REVIEWER_GID is unset or non-numeric" \
  "MAGPIE_IS_MICROVM=1 MAGPIE_MICROVM_REVIEWER_UID=993 MAGPIE_MICROVM_REVIEWER_GID=wheel"

# uid/gid 0 is rejected on its own, separately from the numeric check: running
# Pi as guest-root would discard the entire purpose of the privilege drop.
run_drop_case "microvm tier, reviewer uid 0 -> fails closed (never run Pi as root)" 1 \
  "resolve to root" \
  "MAGPIE_IS_MICROVM=1 MAGPIE_MICROVM_REVIEWER_UID=0 MAGPIE_MICROVM_REVIEWER_GID=988"

run_drop_case "microvm tier, reviewer gid 0 -> fails closed (never run Pi as root)" 1 \
  "resolve to root" \
  "MAGPIE_IS_MICROVM=1 MAGPIE_MICROVM_REVIEWER_UID=993 MAGPIE_MICROVM_REVIEWER_GID=0"

# Tier scoping: the crun tier must skip the whole block -- it has no privilege
# drop to do (podman's `--user` already did it), so the new fail-closed checks
# must not fire there even with both vars absent.
run_drop_case "crun tier, reviewer uid/gid absent -> block skipped entirely (no drop, no abort)" 0 \
  "MAGPIE_TEST_DROP_SKIPPED" \
  "MAGPIE_IS_MICROVM=0"

echo
echo "${pass_count} passed, ${fail_count} failed"
[ "${fail_count}" -eq 0 ]
