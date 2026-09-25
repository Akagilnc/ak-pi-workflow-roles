#!/bin/zsh
# Frozen replay of one recorded seat run. Caller-side tool; not part of the public CLI.
#   replay-run.sh freeze <run-dir> [--cut <ISO>] [--head <sha>] [--kit <dir>]
#   replay-run.sh run    <kit> <arm> <n> [--sys <file>] [--instr <text>] [--effort <e>] [--model <m>] [--thinking <t>]
#   replay-run.sh show   <kit> [<arm>]
#   replay-run.sh clean  <kit>
set -e
HERE=${0:A:h}
cmd=$1; [[ -n $cmd ]] && shift
case $cmd in
  freeze) exec python3 "$HERE/freeze.py" --tool-dir "$HERE" "$@";;
  run)    exec python3 "$HERE/run.py" "$@";;
  show)   exec python3 "$HERE/show.py" "$@";;
  clean)  exec python3 "$HERE/clean.py" "$@";;
  *) sed -n '2,7p' "$0"; exit 2;;
esac
