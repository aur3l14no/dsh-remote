set -eu
cat world.txt > skill-proof.txt
printf 'skill-executed-in-%s\n' "$(cat world.txt)"
