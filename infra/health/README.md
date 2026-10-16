# Health probe → Uptime Kuma (Push monitor)

The HTTP monitors in Kuma query each node's `/health`, which proves **nginx, TLS
and the name**. It does not prove the relay: if the `onchato-relay` process died,
all of them would stay green while the messenger is down. This probe closes that gap.

It checks three things locally, and only then knocks on Kuma:

1. `onchato-relay` is `active`,
2. port `9001` is listening (the process got as far as listening),
3. the journal has a `[stats 15m]` line from the last 25 minutes — its absence
   means the event loop has stalled: the process is alive but not working.
   Skipped for the first 20 minutes after start, because no window has closed yet.

What goes onto the Kuma chart is **the worst event-loop stall** of the last window
(`lag` from the `[stats]` line), not the probe's run time.

## Installing on a node

```sh
# 1. the token from Kuma (Add New Monitor → Push → copy the Push URL WITHOUT parameters)
printf 'PUSH_URL=https://status.encedo.com/api/push/<TOKEN>\n' | sudo tee /etc/onchato-health.env >/dev/null
sudo chmod 600 /etc/onchato-health.env

# 2. the script under a fixed path + the units
sudo install -D -m 755 infra/health/relay-health.sh /usr/local/lib/onchato/relay-health.sh
sudo cp infra/health/onchato-health.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now onchato-health.timer

# 3. check
sudo systemctl start onchato-health.service && journalctl -u onchato-health -n 5 --no-pager
```

The script lives in `/usr/local/lib/onchato/`, not in the repository clone on the
node: that clone is updated only on a new app tag, and monitoring has nothing to
do with the release cycle. After changing the script — copy it again.

**The token is a secret** — whoever has it can report "I'm alive" on the node's
behalf. That is why `/etc/onchato-health.env` has mode 0600 and is not in the repository.

Silence is a signal too: when the whole machine goes down, there is nobody to send
`down`, and Kuma raises the alarm anyway after two missed knocks.
