"""Tests for hooks/ssh-login.py - run: python3 -m unittest -v (in this directory)."""
import importlib.util
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
import unittest

_spec = importlib.util.spec_from_file_location('ssh_login', os.path.join(os.path.dirname(__file__), 'hooks', 'ssh-login.py'))
hook = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hook)

LOGIN = {'PAM_TYPE': 'open_session', 'PAM_USER': 'root', 'PAM_RHOST': '203.0.113.7'}
KEY = ('publickey', 'SHA256:abc', 'chris@vostro')


class Message(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def msg(self, env=LOGIN, now=1000.0, auth=KEY, lang='pl'):
        return hook.message(env, lang, now, self.dir, 600, auth)

    def test_a_login_names_user_address_time_and_key(self):
        m = self.msg()
        self.assertIn('root z 203.0.113.7', m)
        self.assertIn(hook.stamp(1000.0), m)
        self.assertIn('klucz SHA256:abc (chris@vostro)', m)
        self.assertIn('SSH login: root from', hook.message(LOGIN, 'en', 1000.0, tempfile.mkdtemp(), 600, KEY))

    def test_only_open_session_is_a_login(self):
        for t in ('auth', 'close_session', 'account', None):
            self.assertIsNone(self.msg(dict(LOGIN, PAM_TYPE=t)))

    def test_identical_logins_within_the_window_fold_into_the_next_message(self):
        self.assertIsNotNone(self.msg(now=1000))
        self.assertIsNone(self.msg(now=1100))
        self.assertIsNone(self.msg(now=1500))
        m = self.msg(now=1700)                   # 700 s after the last message
        self.assertIn('+2 takich samych od ' + hook.stamp(1100), m)
        self.assertNotIn('+', self.msg(now=2400).split('\n')[-1])

    def test_another_address_or_key_is_a_message_of_its_own(self):
        self.assertIsNotNone(self.msg(now=1000))
        self.assertIsNotNone(self.msg(dict(LOGIN, PAM_RHOST='198.51.100.1'), now=1001))
        self.assertIsNotNone(self.msg(now=1002, auth=('publickey', 'SHA256:other', '')))
        self.assertIsNone(self.msg(now=1003))

    def test_what_the_client_controls_is_filtered(self):
        m = self.msg(dict(LOGIN, PAM_USER='ro\not\n[bs1] fake', PAM_RHOST='1.2.3.4\nwszystko ok'),
                     auth=('publickey', 'SHA256:abc', 'x\n[bs2] ok; rm -rf'))
        self.assertEqual(m.count('\n'), 1, m)   # only the key line, nothing injected
        self.assertIn('rootbs1fake z 1.2.3.4wszystkook', m)
        self.assertNotIn(';', m)

    def test_password_login_says_the_method(self):
        self.assertIn('metoda password', self.msg(auth=('password', '', '')))


class AuthInfo(unittest.TestCase):
    def test_fingerprint_from_sshd_auth_info_matches_ssh_keygen(self):
        d = tempfile.mkdtemp()
        k = os.path.join(d, 'k')
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'test@here', '-f', k], check=True)
        pub = open(k + '.pub').read().split()
        want = subprocess.run(['ssh-keygen', '-lf', k + '.pub'], capture_output=True, text=True).stdout.split()[1]
        self.assertEqual(hook.fingerprint(f'{pub[0]} {pub[1]}'), want)
        env = {'SSH_AUTH_INFO_0': f'publickey {pub[0]} {pub[1]}\n'}
        self.assertEqual(hook.auth_info(env, 'nobody-here-xyz')[:2], ('publickey', want))
        self.assertEqual(hook.auth_info({}, 'root'), ('', '', ''))


class NeverBlocksALogin(unittest.TestCase):
    def config(self, sock):
        d = tempfile.mkdtemp()
        p = os.path.join(d, 'bot.json')
        with open(p, 'w') as f:
            json.dump({'socket': sock, 'name': 't', 'lang': 'pl', 'admins': ['00:00:00:00:00:00:00:00'],
                       'commands': {}}, f)
        return p, d

    def run_hook(self, cfg, state):
        bot = os.path.join(os.path.dirname(__file__), 'onchato-bot.py')
        t = time.monotonic()
        rc = hook.main(['--config', cfg, '--bot', bot, '--state', state], dict(LOGIN))
        return rc, time.monotonic() - t

    def test_a_daemon_that_never_answers_does_not_hold_the_login(self):
        d = tempfile.mkdtemp()
        sock = os.path.join(d, 's')
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(sock)
        srv.listen(4)
        got = []
        threading.Thread(target=lambda: got.append(srv.accept()), daemon=True).start()
        cfg, state = self.config(sock)
        rc, took = self.run_hook(cfg, state)
        self.assertEqual(rc, 0)
        self.assertLess(took, 1.0, 'the login waited for the daemon')
        for _ in range(50):                      # the detached sender did connect
            if got:
                break
            time.sleep(0.1)
        self.assertTrue(got, 'nothing was sent at all')
        got[0][0].close()                        # EOF: the sender exits
        srv.close()

    def test_no_daemon_and_a_broken_config_still_exit_0(self):
        cfg, state = self.config('/nonexistent/s')
        self.assertEqual(self.run_hook(cfg, state)[0], 0)
        self.assertEqual(hook.main(['--config', '/nonexistent/bot.json'], dict(LOGIN)), 0)


if __name__ == '__main__':
    unittest.main()
