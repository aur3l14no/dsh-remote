#!/bin/sh
set -eu
: "${DSH_E2E_PUBLIC_KEY:?}" "${WORLD_ID:?}"
install -d -m 700 -o world -g world /home/world/.ssh
printf '%s\n' "$DSH_E2E_PUBLIC_KEY" > /home/world/.ssh/authorized_keys
chown world:world /home/world/.ssh/authorized_keys
chmod 600 /home/world/.ssh/authorized_keys
ssh-keygen -A
if [ ! -d /workspace/.git ]; then
  runuser -u world -- git -C /workspace init --quiet
  printf '%s\n' "$WORLD_ID" > /workspace/world.txt
  chown world:world /workspace/world.txt
  runuser -u world -- git -C /workspace add world.txt
  runuser -u world -- git -C /workspace -c user.name=E2E -c user.email=e2e@example.invalid commit --quiet -m 'Initialize isolated World'
fi
exec /usr/sbin/sshd -D -e -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no \
  -o PermitRootLogin=no -o AllowUsers=world -o AllowTcpForwarding=no -o X11Forwarding=no
