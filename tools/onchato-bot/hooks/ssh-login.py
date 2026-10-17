#!/usr/bin/env python3
"""
ssh-login.py - a message to the bot's admins on every successful SSH login
(GUIDE.md, "SSH logins"). Called by PAM, from /etc/pam.d/sshd:

  session optional pam_exec.so quiet /usr/bin/python3 -I /usr/local/lib/onchato/ssh-login.py

  --config PATH   the bot's config (default /etc/onchato/bot.json)
  --bot PATH      onchato-bot.py (default: next to this file, else /opt/onchato-bot/)
  --to WHO        admins (default) or reports - who gets the message
  --window S      identical logins (user, address, key) within S seconds after a
                  message are counted, not sent; the next message says how many (600)

Rules - this runs inside every login to the machine:
  - it never fails or delays a login: PAM `optional`, every error swallowed, exit 0,
    and the send runs in a detached process, so a dead daemon costs nothing;
  - nothing from the client reaches the message unfiltered: user, address and the
    key's comment are cut to a safe character set;
  - only `open_session` counts - a password typed wrong is not a login.
The key: with `ExposeAuthInfo yes` in sshd_config sshd hands PAM the method and the
public key; the fingerprint and the key's comment come from the user's authorized_keys.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import pwd
import re
import shutil
import subprocess
import sys
import time

STATE_DIR = '/run/onchato-ssh-login'
HERE = os.path.dirname(os.path.abspath(__file__))

TEXT = {
    'pl': {'msg': 'logowanie SSH: {user} z {ip}, {when}{auth}{more}',
           'key': '\nklucz {fp}{cmt}', 'method': '\nmetoda {m}',
           'more': '\n(+{n} takich samych od {since}, niezgłaszanych osobno)'},
    'en': {'msg': 'SSH login: {user} from {ip}, {when}{auth}{more}',
           'key': '\nkey {fp}{cmt}', 'method': '\nmethod {m}',
           'more': '\n(+{n} identical since {since}, not reported separately)'},
}


def clean(s, allowed, n):
    """Only `allowed` characters, at most n of them; '?' when nothing is left."""
    s = re.sub(f'[^{allowed}]', '', str(s or ''))[:n]
    return s or '?'


def clean_user(s):
    return clean(s, r'A-Za-z0-9._@-', 32)


def clean_host(s):
    return clean(s, r'0-9A-Za-z.:%_-', 64)


def clean_comment(s):
    return clean(s, r'A-Za-z0-9 ._@+=:/-', 40)


def keygen():
    return shutil.which('ssh-keygen') or '/usr/bin/ssh-keygen'


def fingerprint(publine):
    """'ssh-ed25519 AAAA...' -> 'SHA256:...', or '' (PAM gives no PATH, hence keygen())."""
    try:
        r = subprocess.run([keygen(), '-lf', '-'], input=publine + '\n', capture_output=True, text=True, timeout=5)
        p = r.stdout.split()
        return p[1] if r.returncode == 0 and len(p) > 1 else ''
    except Exception:
        return ''


def key_comment(user, fp):
    """The comment of the authorized_keys line with this fingerprint - who it is."""
    try:
        path = os.path.join(pwd.getpwnam(user).pw_dir, '.ssh', 'authorized_keys')
        r = subprocess.run([keygen(), '-lf', path], capture_output=True, text=True, timeout=5)
        for line in r.stdout.splitlines():
            p = line.split()
            if len(p) > 2 and p[1] == fp:
                # "256 SHA256:x comment words (ED25519)"
                return ' '.join(p[2:-1] if p[-1].startswith('(') else p[2:])
    except Exception:
        pass
    return ''


def auth_info(env, user):
    """(method, fingerprint, comment) of the last method that let the user in."""
    lines = [l for l in str(env.get('SSH_AUTH_INFO_0', '')).splitlines() if l.strip()]
    if not lines:
        return '', '', ''
    p = lines[-1].split()
    method = clean(p[0], r'a-z-', 32)
    if method == 'publickey' and len(p) >= 3:
        fp = fingerprint(f'{p[1]} {p[2]}')
        if fp:
            return method, fp, key_comment(user, fp)
    return method, '', ''


def collapse(state_dir, key, now, window):
    """None = say nothing (counted); else (n, since) folded into this message."""
    os.makedirs(state_dir, mode=0o700, exist_ok=True)
    path = os.path.join(state_dir, hashlib.sha256(key.encode()).hexdigest()[:24])
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(fd, 'r+') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            st = json.loads(f.read() or '{}')
        except ValueError:
            st = {}
        if now - st.get('sent', 0) < window:
            st['more'] = st.get('more', 0) + 1
            st.setdefault('since', now)
            out = None
        else:
            out = (st.get('more', 0), st.get('since'))
            st = {'sent': now}
        f.seek(0)
        f.truncate()
        f.write(json.dumps(st))
    return out


def stamp(t):
    return time.strftime('%Y-%m-%d %H:%M:%S %Z', time.localtime(t))


def message(env, lang, now, state_dir=STATE_DIR, window=600, auth=None):
    """The text to send, or None (not a login, or folded into a later one)."""
    if env.get('PAM_TYPE') != 'open_session':
        return None
    user, ip = clean_user(env.get('PAM_USER')), clean_host(env.get('PAM_RHOST'))
    method, fp, cmt = auth if auth is not None else auth_info(env, user)
    folded = collapse(state_dir, f'{user}|{ip}|{method}|{fp}', now, window)
    if folded is None:
        return None
    t = TEXT.get(lang, TEXT['en'])
    if fp:
        a = t['key'].format(fp=fp, cmt=f' ({clean_comment(cmt)})' if cmt else '')
    elif method:
        a = t['method'].format(m=method)
    else:
        a = ''
    n, since = folded
    more = t['more'].format(n=n, since=stamp(since)) if n else ''
    return t['msg'].format(user=user, ip=ip, when=stamp(now), auth=a, more=more)


def load_bot(path):
    spec = importlib.util.spec_from_file_location('onchato_bot', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def deliver(botmod, cfg, text, to):
    d = botmod.Daemon(os.environ.get('ONCHATO_SOCKET', cfg['socket']))
    b = botmod.Bot(cfg, d)
    if to == 'reports':
        return b.broadcast(text)
    ttl = botmod.parse_ttl(cfg['reports']['ttl'])
    for c in d.ask({'op': 'contacts'}).get('contacts', []):
        if botmod.fingerprint(c['pub']) in b.admins:
            d.send(c['name'], b.tag + text, ttl)
    return True


def detach():
    """True in the detached grandchild; the caller (PAM) returns at once."""
    if os.fork():
        os.wait()                            # the child exits right away - no zombie
        return False
    os.setsid()
    if os.fork():
        os._exit(0)
    null = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null, fd)
    return True


def main(argv=None, env=None):
    env = os.environ if env is None else env
    try:
        ap = argparse.ArgumentParser(prog='ssh-login')
        ap.add_argument('--config', default='/etc/onchato/bot.json')
        ap.add_argument('--bot', default=None)
        ap.add_argument('--to', choices=['admins', 'reports'], default='admins')
        ap.add_argument('--window', type=int, default=600)
        ap.add_argument('--state', default=STATE_DIR)
        a = ap.parse_args(argv)
        botpath = a.bot or next((p for p in (os.path.join(HERE, 'onchato-bot.py'),
                                             os.path.join(HERE, '..', 'onchato-bot.py'),
                                             '/opt/onchato-bot/onchato-bot.py') if os.path.exists(p)), '')
        botmod = load_bot(botpath)
        cfg = botmod.load_config(a.config)
        text = message(env, cfg['lang'], time.time(), a.state, a.window)
        if text is None:
            return 0
    except Exception:
        return 0
    if detach():
        try:
            deliver(botmod, cfg, text, a.to)
        finally:
            os._exit(0)
    return 0


if __name__ == '__main__':
    sys.exit(main())
