#!/usr/bin/env python3
"""
onchato-bot - a command bot over the onchato-cli daemon (GUIDE.md).

The daemon (`onchato-cli daemon`) holds the identity, the keys, the network and
the queue. This holds none of it: it talks to the daemon's socket, one JSON
line each way (impl/cli/daemon.ts), and maps a message to a program from a
fixed list in its config. Python 3.8+, standard library only.

  onchato-bot.py --config bot.json serve        answer commands, report knocks to admins
  onchato-bot.py --config bot.json run <cmd>    run a configured command, send its output to `reports`
  onchato-bot.py --config bot.json notify       send stdin to `reports`
  onchato-bot.py --config bot.json check        validate the config and reach the daemon

Rules that keep a chat message from becoming a shell:
  - a command runs a fixed argv from the config; never a shell;
  - an argument exists only where the config declares it, with a regex it must
    match whole, and it replaces only an argv element that is exactly "{name}";
  - admins are named by key FINGERPRINT (a name is just what we call them);
    `"admin": true` commands and contact management are theirs alone;
  - adding a contact asks the admin to confirm the fingerprint read from the link;
  - one answer per non-admin sender per `rate_seconds`; group messages are ignored.
"""
import argparse
import base64
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time

DEFAULTS = {
    'socket': '/srv/onchato/onchato.sock',
    'name': '',
    'admins': [],
    'answer': 'contacts',      # 'contacts' = anyone in the bot's book, 'admins' = admins only
    'rate_seconds': 10,
    'timeout_seconds': 20,
    'max_reply': 3000,
    'reports': {'to': [], 'ttl': '7d'},
    'commands': {},
}
BUILTIN = {'pomoc', 'dodaj', 'tak', 'pukania', 'przyjmij', 'ignoruj'}
CONFIRM_S = 300                 # an unconfirmed `dodaj` is forgotten after this
FP_RE = re.compile(r'^[0-9A-F]{2}(:[0-9A-F]{2}){7}$')
PLACEHOLDER = re.compile(r'\{([A-Za-z_][A-Za-z0-9_]*)\}')


def log(m):
    print(m, file=sys.stderr, flush=True)


# ---- config -----------------------------------------------------------------

class ConfigError(Exception):
    pass


def load_config(path):
    with open(path, encoding='utf-8') as f:
        raw = json.load(f)
    cfg = dict(DEFAULTS)
    cfg.update(raw)
    cfg['reports'] = dict(DEFAULTS['reports'], **raw.get('reports', {}))
    validate(cfg)
    return cfg


def validate(cfg):
    for fp in cfg['admins']:
        if not FP_RE.match(str(fp)):
            raise ConfigError(f'admins: "{fp}" to nie odcisk (AA:BB:... 8 bajtow, jak w onchato-cli contacts)')
    if cfg['answer'] not in ('contacts', 'admins'):
        raise ConfigError('answer: "contacts" albo "admins"')
    for name, c in cfg['commands'].items():
        if name in BUILTIN:
            raise ConfigError(f'commands.{name}: ta nazwa jest wbudowana')
        if not re.match(r'^[a-z0-9][a-z0-9_-]*$', name):
            raise ConfigError(f'commands.{name}: nazwa z malych liter, cyfr, - i _')
        run = c.get('run')
        if not isinstance(run, list) or not run or not all(isinstance(x, str) for x in run):
            raise ConfigError(f'commands.{name}.run: niepusta lista napisow (argv, bez powloki)')
        args = c.get('args', {})
        # A placeholder is {identifier}; anything else in braces is the program's own
        # syntax (docker's {{.Names}}) and is passed through untouched.
        for x in run:
            for ph in PLACEHOLDER.findall(x):
                if x != '{' + ph + '}':
                    raise ConfigError(f'commands.{name}.run: "{x}" - argument tylko jako caly element, nie wewnatrz')
                if ph not in args:
                    raise ConfigError(f'commands.{name}.run: "{{{ph}}}" bez wpisu w args')
        for a, rx in args.items():
            try:
                re.compile(rx)
            except re.error as e:
                raise ConfigError(f'commands.{name}.args.{a}: zly regex ({e})')
            if '{' + a + '}' not in run:
                raise ConfigError(f'commands.{name}.args.{a}: nie ma elementu "{{{a}}}" w run')


def parse_ttl(s):
    m = re.match(r'^(\d+)([mhd])$', str(s).strip())
    if not m:
        raise ConfigError(f'czas jak 30m, 24h albo 7d - nie "{s}"')
    return int(m.group(1)) * {'m': 60_000, 'h': 3_600_000, 'd': 86_400_000}[m.group(2)]


# ---- keys and links ---------------------------------------------------------

def fingerprint(pub_b64):
    """The app's form: SHA-256(pub)[0:8] as colon hex (impl/cli/fp.ts)."""
    h = hashlib.sha256(base64.b64decode(pub_b64)).digest()[:8]
    return ':'.join(f'{b:02X}' for b in h)


def read_link(text):
    """(pub, name, has_inbox) from a link, a #i= fragment or a bare code; None if it is not one.
    Only for SHOWING the admin what they are about to add - the daemon parses it again."""
    t = text.strip()
    m = re.search(r'(?:^|#)i=([A-Za-z0-9_-]+)', t)
    code = m.group(1) if m else (t if re.match(r'^[A-Za-z0-9_-]+$', t) else None)
    if not code:
        return None
    try:
        o = json.loads(base64.urlsafe_b64decode(code + '=' * (-len(code) % 4)))
        if len(base64.b64decode(o['p'])) != 32 or not isinstance(o['n'], str):
            return None
        return o['p'], o['n'], bool(o.get('s') and o.get('k'))
    except Exception:
        return None


# ---- the daemon's socket ----------------------------------------------------

class Daemon:
    def __init__(self, path):
        self.path = path

    def ask(self, req, timeout=90):
        """One request, one reply (a fresh connection each, as onchato-cli does)."""
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            s.connect(self.path)
            s.sendall((json.dumps(req) + '\n').encode())
            buf = b''
            while b'\n' not in buf:
                chunk = s.recv(65536)
                if not chunk:
                    raise ConnectionError('demon zamknal polaczenie')
                buf += chunk
            return json.loads(buf.split(b'\n', 1)[0])

    def events(self):
        """The `listen` stream, one event per line, until the daemon goes away."""
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(self.path)
        s.sendall(b'{"op":"listen"}\n')
        f = s.makefile('r', encoding='utf-8')
        f.readline()                         # {"ok":true}
        for line in f:
            try:
                yield json.loads(line)
            except ValueError:
                continue

    def send(self, to, text, ttl_ms=None):
        req = {'op': 'send', 'to': to, 'text': text, 'wait': 20_000}
        if ttl_ms:
            req['ttl'] = ttl_ms
        return self.ask(req)


# ---- the bot ----------------------------------------------------------------

class Bot:
    def __init__(self, cfg, daemon, now=time.monotonic, runner=None):
        self.cfg = cfg
        self.d = daemon
        self.now = now
        self.run_argv = runner or self._run_argv
        self.last = {}                       # sender pub -> time of our last answer
        self.pending = {}                    # admin pub -> (link, name, code, at)
        self.lock = threading.Lock()
        self.admins = {fp.upper() for fp in cfg['admins']}
        self.tag = f"[{cfg['name']}] " if cfg['name'] else ''

    def is_admin(self, pub):
        return fingerprint(pub) in self.admins

    # one incoming message -> maybe one answer (returned for tests, sent for real)
    def on_message(self, ev):
        if ev.get('t') != 'msg' or ev.get('group'):
            return None                      # 1:1 only: a group is not a console
        pub, who = ev.get('pub', ''), ev.get('from', '?')
        admin = self.is_admin(pub)
        if self.cfg['answer'] == 'admins' and not admin:
            return None
        # Admins are not rate-limited: `dodaj` is answered by `tak` seconds later.
        with self.lock:
            t = self.now()
            if not admin and t - self.last.get(pub, -1e9) < self.cfg['rate_seconds']:
                log(f'pominieto {who}: limit 1 odpowiedz na {self.cfg["rate_seconds"]} s')
                return None
            self.last[pub] = t
        reply = self.answer(ev.get('text', ''), pub, admin)
        self.d.send(who, self.tag + reply)
        return reply

    def answer(self, text, pub, admin):
        words = text.strip().split()
        if not words:
            return self.help(admin)
        cmd, args = words[0].lower(), words[1:]
        if cmd in ('dodaj', 'tak', 'pukania', 'przyjmij', 'ignoruj'):
            if not admin:
                return 'to polecenie jest tylko dla adminow bota'
            return getattr(self, 'cmd_' + cmd)(args, pub)
        c = self.cfg['commands'].get(cmd)
        if not c or (c.get('admin') and not admin):
            return self.help(admin)
        argv = self.argv(c, args)
        if isinstance(argv, str):
            return argv
        return self.run_argv(argv)

    def help(self, admin):
        mine = [n for n, c in self.cfg['commands'].items() if admin or not c.get('admin')]
        names = [n + ''.join(f' <{a}>' for a in self.cfg['commands'][n].get('args', {})) for n in mine]
        if admin:
            names += ['dodaj <link> [nazwa]', 'pukania', 'przyjmij <nr>', 'ignoruj <nr>']
        return 'polecenia: ' + ', '.join(names) if names else 'brak polecen'

    def argv(self, c, args):
        """The argv to run, or a refusal (str). Arguments only as declared, regex-checked whole."""
        decl = c.get('args', {})
        if len(args) != len(decl):
            return 'uzycie: ' + ' '.join(['<' + a + '>' for a in decl]) if decl else 'to polecenie nie bierze argumentow'
        vals = {}
        for (name, rx), v in zip(decl.items(), args):
            if not re.fullmatch(rx, v):
                return f'niedozwolona wartosc dla {name}'
            vals[name] = v
        return [vals[x[1:-1]] if PLACEHOLDER.fullmatch(x) and x[1:-1] in vals else x for x in c['run']]

    def _run_argv(self, argv):
        try:
            r = subprocess.run(argv, capture_output=True, text=True, timeout=self.cfg['timeout_seconds'])
            out = (r.stdout.strip() or r.stderr.strip() or '(pusto)')
            if r.returncode:
                out = f'[kod {r.returncode}] ' + out
        except subprocess.TimeoutExpired:
            out = f'przekroczony czas ({self.cfg["timeout_seconds"]} s)'
        except OSError as e:
            out = f'nie uruchomiono: {e}'
        return out[:self.cfg['max_reply']]

    # ---- admin: contacts and knocks (the daemon's add / knocks / accept / ignore)

    def cmd_dodaj(self, args, pub):
        if not args:
            return 'uzycie: dodaj <link> [nazwa]'
        got = read_link(args[0])
        if not got:
            return 'to nie jest link onchato ani kod zaproszenia'
        their, link_name, inbox = got
        name = ' '.join(args[1:]) or link_name
        fp = fingerprint(their)
        code = fp.replace(':', '')[:4]
        with self.lock:
            self.pending[pub] = (args[0], name, code, self.now())
        how = 'zapukam i bede pukac, az przyjmie' if inbox else 'odesle link zwrotny'
        return (f'dodac "{name}" (w linku: {link_name}), odcisk {fp}? {how}.\n'
                f'Porownaj odcisk z ta osoba i odpisz: tak {code}')

    def cmd_tak(self, args, pub):
        with self.lock:
            p = self.pending.get(pub)
            if not p or self.now() - p[3] > CONFIRM_S:
                self.pending.pop(pub, None)
                return 'nie ma czego potwierdzac (dodaj <link>)'
            if not args or args[0].upper() != p[2]:
                return f'zly kod - odpisz: tak {p[2]}'
            del self.pending[pub]
        r = self.d.ask({'op': 'add', 'link': p[0], 'name': p[1]})
        if not r.get('ok'):
            return 'nie dodano: ' + r.get('error', '?')
        if r['status'] == 'known':
            return f'ten klucz juz jest: {r["name"]} ({r["fp"]})'
        if 'knock' in r:
            return f'dodano {r["name"]} ({r["fp"]}) i zapukano - gdy przyjmie, przyjdzie potwierdzenie'
        return f'dodano {r["name"]} ({r["fp"]}). Ta osoba musi jeszcze dodac bota:\n{r.get("reply", "")}'

    def cmd_pukania(self, args, pub):
        r = self.d.ask({'op': 'knocks'})
        if not r.get('ok'):
            return r.get('error', '?')
        if not r['knocks']:
            return 'nikt nie puka'
        return '\n'.join(f'{k["n"]}) {k["name"]} - odcisk {k["fp"]}, zaproszenie "{k["invite"]}"'
                         + (f', "{k["note"]}"' if k['note'] else '') for k in r['knocks'])

    def cmd_przyjmij(self, args, pub):
        return self._decide('accept', args, 'dodano')

    def cmd_ignoruj(self, args, pub):
        return self._decide('ignore', args, 'zignorowano')

    def _decide(self, op, args, said):
        if len(args) != 1 or not args[0].isdigit():
            return 'podaj numer z: pukania'
        r = self.d.ask({'op': op, 'n': int(args[0])})
        return f'{said} {r["name"]} ({r["fp"]})' if r.get('ok') else r.get('error', '?')

    # ---- events other than messages

    def on_event(self, ev):
        t = ev.get('t')
        if t == 'msg':
            return self.on_message(ev)
        if t == 'knock':
            return self.tell_admins(f'{ev["name"]} puka (zaproszenie "{ev["invite"]}"), odcisk {ev["fp"]}'
                                    + (f', "{ev["note"]}"' if ev.get('note') else '') + f' - odpisz: przyjmij {ev["n"]} albo ignoruj {ev["n"]}')
        if t == 'contact' and ev.get('how') == 'accepted':
            return self.tell_admins(f'{ev["name"]} przyjal(a) zaproszenie bota ({ev["fp"]})')
        return None

    def tell_admins(self, text):
        r = self.d.ask({'op': 'contacts'})
        names = [c['name'] for c in r.get('contacts', []) if fingerprint(c['pub']) in self.admins]
        for n in names:
            self.d.send(n, self.tag + text)
        return names

    # ---- reports

    def broadcast(self, text):
        ttl = parse_ttl(self.cfg['reports']['ttl'])
        ok = True
        for to in self.cfg['reports']['to']:
            r = self.d.send(to, self.tag + text, ttl)
            log(f'{to}: {r.get("status") or r.get("error")}')
            ok = ok and bool(r.get('ok'))
        return ok


def serve(bot, daemon):
    log(f'odpowiadam ({bot.cfg["answer"]}), adminow: {len(bot.admins)}, polecen: {len(bot.cfg["commands"])}')
    try:
        for ev in daemon.events():
            # A thread per event: an answer may wait up to 20 s for the recipient's ack.
            threading.Thread(target=safe, args=(bot.on_event, ev), daemon=True).start()
    except OSError as e:
        log(f'demon {daemon.path}: {e}')
        return 1
    log('strumien zdarzen sie skonczyl (demon zatrzymany?)')
    return 1                                 # systemd: Restart=always


def safe(f, *a):
    try:
        f(*a)
    except Exception as e:                   # one bad event must not take the bot down
        log(f'blad: {e}')


def main(argv=None):
    ap = argparse.ArgumentParser(prog='onchato-bot')
    ap.add_argument('--config', required=True)
    ap.add_argument('mode', choices=['serve', 'run', 'notify', 'check'])
    ap.add_argument('cmd', nargs='?')
    a = ap.parse_args(argv)
    try:
        cfg = load_config(a.config)
    except (OSError, ValueError, ConfigError) as e:
        log(f'konfiguracja {a.config}: {e}')
        return 2
    d = Daemon(os.environ.get('ONCHATO_SOCKET', cfg['socket']))
    bot = Bot(cfg, d)
    if a.mode == 'check':
        r = d.ask({'op': 'status'})
        print(f'demon: {r.get("me")} ({r.get("link")}), kontaktow {r.get("contacts")}; polecenia: {", ".join(cfg["commands"]) or "-"}')
        return 0
    if a.mode == 'serve':
        return serve(bot, d)
    if a.mode == 'run':
        c = cfg['commands'].get(a.cmd or '')
        if not c or c.get('args'):
            log(f'run: "{a.cmd}" - polecenie z konfiguracji, bez argumentow')
            return 2
        return 0 if bot.broadcast(bot.run_argv(c['run'])) else 1
    if a.mode == 'notify':
        text = sys.stdin.read().strip()
        return 0 if text and bot.broadcast(text) else 1
    return 2


if __name__ == '__main__':
    sys.exit(main())
