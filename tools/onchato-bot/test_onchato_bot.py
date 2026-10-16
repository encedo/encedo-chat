"""Tests for onchato-bot.py - run: python3 -m unittest -v (in this directory)."""
import importlib.util
import json
import os
import socket
import tempfile
import threading
import unittest

_spec = importlib.util.spec_from_file_location('bot', os.path.join(os.path.dirname(__file__), 'onchato-bot.py'))
bot = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bot)

# Real links from 2026-10-16; the fingerprints are what onchato-cli (TS) printed for them.
KUBA = 'https://app.onchato.com/#i=eyJwIjoicE1NQkYvdm1SbndnUGprV2xoUDQxdDZOckxsTE04K2k3ZFpQcjg1NC9GUT0iLCJuIjoiRmVsaXgiLCJzIjoiMTJ5RGJvaGordmM4RVNFSFd3dkp3OEdmWXlnWFlHS3VFUC9idlRTVFZwcz0iLCJrIjoiWEs0UWtOYzF5WWJObVM0azVtako0eGxVS0lNSFh0ZlVUaC9iY0MvR05ROD0ifQ'
TOMEK = 'https://app.onchato.com/#i=eyJwIjoiTzNqdzRHN2RSWVJqUUtFMHh1Y0NadVROVlg1ZDIxTDhTU3h4RURNQnNqbz0iLCJuIjoiS2FqdG9tYXRvLUZvbiJ9'
ADMIN, USER = 'A' * 43 + '=', 'B' * 43 + '='
ADMIN_FP = bot.fingerprint(ADMIN)


class FakeDaemon:
    def __init__(self):
        self.sent, self.asked = [], []
        self.contacts = [{'name': 'szef', 'pub': ADMIN}, {'name': 'ewa', 'pub': USER}]

    def send(self, to, text, ttl=None):
        self.sent.append((to, text))
        return {'ok': True, 'status': 'delivered'}

    def ask(self, req):
        self.asked.append(req)
        op = req['op']
        if op == 'contacts':
            return {'ok': True, 'contacts': self.contacts}
        if op == 'add':
            return {'ok': True, 'status': 'added', 'name': req['name'], 'fp': '39:46:1D:E0:18:8C:93:39', 'knock': 1}
        if op == 'knocks':
            return {'ok': True, 'knocks': [{'n': 1, 'name': 'Ola', 'fp': 'AA:BB:CC:DD:EE:FF:00:11', 'note': '', 'invite': 'bot'}]}
        if op in ('accept', 'ignore'):
            return {'ok': True, 'name': 'Ola', 'fp': 'AA:BB:CC:DD:EE:FF:00:11'}
        return {'ok': False, 'error': 'nieznane op'}


def make(commands=None, **over):
    cfg = dict(bot.DEFAULTS, admins=[ADMIN_FP], name='t', commands=commands or {
        'ping': {'run': ['echo', 'pong']},
        'logi': {'run': ['journalctl', '-u', '{unit}', '-n', '5'], 'args': {'unit': '^(nginx|relay)$'}, 'admin': True},
    })
    cfg.update(over)
    bot.validate(cfg)
    clock = [1000.0]
    ran = []
    d = FakeDaemon()
    b = bot.Bot(cfg, d, now=lambda: clock[0], runner=lambda argv: ran.append(argv) or 'OUT ' + ' '.join(argv))
    return b, d, ran, clock


def msg(text, pub=USER, frm='ewa', **kw):
    return dict({'t': 'msg', 'from': frm, 'pub': pub, 'text': text}, **kw)


class Config(unittest.TestCase):
    def bad(self, commands, needle):
        with self.assertRaises(bot.ConfigError) as e:
            make(commands)
        self.assertIn(needle, str(e.exception))

    def test_an_argument_only_as_a_whole_element(self):
        self.bad({'x': {'run': ['sh', '-c', 'echo {a}'], 'args': {'a': '.*'}}}, 'caly element')

    def test_a_placeholder_needs_a_declared_regex(self):
        self.bad({'x': {'run': ['cat', '{f}']}}, 'bez wpisu w args')

    def test_a_declared_argument_must_be_used(self):
        self.bad({'x': {'run': ['true'], 'args': {'a': 'x'}}}, 'nie ma elementu')

    def test_builtin_names_are_reserved(self):
        self.bad({'dodaj': {'run': ['true']}}, 'wbudowana')

    def test_admins_are_fingerprints(self):
        with self.assertRaises(bot.ConfigError):
            make(admins=['szef'])

    def test_the_example_config_loads(self):
        bot.load_config(os.path.join(os.path.dirname(__file__), 'bot.example.json'))


class Commands(unittest.TestCase):
    def test_a_command_runs_its_argv_and_answers_the_sender(self):
        b, d, ran, _ = make()
        self.assertEqual(b.on_message(msg('PING')), 'OUT echo pong')
        self.assertEqual(ran, [['echo', 'pong']])
        self.assertEqual(d.sent, [('ewa', '[t] OUT echo pong')])

    def test_an_argument_must_match_its_regex_whole(self):
        b, d, ran, clock = make()
        self.assertEqual(b.on_message(msg('logi nginx', ADMIN, 'szef')), 'OUT journalctl -u nginx -n 5')
        for v in ('nginx;reboot', 'nginxx', '../etc', 'ssh'):
            self.assertEqual(b.on_message(msg('logi ' + v, ADMIN, 'szef')), 'niedozwolona wartosc dla unit')
        self.assertEqual(b.on_message(msg('logi', ADMIN, 'szef')), 'uzycie: <unit>')
        self.assertEqual(len(ran), 1, 'nothing else ran')

    def test_an_admin_command_is_not_run_for_a_contact(self):
        b, d, ran, _ = make()
        r = b.on_message(msg('logi nginx'))
        self.assertTrue(r.startswith('polecenia: ping'))
        self.assertNotIn('logi', r)
        self.assertEqual(ran, [])

    def test_a_programs_own_braces_pass_through(self):
        b, d, ran, _ = make({'docker': {'run': ['docker', 'ps', '--format', '{{.Names}}']}})
        b.on_message(msg('docker'))
        self.assertEqual(ran, [['docker', 'ps', '--format', '{{.Names}}']])

    def test_unknown_text_gets_help_and_runs_nothing(self):
        b, d, ran, _ = make()
        self.assertEqual(b.on_message(msg('rm -rf /')), 'polecenia: ping')
        self.assertEqual(ran, [])

    def test_rate_limit_for_contacts_not_admins(self):
        b, d, ran, clock = make()
        self.assertIsNotNone(b.on_message(msg('ping')))
        clock[0] += 5
        self.assertIsNone(b.on_message(msg('ping')))
        clock[0] += 6
        self.assertIsNotNone(b.on_message(msg('ping')))
        self.assertIsNotNone(b.on_message(msg('ping', ADMIN, 'szef')))
        self.assertIsNotNone(b.on_message(msg('ping', ADMIN, 'szef')))

    def test_groups_are_ignored_and_answer_admins_only_works(self):
        b, d, ran, _ = make()
        self.assertIsNone(b.on_message(msg('ping', group='zespol')))
        b2, d2, ran2, _ = make(answer='admins')
        self.assertIsNone(b2.on_message(msg('ping')))
        self.assertIsNotNone(b2.on_message(msg('ping', ADMIN, 'szef')))


class Contacts(unittest.TestCase):
    def test_a_contact_cannot_add_or_accept(self):
        b, d, ran, _ = make()
        for t in ('dodaj ' + KUBA, 'tak 3946', 'pukania', 'przyjmij 1'):
            self.assertEqual(b.answer(t, USER, False), 'to polecenie jest tylko dla adminow bota')
        self.assertEqual(d.asked, [])

    def test_add_shows_the_fingerprint_and_waits_for_its_code(self):
        b, d, ran, clock = make()
        r = b.on_message(msg('dodaj ' + KUBA + ' Kuba', ADMIN, 'szef'))
        self.assertIn('39:46:1D:E0:18:8C:93:39', r)
        self.assertIn('tak 3946', r)
        self.assertIn('zapukam', r)
        self.assertEqual(d.asked, [], 'nothing added before the confirmation')
        self.assertEqual(b.on_message(msg('tak 0000', ADMIN, 'szef')), 'zly kod - odpisz: tak 3946')
        self.assertEqual(d.asked, [])
        self.assertIn('zapukano', b.on_message(msg('tak 3946', ADMIN, 'szef')))
        self.assertEqual(d.asked, [{'op': 'add', 'link': KUBA, 'name': 'Kuba'}])
        self.assertIn('nie ma czego', b.on_message(msg('tak 3946', ADMIN, 'szef')), 'a code is used once')

    def test_an_unconfirmed_add_expires(self):
        b, d, ran, clock = make()
        b.on_message(msg('dodaj ' + TOMEK, ADMIN, 'szef'))
        clock[0] += bot.CONFIRM_S + 1
        self.assertIn('nie ma czego', b.on_message(msg('tak ' + bot.fingerprint(bot.read_link(TOMEK)[0]).replace(':', '')[:4], ADMIN, 'szef')))
        self.assertEqual(d.asked, [])

    def test_knocks_go_to_admins_only_and_are_decided_by_them(self):
        b, d, ran, _ = make()
        told = b.on_event({'t': 'knock', 'n': 1, 'name': 'Ola', 'fp': 'AA:BB:CC:DD:EE:FF:00:11', 'note': 'hej', 'invite': 'bot'})
        self.assertEqual(told, ['szef'])
        self.assertIn('przyjmij 1', d.sent[0][1])
        self.assertEqual(b.on_message(msg('przyjmij 1', ADMIN, 'szef')), 'dodano Ola (AA:BB:CC:DD:EE:FF:00:11)')
        self.assertEqual(d.asked[-1], {'op': 'accept', 'n': 1})


class Links(unittest.TestCase):
    def test_fingerprints_match_the_cli(self):
        self.assertEqual(bot.fingerprint(bot.read_link(KUBA)[0]), '39:46:1D:E0:18:8C:93:39')
        self.assertEqual(bot.fingerprint(bot.read_link(TOMEK)[0]), 'F0:90:1B:11:E4:ED:1A:24')

    def test_link_shapes(self):
        self.assertEqual(bot.read_link(KUBA)[1:], ('Felix', True))
        self.assertEqual(bot.read_link(TOMEK)[1:], ('Kajtomato-Fon', False))
        self.assertEqual(bot.read_link(TOMEK.split('#')[1])[1], 'Kajtomato-Fon')
        self.assertEqual(bot.read_link(TOMEK.split('#i=')[1])[1], 'Kajtomato-Fon')
        for junk in ('', 'hello', 'https://example.com/#i=AAAA', ADMIN):
            self.assertIsNone(bot.read_link(junk))


class Socket(unittest.TestCase):
    def test_ask_and_events_over_a_real_unix_socket(self):
        path = os.path.join(tempfile.mkdtemp(), 's.sock')
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(path)
        srv.listen(2)

        def serve():
            for _ in range(2):
                c, _ = srv.accept()
                req = json.loads(c.makefile('r').readline())
                if req['op'] == 'listen':
                    c.sendall(b'{"ok":true}\n{"t":"msg","from":"ewa","text":"x"}\nnot json\n{"t":"link","state":"online"}\n')
                else:
                    c.sendall((json.dumps({'ok': True, 'echo': req}) + '\n').encode())
                c.close()
        threading.Thread(target=serve, daemon=True).start()
        d = bot.Daemon(path)
        self.assertEqual(d.ask({'op': 'status'})['echo'], {'op': 'status'})
        self.assertEqual([e['t'] for e in d.events()], ['msg', 'link'])
        srv.close()


if __name__ == '__main__':
    unittest.main()
